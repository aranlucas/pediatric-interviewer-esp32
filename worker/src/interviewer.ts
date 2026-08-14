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
import { isResponseComplete, shouldEndTurn } from "./turn-completion";
import {
  GEMINI_LIVE_MODEL,
  geminiLiveConfig,
  geminiOpeningTurn,
  geminiReplayForAudioTurn,
  geminiWarmUpTurn,
  geminiReadinessTurn,
  geminiTextTurn,
  TURN_DISPOSITION_TOOL,
} from "./gemini-live-protocol";
import { decodeBase64, encodeBase64, PcmFramer, resamplePcm16 } from "./pcm-audio";

export { PEDIATRIC_TOPICS };

export const DEVICE_SAMPLE_RATE = 24_000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
// The device accepts arbitrary even-length PCM payloads and drains them in
// 20 ms I2S chunks. Sending one WebSocket message per 20 ms caused hundreds of
// TLS/WebSocket callbacks for a single prompt and destabilized the ESP32. Batch
// five chunks per message while preserving Gemini's native 24 kHz mono stream.
export const OUTPUT_PCM_FRAME_BYTES = 4_800;
const LIVE_SESSION_LIMIT_MS = 14 * 60 * 1_000;
const MAX_OPENING_AUDIO_RETRIES = 2;

type TurnDisposition =
  | "begin_first_question"
  | "advance_skillset"
  | "probe_current_answer"
  | "provide_case_information";

/**
 * The opening handshake runs as one linear sequence: a throwaway warm-up turn,
 * the generated case presentation, the readiness question, then the candidate's
 * confirmation. Only after the confirmation is the interview under way.
 */
type OpeningStage =
  | "warming_up"
  | "presenting_case"
  | "asking_readiness"
  | "awaiting_confirmation"
  | "complete";

const OPENING_HANDSHAKE_STAGES: ReadonlySet<OpeningStage> = new Set([
  "warming_up",
  "presenting_case",
  "asking_readiness",
]);

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

/**
 * Durable interview state. Everything a client needs about progress is derived
 * from `exchanges`: its length is the answer count, and the question number is
 * that length capped at the planned question count.
 */
export type PediatricInterviewerState = {
  phase: InterviewPhase;
  topicId: PediatricTopicId;
  currentQuestion: string;
  exchanges: InterviewExchange[];
  reportId: string;
  evaluation?: InterviewEvaluation;
};

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

export class PediatricInterviewer extends Agent<InterviewerEnv, PediatricInterviewerState> {
  initialState: PediatricInterviewerState = {
    phase: "idle",
    topicId: "behavior_guidance",
    currentQuestion: "",
    exchanges: [],
    reportId: "",
  };

  private gemini?: Session;
  private connecting = false;
  private device?: Connection;
  private releaseKeepAlive?: () => void;
  private sessionTimer?: ReturnType<typeof setTimeout>;
  private inputTranscript = "";
  private outputTranscript = "";
  private readonly outputAudio = new PcmFramer(OUTPUT_PCM_FRAME_BYTES);
  private turnProducedAudio = false;
  /** The last status sent to the device; also gates candidate input and
   * de-duplicates the `speaking` transition. */
  private lastStatus: DeviceStatus = "idle";
  private closingGemini = false;
  private interruptedGeneration = false;
  private candidateActivityStarted = false;
  private responseCompletionHandled = false;
  private liveGeneration = 0;
  private turnDisposition: TurnDisposition = "advance_skillset";
  private awaitingToolContinuation = false;
  private openingStage: OpeningStage = "complete";
  private openingAudioRetryCount = 0;
  private pendingQuestion = "";
  private pendingAnswer = "";

  /** Answers recorded so far; the interview ends at INTERVIEW_QUESTION_COUNT. */
  private get answerCount(): number {
    return this.state.exchanges.length;
  }

  /** One-based number of the question currently on screen. */
  private get questionNumber(): number {
    return Math.min(this.answerCount + 1, INTERVIEW_QUESTION_COUNT);
  }

  private get openingHandshakeInProgress(): boolean {
    return OPENING_HANDSHAKE_STAGES.has(this.openingStage);
  }

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
    this.lastStatus = status;
    this.sendJSON(connection, { type: "status", status });
  }

  /** Persists a state change and mirrors it to the device's prompt view. */
  private updateInterview(
    connection: Connection,
    patch: Partial<PediatricInterviewerState>,
  ): void {
    this.setState({ ...this.state, ...patch });
    this.sendInterviewState(connection);
  }

  /**
   * Drives the next scripted turn of the opening handshake. Re-arms the
   * completion guard so Gemini's reply to this prompt is treated as a new turn.
   */
  private askGemini(connection: Connection, turn: { turns: string; turnComplete: true }): void {
    this.responseCompletionHandled = false;
    this.sendStatus(connection, "thinking");
    this.gemini?.sendClientContent(turn);
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
    this.resetTurnState();
    this.resetOutputAudio();
    this.device = connection;
    this.closingGemini = false;
    this.lastStatus = "idle";
    this.openingStage = "warming_up";
    this.connecting = true;
    this.updateInterview(connection, {
      phase: "interviewing",
      topicId: topic.id,
      currentQuestion: "Generating a new oral-board vignette...",
      exchanges: [],
      reportId: "",
      evaluation: undefined,
    });
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
      this.gemini.sendClientContent(geminiWarmUpTurn());
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

  /**
   * Clears everything scoped to the conversation rather than to the socket, so
   * that starting a session and tearing one down cannot drift apart.
   */
  private resetTurnState(): void {
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.interruptedGeneration = false;
    this.candidateActivityStarted = false;
    this.responseCompletionHandled = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    this.openingStage = "complete";
    this.openingAudioRetryCount = 0;
    this.pendingQuestion = "";
    this.pendingAnswer = "";
  }

  private releaseLiveResources(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = undefined;
    this.gemini = undefined;
    this.resetOutputAudio();
    this.resetTurnState();
    this.lastStatus = "idle";
    this.device = undefined;
    this.releaseKeepAlive?.();
    this.releaseKeepAlive = undefined;
  }

  private resetOutputAudio(): void {
    this.outputAudio.clear();
    this.turnProducedAudio = false;
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
            : this.lastStatus !== "listening"
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
    // Close the input window before anything can be sent back, so a second
    // typed answer cannot slip in ahead of the `thinking` status below.
    this.lastStatus = "thinking";
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
            disposition === "begin_first_question" ||
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
    {
      const parts = content.modelTurn?.parts ?? [];
      console.log(
        JSON.stringify({
          event: "gemini_server_content",
          stage: this.openingStage,
          parts: parts.length,
          audioParts: parts.filter((part) => part.inlineData?.data).length,
          audioBytes: parts.reduce(
            (total, part) => total + (part.inlineData?.data?.length ?? 0),
            0,
          ),
          mimeTypes: [...new Set(parts.map((part) => part.inlineData?.mimeType ?? "none"))],
          textParts: parts.filter((part) => part.text).length,
          outputTranscriptionChars: content.outputTranscription?.text?.length ?? 0,
          generationComplete: Boolean(content.generationComplete),
          turnComplete: Boolean(content.turnComplete),
          interrupted: Boolean(content.interrupted),
        }),
      );
    }
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
      if (this.lastStatus !== "speaking") this.sendStatus(this.device, "speaking");
    }
    const responseComplete = isResponseComplete(content);
    if (responseComplete && this.awaitingToolContinuation) return;
    if (responseComplete && this.interruptedGeneration) {
      this.interruptedGeneration = false;
      this.sendStatus(this.device, "listening");
      return;
    }
    if (!shouldEndTurn(content, this.openingHandshakeInProgress)) return;
    if (this.responseCompletionHandled) return;
    this.responseCompletionHandled = true;
    const audioDrained = this.flushOutputAudio();
    const generation = this.liveGeneration;
    const connectionId = this.device.id;
    void audioDrained.then(() => {
      if (generation !== this.liveGeneration || this.device?.id !== connectionId) return;
      return this.finishGeminiTurn(this.device).then(() => {
        if (generation === this.liveGeneration && this.device?.id === connectionId) {
          this.sendJSON(this.device, {
            type: "turn_complete",
            answerCount: this.answerCount,
            questionNumber: this.questionNumber,
          });
        }
      });
    });
  }

  /** Frames Gemini audio; the ESP32 applies flow control at its jitter queue. */
  private queueOutputAudio(pcm: Uint8Array): void {
    if (!this.device) return;
    // The warm-up turn exists only to absorb the cold-session anomaly.
    if (this.openingStage === "warming_up") return;
    this.turnProducedAudio = true;
    for (const frame of this.outputAudio.write(pcm)) {
      this.device.send(frame);
    }
  }

  /** Emits the partial trailing frame before the ordered turn-complete status. */
  private flushOutputAudio(): Promise<void> {
    const tail = this.outputAudio.flush();
    if (tail && this.device) this.device.send(tail);
    return Promise.resolve();
  }

  private async finishGeminiTurn(connection: Connection): Promise<void> {
    const answer = normalizeTranscript(this.inputTranscript);
    const examinerSpeech = normalizeTranscript(this.outputTranscript);
    const producedAudio = this.turnProducedAudio;
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.turnProducedAudio = false;

    if (examinerSpeech) {
      this.sendJSON(connection, { type: "transcript_start", role: "assistant" });
      this.sendJSON(connection, {
        type: "transcript_end",
        role: "assistant",
        text: examinerSpeech,
      });
    }
    if (!answer) {
      // The first generation of a cold Live session behaves differently from
      // every later one: it returns the whole transcript at once and streams
      // its audio after turnComplete. Spend that anomaly on a throwaway
      // warm-up turn so the case presentation is never the first generation.
      if (this.openingStage === "warming_up") {
        this.openingStage = "presenting_case";
        this.askGemini(connection, geminiOpeningTurn());
        return;
      }
      if (
        this.openingHandshakeInProgress &&
        !producedAudio &&
        this.openingAudioRetryCount < MAX_OPENING_AUDIO_RETRIES
      ) {
        this.openingAudioRetryCount += 1;
        this.askGemini(
          connection,
          this.openingStage === "presenting_case" && examinerSpeech
            ? geminiReplayForAudioTurn(examinerSpeech)
            : geminiReadinessTurn(),
        );
        return;
      }
      this.openingAudioRetryCount = 0;
      const generatedQuestion = openingPresentationForDisplay(examinerSpeech);
      if (
        this.state.phase === "interviewing" &&
        this.answerCount === 0 &&
        this.openingStage === "presenting_case" &&
        generatedQuestion
      ) {
        this.updateInterview(connection, { currentQuestion: generatedQuestion });
      }
      if (this.openingStage === "presenting_case") {
        this.openingStage = "asking_readiness";
        this.askGemini(connection, geminiReadinessTurn());
        return;
      }
      if (this.openingStage === "asking_readiness") {
        this.openingStage = "awaiting_confirmation";
        this.updateInterview(connection, {
          currentQuestion: openingPresentationForDisplay(
            `${this.state.currentQuestion} ${examinerSpeech}`,
          ),
        });
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

    if (this.openingStage === "awaiting_confirmation") {
      const readinessConfirmed =
        this.turnDisposition === "begin_first_question" ||
        /^(?:yes|yeah|yep|ready|i am ready|let'?s (?:begin|start)|go ahead)\b/i.test(answer);
      if (readinessConfirmed) this.openingStage = "complete";
      this.updateInterview(connection, {
        currentQuestion: readinessConfirmed
          ? questionForDisplay(examinerSpeech) || "The first clinical question is being prepared."
          : this.state.currentQuestion,
      });
      this.sendStatus(connection, "listening");
      return;
    }

    if (this.turnDisposition !== "advance_skillset") {
      if (!this.pendingQuestion) this.pendingQuestion = this.state.currentQuestion;
      if (this.turnDisposition === "probe_current_answer") {
        this.pendingAnswer = normalizeTranscript(`${this.pendingAnswer} ${answer}`);
      }
      this.updateInterview(connection, {
        currentQuestion: questionForDisplay(examinerSpeech) || this.state.currentQuestion,
      });
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
    if (exchanges.length >= INTERVIEW_QUESTION_COUNT) {
      this.updateInterview(connection, { phase: "evaluating", exchanges });
      this.sendStatus(connection, "evaluating");
      await this.finishInterview(connection);
      return;
    }

    this.updateInterview(connection, {
      phase: "interviewing",
      currentQuestion:
        questionForDisplay(examinerSpeech) || "The next clinical question is being prepared.",
      exchanges,
    });
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
      await this.retry(() => storeInterviewReport(this.env.INTERVIEW_REPORTS, report), {
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 2_000,
      });
      this.sendJSON(connection, {
        type: "interview_report",
        reportId,
        outcome: evaluation.outcome,
        reviewPath: `/interviewer/reports/${reportId}.md`,
      });
      this.updateInterview(connection, { phase: "complete", reportId, evaluation });
      this.sendStatus(connection, "complete");
      this.closeLiveSession("interview complete");
    } catch (error) {
      this.updateInterview(connection, { phase: "evaluation_failed", reportId });
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
      questionNumber: this.state.phase === "idle" ? 0 : this.questionNumber,
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
