import { Agent, type Connection } from "agents";
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai/web";

import {
  PEDIATRIC_TOPICS,
  type PediatricTopicId,
} from "./interview-content";
import {
  buildInterviewTopic,
  DEFAULT_INTERVIEW_DIFFICULTY,
  DEFAULT_INTERVIEW_QUESTION_COUNT,
  normalizeDifficulty,
  normalizeQuestionCount,
  resolveInterviewConfiguration,
  type InterviewDifficulty,
} from "./interview-config";
import { openingPresentationForDisplay, questionForDisplay } from "./interview-display";
import { parseInterviewerDeviceMessage, type DeviceStatus } from "./interviewer-protocol";
import {
  EVALUATION_MODEL,
  MAX_FOLLOW_UPS_PER_EXCHANGE,
  type InterviewEvaluation,
  type InterviewExchange,
  type InterviewFollowUp,
} from "./interview-report";
import {
  cloneInterviewExchanges,
  finalizeInterviewReport,
  type InterviewFinalizationSnapshot,
  type InterviewRetry,
} from "./interview-finalization";
import { isResponseComplete, shouldEndTurn } from "./turn-completion";
import {
  appendBoundedTranscript,
  isBoundedProviderAudio,
  isValidPcm16Input,
  liveReconnectDelayMs,
  MAX_INPUT_PCM_BYTES,
  PcmInputRateGuard,
} from "./live-session-lifecycle";
import {
  GEMINI_TTS_MODEL,
  synthesizeOpeningSpeech,
  type OpeningSpeech,
} from "./opening-speech";
import {
  CLOUDFLARE_TTS_MODEL,
  synthesizeCloudflareSpeech,
} from "./cloudflare-speech";
import {
  generateOpeningCase,
  GEMINI_OPENING_CASE_MODEL,
} from "./opening-case";
import {
  GEMINI_LIVE_MODEL,
  geminiFirstQuestionTurn,
  geminiLiveConfig,
  geminiReconnectTurn,
  geminiWarmUpTurn,
  turnDispositionToolOutput,
  TURN_DISPOSITION_TOOL,
  type TurnDisposition,
} from "./gemini-live-protocol";
import { decodeBase64, encodeBase64, PcmFramer, resamplePcm16 } from "./pcm-audio";
import { workerLog, type WorkerLogLevel } from "./log";

export { PEDIATRIC_TOPICS };

export const DEVICE_SAMPLE_RATE = 24_000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
// The device accepts arbitrary even-length PCM payloads and drains them in
// 20 ms I2S chunks. Sending one WebSocket message per 20 ms caused hundreds of
// TLS/WebSocket callbacks for a single prompt and destabilized the ESP32. Batch
// five chunks per message while preserving Gemini's native 24 kHz mono stream.
export const OUTPUT_PCM_FRAME_BYTES = 4_800;
const MAX_OPENING_AUDIO_RETRIES = 1;
const MAX_LIVE_RECONNECT_ATTEMPTS = 3;
const LIVE_RECONNECT_DELAY_MS = 1_000;
const CLIENT_RECONNECT_GRACE_MS = 20_000;
export const PROVIDER_RESPONSE_TIMEOUT_MS = 45_000;
export const GEMINI_CONNECT_TIMEOUT_MS = 15_000;
export const CANDIDATE_TURN_TIMEOUT_MS = 90_000;
const MAX_REPLAYABLE_CANDIDATE_AUDIO_BYTES = 4_320_000;
const PCM16_BYTES_PER_SECOND = DEVICE_SAMPLE_RATE * 2;

/**
 * The opening sequence is runtime-owned: absorb the Live cold-start turn,
 * play the prevalidated case, then ask the first clinical question. There is
 * no model-owned readiness gate between the case and scored interview.
 */
export type OpeningStage =
  | "warming_up"
  | "presenting_case"
  | "asking_first_question"
  | "complete";

type OpeningPlaybackResult = "played" | "failed" | "stale" | "unavailable";

type ClientContentTurn = { turns: string; turnComplete: true };

type PendingProviderTurn =
  | {
      id: number;
      kind: "client_content";
      turn: ClientContentTurn;
    }
  | {
      id: number;
      kind: "candidate_text";
      text: string;
    }
  | {
      id: number;
      kind: "candidate_audio";
      chunks: ArrayBuffer[];
      bytes: number;
      committed: boolean;
      replayable: boolean;
    };

type DeferredTransportFailure = {
  connection?: Connection;
  generation: number;
  reason: string;
};

const OPENING_SEQUENCE_STAGES: ReadonlySet<OpeningStage> = new Set([
  "warming_up",
  "presenting_case",
  "asking_first_question",
]);
const OPENING_STAGES: ReadonlySet<OpeningStage> = new Set([
  ...OPENING_SEQUENCE_STAGES,
  "complete",
]);

type ReconnectRequest = {
  connection?: Connection;
  reason: string;
  interviewGeneration: string;
  epoch: number;
};

type ReconnectTask = ReconnectRequest & {
  promise: Promise<void>;
};

type InterviewerEnv = Env & {
  AI: Ai;
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
 * Durable interview state. Completed progress is derived from `exchanges`;
 * `pendingExchange` retains an answered exchange while Gemini is still asking
 * probes so interruption recovery cannot lose candidate work.
 */
export type PediatricInterviewerState = {
  phase: InterviewPhase;
  /** Stable identity for one interview, used to scope Live metadata. */
  interviewGeneration: string;
  topicId: PediatricTopicId;
  topicIds: PediatricTopicId[];
  questionCount: number;
  difficulty: InterviewDifficulty;
  /** Safe, durable opening checkpoint used to recover after DO hibernation. */
  openingStage?: OpeningStage;
  /** The already-presented case is public interview content, not hidden rubric data. */
  casePresentation?: string;
  currentQuestion: string;
  /** Partial scored exchange retained across a Durable Object restart. */
  pendingExchange?: {
    question: string;
    answer: string;
    followUps: InterviewFollowUp[];
    activeQuestion: string;
  };
  exchanges: InterviewExchange[];
  reportId: string;
  cheatsheetAvailable?: boolean;
  evaluation?: InterviewEvaluation;
};

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 4_000);
}

export class PediatricInterviewer extends Agent<InterviewerEnv, PediatricInterviewerState> {
  initialState: PediatricInterviewerState = {
    phase: "idle",
    interviewGeneration: "",
    topicId: "behavior_guidance",
    topicIds: ["behavior_guidance"],
    questionCount: DEFAULT_INTERVIEW_QUESTION_COUNT,
    difficulty: DEFAULT_INTERVIEW_DIFFICULTY,
    openingStage: "complete",
    casePresentation: "",
    currentQuestion: "",
    exchanges: [],
    reportId: "",
    cheatsheetAvailable: false,
  };

  private gemini?: Session;
  private connecting = false;
  private device?: Connection;
  private disconnectedDeviceId?: string;
  private clientGraceTimer?: ReturnType<typeof setTimeout>;
  private releaseKeepAlive?: () => void;
  private reconnectTask?: ReconnectTask;
  /** The reconnect task currently inside an async provider connect attempt. */
  private reconnectConnectingTask?: ReconnectTask;
  private pendingReconnect?: ReconnectRequest;
  private reconnectEpoch = 0;
  private reconnectAttempts = 0;
  private finalizationPromise?: Promise<void>;
  private resumptionHandleUsable = true;
  private inputTranscript = "";
  private outputTranscript = "";
  private readonly outputAudio = new PcmFramer(OUTPUT_PCM_FRAME_BYTES);
  private readonly inputAudioRate = new PcmInputRateGuard();
  private lastPcmRateLimitLogAt = 0;
  private turnProducedAudio = false;
  private turnAudioDeliveryFailed = false;
  /** The last status sent to the device; also gates candidate input and
   * de-duplicates the `speaking` transition. */
  private lastStatus: DeviceStatus = "idle";
  private closingGemini = false;
  private interruptedGeneration = false;
  private candidateActivityStarted = false;
  private responseCompletionHandled = false;
  private providerTurnSequence = 0;
  private providerResponseTimer?: ReturnType<typeof setTimeout>;
  private candidateTurnTimer?: ReturnType<typeof setTimeout>;
  private pendingProviderTurn?: PendingProviderTurn;
  private turnFinalizationGeneration?: number;
  private deferredTransportFailure?: DeferredTransportFailure;
  private liveGeneration = 0;
  private turnDisposition: TurnDisposition = "advance_skillset";
  private awaitingToolContinuation = false;
  private openingStage: OpeningStage = "complete";
  private openingAudioRetryCount = 0;
  private openingCaseText = "";
  private openingCaseSpeechText = "";
  private openingCaseSpeech?: OpeningSpeech;
  private openingCaseSpeechPromise?: Promise<OpeningSpeech>;
  private lastOpeningTranscript = "";
  private pendingQuestion = "";
  private pendingAnswer = "";
  private pendingFollowUps: InterviewFollowUp[] = [];
  /**
   * The question the candidate is answering right now: the primary question of
   * the exchange, or the latest probe. Tracked separately from
   * `state.currentQuestion` because a case-information reply overwrites the
   * display without changing what is actually being answered.
   */
  private activeQuestion = "";

  /**
   * The Agent SDK's protocol state messages remain enabled for the web client,
   * but this interviewer never accepts state writes from a WebSocket peer.
   * Runtime progress must be authored by this class so the answer-count
   * invariant cannot be bypassed with a `cf_agent_state` frame.
   *
   * Do not mark the whole connection readonly: Agents SDK also applies that
   * flag to server-authored `setState()` calls running inside the connection's
   * message context, which would prevent `start_call` from entering the
   * interviewing phase.
   */
  validateStateChange(
    _nextState: PediatricInterviewerState,
    source: Connection | "server",
  ): void {
    if (source !== "server") throw new Error("Client state updates are not allowed.");
  }

  private durableOpeningStage(): OpeningStage {
    const persistedStage = this.state.openingStage as string | undefined;
    if (persistedStage && OPENING_STAGES.has(persistedStage as OpeningStage)) {
      return persistedStage as OpeningStage;
    }
    if (this.hasSavedCandidateWork) return "complete";
    // Migrate sessions persisted by the removed readiness handshake. They have
    // a durable case but no scored work, so the only safe next action is to ask
    // the first clinical question.
    if (
      persistedStage === "asking_readiness" ||
      persistedStage === "awaiting_confirmation" ||
      /are you ready to begin\??\s*$/iu.test(this.state.currentQuestion)
    ) {
      return "asking_first_question";
    }
    if (/generating a new oral-board vignette/iu.test(this.state.currentQuestion)) {
      return "warming_up";
    }
    if (this.state.currentQuestion.trim()) return "presenting_case";
    return "complete";
  }

  /**
   * Agents SDK calls this on every Durable Object wake. Provider sockets and
   * in-flight PCM are process-local, so a persisted interview deliberately
   * discards its old provider handle and resumes from the durable opening/
   * question checkpoint instead of guessing at a lost turn.
   */
  async onStart(): Promise<void> {
    if (this.state.phase !== "interviewing") return;
    const openingStage = this.durableOpeningStage();
    const casePresentation = normalizeTranscript(this.state.casePresentation ?? "");
    this.clearPendingProviderTurn();
    this.resetLiveBuffers();
    this.openingStage = openingStage;
    this.openingCaseText = casePresentation;
    this.lastOpeningTranscript = "";
    const pending = this.state.pendingExchange;
    this.pendingQuestion = normalizeTranscript(pending?.question ?? "");
    this.pendingAnswer = normalizeTranscript(pending?.answer ?? "");
    this.pendingFollowUps = (pending?.followUps ?? [])
      .slice(0, MAX_FOLLOW_UPS_PER_EXCHANGE)
      .map((followUp) => ({
        question: normalizeTranscript(followUp.question),
        answer: normalizeTranscript(followUp.answer),
      }));
    this.activeQuestion =
      normalizeTranscript(pending?.activeQuestion ?? "") || this.state.currentQuestion;
    this.lastStatus = "thinking";
    this.resumptionHandleUsable = true;
    this.clearResumptionHandle(this.currentInterviewGeneration());
    if (
      this.state.openingStage !== openingStage ||
      (this.state.casePresentation ?? "") !== casePresentation
    ) {
      this.setState({
        ...this.state,
        openingStage,
        casePresentation,
      });
    }
  }

  /** Answers recorded so far; the configured target owns normal completion. */
  private get answerCount(): number {
    return this.state.exchanges.length;
  }

  /**
   * Converts durable probe-in-progress state into a reportable exchange. The
   * answer is the authority for saved work; question fallbacks only protect a
   * migrated/corrupt legacy row from making that answer unrecoverable.
   */
  private get pendingSavedExchange(): InterviewExchange | undefined {
    const pending = this.state.pendingExchange;
    const answer = normalizeTranscript(pending?.answer ?? "");
    if (!pending || !answer) return undefined;
    const question =
      normalizeTranscript(pending.question ?? "") ||
      normalizeTranscript(this.state.currentQuestion) ||
      "Interrupted oral-board question";
    const followUps = (pending.followUps ?? [])
      .slice(0, MAX_FOLLOW_UPS_PER_EXCHANGE)
      .map((followUp) => ({
        question: normalizeTranscript(followUp.question) || "Follow-up question",
        answer: normalizeTranscript(followUp.answer),
      }))
      .filter((followUp) => followUp.answer.length > 0);
    return {
      question,
      answer,
      ...(followUps.length > 0 ? { followUps } : {}),
    };
  }

  private get hasSavedCandidateWork(): boolean {
    return this.answerCount > 0 || Boolean(this.pendingSavedExchange);
  }

  private durableTurnProgressFingerprint(): string {
    return JSON.stringify({
      phase: this.state.phase,
      openingStage: this.state.openingStage,
      currentQuestion: this.state.currentQuestion,
      exchanges: this.state.exchanges,
      pendingExchange: this.state.pendingExchange,
    });
  }

  private get plannedQuestionCount(): number {
    return normalizeQuestionCount(
      this.state.questionCount,
      this.state.topicIds?.length || 1,
    );
  }

  private get selectedTopicIds(): PediatricTopicId[] {
    return (
      resolveInterviewConfiguration({
        topicIds: this.state.topicIds,
        legacyTopicId: this.state.topicId,
        questionCount: this.state.questionCount,
        difficulty: this.state.difficulty,
      })?.topicIds ?? [this.state.topicId]
    );
  }

  private get interviewDifficulty(): InterviewDifficulty {
    return normalizeDifficulty(this.state.difficulty);
  }

  /** One-based number of the question currently on screen. */
  private get questionNumber(): number {
    return Math.min(this.answerCount + 1, this.plannedQuestionCount);
  }

  private get openingSequenceInProgress(): boolean {
    return OPENING_SEQUENCE_STAGES.has(this.openingStage);
  }

  /** Adds the durable progress needed to understand any lifecycle record. */
  private log(
    level: WorkerLogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    workerLog(level, event, {
      interviewGeneration: this.currentInterviewGeneration(),
      phase: this.state.phase,
      openingStage: this.openingStage,
      answerCount: this.answerCount,
      questionNumber: this.questionNumber,
      questionCount: this.plannedQuestionCount,
      ...fields,
    });
  }

  private currentInterviewGeneration(): string | undefined {
    const generation = this.state.interviewGeneration?.trim();
    return generation || undefined;
  }

  /**
   * Older Durable Object state predates `interviewGeneration`. Assigning one
   * here makes those sessions safe to reconnect, but deliberately cannot reuse
   * an unscoped legacy Live handle.
   */
  private ensureInterviewGeneration(): string | undefined {
    const current = this.currentInterviewGeneration();
    if (current || this.state.phase !== "interviewing") return current;
    const generated = crypto.randomUUID();
    this.setState({ ...this.state, interviewGeneration: generated });
    return generated;
  }

  private ensureLiveMetadataStore(): void {
    this.sql`CREATE TABLE IF NOT EXISTS pediatric_interviewer_live_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      interview_generation TEXT NOT NULL DEFAULT '',
      resumption_handle TEXT,
      updated_at INTEGER NOT NULL
    )`;
    const columns = this.sql<{ name: string }>`
      PRAGMA table_info(pediatric_interviewer_live_metadata)
    `;
    if (!columns.some((column) => column.name === "interview_generation")) {
      this.sql`
        ALTER TABLE pediatric_interviewer_live_metadata
        ADD COLUMN interview_generation TEXT NOT NULL DEFAULT ''
      `;
    }
  }

  /** The resumption handle is private DO metadata, never part of public state. */
  private readResumptionHandle(interviewGeneration: string | undefined): string | undefined {
    if (!interviewGeneration || !this.resumptionHandleUsable) return undefined;
    try {
      this.ensureLiveMetadataStore();
      const rows = this.sql<{ resumption_handle: string | null }>`
        SELECT resumption_handle
        FROM pediatric_interviewer_live_metadata
        WHERE id = 1 AND interview_generation = ${interviewGeneration}
      `;
      return rows[0]?.resumption_handle || undefined;
    } catch (error) {
      this.resumptionHandleUsable = false;
      this.log("error", "live_metadata_read_failed", {
        error: String(error).slice(0, 160),
      });
      return undefined;
    }
  }

  private writeResumptionHandle(interviewGeneration: string | undefined, handle: string): boolean {
    if (!interviewGeneration || !this.resumptionHandleUsable) return false;
    try {
      this.ensureLiveMetadataStore();
      this.sql`
        INSERT OR REPLACE INTO pediatric_interviewer_live_metadata
          (id, interview_generation, resumption_handle, updated_at)
        VALUES (1, ${interviewGeneration}, ${handle}, ${Date.now()})
      `;
      return true;
    } catch (error) {
      this.resumptionHandleUsable = false;
      this.log("error", "live_metadata_write_failed", {
        error: String(error).slice(0, 160),
      });
      return false;
    }
  }

  private clearResumptionHandle(interviewGeneration?: string): boolean {
    try {
      this.ensureLiveMetadataStore();
      if (interviewGeneration) {
        this.sql`
          DELETE FROM pediatric_interviewer_live_metadata
          WHERE id = 1 AND interview_generation = ${interviewGeneration}
        `;
      } else {
        this.sql`DELETE FROM pediatric_interviewer_live_metadata WHERE id = 1`;
      }
      return true;
    } catch (error) {
      this.resumptionHandleUsable = false;
      this.log("error", "live_metadata_clear_failed", {
        error: String(error).slice(0, 160),
      });
      return false;
    }
  }

  private detachedConnection(id: string): Connection {
    return { id, send: () => undefined } as unknown as Connection;
  }

  private statusForState(): DeviceStatus {
    if (this.state.phase === "complete") return "complete";
    if (this.state.phase === "evaluating") return "evaluating";
    if (this.state.phase === "evaluation_failed") return "error";
    if (this.state.phase === "interviewing") {
      return this.gemini && this.lastStatus !== "idle" ? this.lastStatus : "thinking";
    }
    return "idle";
  }

  private claimConnection(connection: Connection): void {
    if (this.clientGraceTimer) clearTimeout(this.clientGraceTimer);
    this.clientGraceTimer = undefined;
    this.disconnectedDeviceId = undefined;
    this.device = connection;
  }

  private runProtected(operation: () => Promise<void>, event: string): void {
    void this.keepAliveWhile(operation).catch((error) => {
      this.log("error", event, { error: String(error).slice(0, 240) });
    });
  }

  private clearProviderResponseTimer(): void {
    if (this.providerResponseTimer) clearTimeout(this.providerResponseTimer);
    this.providerResponseTimer = undefined;
  }

  private clearCandidateTurnTimer(): void {
    if (this.candidateTurnTimer) clearTimeout(this.candidateTurnTimer);
    this.candidateTurnTimer = undefined;
  }

  private clearPendingProviderTurn(): void {
    this.clearProviderResponseTimer();
    this.clearCandidateTurnTimer();
    this.pendingProviderTurn = undefined;
  }

  private nextProviderTurnId(): number {
    this.providerTurnSequence += 1;
    return this.providerTurnSequence;
  }

  private beginClientContentTurn(turn: ClientContentTurn): PendingProviderTurn {
    this.clearPendingProviderTurn();
    const pending: PendingProviderTurn = {
      id: this.nextProviderTurnId(),
      kind: "client_content",
      turn,
    };
    this.pendingProviderTurn = pending;
    return pending;
  }

  private beginCandidateAudioTurn(): Extract<PendingProviderTurn, { kind: "candidate_audio" }> {
    this.clearPendingProviderTurn();
    const pending: Extract<PendingProviderTurn, { kind: "candidate_audio" }> = {
      id: this.nextProviderTurnId(),
      kind: "candidate_audio",
      chunks: [],
      bytes: 0,
      committed: false,
      replayable: true,
    };
    this.pendingProviderTurn = pending;
    return pending;
  }

  private armCandidateTurnDeadline(
    pending: Extract<PendingProviderTurn, { kind: "candidate_audio" }>,
    connection: Connection,
    generation = this.liveGeneration,
  ): void {
    this.clearCandidateTurnTimer();
    this.candidateTurnTimer = setTimeout(() => {
      this.candidateTurnTimer = undefined;
      if (
        this.pendingProviderTurn?.id !== pending.id ||
        generation !== this.liveGeneration ||
        this.device?.id !== connection.id ||
        !this.candidateActivityStarted ||
        this.state.phase !== "interviewing"
      ) {
        return;
      }
      if (!this.safeGeminiSend(this.gemini, "candidate_turn_timeout", (session) => {
        session.sendRealtimeInput({ activityEnd: {} });
      })) return;
      this.candidateActivityStarted = false;
      pending.committed = true;
      this.sendJSON(connection, {
        type: "turn_recovery",
        action: "auto_committed",
        message: "The 90-second answer limit was reached, so your answer was submitted.",
      });
      this.sendStatus(connection, "thinking");
      this.armProviderResponseDeadline(pending, generation);
    }, CANDIDATE_TURN_TIMEOUT_MS);
  }

  private beginCandidateTextTurn(text: string): PendingProviderTurn {
    this.clearPendingProviderTurn();
    const pending: PendingProviderTurn = {
      id: this.nextProviderTurnId(),
      kind: "candidate_text",
      text,
    };
    this.pendingProviderTurn = pending;
    return pending;
  }

  private armProviderResponseDeadline(
    pending: PendingProviderTurn,
    generation = this.liveGeneration,
  ): void {
    this.clearProviderResponseTimer();
    this.providerResponseTimer = setTimeout(() => {
      this.providerResponseTimer = undefined;
      if (
        this.pendingProviderTurn?.id !== pending.id ||
        generation !== this.liveGeneration ||
        this.state.phase !== "interviewing"
      ) {
        return;
      }
      const target = this.device;
      this.log("error", "gemini_response_timeout", {
        turnKind: pending.kind,
        timeoutMs: PROVIDER_RESPONSE_TIMEOUT_MS,
      });
      this.sendJSON(target, { type: "playback_interrupt" });
      this.sendJSON(target, {
        type: "turn_recovery",
        action: "retrying",
        message: "The examiner paused unexpectedly. Reconnecting and retrying this turn…",
      });
      this.handleGeminiTransportFailure(target, generation, "response_timeout");
    }, PROVIDER_RESPONSE_TIMEOUT_MS);
  }

  /** Treat the response deadline as an inactivity timeout while Gemini is making progress. */
  private refreshProviderResponseDeadline(generation: number): void {
    const pending = this.pendingProviderTurn;
    if (
      !pending ||
      generation !== this.liveGeneration ||
      this.state.phase !== "interviewing" ||
      (pending.kind === "candidate_audio" && !pending.committed)
    ) {
      return;
    }
    this.armProviderResponseDeadline(pending, generation);
  }

  /**
   * Keeps an unfinished turn only when it can be replayed exactly. A resumable
   * provider handle is deliberately discarded in that case: resuming and
   * replaying against the same provider history could score one answer twice.
   */
  private preparePendingTurnForReconnect(connection: Connection | undefined): void {
    this.clearProviderResponseTimer();
    const pending = this.pendingProviderTurn;
    if (!pending) return;
    // Every in-flight turn invalidates the provider handle before reconnect.
    // In particular, an uncommitted/over-limit audio turn is discarded below;
    // resuming its handle would retain a partial input that the client is told
    // to repeat, allowing the provider to score both copies.
    this.clearResumptionHandle(this.currentInterviewGeneration());
    const incompleteAudio =
      pending.kind === "candidate_audio" && (!pending.committed || !pending.replayable);
    if (incompleteAudio) {
      this.pendingProviderTurn = undefined;
      this.sendJSON(this.device ?? connection, {
        type: "turn_recovery",
        action: "repeat_required",
        message: pending.replayable
          ? "The connection changed before your answer finished. Please repeat it."
          : "That answer was too long to retry safely. Please give it again more briefly.",
      });
      return;
    }
  }

  private replayPendingProviderTurn(
    session: Session,
    connection: Connection | undefined,
    generation: number,
    pending: PendingProviderTurn,
  ): boolean {
    if (
      this.pendingProviderTurn?.id !== pending.id ||
      generation !== this.liveGeneration ||
      session !== this.gemini ||
      this.state.phase !== "interviewing"
    ) {
      return false;
    }
    this.responseCompletionHandled = false;
    if (connection) this.sendStatus(connection, "thinking");

    let sent = false;
    if (pending.kind === "client_content") {
      sent = this.safeGeminiSend(session, "replay_realtime_text", (live) => {
        live.sendRealtimeInput({ text: pending.turn.turns });
      });
    } else if (pending.kind === "candidate_text") {
      this.inputTranscript = pending.text;
      sent = this.safeGeminiSend(session, "replay_candidate_text", (live) => {
        live.sendRealtimeInput({ text: pending.text });
      });
    } else if (pending.committed && pending.replayable && pending.chunks.length > 0) {
      sent = this.safeGeminiSend(session, "replay_activity_start", (live) => {
        live.sendRealtimeInput({ activityStart: {} });
      });
      for (const chunk of pending.chunks) {
        if (!sent) break;
        sent = this.safeGeminiSend(session, "replay_audio", (live) => {
          live.sendRealtimeInput({
            audio: {
              data: encodeBase64(chunk),
              mimeType: `audio/pcm;rate=${DEVICE_SAMPLE_RATE}`,
            },
          });
        });
      }
      if (sent) {
        sent = this.safeGeminiSend(session, "replay_activity_end", (live) => {
          live.sendRealtimeInput({ activityEnd: {} });
        });
      }
    }
    if (!sent) return false;
    this.armProviderResponseDeadline(pending, generation);
    this.log("info", "gemini_turn_replayed", {
      turnKind: pending.kind,
      audioBytes: pending.kind === "candidate_audio" ? pending.bytes : undefined,
    });
    return true;
  }

  /** Cancels queued/backoff reconnect work without waiting for its timer. */
  private cancelReconnectTask(): void {
    // A task may be awaiting `openGeminiSession` while its public task token is
    // cancelled by a new interview or finalization. Release only the flag
    // owned by that task; an unrelated initial-start attempt must remain
    // protected from a stale retry's cleanup.
    if (this.reconnectConnectingTask) {
      this.connecting = false;
      this.reconnectConnectingTask = undefined;
    }
    ++this.reconnectEpoch;
    this.pendingReconnect = undefined;
    this.reconnectTask = undefined;
  }

  private isReconnectRequestValid(task: ReconnectRequest): boolean {
    return (
      task.epoch === this.reconnectEpoch &&
      this.state.phase === "interviewing" &&
      this.currentInterviewGeneration() === task.interviewGeneration
    );
  }

  private isReconnectTaskCurrent(task: ReconnectRequest): boolean {
    return this.reconnectTask === task && this.isReconnectRequestValid(task);
  }

  private markDeviceDisconnected(connection: Connection): void {
    if (this.device?.id !== connection.id) return;
    this.device = undefined;
    this.disconnectedDeviceId = connection.id;
    if (this.clientGraceTimer) clearTimeout(this.clientGraceTimer);
    this.clientGraceTimer = setTimeout(() => {
      this.clientGraceTimer = undefined;
      if (this.device || this.disconnectedDeviceId !== connection.id) return;
      this.disconnectedDeviceId = undefined;
      this.closeGeminiSession("device reconnect grace expired");
      if (this.state.phase === "interviewing" && this.hasSavedCandidateWork) {
        this.runProtected(
          () => this.salvageInterview(this.detachedConnection("disconnected-report"), "device disconnected"),
          "disconnected_salvage_failed",
        );
      } else if (this.state.phase === "interviewing") {
        this.setState({
          ...this.state,
          phase: "idle",
          openingStage: "complete",
          casePresentation: "",
          currentQuestion: "",
        });
      }
    }, CLIENT_RECONNECT_GRACE_MS);
  }

  private safeDeviceSend(connection: Connection | undefined, payload: string | ArrayBuffer | Uint8Array): boolean {
    if (!connection) return false;
    try {
      connection.send(payload);
      return true;
    } catch (error) {
      this.log("error", "device_send_failed", {
        connectionId: connection.id,
        error: String(error).slice(0, 160),
      });
      this.markDeviceDisconnected(connection);
      return false;
    }
  }

  private safeGeminiSend(
    session: Session | undefined,
    operation: string,
    send: (session: Session) => void,
  ): boolean {
    if (!session || session !== this.gemini || this.closingGemini) return false;
    try {
      send(session);
      return true;
    } catch (error) {
      this.log("error", "gemini_send_failed", {
        operation,
        error: String(error).slice(0, 200),
      });
      this.handleGeminiTransportFailure(this.device, this.liveGeneration, operation);
      return false;
    }
  }

  private handleGeminiTransportFailure(
    connection: Connection | undefined,
    generation: number,
    reason: string,
  ): void {
    if (generation !== this.liveGeneration || this.closingGemini) return;
    // Terminal content is persisted asynchronously after the provider callback
    // returns. Let that callback finish against the current generation before
    // invalidating its buffers; otherwise a GoAway/onclose immediately after
    // turnComplete can erase an answer that was already fully received.
    if (this.turnFinalizationGeneration === generation) {
      this.deferredTransportFailure = { connection, generation, reason };
      return;
    }
    this.preparePendingTurnForReconnect(connection);
    this.invalidateGeminiForReconnect(reason);
    if (this.state.phase === "interviewing") {
      // Store the request even while startup/reconnect owns `connecting`; the
      // operation's finally block drains it after the guard is released.
      this.scheduleGeminiReconnect(connection ?? this.device, reason);
    }
  }

  private startPendingReconnect(): void {
    const request = this.pendingReconnect;
    if (
      !request ||
      this.reconnectTask ||
      this.connecting ||
      this.gemini ||
      !this.isReconnectRequestValid(request)
    ) {
      return;
    }
    this.pendingReconnect = undefined;
    const task: ReconnectTask = {
      ...request,
      promise: Promise.resolve(),
    };
    this.reconnectTask = task;
    const promise = this.keepAliveWhile(() => this.reconnectGemini(task))
      .catch((error) => {
        if (!this.isReconnectTaskCurrent(task)) return;
        this.log("error", "gemini_reconnect_exhausted", {
          reason: task.reason.slice(0, 100),
          error: String(error).slice(0, 220),
        });
        this.finalizeAfterLiveFailure(task.connection, "Gemini Live reconnect failed");
      })
      .finally(() => {
        if (this.reconnectTask !== task) return;
        this.reconnectTask = undefined;
        if (this.pendingReconnect) queueMicrotask(() => this.startPendingReconnect());
      });
    task.promise = promise;
  }

  private resyncConnection(connection: Connection): void {
    if (this.state.phase === "interviewing" && this.gemini) {
      this.sendJSON(connection, {
        type: "audio_config",
        format: "pcm16",
        sampleRate: DEVICE_SAMPLE_RATE,
      });
    }
    this.sendInterviewState(connection);
    this.sendStatus(connection, this.statusForState());
    if (this.state.phase === "complete") this.notifyCompletedReport(connection);
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/recover-report") {
      return new Response("Not found", { status: 404 });
    }
    if (
      !this.hasSavedCandidateWork ||
      !["interviewing", "evaluating", "evaluation_failed"].includes(this.state.phase)
    ) {
      return Response.json({ error: "no_interrupted_interview" }, { status: 409 });
    }
    if (
      this.finalizationPromise ||
      this.gemini ||
      this.connecting ||
      this.reconnectTask ||
      this.device
    ) {
      return Response.json({ error: "interview_still_active" }, { status: 409 });
    }
    const connection = this.detachedConnection("recovery");
    this.updateInterview(connection, { phase: "evaluating" });
    await this.keepAliveWhile(() => this.finishInterview(connection));
    return Response.json({ ok: this.state.phase === "complete", reportId: this.state.reportId });
  }

  onConnect(connection: Connection): void {
    this.sendJSON(connection, { type: "welcome", protocol_version: 1 });
    // A newly established socket supersedes the old one. The old socket may
    // close after this callback; its close event must not tear down this live
    // session or steal the completion notification from the new client.
    this.claimConnection(connection);
    if (
      this.state.phase === "interviewing" &&
      this.openingStage === "presenting_case" &&
      this.openingCaseText
    ) {
      this.prewarmOpeningCaseSpeech(this.openingCaseText);
    }
    this.resyncConnection(connection);
    if (this.state.phase === "interviewing" && !this.gemini) {
      this.scheduleGeminiReconnect(connection, "client reconnected");
    }
  }

  async onMessage(connection: Connection, message: unknown): Promise<void> {
    if (message instanceof ArrayBuffer) {
      this.forwardAudio(connection, message);
      return;
    }
    if (typeof message !== "string") return;
    const parsed = parseInterviewerDeviceMessage(message);
    if (!parsed) return;
    if (parsed.type === "start_call") {
      await this.startLiveSession(connection, parsed);
    } else if (parsed.type === "recover_report") {
      await this.recoverReport(connection);
    } else if (parsed.type === "end_call") {
      if (this.device?.id !== connection.id) return;
      // Stopping the device is also a valid end-of-session boundary. Preserve
      // any answers already persisted in the Durable Object and file an early
      // report instead of silently discarding them with the Live connection.
      if (this.state.phase === "interviewing" && this.hasSavedCandidateWork) {
        this.updateInterview(connection, { phase: "evaluating" });
        this.closeGeminiSession("device ended call");
        await this.keepAliveWhile(() => this.finishInterview(connection));
        return;
      }
      if (this.state.phase === "evaluating" || this.state.phase === "evaluation_failed") {
        await this.keepAliveWhile(() => this.finishInterview(connection));
        return;
      }
      if (this.state.phase === "complete") {
        this.notifyCompletedReport(connection);
        return;
      }
      this.closeGeminiSession("device ended call");
      this.updateInterview(connection, {
        phase: "idle",
        openingStage: "complete",
        casePresentation: "",
        currentQuestion: "",
      });
      this.sendStatus(connection, "idle");
    } else if (parsed.type === "commit_turn") {
      this.commitAudioTurn(connection);
    } else if (parsed.type === "candidate_text") {
      this.forwardCandidateText(connection, parsed.text);
    }
  }

  onClose(connection: Connection): void {
    if (this.device?.id !== connection.id) return;
    // Keep the provider alive for a short reconnect window. Browser reloads
    // and ESP32 Wi-Fi handoffs otherwise look identical to an intentional end.
    this.markDeviceDisconnected(connection);
  }

  private sendJSON(connection: Connection | undefined, message: Record<string, unknown>): boolean {
    return this.safeDeviceSend(connection, JSON.stringify(message));
  }

  private sendStatus(connection: Connection, status: DeviceStatus): void {
    if (this.sendJSON(connection, { type: "status", status })) this.lastStatus = status;
  }

  /** Persists a state change and mirrors it to the device's prompt view. */
  private updateInterview(
    connection: Connection,
    patch: Partial<PediatricInterviewerState>,
  ): void {
    if (patch.openingStage) this.openingStage = patch.openingStage;
    if (patch.casePresentation !== undefined) {
      this.openingCaseText = normalizeTranscript(patch.casePresentation);
    }
    this.setState({ ...this.state, ...patch });
    this.sendInterviewState(connection);
  }

  /**
   * Drives the next scripted turn of the opening sequence. Re-arms the
   * completion guard so Gemini's reply to this prompt is treated as a new turn.
   */
  private askGemini(connection: Connection, turn: { turns: string; turnComplete: true }): void {
    this.responseCompletionHandled = false;
    const pending = this.beginClientContentTurn(turn);
    this.sendStatus(connection, "thinking");
    const sent = this.safeGeminiSend(this.gemini, "realtime_text", (session) => {
      session.sendRealtimeInput({ text: turn.turns });
    });
    if (sent) this.armProviderResponseDeadline(pending);
  }

  /** Plays the exact durable case without asking Live to rewrite its boundary. */
  private async presentPersistedOpeningCase(
    connection: Connection,
    generation: number,
  ): Promise<void> {
    if (!this.openingCaseText) {
      this.failOpening(
        connection,
        generation,
        "missing opening case",
        "The saved case was unavailable. Please restart the interview.",
      );
      return;
    }
    const playback = await this.playOpeningSpeechFallback(
      "case",
      this.openingCaseText,
      generation,
    );
    if (playback === "stale") return;
    if (playback === "unavailable") {
      this.deferOpeningPlaybackUntilReconnect("case playback client disconnected");
      return;
    }
    if (playback === "failed") {
      this.failOpeningAudio(connection, generation, "case");
      return;
    }
    if (!this.openingPlaybackIsCurrent(generation, "case")) return;
    const target = this.device ?? connection;
    this.sendAssistantTranscript(target, this.openingCaseText);
    this.updateInterview(target, {
      openingStage: "asking_first_question",
      casePresentation: this.openingCaseText,
      currentQuestion: openingPresentationForDisplay(this.openingCaseText),
    });
    this.askGemini(target, geminiFirstQuestionTurn());
  }

  /** Replays the exact durable checkpoint when a provider handle is unavailable. */
  private resumeFreshGeminiSession(connection: Connection): void {
    if (this.openingStage === "warming_up") {
      this.askGemini(connection, geminiWarmUpTurn());
      return;
    }
    if (this.openingStage === "presenting_case") {
      this.runProtected(
        () => this.presentPersistedOpeningCase(connection, this.liveGeneration),
        "case_playback_failed",
      );
      return;
    }
    if (this.openingStage === "asking_first_question") {
      this.askGemini(connection, geminiFirstQuestionTurn());
      return;
    }
    this.askGemini(
      connection,
      geminiReconnectTurn(
        this.authoritativeRecoveryQuestion(),
        this.answerCount,
        this.plannedQuestionCount,
      ),
    );
  }

  /** Returns the unanswered prompt, not a transient case-information display. */
  private authoritativeRecoveryQuestion(): string {
    return (
      normalizeTranscript(this.activeQuestion) ||
      normalizeTranscript(this.state.pendingExchange?.activeQuestion ?? "") ||
      normalizeTranscript(this.state.currentQuestion)
    );
  }

  private async openGeminiSession(
    connection: Connection | undefined,
    topic: ReturnType<typeof buildInterviewTopic>,
    configuration: {
      questionCount: number;
      difficulty: InterviewDifficulty;
      topicIds: PediatricTopicId[];
    },
    generation: number,
    sessionResumptionHandle?: string,
    recoveryContext?: {
      casePresentation: string;
      currentQuestion: string;
      persistedAnswerCount: number;
      plannedQuestionCount: number;
    },
  ): Promise<Session> {
    const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });
    const connectPromise = ai.live.connect({
      model: GEMINI_LIVE_MODEL,
      config: geminiLiveConfig(topic, {
        questionCount: configuration.questionCount,
        difficulty: configuration.difficulty,
        sessionResumptionHandle,
        recoveryContext,
      }),
      callbacks: {
        onmessage: (message) =>
          this.handleGeminiMessageSafely(message, generation, connection),
        onerror: (event) => {
          this.runGeminiCallbackSafely("error", generation, connection, () => {
            this.log("error", "gemini_live_error", {
              error: String(event.error ?? event.message).slice(0, 200),
            });
            this.handleGeminiTransportFailure(connection, generation, "sdk_error");
          });
        },
        onclose: (event) => {
          this.runGeminiCallbackSafely("close", generation, connection, () => {
            this.log("warn", "gemini_live_close", {
              code: event.code,
              reason: event.reason,
              clean: event.wasClean,
            });
            if (this.closingGemini) return;
            this.handleGeminiTransportFailure(
              connection ?? this.device,
              generation,
              `close_${event.code}`,
            );
          });
        },
      },
    });
    let timedOut = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      connectTimer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Gemini Live setup exceeded ${GEMINI_CONNECT_TIMEOUT_MS} ms.`));
      }, GEMINI_CONNECT_TIMEOUT_MS);
    });
    let session: Session;
    try {
      session = await Promise.race([connectPromise, timeout]);
    } catch (error) {
      if (timedOut) {
        void connectPromise.then(
          (lateSession) => {
            try {
              lateSession.close();
            } catch {
              // A late setup can close itself before the timeout cleanup runs.
            }
          },
          () => undefined,
        );
      }
      throw error;
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }
    if (generation !== this.liveGeneration || this.closingGemini) {
      try {
        session.close();
      } catch {
        // A stale session may already have closed while connect was resolving.
      }
      throw new Error("stale Gemini Live connection");
    }
    this.gemini = session;
    return session;
  }

  private invalidateGeminiForReconnect(reason: string): void {
    const session = this.gemini;
    this.gemini = undefined;
    ++this.liveGeneration;
    this.resetLiveBuffers();
    this.releaseKeepAlive?.();
    this.releaseKeepAlive = undefined;
    this.closingGemini = true;
    this.log("warn", "gemini_live_reconnect", { reason: reason.slice(0, 120) });
    try {
      session?.close();
    } catch {
      // Closing an already closed provider socket is harmless.
    }
    this.closingGemini = false;
  }

  private scheduleGeminiReconnect(connection: Connection | undefined, reason: string): void {
    const interviewGeneration = this.ensureInterviewGeneration();
    if (this.state.phase !== "interviewing" || this.gemini || !interviewGeneration) return;
    this.pendingReconnect = {
      connection,
      reason,
      interviewGeneration,
      epoch: this.reconnectEpoch,
    };
    this.startPendingReconnect();
  }

  private async reconnectGemini(task: ReconnectTask): Promise<void> {
    for (let attempt = 1; attempt <= MAX_LIVE_RECONNECT_ATTEMPTS; attempt += 1) {
      if (!this.isReconnectTaskCurrent(task)) return;
      this.reconnectAttempts = attempt;
      await new Promise<void>((resolve) => setTimeout(resolve, liveReconnectDelayMs(attempt, LIVE_RECONNECT_DELAY_MS)));
      if (!this.isReconnectTaskCurrent(task)) return;
      const configuration = resolveInterviewConfiguration({
        topicIds: this.state.topicIds,
        legacyTopicId: this.state.topicId,
        questionCount: this.state.questionCount,
        difficulty: this.state.difficulty,
      });
      if (!configuration) throw new Error("saved interview configuration is invalid");
      const target = this.device ?? task.connection;
      const generation = ++this.liveGeneration;
      const pendingTurn = this.pendingProviderTurn;
      const handle = pendingTurn
        ? undefined
        : this.readResumptionHandle(task.interviewGeneration);
      const recoveryContext = handle
        ? undefined
        : {
            casePresentation: this.openingCaseText.slice(0, 4_000),
            currentQuestion:
              this.openingStage === "complete"
                ? this.authoritativeRecoveryQuestion().slice(0, 4_000)
                : "",
            persistedAnswerCount: this.answerCount,
            plannedQuestionCount: this.plannedQuestionCount,
          };
      this.connecting = true;
      this.reconnectConnectingTask = task;
      this.closingGemini = false;
      try {
        const session = await this.openGeminiSession(
          target,
          buildInterviewTopic(configuration.topicIds),
          configuration,
          generation,
          handle,
          recoveryContext,
        );
        if (
          !this.isReconnectTaskCurrent(task) ||
          generation !== this.liveGeneration ||
          this.gemini !== session
        ) return;
        // `keepAliveWhile` protects only this reconnect operation. A Live
        // WebSocket also needs a long-lived hold after reconnect succeeds or
        // the Durable Object can hibernate and stop receiving SDK callbacks.
        const releaseKeepAlive = await this.keepAlive();
        if (
          !this.isReconnectTaskCurrent(task) ||
          generation !== this.liveGeneration ||
          this.gemini !== session
        ) {
          releaseKeepAlive();
          return;
        }
        this.releaseKeepAlive?.();
        this.releaseKeepAlive = releaseKeepAlive;
        if (pendingTurn) {
          if (!this.replayPendingProviderTurn(session, target, generation, pendingTurn)) {
            throw new Error("failed to replay pending provider turn");
          }
        } else if (!handle && target) {
          this.resumeFreshGeminiSession(target);
        }
        this.reconnectAttempts = 0;
        if (target) this.resyncConnection(target);
        this.pendingReconnect = undefined;
        this.log("info", "gemini_reconnected", {
          reason: task.reason.slice(0, 100),
          resumed: Boolean(handle),
        });
        return;
      } catch (error) {
        if (!this.isReconnectTaskCurrent(task)) return;
        this.invalidateGeminiForReconnect(`reconnect attempt ${attempt} failed`);
        // Resumption handles are opaque and can expire or be rejected. Do not
        // spend every retry presenting the same bad handle; the next attempt
        // starts a fresh Live transport and replays the persisted question.
        if (handle) this.clearResumptionHandle(task.interviewGeneration);
        if (attempt === MAX_LIVE_RECONNECT_ATTEMPTS) throw error;
      } finally {
        if (this.reconnectConnectingTask === task) {
          this.reconnectConnectingTask = undefined;
          if (this.reconnectTask === task && task.epoch === this.reconnectEpoch) {
            this.connecting = false;
          }
        }
        if (this.pendingReconnect) this.startPendingReconnect();
      }
    }
  }

  private finalizeAfterLiveFailure(connection: Connection | undefined, reason: string): void {
    this.cancelReconnectTask();
    const target = this.device ?? connection ?? this.detachedConnection("live-failure");
    this.closeGeminiSession(reason, true);
    if (this.state.phase === "interviewing" && this.hasSavedCandidateWork) {
      this.runProtected(() => this.salvageInterview(target, reason), "live_salvage_failed");
      return;
    }
    if (this.state.phase === "interviewing") {
      this.updateInterview(target, {
        phase: "idle",
        openingStage: "complete",
        casePresentation: "",
        currentQuestion: "",
      });
      this.sendJSON(target, { type: "error", message: "Gemini Live closed the interview." });
      this.sendStatus(target, "idle");
    }
  }

  private async startLiveSession(
    connection: Connection,
    request: {
      topic_id?: string;
      topic_ids?: string[];
      question_count?: number;
      difficulty?: InterviewDifficulty;
    },
  ): Promise<void> {
    if (this.finalizationPromise) {
      this.sendJSON(connection, {
        type: "error",
        message: "The previous review is still being prepared. Please wait a moment.",
      });
      return;
    }
    if (this.state.phase === "interviewing") {
      this.claimConnection(connection);
      this.resyncConnection(connection);
      if (!this.gemini && !this.connecting) this.scheduleGeminiReconnect(connection, "start_call reattach");
      return;
    }
    // A new interview supersedes any old reconnect backoff. The old task may
    // still be sleeping, but its epoch check prevents it from touching this
    // interview or its Gemini session.
    this.cancelReconnectTask();
    if (this.gemini || this.connecting) return;
    const configuration = resolveInterviewConfiguration({
      topicIds: request.topic_ids,
      legacyTopicId: request.topic_id,
      questionCount: request.question_count,
      difficulty: request.difficulty,
    });
    if (!configuration) {
      this.sendJSON(connection, {
        type: "error",
        message: "Select one or more valid pediatric oral-board topics.",
      });
      return;
    }
    const topic = buildInterviewTopic(configuration.topicIds);
    if (!this.env.GEMINI_API_KEY.trim()) {
      this.sendJSON(connection, { type: "error", message: "Gemini Live is not configured." });
      return;
    }
    this.claimConnection(connection);
    const interviewGeneration = crypto.randomUUID();
    this.resumptionHandleUsable = true;
    // A failed delete cannot make the next interview reuse the old row: every
    // handle read is additionally scoped to this newly generated identity.
    this.clearResumptionHandle();
    const generation = ++this.liveGeneration;
    this.resetTurnState();
    this.inputAudioRate.reset();
    this.lastPcmRateLimitLogAt = 0;
    this.resetOutputAudio();
    this.closingGemini = false;
    this.lastStatus = "idle";
    this.openingStage = "warming_up";
    this.connecting = true;
    this.reconnectAttempts = 0;
    this.updateInterview(connection, {
      phase: "interviewing",
      interviewGeneration,
      topicId: configuration.topicIds[0],
      topicIds: configuration.topicIds,
      questionCount: configuration.questionCount,
      difficulty: configuration.difficulty,
      openingStage: "warming_up",
      casePresentation: "",
      currentQuestion: "Generating a new oral-board vignette...",
      pendingExchange: undefined,
      exchanges: [],
      reportId: "",
      cheatsheetAvailable: false,
      evaluation: undefined,
    });
    this.log("info", "interview_started", {
      topicIds: configuration.topicIds,
      difficulty: configuration.difficulty,
    });
    try {
      this.releaseKeepAlive = await this.keepAlive();
      // Generate the clinical content through a schema-constrained text model
      // before Live connects. Live then receives and speaks the exact durable
      // case instead of being asked to invent content and obey an audio turn
      // boundary simultaneously—a behavior that proved stochastic in
      // production even with retries.
      const openingCaseText = await generateOpeningCase(
        this.env.GEMINI_API_KEY,
        topic,
        configuration.difficulty,
      );
      if (
        generation !== this.liveGeneration ||
        this.state.interviewGeneration !== interviewGeneration
      ) {
        return;
      }
      // The exact case is already validated. Start its audio generation while
      // Gemini Live connects and completes its cold-session warm-up so the
      // candidate does not pay those independent network latencies serially.
      this.prewarmOpeningCaseSpeech(openingCaseText);
      this.updateInterview(connection, {
        casePresentation: openingCaseText,
        currentQuestion: openingPresentationForDisplay(openingCaseText),
      });
      this.log("info", "opening_case_ready", {
        characters: openingCaseText.length,
      });
      if (this.device?.id !== connection.id) return;
      await this.openGeminiSession(
        connection,
        topic,
        configuration,
        generation,
        undefined,
        {
          casePresentation: openingCaseText,
          currentQuestion: "",
          persistedAnswerCount: 0,
          plannedQuestionCount: configuration.questionCount,
        },
      );
      if (generation !== this.liveGeneration || this.device?.id !== connection.id) return;
      this.sendJSON(connection, {
        type: "audio_config",
        format: "pcm16",
        sampleRate: DEVICE_SAMPLE_RATE,
      });
      this.askGemini(connection, geminiWarmUpTurn());
    } catch (error) {
      if (generation !== this.liveGeneration) return;
      this.log("error", "gemini_live_start_failed", {
        error: String(error).slice(0, 240),
      });
      this.closeGeminiSession("Gemini Live startup failed", true);
      this.sendJSON(connection, {
        type: "error",
        message: "The examiner could not start. Please retry in a moment.",
      });
      this.updateInterview(connection, {
        phase: "idle",
        openingStage: "complete",
        casePresentation: "",
        currentQuestion: "",
      });
      this.sendStatus(connection, "idle");
    } finally {
      this.connecting = false;
      this.startPendingReconnect();
    }
  }

  /**
   * Clears everything scoped to the conversation rather than to the socket, so
   * that starting a session and tearing one down cannot drift apart.
   */
  private resetTurnState(): void {
    this.clearPendingProviderTurn();
    this.turnFinalizationGeneration = undefined;
    this.deferredTransportFailure = undefined;
    this.resetLiveBuffers();
    this.openingStage = "complete";
    this.openingAudioRetryCount = 0;
    this.openingCaseText = "";
    this.openingCaseSpeechText = "";
    this.openingCaseSpeech = undefined;
    this.openingCaseSpeechPromise = undefined;
    this.lastOpeningTranscript = "";
    this.pendingQuestion = "";
    this.pendingAnswer = "";
    this.pendingFollowUps = [];
    this.activeQuestion = "";
  }

  private resetLiveBuffers(): void {
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.interruptedGeneration = false;
    this.candidateActivityStarted = false;
    this.responseCompletionHandled = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    this.resetOutputAudio();
  }

  private closeGeminiSession(
    reason: string,
    preserveResumptionHandle = false,
    interviewGeneration = this.currentInterviewGeneration(),
  ): void {
    this.cancelReconnectTask();
    this.clearPendingProviderTurn();
    this.turnFinalizationGeneration = undefined;
    this.deferredTransportFailure = undefined;
    this.closingGemini = true;
    this.log("info", "gemini_live_closed", { reason: reason.slice(0, 100) });
    const session = this.gemini;
    this.gemini = undefined;
    ++this.liveGeneration;
    this.connecting = false;
    this.reconnectAttempts = MAX_LIVE_RECONNECT_ATTEMPTS;
    this.resetLiveBuffers();
    this.lastStatus = "idle";
    this.inputAudioRate.reset();
    this.lastPcmRateLimitLogAt = 0;
    this.releaseKeepAlive?.();
    this.releaseKeepAlive = undefined;
    if (!preserveResumptionHandle) this.clearResumptionHandle(interviewGeneration);
    try {
      session?.close();
    } catch {
      // Closing an already closed provider socket is harmless.
    }
    this.closingGemini = false;
  }

  private resetOutputAudio(): void {
    this.outputAudio.clear();
    this.turnProducedAudio = false;
    this.turnAudioDeliveryFailed = false;
  }

  private closeLiveSession(reason: string, ownerConnection?: Connection): void {
    this.cancelReconnectTask();
    this.closeGeminiSession(reason);
    const replacementAttached = Boolean(
      this.device && ownerConnection && this.device.id !== ownerConnection.id,
    );
    if (!replacementAttached) {
      if (this.clientGraceTimer) clearTimeout(this.clientGraceTimer);
      this.clientGraceTimer = undefined;
      this.disconnectedDeviceId = undefined;
      this.device = undefined;
    }
  }

  /**
   * Replays evaluation for an interrupted interview without opening Gemini.
   * This is intentionally a device-protocol escape hatch for recovering a
   * report after a transport or UI interruption; it never resets exchanges.
   */
  private async recoverReport(connection: Connection): Promise<void> {
    if (
      this.finalizationPromise ||
      this.connecting ||
      this.reconnectTask ||
      (this.gemini && this.state.phase === "interviewing")
    ) {
      this.sendJSON(connection, {
        type: "error",
        message: "The interview is still connected; stop it before recovering the report.",
      });
      return;
    }
    if (
      !this.hasSavedCandidateWork ||
      !["interviewing", "evaluating", "evaluation_failed"].includes(this.state.phase)
    ) {
      this.sendJSON(connection, {
        type: "error",
        message: "No interrupted interview with saved answers is available.",
      });
      return;
    }
    this.claimConnection(connection);
    this.updateInterview(connection, { phase: "evaluating" });
    this.sendStatus(connection, "evaluating");
    await this.keepAliveWhile(() => this.finishInterview(connection));
  }

  private forwardAudio(connection: Connection, audio: ArrayBuffer): void {
    if (
      this.device?.id !== connection.id ||
      this.state.phase !== "interviewing" ||
      !this.gemini ||
      this.connecting ||
      this.lastStatus !== "listening"
    ) {
      return;
    }
    if (!isValidPcm16Input(audio)) {
      this.log("warn", "invalid_pcm_frame", {
        connectionId: connection.id,
        bytes: audio.byteLength,
      });
      return;
    }
    if (!this.inputAudioRate.accept(audio.byteLength)) {
      const now = Date.now();
      if (now - this.lastPcmRateLimitLogAt >= 1_000) {
        this.lastPcmRateLimitLogAt = now;
        this.log("warn", "pcm_rate_limited", {
          connectionId: connection.id,
          bytes: audio.byteLength,
        });
      }
      return;
    }
    if (!this.candidateActivityStarted) {
      const pending = this.beginCandidateAudioTurn();
      if (!this.safeGeminiSend(this.gemini, "activity_start", (session) => {
        session.sendRealtimeInput({ activityStart: {} });
      })) return;
      this.candidateActivityStarted = true;
      this.armCandidateTurnDeadline(pending, connection);
    }
    const pending = this.pendingProviderTurn;
    if (pending?.kind === "candidate_audio" && pending.replayable) {
      if (pending.bytes + audio.byteLength <= MAX_REPLAYABLE_CANDIDATE_AUDIO_BYTES) {
        const lastIndex = pending.chunks.length - 1;
        const last = pending.chunks[lastIndex];
        if (last && last.byteLength + audio.byteLength <= MAX_INPUT_PCM_BYTES) {
          const combined = new Uint8Array(last.byteLength + audio.byteLength);
          combined.set(new Uint8Array(last), 0);
          combined.set(new Uint8Array(audio), last.byteLength);
          pending.chunks[lastIndex] = combined.buffer;
        } else {
          pending.chunks.push(audio.slice(0));
        }
        pending.bytes += audio.byteLength;
      } else {
        pending.chunks = [];
        pending.bytes += audio.byteLength;
        pending.replayable = false;
      }
    }
    this.safeGeminiSend(this.gemini, "audio", (session) => {
      session.sendRealtimeInput({
        audio: {
          data: encodeBase64(audio),
          mimeType: `audio/pcm;rate=${DEVICE_SAMPLE_RATE}`,
        },
      });
    });
  }

  private commitAudioTurn(connection: Connection): void {
    if (this.device?.id !== connection.id || !this.gemini || !this.candidateActivityStarted) {
      return;
    }
    this.responseCompletionHandled = false;
    this.turnDisposition = "advance_skillset";
    this.awaitingToolContinuation = false;
    if (!this.safeGeminiSend(this.gemini, "activity_end", (session) => {
      session.sendRealtimeInput({ activityEnd: {} });
    })) return;
    this.clearCandidateTurnTimer();
    this.candidateActivityStarted = false;
    const pending = this.pendingProviderTurn;
    if (pending?.kind === "candidate_audio") {
      pending.committed = true;
      this.armProviderResponseDeadline(pending);
    }
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
    const replacesAudioTurn = this.candidateActivityStarted;
    this.candidateActivityStarted = false;
    const pending = this.beginCandidateTextTurn(text);
    if (!this.safeGeminiSend(gemini, "candidate_text", (session) => {
      session.sendRealtimeInput({ text });
      // Realtime text received while manual audio activity is open belongs to
      // that same candidate turn. Close it after the text so Gemini produces
      // one response instead of leaving the ambient microphone turn active.
      if (replacesAudioTurn) session.sendRealtimeInput({ activityEnd: {} });
    })) {
      this.sendJSON(connection, {
        type: "candidate_text_ack",
        accepted: true,
        recovering: true,
      });
      return;
    }
    this.armProviderResponseDeadline(pending);
    this.sendJSON(connection, {
      type: "candidate_text_ack",
      accepted: true,
      turnComplete: true,
    });
    this.sendStatus(connection, "thinking");
  }

  private handleGeminiMessage(message: LiveServerMessage, generation: number): void {
    if (generation !== this.liveGeneration) return;
    const resumption = message.sessionResumptionUpdate;
    if (resumption) {
      const interviewGeneration = this.ensureInterviewGeneration();
      if (resumption.resumable && resumption.newHandle) {
        this.writeResumptionHandle(interviewGeneration, resumption.newHandle);
      } else if (resumption.resumable === false) {
        this.clearResumptionHandle(interviewGeneration);
      }
    }
    if (message.goAway) {
      this.log("warn", "gemini_live_go_away", {
        timeLeft: message.goAway.timeLeft,
      });
      this.handleGeminiTransportFailure(
        this.device,
        generation,
        `go_away_${message.goAway.timeLeft ?? "unknown"}`,
      );
      return;
    }
    // Provider messages remain authoritative during the client grace window.
    // Use a no-op connection so a completed turn can still be persisted and a
    // replacement socket can receive the durable state on reconnect.
    const connection = this.device ?? this.detachedConnection("offline-client");
    if (message.toolCall?.functionCalls?.length) {
      this.refreshProviderResponseDeadline(generation);
      const responses = message.toolCall.functionCalls.map((call) => {
        let output = "Continue with the spoken examiner response.";
        if (call.name === TURN_DISPOSITION_TOOL) {
          const disposition = call.args?.disposition;
          if (
            disposition === "advance_skillset" ||
            disposition === "probe_current_answer" ||
            disposition === "provide_case_information"
          ) {
            const probeCapReached =
              disposition === "probe_current_answer" &&
              Boolean(this.pendingQuestion) &&
              this.pendingFollowUps.length >= MAX_FOLLOW_UPS_PER_EXCHANGE - 1;
            this.turnDisposition = probeCapReached ? "advance_skillset" : disposition;
            if (probeCapReached) {
              this.log("info", "probe_limit_reached", {
                completedFollowUps: this.pendingFollowUps.length,
                answeringFinalFollowUp: true,
              });
            }
            output = turnDispositionToolOutput(
              this.turnDisposition,
              this.answerCount,
              this.plannedQuestionCount,
            );
          }
          this.awaitingToolContinuation = true;
        }
        return {
          id: call.id,
          name: call.name,
          response: { output },
        };
      });
      this.safeGeminiSend(this.gemini, "tool_response", (session) => {
        session.sendToolResponse({ functionResponses: responses });
      });
      return;
    }
    if (message.toolCallCancellation) {
      this.refreshProviderResponseDeadline(generation);
      this.awaitingToolContinuation = false;
      this.log("warn", "gemini_tool_call_cancelled", {
        ids: message.toolCallCancellation.ids,
      });
    }
    const content = message.serverContent;
    if (!content) return;
    const parts = content.modelTurn?.parts ?? [];
    if (
      content.inputTranscription?.text ||
      content.outputTranscription?.text ||
      parts.some((part) => part.text || part.inlineData?.data) ||
      content.generationComplete ||
      content.turnComplete ||
      content.interrupted
    ) {
      this.refreshProviderResponseDeadline(generation);
    }
    if (content.interrupted) {
      this.log("info", "gemini_generation_interrupted", {
        answerCharacters: this.inputTranscript.length,
      });
      this.interruptedGeneration = true;
      this.resetOutputAudio();
      this.outputTranscript = "";
      this.sendJSON(connection, { type: "playback_interrupt" });
      this.sendStatus(connection, "listening");
      return;
    }
    if (content.inputTranscription?.text) {
      this.inputTranscript = appendBoundedTranscript(
        this.inputTranscript,
        content.inputTranscription.text,
      );
      // Transcription is a partial observation, not an input-state boundary.
      // The explicit commit path owns the listening -> thinking transition.
    }
    if (content.outputTranscription?.text) {
      this.awaitingToolContinuation = false;
      this.outputTranscript = appendBoundedTranscript(
        this.outputTranscript,
        content.outputTranscription.text,
      );
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (!inline?.data) continue;
      if (!isBoundedProviderAudio(inline.data)) {
        this.log("error", "gemini_audio_chunk_rejected", {
          encodedCharacters: inline.data.length,
        });
        this.handleGeminiTransportFailure(connection, generation, "oversized_audio_chunk");
        return;
      }
      this.awaitingToolContinuation = false;
      const rate = inline.mimeType?.includes("rate=16000") ? 16_000 : GEMINI_OUTPUT_SAMPLE_RATE;
      const pcm = resamplePcm16(decodeBase64(inline.data), rate, DEVICE_SAMPLE_RATE);
      this.queueOutputAudio(pcm, connection);
      if (this.lastStatus !== "speaking") this.sendStatus(connection, "speaking");
    }
    const responseComplete = isResponseComplete(content);
    if (responseComplete && this.awaitingToolContinuation) return;
    if (responseComplete && this.interruptedGeneration) {
      this.interruptedGeneration = false;
      this.clearPendingProviderTurn();
      this.sendStatus(connection, "listening");
      return;
    }
    if (!shouldEndTurn(content, this.openingSequenceInProgress)) return;
    if (this.responseCompletionHandled) return;
    this.responseCompletionHandled = true;
    const completedProviderTurn = this.pendingProviderTurn;
    const durableProgressBeforeFinalization = this.durableTurnProgressFingerprint();
    this.clearPendingProviderTurn();
    const audioDrained = this.flushOutputAudio(connection);
    this.turnFinalizationGeneration = generation;
    this.runProtected(async () => {
      try {
        await audioDrained;
        if (generation !== this.liveGeneration) return;
        // A client socket is an output sink, not the authority for the Gemini
        // turn. During the reconnect grace period the provider can finish a
        // response while no socket is attached; persist that turn against the
        // no-op connection so the replacement client receives the updated state.
        await this.finishGeminiTurn(connection, generation);
        const activeConnection = this.device;
        if (generation === this.liveGeneration && activeConnection) {
          this.sendJSON(activeConnection, {
            type: "turn_complete",
            answerCount: this.answerCount,
            questionNumber: this.questionNumber,
          });
        }
      } catch (error) {
        this.log("error", "turn_finalization_failed", {
          error: String(error).slice(0, 240),
        });
        if (generation === this.liveGeneration) {
          if (
            completedProviderTurn &&
            this.durableTurnProgressFingerprint() === durableProgressBeforeFinalization
          ) {
            this.pendingProviderTurn = completedProviderTurn;
            this.clearResumptionHandle(this.currentInterviewGeneration());
            this.sendJSON(this.device ?? connection, {
              type: "turn_recovery",
              action: "retrying",
              message: "That turn could not be saved. Reconnecting and retrying it safely…",
            });
          }
          this.deferredTransportFailure = {
            connection,
            generation,
            reason: "turn_finalization_failed",
          };
        }
      } finally {
        if (this.turnFinalizationGeneration !== generation) return;
        this.turnFinalizationGeneration = undefined;
        const deferred = this.deferredTransportFailure;
        this.deferredTransportFailure = undefined;
        if (
          deferred &&
          deferred.generation === generation &&
          generation === this.liveGeneration
        ) {
          this.handleGeminiTransportFailure(
            deferred.connection,
            generation,
            deferred.reason,
          );
        }
      }
    }, "turn_finalization_failed");
  }

  /** Provider callbacks must never be able to tear down the client socket. */
  private handleGeminiMessageSafely(
    message: LiveServerMessage,
    generation: number,
    connection?: Connection,
  ): void {
    this.runGeminiCallbackSafely("message", generation, connection, () => {
      this.handleGeminiMessage(message, generation);
    });
  }

  private runGeminiCallbackSafely(
    operation: "message" | "error" | "close",
    generation: number,
    connection: Connection | undefined,
    callback: () => void,
  ): void {
    if (generation !== this.liveGeneration) return;
    try {
      callback();
    } catch (error) {
      if (generation !== this.liveGeneration) return;
      this.log("error", `gemini_${operation}_callback_failed`, {
        error: String(error).slice(0, 240),
      });
      try {
        this.handleGeminiTransportFailure(
          this.device ?? connection,
          generation,
          `${operation}_callback_failed`,
        );
      } catch (recoveryError) {
        this.log("error", "gemini_callback_recovery_failed", {
          operation,
          error: String(recoveryError).slice(0, 240),
        });
      }
    }
  }

  /**
   * Plays exact opening text through Gemini TTS when the Live model returns a
   * transcript-only turn. Frames are paced at their PCM duration so the ESP32
   * jitter queue and browser playback queue see the same realtime envelope as
   * native Live audio.
   */
  private openingPlaybackIsCurrent(
    generation: number,
    stage: "case" | "first_question",
  ): boolean {
    const expectedStage = stage === "case" ? "presenting_case" : "asking_first_question";
    return (
      generation === this.liveGeneration &&
      this.state.phase === "interviewing" &&
      this.openingStage === expectedStage
    );
  }

  private async playOpeningSpeechFallback(
    stage: "case" | "first_question",
    text: string,
    generation: number,
  ): Promise<OpeningPlaybackResult> {
    if (!this.openingPlaybackIsCurrent(generation, stage)) return "stale";
    try {
      const speech =
        stage === "case"
          ? await this.openingCaseSpeechForPlayback(text)
          : await this.synthesizeReliableOpeningSpeech(text);
      if (!this.openingPlaybackIsCurrent(generation, stage)) return "stale";
      const pcm = resamplePcm16(speech.pcm, speech.sampleRate, DEVICE_SAMPLE_RATE);
      const target = this.device;
      if (!target) return "unavailable";

      this.sendStatus(target, "speaking");
      const framer = new PcmFramer(OUTPUT_PCM_FRAME_BYTES);
      let sentBytes = 0;
      const sendFrame = async (
        frame: Uint8Array,
      ): Promise<Exclude<OpeningPlaybackResult, "played"> | null> => {
        if (!this.openingPlaybackIsCurrent(generation, stage)) return "stale";
        if (this.device?.id !== target.id || !this.safeDeviceSend(target, frame)) {
          return "unavailable";
        }
        sentBytes += frame.byteLength;
        const playbackMs = Math.max(
          1,
          Math.round((frame.byteLength / PCM16_BYTES_PER_SECOND) * 1_000),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, playbackMs));
        return null;
      };

      for (const frame of framer.write(pcm)) {
        const issue = await sendFrame(frame);
        if (issue) return issue;
      }
      const tail = framer.flush();
      if (tail) {
        const issue = await sendFrame(tail);
        if (issue) return issue;
      }
      if (!this.openingPlaybackIsCurrent(generation, stage)) return "stale";
      if (this.device?.id !== target.id) return "unavailable";
      if (sentBytes === 0) return "failed";

      this.sendJSON(target, {
        type: "opening_audio_fallback",
        stage,
        bytes: sentBytes,
      });
      this.log("info", "opening_audio_fallback_played", {
        stage,
        bytes: sentBytes,
      });
      return "played";
    } catch (error) {
      if (!this.openingPlaybackIsCurrent(generation, stage)) return "stale";
      this.log("error", "opening_audio_fallback_failed", {
        stage,
        error: String(error).slice(0, 200),
      });
      return "failed";
    }
  }

  /**
   * Keep exact opening speech available when either provider is rate-limited.
   * Cloudflare's native binding is primary because it returns the device's raw
   * PCM format directly; Gemini's separately validated TTS path is fallback.
   */
  private async synthesizeReliableOpeningSpeech(text: string): Promise<OpeningSpeech> {
    if (this.env.AI) {
      try {
        return await synthesizeCloudflareSpeech(this.env.AI, text);
      } catch (error) {
        this.log("warn", "cloudflare_opening_tts_failed", {
          error: String(error).slice(0, 180),
        });
      }
    }
    return synthesizeOpeningSpeech(this.env.GEMINI_API_KEY, text);
  }

  private async openingCaseSpeechForPlayback(text: string): Promise<OpeningSpeech> {
    const normalized = normalizeTranscript(text);
    if (!normalized) throw new Error("Opening case speech input is empty.");
    if (this.openingCaseSpeechText !== normalized) {
      this.openingCaseSpeechText = normalized;
      this.openingCaseSpeech = undefined;
      this.openingCaseSpeechPromise = undefined;
    }
    if (this.openingCaseSpeech) return this.openingCaseSpeech;
    const pending =
      this.openingCaseSpeechPromise ?? this.synthesizeReliableOpeningSpeech(normalized);
    this.openingCaseSpeechPromise = pending;
    try {
      const speech = await pending;
      if (this.openingCaseSpeechText === normalized) this.openingCaseSpeech = speech;
      return speech;
    } finally {
      if (this.openingCaseSpeechPromise === pending) {
        this.openingCaseSpeechPromise = undefined;
      }
    }
  }

  private prewarmOpeningCaseSpeech(text: string): void {
    const normalized = normalizeTranscript(text);
    if (!normalized) return;
    if (this.openingCaseSpeechText === normalized && this.openingCaseSpeech) return;
    this.runProtected(
      () => this.openingCaseSpeechForPlayback(normalized).then(() => undefined),
      "opening_case_prewarm_failed",
    );
  }

  private sendAssistantTranscript(connection: Connection, text: string): void {
    const normalized = normalizeTranscript(text);
    if (
      !normalized ||
      (this.openingSequenceInProgress && normalized === this.lastOpeningTranscript)
    ) {
      return;
    }
    this.sendJSON(connection, { type: "transcript_start", role: "assistant" });
    this.sendJSON(connection, {
      type: "transcript_end",
      role: "assistant",
      text: normalized,
    });
    if (this.openingSequenceInProgress) this.lastOpeningTranscript = normalized;
  }

  private deferOpeningPlaybackUntilReconnect(reason: string): void {
    const replacement = this.device;
    this.openingAudioRetryCount = 0;
    this.closeGeminiSession(reason);
    if (replacement) this.scheduleGeminiReconnect(replacement, reason);
  }

  private failOpeningAudio(
    connection: Connection,
    generation: number,
    stage: "case" | "first_question",
  ): void {
    if (!this.openingPlaybackIsCurrent(generation, stage)) return;
    this.failOpening(
      connection,
      generation,
      "opening audio unavailable",
      `The ${stage.replace("_", " ")} audio could not play. Please retry the interview.`,
    );
  }

  private failOpening(
    connection: Connection,
    generation: number,
    reason: string,
    message: string,
  ): void {
    if (generation !== this.liveGeneration || this.state.phase !== "interviewing") return;
    const target = this.device ?? connection;
    this.closeGeminiSession(reason);
    this.openingStage = "complete";
    this.openingAudioRetryCount = 0;
    this.openingCaseText = "";
    this.lastOpeningTranscript = "";
    this.sendJSON(target, {
      type: "error",
      message,
    });
    this.updateInterview(target, {
      phase: "idle",
      openingStage: "complete",
      casePresentation: "",
      currentQuestion: "",
    });
    this.sendStatus(target, "idle");
  }

  /** Frames Gemini audio; the ESP32 applies flow control at its jitter queue. */
  private queueOutputAudio(pcm: Uint8Array, connection: Connection): void {
    // The warm-up turn exists only to absorb the cold-session anomaly.
    if (this.openingStage === "warming_up") return;
    if (this.device?.id !== connection.id) {
      // There is no playback sink while the browser/device is reconnecting;
      // discard queued bytes but retain transcript/turn ordering state.
      this.turnAudioDeliveryFailed = true;
      this.outputAudio.clear();
      return;
    }
    this.turnProducedAudio = true;
    for (const frame of this.outputAudio.write(pcm)) {
      if (!this.safeDeviceSend(connection, frame)) {
        this.turnAudioDeliveryFailed = true;
        return;
      }
    }
  }

  /** Emits the partial trailing frame before the ordered turn-complete status. */
  private flushOutputAudio(connection: Connection): Promise<void> {
    const tail = this.outputAudio.flush();
    if (tail && !this.safeDeviceSend(connection, tail)) this.turnAudioDeliveryFailed = true;
    return Promise.resolve();
  }

  private async finishGeminiTurn(
    connection: Connection,
    generation: number,
  ): Promise<void> {
    if (generation !== this.liveGeneration) return;
    const startedStage = this.openingStage;
    const answerCountBefore = this.answerCount;
    const answer = normalizeTranscript(this.inputTranscript);
    const examinerSpeech = normalizeTranscript(this.outputTranscript);
    const producedAudio = this.turnProducedAudio && !this.turnAudioDeliveryFailed;
    const audioDeliveryFailed = this.turnAudioDeliveryFailed;
    this.inputTranscript = "";
    this.outputTranscript = "";
    this.turnProducedAudio = false;
    this.turnAudioDeliveryFailed = false;
    this.log("info", "gemini_turn_received", {
      startedStage,
      answerCountBefore,
      answerCharacters: answer.length,
      examinerCharacters: examinerSpeech.length,
      disposition: this.turnDisposition,
      producedAudio,
      audioDeliveryFailed,
    });

    // Normal examiner turns can remain text-visible if provider audio is
    // unavailable. Opening audio has a stricter fallback below so the first
    // clinical question is never silently presented.
    if (startedStage === "complete" && examinerSpeech) {
      this.sendAssistantTranscript(connection, examinerSpeech);
    }

    if (!answer) {
      if (startedStage === "warming_up" && !this.device) {
        this.deferOpeningPlaybackUntilReconnect("opening playback client disconnected");
        return;
      }
      // The first generation of a cold Live session behaves differently from
      // every later one: it returns the whole transcript at once and streams
      // its audio after turnComplete. Spend that anomaly on a throwaway
      // warm-up turn so the case presentation is never the first generation.
      if (startedStage === "warming_up") {
        this.updateInterview(connection, { openingStage: "presenting_case" });
        await this.presentPersistedOpeningCase(connection, generation);
        return;
      }
      if (startedStage === "asking_first_question") {
        const firstQuestion = questionForDisplay(examinerSpeech);
        if (!firstQuestion.includes("?")) {
          const target = this.device ?? connection;
          this.sendJSON(target, { type: "playback_interrupt" });
          if (this.openingAudioRetryCount < MAX_OPENING_AUDIO_RETRIES) {
            this.openingAudioRetryCount += 1;
            this.log("warn", "first_question_retry", {
              examinerCharacters: examinerSpeech.length,
            });
            this.askGemini(target, geminiFirstQuestionTurn());
            return;
          }
          this.failOpening(
            target,
            generation,
            "invalid first clinical question",
            "The examiner could not prepare the first question. Please retry the interview.",
          );
          return;
        }
        if (!this.device || audioDeliveryFailed) {
          this.deferOpeningPlaybackUntilReconnect("first question playback disconnected");
          return;
        }
        if (!producedAudio) {
          const playback = await this.playOpeningSpeechFallback(
            "first_question",
            examinerSpeech,
            generation,
          );
          if (playback === "stale") return;
          if (playback === "unavailable") {
            this.deferOpeningPlaybackUntilReconnect("first question playback disconnected");
            return;
          }
          if (playback === "failed") {
            this.failOpeningAudio(connection, generation, "first_question");
            return;
          }
          if (!this.openingPlaybackIsCurrent(generation, "first_question")) return;
        }
        const target = this.device ?? connection;
        this.openingAudioRetryCount = 0;
        this.lastOpeningTranscript = "";
        this.sendAssistantTranscript(target, examinerSpeech);
        this.activeQuestion = firstQuestion;
        this.updateInterview(target, {
          openingStage: "complete",
          casePresentation: this.openingCaseText,
          currentQuestion: firstQuestion,
        });
        this.log("info", "first_question_ready", {
          questionCharacters: firstQuestion.length,
          usedTtsFallback: !producedAudio,
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

    // The model does not reliably honor its own probe limit, so enforce it
    // here: past the cap the next answer closes the exchange whatever the
    // model classified, which keeps the interview reaching its configured target.
    const probeLimitReached =
      this.turnDisposition === "probe_current_answer" &&
      Boolean(this.pendingQuestion) &&
      this.pendingFollowUps.length + 1 >= MAX_FOLLOW_UPS_PER_EXCHANGE;
    if (probeLimitReached) {
      this.log("info", "probe_limit_reached", {
        followUps: this.pendingFollowUps.length,
      });
      this.turnDisposition = "advance_skillset";
    }

    if (this.turnDisposition !== "advance_skillset") {
      if (this.turnDisposition === "probe_current_answer") {
        // The answer just given replies to whatever was last asked; the probe
        // in `examinerSpeech` is what the *next* answer will reply to.
        this.recordAnswerToActiveQuestion(answer);
        const probe = questionForDisplay(examinerSpeech) || this.state.currentQuestion;
        this.activeQuestion = probe;
        this.persistPendingExchange();
        this.updateInterview(connection, { currentQuestion: probe });
      } else {
        // A case-information reply does not ask anything new, so the candidate
        // is still answering the same question.
        this.updateInterview(connection, {
          currentQuestion: questionForDisplay(examinerSpeech) || this.state.currentQuestion,
        });
      }
      this.sendStatus(connection, "listening");
      return;
    }

    this.recordAnswerToActiveQuestion(answer);
    const exchangeQuestion = this.pendingQuestion || this.state.currentQuestion;
    const followUps = this.pendingFollowUps;
    const exchangeAnswer = this.pendingAnswer;
    this.pendingQuestion = "";
    this.pendingAnswer = "";
    this.pendingFollowUps = [];
    const exchanges = [
      ...this.state.exchanges,
      {
        question: exchangeQuestion,
        answer: exchangeAnswer,
        ...(followUps.length > 0 ? { followUps } : {}),
      },
    ];
    this.log("info", "exchange_recorded", {
      persistedAnswerCount: exchanges.length,
      followUpCount: followUps.length,
      finalExchange: exchanges.length >= this.plannedQuestionCount,
    });
    if (exchanges.length >= this.plannedQuestionCount) {
      this.updateInterview(connection, {
        phase: "evaluating",
        pendingExchange: undefined,
        exchanges,
      });
      this.sendStatus(connection, "evaluating");
      await this.finishInterview(connection);
      return;
    }

    const nextQuestion =
      questionForDisplay(examinerSpeech) || "The next clinical question is being prepared.";
    this.activeQuestion = nextQuestion;
    this.updateInterview(connection, {
      phase: "interviewing",
      currentQuestion: nextQuestion,
      pendingExchange: undefined,
      exchanges,
    });
    this.sendStatus(connection, "listening");
  }

  /**
   * Files the candidate's answer against the question it actually replies to.
   * The first answer of an exchange is the primary one; every later answer is a
   * follow-up, so the report can tell volunteered content from prompted content.
   */
  private recordAnswerToActiveQuestion(answer: string): void {
    const question = this.activeQuestion || this.state.currentQuestion;
    if (!this.pendingQuestion) {
      this.pendingQuestion = question;
      this.pendingAnswer = answer;
      this.persistPendingExchange();
      return;
    }
    if (this.pendingFollowUps.length >= MAX_FOLLOW_UPS_PER_EXCHANGE) {
      // Past the cap, keep the content but stop growing the array.
      const last = this.pendingFollowUps[this.pendingFollowUps.length - 1];
      last.answer = normalizeTranscript(`${last.answer} ${answer}`);
      this.persistPendingExchange();
      return;
    }
    this.pendingFollowUps.push({ question, answer });
    this.persistPendingExchange();
  }

  private persistPendingExchange(): void {
    if (!this.pendingQuestion) {
      if (this.state.pendingExchange) {
        this.setState({ ...this.state, pendingExchange: undefined });
      }
      return;
    }
    this.setState({
      ...this.state,
      pendingExchange: {
        question: normalizeTranscript(this.pendingQuestion),
        answer: normalizeTranscript(this.pendingAnswer),
        followUps: this.pendingFollowUps
          .slice(0, MAX_FOLLOW_UPS_PER_EXCHANGE)
          .map((followUp) => ({
            question: normalizeTranscript(followUp.question),
            answer: normalizeTranscript(followUp.answer),
          })),
        activeQuestion: normalizeTranscript(this.activeQuestion),
      },
    });
  }

  /**
   * Grades whatever the candidate answered when the interview stops for a
   * reason outside their control: Gemini dropping the Live session, or the
   * session time limit. Losing an unfinished exam entirely is the worst
   * outcome available, so anything with at least one answer still reaches the
   * review screen.
   */
  private async salvageInterview(connection: Connection, reason: string): Promise<void> {
    this.log("warn", "interview_salvaged", {
      reason: reason.slice(0, 60),
      savedAnswerCount: this.answerCount + (this.pendingSavedExchange ? 1 : 0),
    });
    this.updateInterview(connection, { phase: "evaluating" });
    this.sendStatus(connection, "evaluating");
    await this.finishInterview(connection);
  }

  private async finishInterview(connection: Connection): Promise<void> {
    if (this.state.phase === "complete" && this.state.evaluation && this.state.reportId) {
      this.notifyCompletedReport(connection);
      return;
    }
    if (this.finalizationPromise) {
      await this.finalizationPromise;
      if (this.state.phase === "complete") this.notifyCompletedReport(connection);
      return;
    }
    const reportId = this.state.reportId || crypto.randomUUID();
    if (!this.state.reportId) this.setState({ ...this.state, reportId });
    const interviewGeneration =
      this.ensureInterviewGeneration() ?? crypto.randomUUID();
    if (this.currentInterviewGeneration() !== interviewGeneration) {
      this.setState({ ...this.state, interviewGeneration });
    }
    const snapshot = this.buildFinalizationSnapshot(reportId, interviewGeneration);
    this.log("info", "interview_finalization_started", {
      reportId,
      savedAnswerCount: snapshot.exchanges.length,
    });
    const finalization = this.finalizeInterview(connection, snapshot);
    this.finalizationPromise = finalization;
    try {
      await finalization;
    } finally {
      if (this.finalizationPromise === finalization) this.finalizationPromise = undefined;
    }
  }

  private buildFinalizationSnapshot(
    reportId: string,
    interviewGeneration: string,
  ): InterviewFinalizationSnapshot {
    const topicIds = this.selectedTopicIds;
    const exchanges = cloneInterviewExchanges(this.state.exchanges);
    const pending = this.pendingSavedExchange;
    if (
      pending &&
      exchanges.length < this.plannedQuestionCount &&
      !exchanges.some((exchange) => this.sameExchange(exchange, pending))
    ) {
      exchanges.push(pending);
    }
    return {
      apiKey: this.env.GEMINI_API_KEY,
      reportId,
      sessionId: this.name,
      interviewGeneration,
      topicIds,
      topic: buildInterviewTopic(topicIds),
      questionCount: this.plannedQuestionCount,
      difficulty: this.interviewDifficulty,
      exchanges,
      // The presented case is public interview content, so the saved review
      // can quote the exact vignette the answers were graded against.
      casePresentation:
        normalizeTranscript(this.openingCaseText || this.state.casePresentation || "") ||
        undefined,
    };
  }

  private notifyCompletedReport(connection: Connection): void {
    const evaluation = this.state.evaluation;
    const reportId = this.state.reportId;
    if (!evaluation || !reportId) return;
    this.sendJSON(connection, {
      type: "interview_report",
      reportId,
      outcome: evaluation.outcome,
      reviewPath: `/interviewer/reports/${reportId}.md`,
      ...(this.state.cheatsheetAvailable
        ? { cheatsheetPath: `/interviewer/reports/${reportId}-cheatsheet.md` }
        : {}),
    });
    this.sendStatus(connection, "complete");
  }

  private async finalizeInterview(
    connection: Connection,
    snapshot: InterviewFinalizationSnapshot,
  ): Promise<void> {
    try {
      const retry: InterviewRetry = (operation, options) => this.retry(operation, options);
      const { evaluation, cheatsheet } = await finalizeInterviewReport(
        snapshot,
        this.env.INTERVIEW_REPORTS,
        retry,
      );
      if (this.currentInterviewGeneration() !== snapshot.interviewGeneration) return;
      const reportConnection = this.device ?? connection;
      this.updateInterview(reportConnection, {
        phase: "complete",
        reportId: snapshot.reportId,
        pendingExchange: undefined,
        exchanges: cloneInterviewExchanges(snapshot.exchanges),
        evaluation,
        cheatsheetAvailable: Boolean(cheatsheet),
      });
      this.log("info", "interview_completed", {
        reportId: snapshot.reportId,
        outcome: evaluation.outcome,
        savedAnswerCount: snapshot.exchanges.length,
        cheatsheetAvailable: Boolean(cheatsheet),
      });
      this.notifyCompletedReport(reportConnection);
      this.closeLiveSession("interview complete", connection);
    } catch (error) {
      if (this.currentInterviewGeneration() !== snapshot.interviewGeneration) return;
      // A failed provider/R2 call must leave the DO in a recoverable state and
      // release the Live heartbeat/socket before the client tries recovery.
      this.log("error", "interview_finalization_failed", {
        reportId: snapshot.reportId,
        error: String(error).slice(0, 240),
      });
      this.closeGeminiSession(
        "interview finalization failed",
        true,
        snapshot.interviewGeneration,
      );
      const reportConnection = this.device ?? connection;
      this.updateInterview(reportConnection, {
        phase: "evaluation_failed",
        reportId: snapshot.reportId,
      });
      this.sendJSON(reportConnection, {
        type: "error",
        message: "The review could not be saved yet. Retry report recovery in a moment.",
      });
    }
  }

  private sameExchange(left: InterviewExchange, right: InterviewExchange): boolean {
    if (
      normalizeTranscript(left.question) !== normalizeTranscript(right.question) ||
      normalizeTranscript(left.answer) !== normalizeTranscript(right.answer)
    ) {
      return false;
    }
    const leftFollowUps = left.followUps ?? [];
    const rightFollowUps = right.followUps ?? [];
    return (
      leftFollowUps.length === rightFollowUps.length &&
      leftFollowUps.every(
        (followUp, index) =>
          normalizeTranscript(followUp.question) ===
            normalizeTranscript(rightFollowUps[index]?.question ?? "") &&
          normalizeTranscript(followUp.answer) ===
            normalizeTranscript(rightFollowUps[index]?.answer ?? ""),
      )
    );
  }

  private sendInterviewState(connection: Connection): void {
    const topic = buildInterviewTopic(this.selectedTopicIds);
    this.sendJSON(connection, {
      type: "interview_state",
      phase: this.state.phase,
      questionNumber: this.state.phase === "idle" ? 0 : this.questionNumber,
      answerCount: this.answerCount,
      totalQuestions: this.plannedQuestionCount,
      difficulty: this.interviewDifficulty,
      domain: topic.label,
      question: this.state.currentQuestion,
      ...(this.state.reportId ? { reportId: this.state.reportId } : {}),
    });
  }
}

export const pediatricInterviewerModels = {
  openingCase: GEMINI_OPENING_CASE_MODEL,
  conversation: GEMINI_LIVE_MODEL,
  transcription: GEMINI_LIVE_MODEL,
  speech: GEMINI_LIVE_MODEL,
  cloudflareOpeningSpeech: CLOUDFLARE_TTS_MODEL,
  openingSpeechFallback: GEMINI_TTS_MODEL,
  evaluation: EVALUATION_MODEL,
} as const;
