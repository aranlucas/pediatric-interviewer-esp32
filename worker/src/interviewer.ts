import { Agent, type Connection } from "agents";
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai/web";

import {
  ABPD_OCE_BLUEPRINT_URL,
  findTopic,
  knownTopic,
  PEDIATRIC_TOPICS,
  type PediatricTopicId,
} from "./interview-content";
import { openingPresentationForDisplay, questionForDisplay } from "./interview-display";
import { parseInterviewerDeviceMessage, type DeviceStatus } from "./interviewer-protocol";
import {
  EVALUATION_MODEL,
  evaluateInterview,
  INTERVIEW_QUESTION_COUNT,
  storeInterviewReport,
  type InterviewEvaluation,
  type InterviewExchange,
  type StoredInterviewReport,
} from "./interview-report";
import {
  GEMINI_LIVE_MODEL,
  geminiLiveConfig,
  geminiTextTurn,
  TURN_DISPOSITION_TOOL,
} from "./gemini-live-protocol";
import { decodeBase64, encodeBase64, PcmFramer, resamplePcm16 } from "./pcm-audio";

export { PEDIATRIC_TOPICS };

const DEVICE_SAMPLE_RATE = 24_000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
// The device accepts arbitrary even-length PCM payloads and drains them in
// 20 ms I2S chunks. Sending one WebSocket message per 20 ms caused hundreds of
// TLS/WebSocket callbacks for a single prompt and destabilized the ESP32. Batch
// five chunks per message while preserving Gemini's native 24 kHz mono stream.
const OUTPUT_PCM_FRAME_BYTES = 4_800;
const OUTPUT_PCM_FRAME_DURATION_MS = (OUTPUT_PCM_FRAME_BYTES / (DEVICE_SAMPLE_RATE * 2)) * 1_000;
const LIVE_SESSION_LIMIT_MS = 14 * 60 * 1_000;

type TurnDisposition = "advance_skillset" | "probe_current_answer" | "provide_case_information";

type InterviewerEnv = Env & {
  GEMINI_API_KEY: string;
  INTERVIEW_REPORTS: R2Bucket;
};

export type InterviewPhase =
  | "idle"
  | "interviewing"
  | "evaluating"
  | "evaluation_failed"
  | "complete";

export type PediatricInterviewerState = {
  phase: InterviewPhase;
  topicId: PediatricTopicId;
  questionIndex: number;
  answerCount: number;
  currentQuestion: string;
  exchanges: InterviewExchange[];
  reportId: string;
  reportJsonKey: string;
  reportMarkdownKey: string;
  evaluation?: InterviewEvaluation;
};

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

export class PediatricInterviewer extends Agent<InterviewerEnv, PediatricInterviewerState> {
  initialState: PediatricInterviewerState = {
    phase: "idle",
    topicId: "behavior_guidance",
    questionIndex: 0,
    answerCount: 0,
    currentQuestion: "",
    exchanges: [],
    reportId: "",
    reportJsonKey: "",
    reportMarkdownKey: "",
  };

  private gemini?: Session;
  private connecting = false;
  private device?: Connection;
  private releaseKeepAlive?: () => void;
  private sessionTimer?: ReturnType<typeof setTimeout>;
  private inputTranscript = "";
  private outputTranscript = "";
  private readonly outputAudio = new PcmFramer(OUTPUT_PCM_FRAME_BYTES);
  private outputAudioFrames: Uint8Array[] = [];
  private outputAudioFrameHead = 0;
  private outputAudioDrain?: Promise<void>;
  private outputAudioGeneration = 0;
  private modelSpeaking = false;
  private acceptingCandidateInput = false;
  private closingGemini = false;
  private finishingTurn = false;
  private interruptedGeneration = false;
  private candidateActivityStarted = false;
  private responseCompletionHandled = false;
  private loggedOutputFrame = false;
  private liveGeneration = 0;
  private turnDisposition: TurnDisposition = "advance_skillset";
  private awaitingToolContinuation = false;
  private pendingQuestion = "";
  private pendingAnswer = "";

  onConnect(connection: Connection): void {
    this.sendJSON(connection, { type: "welcome", protocol_version: 1 });
    this.sendStatus(connection, "idle");
  }

  onMessage(connection: Connection, message: unknown): void {
    if (message instanceof ArrayBuffer) {
      this.forwardAudio(connection, message);
      return;
    }
    if (typeof message !== "string") return;
    const parsed = parseInterviewerDeviceMessage(message);
    if (!parsed) return;
    if (parsed.type === "start_call") {
      void this.startLiveSession(connection, parsed.topic_id);
    } else if (parsed.type === "end_call") {
      if (this.device?.id !== connection.id) return;
      this.closeLiveSession("device ended call");
      this.sendStatus(connection, "idle");
    } else if (parsed.type === "commit_turn") {
      this.commitAudioTurn(connection);
    } else if (parsed.type === "candidate_text") {
      this.forwardCandidateText(connection, parsed.text);
    }
  }

  onClose(connection: Connection): void {
    if (this.device?.id === connection.id) this.closeLiveSession("device disconnected");
  }

  private sendJSON(connection: Connection, message: Record<string, unknown>): void {
    connection.send(JSON.stringify(message));
  }

  private sendStatus(connection: Connection, status: DeviceStatus): void {
    this.acceptingCandidateInput = status === "listening";
    this.sendJSON(connection, { type: "status", status });
  }

  private async startLiveSession(
    connection: Connection,
    topicId: string | undefined,
  ): Promise<void> {
    if (this.gemini || this.connecting) return;
    const topic = knownTopic(topicId);
    if (!topic) {
      this.sendJSON(connection, {
        type: "error",
        message: "Select a valid pediatric oral-board topic.",
      });
      return;
    }
    if (!this.env.GEMINI_API_KEY.trim()) {
      this.sendJSON(connection, { type: "error", message: "Gemini Live is not configured." });
      return;
    }
    const generation = ++this.liveGeneration;
    this.device = connection;
    this.closingGemini = false;
    this.loggedOutputFrame = false;
    this.responseCompletionHandled = false;
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.modelSpeaking = false;
    this.acceptingCandidateInput = false;
    this.finishingTurn = false;
    this.interruptedGeneration = false;
    this.candidateActivityStarted = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    this.pendingQuestion = "";
    this.pendingAnswer = "";
    this.connecting = true;
    this.setState({
      phase: "interviewing",
      topicId: topic.id,
      questionIndex: 0,
      answerCount: 0,
      currentQuestion: "Generating a new oral-board vignette...",
      exchanges: [],
      reportId: "",
      reportJsonKey: "",
      reportMarkdownKey: "",
      evaluation: undefined,
    });
    this.sendInterviewState(connection);
    try {
      this.releaseKeepAlive = await this.keepAlive();
      const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });
      this.gemini = await ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        config: geminiLiveConfig(topic),
        callbacks: {
          onmessage: (message) => this.handleGeminiMessage(message),
          onerror: (event) => {
            if (generation !== this.liveGeneration) return;
            console.error("Gemini Live SDK error", event.error ?? event.message);
            this.sendJSON(connection, {
              type: "error",
              message: "Gemini Live connection failed.",
            });
            this.closeLiveSession("Gemini Live SDK error");
          },
          onclose: (event) => {
            if (generation !== this.liveGeneration) return;
            console.error(
              JSON.stringify({
                event: "gemini_live_close",
                code: event.code,
                reason: event.reason,
                clean: event.wasClean,
              }),
            );
            ++this.liveGeneration;
            this.releaseLiveResources();
            if (!this.closingGemini) {
              this.sendJSON(connection, {
                type: "error",
                message: "Gemini Live closed the interview.",
              });
              this.sendStatus(connection, "idle");
            }
          },
        },
      });
      if (generation !== this.liveGeneration || this.device?.id !== connection.id) {
        this.gemini.close();
        return;
      }
      this.sendJSON(connection, {
        type: "audio_config",
        format: "pcm16",
        sampleRate: DEVICE_SAMPLE_RATE,
      });
      this.sendStatus(connection, "thinking");
      this.gemini.sendClientContent({
        turns: "BEGIN_EXAMINATION. Generate the vignette and ask question one now.",
        turnComplete: true,
      });
      this.sessionTimer = setTimeout(() => {
        this.sendJSON(connection, {
          type: "error",
          message: "The fourteen-minute Gemini Live session limit was reached.",
        });
        this.closeLiveSession("session limit");
      }, LIVE_SESSION_LIMIT_MS);
    } catch (error) {
      if (generation !== this.liveGeneration) return;
      ++this.liveGeneration;
      this.releaseLiveResources();
      this.sendJSON(connection, {
        type: "error",
        message: `Could not start Gemini Live: ${String(error).slice(0, 180)}`,
      });
    } finally {
      this.connecting = false;
    }
  }

  private releaseLiveResources(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = undefined;
    this.gemini = undefined;
    this.resetOutputAudio();
    this.interruptedGeneration = false;
    this.candidateActivityStarted = false;
    this.responseCompletionHandled = false;
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.modelSpeaking = false;
    this.acceptingCandidateInput = false;
    this.finishingTurn = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    this.pendingQuestion = "";
    this.pendingAnswer = "";
    this.device = undefined;
    this.releaseKeepAlive?.();
    this.releaseKeepAlive = undefined;
  }

  private resetOutputAudio(): void {
    this.outputAudioGeneration += 1;
    this.outputAudio.clear();
    this.outputAudioFrames = [];
    this.outputAudioFrameHead = 0;
    this.outputAudioDrain = undefined;
  }

  private closeLiveSession(reason: string): void {
    this.closingGemini = true;
    console.log(`Closing Gemini Live session: ${reason.slice(0, 100)}`);
    const session = this.gemini;
    ++this.liveGeneration;
    this.releaseLiveResources();
    session?.close();
  }

  private forwardAudio(connection: Connection, audio: ArrayBuffer): void {
    if (this.device?.id !== connection.id || this.state.phase !== "interviewing" || !this.gemini) {
      return;
    }
    if (!this.candidateActivityStarted) {
      this.gemini.sendRealtimeInput({ activityStart: {} });
      this.candidateActivityStarted = true;
    }
    this.gemini.sendRealtimeInput({
      audio: {
        data: encodeBase64(audio),
        mimeType: `audio/pcm;rate=${DEVICE_SAMPLE_RATE}`,
      },
    });
  }

  private commitAudioTurn(connection: Connection): void {
    if (this.device?.id !== connection.id || !this.gemini || !this.candidateActivityStarted) {
      return;
    }
    this.responseCompletionHandled = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    this.gemini.sendRealtimeInput({ activityEnd: {} });
    this.candidateActivityStarted = false;
    this.sendStatus(connection, "thinking");
  }

  private forwardCandidateText(connection: Connection, text: string): void {
    const gemini = this.gemini;
    const rejectionReason =
      this.device?.id !== connection.id
        ? "device_mismatch"
        : this.state.phase !== "interviewing"
          ? "interview_not_active"
          : !gemini
            ? "gemini_not_connected"
            : !this.acceptingCandidateInput
              ? "interviewer_not_listening"
              : this.candidateActivityStarted
                ? "audio_turn_active"
                : null;
    if (rejectionReason) {
      this.sendJSON(connection, {
        type: "candidate_text_ack",
        accepted: false,
        reason: rejectionReason,
      });
      return;
    }
    if (!gemini) return;
    this.acceptingCandidateInput = false;
    this.responseCompletionHandled = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    this.inputTranscript = text;
    gemini.sendClientContent(geminiTextTurn(text));
    this.sendJSON(connection, {
      type: "candidate_text_ack",
      accepted: true,
      turnComplete: true,
    });
    this.sendStatus(connection, "thinking");
  }

  private handleGeminiMessage(message: LiveServerMessage): void {
    if (!this.device) return;
    if (message.toolCall?.functionCalls?.length) {
      const responses = message.toolCall.functionCalls.map((call) => {
        if (call.name === TURN_DISPOSITION_TOOL) {
          const disposition = call.args?.disposition;
          if (
            disposition === "advance_skillset" ||
            disposition === "probe_current_answer" ||
            disposition === "provide_case_information"
          ) {
            this.turnDisposition = disposition;
          }
          this.awaitingToolContinuation = true;
        }
        return {
          id: call.id,
          name: call.name,
          response: { output: "Continue with the spoken examiner response." },
        };
      });
      this.gemini?.sendToolResponse({ functionResponses: responses });
      return;
    }
    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) {
      console.log(
        JSON.stringify({
          event: "gemini_generation_interrupted",
          answerCharacters: this.inputTranscript.length,
        }),
      );
      this.interruptedGeneration = true;
      this.resetOutputAudio();
      this.outputTranscript = "";
      this.modelSpeaking = false;
      this.sendJSON(this.device, { type: "playback_interrupt" });
      this.sendStatus(this.device, "listening");
      return;
    }
    if (content.inputTranscription?.text) {
      this.inputTranscript += content.inputTranscription.text;
      console.log(
        JSON.stringify({
          event: "gemini_input_transcription",
          characters: content.inputTranscription.text.length,
        }),
      );
      this.sendStatus(this.device, "thinking");
    }
    if (content.outputTranscription?.text) {
      this.awaitingToolContinuation = false;
      this.outputTranscript += content.outputTranscription.text;
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (!inline?.data) continue;
      this.awaitingToolContinuation = false;
      const rate = inline.mimeType?.includes("rate=16000") ? 16_000 : GEMINI_OUTPUT_SAMPLE_RATE;
      const pcm = resamplePcm16(decodeBase64(inline.data), rate, DEVICE_SAMPLE_RATE);
      this.queueOutputAudio(pcm);
      if (!this.modelSpeaking) {
        this.modelSpeaking = true;
        this.sendStatus(this.device, "speaking");
      }
    }
    const responseComplete = content.generationComplete || content.turnComplete;
    if (responseComplete && this.awaitingToolContinuation) return;
    if (responseComplete && this.interruptedGeneration) {
      this.interruptedGeneration = false;
      this.sendStatus(this.device, "listening");
      return;
    }
    if (responseComplete && !this.responseCompletionHandled && !this.finishingTurn) {
      this.responseCompletionHandled = true;
      const audioDrained = this.flushOutputAudio();
      const generation = this.liveGeneration;
      const connectionId = this.device.id;
      this.finishingTurn = true;
      void audioDrained
        .then(() => {
          if (generation === this.liveGeneration && this.device?.id === connectionId) {
            // The device may respond immediately after finishGeminiTurn sends
            // `listening`. Clear the guard first so that next turn is accepted.
            this.finishingTurn = false;
            return this.finishGeminiTurn(this.device).then(() => {
              if (generation === this.liveGeneration && this.device?.id === connectionId) {
                this.sendJSON(this.device, {
                  type: "turn_complete",
                  answerCount: this.state.answerCount,
                  questionNumber: this.state.questionIndex + 1,
                });
              }
            });
          }
        })
        .finally(() => {
          if (generation === this.liveGeneration) this.finishingTurn = false;
        });
    }
  }

  private queueOutputAudio(pcm: Uint8Array): void {
    if (!this.device) return;
    for (const frame of this.outputAudio.write(pcm)) {
      if (!this.loggedOutputFrame) {
        this.loggedOutputFrame = true;
        console.log(
          JSON.stringify({
            event: "device_audio_frame",
            bytes: OUTPUT_PCM_FRAME_BYTES,
          }),
        );
      }
      this.outputAudioFrames.push(frame);
    }
    this.startOutputAudioDrain();
  }

  private flushOutputAudio(): Promise<void> {
    const tail = this.outputAudio.flush();
    if (tail) this.outputAudioFrames.push(tail);
    this.startOutputAudioDrain();
    return this.outputAudioDrain ?? Promise.resolve();
  }

  private startOutputAudioDrain(): void {
    if (this.outputAudioDrain || this.outputAudioFrameHead >= this.outputAudioFrames.length) {
      return;
    }
    const generation = this.outputAudioGeneration;
    this.outputAudioDrain = this.drainOutputAudio(generation).finally(() => {
      if (generation !== this.outputAudioGeneration) return;
      this.outputAudioDrain = undefined;
      this.startOutputAudioDrain();
    });
  }

  private async drainOutputAudio(generation: number): Promise<void> {
    while (
      generation === this.outputAudioGeneration &&
      this.outputAudioFrameHead < this.outputAudioFrames.length
    ) {
      const frame = this.outputAudioFrames[this.outputAudioFrameHead++];
      if (!this.device) return;
      this.device.send(frame);
      await scheduler.wait(
        Math.max(
          1,
          Math.round((frame.byteLength / OUTPUT_PCM_FRAME_BYTES) * OUTPUT_PCM_FRAME_DURATION_MS),
        ),
      );
    }
    if (generation === this.outputAudioGeneration) {
      this.outputAudioFrames = [];
      this.outputAudioFrameHead = 0;
    }
  }

  private async finishGeminiTurn(connection: Connection): Promise<void> {
    const answer = normalizeTranscript(this.inputTranscript);
    const examinerSpeech = normalizeTranscript(this.outputTranscript);
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.modelSpeaking = false;

    if (examinerSpeech) {
      this.sendJSON(connection, { type: "transcript_start", role: "assistant" });
      this.sendJSON(connection, {
        type: "transcript_end",
        role: "assistant",
        text: examinerSpeech,
      });
    }
    if (!answer) {
      const generatedQuestion = openingPresentationForDisplay(examinerSpeech);
      if (
        this.state.phase === "interviewing" &&
        this.state.answerCount === 0 &&
        generatedQuestion
      ) {
        this.setState({
          ...this.state,
          currentQuestion: generatedQuestion,
        });
        this.sendInterviewState(connection);
      }
      this.sendStatus(connection, "listening");
      return;
    }
    this.sendJSON(connection, { type: "transcript", role: "user", text: answer });
    if (this.state.phase !== "interviewing") return;

    if (
      /^(?:take your time\s*[—-]?\s*please continue|please answer the clinical question)[.!]?$/i.test(
        examinerSpeech,
      )
    ) {
      this.sendStatus(connection, "listening");
      return;
    }

    if (this.turnDisposition !== "advance_skillset") {
      if (!this.pendingQuestion) this.pendingQuestion = this.state.currentQuestion;
      if (this.turnDisposition === "probe_current_answer") {
        this.pendingAnswer = normalizeTranscript(`${this.pendingAnswer} ${answer}`);
      }
      this.setState({
        ...this.state,
        currentQuestion: questionForDisplay(examinerSpeech) || this.state.currentQuestion,
      });
      this.sendInterviewState(connection);
      this.sendStatus(connection, "listening");
      return;
    }

    const exchangeQuestion = this.pendingQuestion || this.state.currentQuestion;
    const exchangeAnswer = normalizeTranscript(`${this.pendingAnswer} ${answer}`);
    this.pendingQuestion = "";
    this.pendingAnswer = "";
    const exchanges = [
      ...this.state.exchanges,
      { question: exchangeQuestion, answer: exchangeAnswer },
    ];
    const answerCount = exchanges.length;
    if (answerCount >= INTERVIEW_QUESTION_COUNT) {
      this.setState({
        ...this.state,
        phase: "evaluating",
        questionIndex: INTERVIEW_QUESTION_COUNT - 1,
        answerCount,
        exchanges,
      });
      this.sendInterviewState(connection);
      this.sendStatus(connection, "evaluating");
      await this.finishInterview(connection);
      return;
    }

    this.setState({
      ...this.state,
      phase: "interviewing",
      questionIndex: answerCount,
      answerCount,
      currentQuestion:
        questionForDisplay(examinerSpeech) || "The next clinical question is being prepared.",
      exchanges,
    });
    this.sendInterviewState(connection);
    this.sendStatus(connection, "listening");
  }

  private async finishInterview(connection: Connection): Promise<void> {
    const topic = findTopic(this.state.topicId);
    const reportId = this.state.reportId || crypto.randomUUID();
    try {
      const evaluation = await this.retry(
        () => evaluateInterview(this.env.GEMINI_API_KEY, topic, this.state.exchanges),
        { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 3_000 },
      );
      const report: StoredInterviewReport = {
        schemaVersion: 1,
        reportId,
        sessionId: this.name,
        generatedAt: new Date().toISOString(),
        evaluatorModel: EVALUATION_MODEL,
        topic: {
          id: topic.id,
          label: topic.label,
          blueprintWeight: topic.blueprintWeight,
          blueprintSource: ABPD_OCE_BLUEPRINT_URL,
          studyMaterial: topic.studyMaterial,
          objectives: topic.objectives,
          competencies: topic.competencies.map((competency) => ({ ...competency })),
        },
        evaluation,
      };
      const keys = await this.retry(
        () => storeInterviewReport(this.env.INTERVIEW_REPORTS, report),
        { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 },
      );
      this.setState({
        ...this.state,
        phase: "complete",
        reportId,
        reportJsonKey: keys.jsonKey,
        reportMarkdownKey: keys.markdownKey,
        evaluation,
      });
      this.sendJSON(connection, {
        type: "interview_report",
        reportId,
        outcome: evaluation.outcome,
        reviewPath: `/interviewer/reports/${reportId}.md`,
      });
      this.sendInterviewState(connection);
      this.sendStatus(connection, "complete");
      this.closeLiveSession("interview complete");
    } catch (error) {
      this.setState({ ...this.state, phase: "evaluation_failed", reportId });
      this.sendInterviewState(connection);
      this.sendJSON(connection, {
        type: "error",
        message: `Could not save the interview review: ${String(error).slice(0, 180)}`,
      });
    }
  }

  private sendInterviewState(connection: Connection): void {
    const topic = findTopic(this.state.topicId);
    this.sendJSON(connection, {
      type: "interview_state",
      phase: this.state.phase,
      questionNumber:
        this.state.phase === "idle"
          ? 0
          : Math.min(this.state.questionIndex + 1, INTERVIEW_QUESTION_COUNT),
      totalQuestions: INTERVIEW_QUESTION_COUNT,
      domain: topic.label,
      question: this.state.currentQuestion,
    });
  }
}

export const pediatricInterviewerModels = {
  conversation: GEMINI_LIVE_MODEL,
  transcription: GEMINI_LIVE_MODEL,
  speech: GEMINI_LIVE_MODEL,
  evaluation: EVALUATION_MODEL,
} as const;
