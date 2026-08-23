import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const genaiMocks = vi.hoisted(() => ({ liveConnect: vi.fn() }));
const openingSpeechMocks = vi.hoisted(() => ({ synthesize: vi.fn() }));

vi.mock("agents", () => {
  class TestAgent {
    state: unknown;
    env = {
      GEMINI_API_KEY: "test-gemini-key",
      INTERVIEW_REPORTS: {},
    };
    name = "test-interview";
    sql = vi.fn(() => []);

    setState(next: unknown): void {
      this.state = next;
    }

    async keepAlive(): Promise<() => void> {
      return () => undefined;
    }

    async keepAliveWhile<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    }

    async retry<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
      return operation(1);
    }
  }

  return { Agent: TestAgent };
});

vi.mock("@google/genai/web", () => ({
  GoogleGenAI: class {
    live = { connect: genaiMocks.liveConnect };
  },
  Modality: { AUDIO: "AUDIO" },
  ThinkingLevel: { MINIMAL: "MINIMAL" },
}));

vi.mock("../src/opening-speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/opening-speech")>();
  return {
    ...actual,
    synthesizeOpeningSpeech: openingSpeechMocks.synthesize,
  };
});

import { type Connection } from "agents";
import {
  CANDIDATE_TURN_TIMEOUT_MS,
  GEMINI_CONNECT_TIMEOUT_MS,
  PediatricInterviewer,
  PROVIDER_RESPONSE_TIMEOUT_MS,
  type PediatricInterviewerState,
} from "../src/interviewer";
import { buildInterviewTopic } from "../src/interview-config";

type PendingProviderTurn =
  | { id: number; kind: "client_content"; turn: { turns: string; turnComplete: true } }
  | { id: number; kind: "candidate_text"; text: string }
  | {
      id: number;
      kind: "candidate_audio";
      chunks: ArrayBuffer[];
      bytes: number;
      committed: boolean;
      replayable: boolean;
    };

type Runtime = {
  state: PediatricInterviewerState;
  initialState: PediatricInterviewerState;
  device?: Connection;
  gemini?: unknown;
  finalizationPromise?: Promise<void>;
  liveGeneration: number;
  pendingProviderTurn?: PendingProviderTurn;
  turnFinalizationGeneration?: number;
  deferredTransportFailure?: {
    connection?: Connection;
    generation: number;
    reason: string;
  };
  connecting: boolean;
  lastStatus: "idle" | "thinking" | "listening" | "speaking" | "evaluating" | "complete" | "error";
  openingStage:
    | "warming_up"
    | "presenting_case"
    | "asking_first_question"
    | "complete";
  openingCaseText: string;
  pendingQuestion: string;
  pendingAnswer: string;
  pendingFollowUps: Array<{ question: string; answer: string }>;
  activeQuestion: string;
  inputTranscript: string;
  outputTranscript: string;
  turnProducedAudio: boolean;
  turnAudioDeliveryFailed: boolean;
  resumptionHandleUsable: boolean;
  sql: ReturnType<typeof vi.fn>;
  armProviderResponseDeadline: (
    pending: PendingProviderTurn,
    generation?: number,
  ) => void;
  clearPendingProviderTurn: () => void;
  handleGeminiTransportFailure: (
    connection: Connection | undefined,
    generation: number,
    reason: string,
  ) => void;
  handleGeminiMessage: (message: unknown, generation: number) => void;
  handleGeminiMessageSafely: (
    message: unknown,
    generation: number,
    connection?: Connection,
  ) => void;
  runGeminiCallbackSafely: (
    operation: "message" | "error" | "close",
    generation: number,
    connection: Connection | undefined,
    callback: () => void,
  ) => void;
  preparePendingTurnForReconnect: (connection: Connection | undefined) => void;
  replayPendingProviderTurn: (
    session: unknown,
    connection: Connection | undefined,
    generation: number,
    pending: PendingProviderTurn,
  ) => boolean;
  forwardAudio: (connection: Connection, audio: ArrayBuffer) => void;
  openGeminiSession: (
    connection: Connection | undefined,
    topic: ReturnType<typeof buildInterviewTopic>,
    configuration: {
      questionCount: number;
      difficulty: "easy" | "standard" | "hard";
      topicIds: PediatricInterviewerState["topicIds"];
    },
    generation: number,
  ) => Promise<unknown>;
  onStart: () => Promise<void>;
  onConnect: (connection: Connection) => void;
  scheduleGeminiReconnect: (connection: Connection | undefined, reason: string) => void;
  resumeFreshGeminiSession: (connection: Connection) => void;
  authoritativeRecoveryQuestion: () => string;
  openingCaseSpeechForPlayback: (text: string) => Promise<{
    pcm: Uint8Array;
    sampleRate: number;
  }>;
  openingPlaybackIsCurrent: (
    generation: number,
    stage: "case" | "first_question",
  ) => boolean;
  failOpeningAudio: (
    connection: Connection,
    generation: number,
    stage: "case" | "first_question",
  ) => void;
  readResumptionHandle: (generation: string | undefined) => string | undefined;
  writeResumptionHandle: (generation: string | undefined, handle: string) => boolean;
  clearResumptionHandle: (generation?: string) => boolean;
  closeLiveSession: (reason: string, ownerConnection?: Connection) => void;
  finishInterview: (connection: Connection) => Promise<void>;
  finishGeminiTurn: (connection: Connection, generation: number) => Promise<void>;
  askGemini: (connection: Connection, turn: unknown) => void;
  buildFinalizationSnapshot: (
    reportId: string,
    interviewGeneration: string,
  ) => { exchanges: PediatricInterviewerState["exchanges"] };
  validateStateChange: (
    nextState: PediatricInterviewerState,
    source: Connection | "server",
  ) => void;
};

function runtimeOf(interviewer: PediatricInterviewer): Runtime {
  return interviewer as unknown as Runtime;
}

function connection(id: string, sent: string[]): Connection {
  return {
    id,
    send: (payload) => sent.push(typeof payload === "string" ? payload : "binary"),
  } as unknown as Connection;
}

function newInterviewer(): { interviewer: PediatricInterviewer; runtime: Runtime } {
  const interviewer = new PediatricInterviewer();
  const runtime = runtimeOf(interviewer);
  runtime.state = structuredClone(runtime.initialState);
  return { interviewer, runtime };
}

beforeEach(() => {
  genaiMocks.liveConnect.mockReset();
  openingSpeechMocks.synthesize.mockReset();
  openingSpeechMocks.synthesize.mockResolvedValue({
    pcm: Uint8Array.from([1, 0, 2, 0]),
    sampleRate: 24_000,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("PediatricInterviewer lifecycle ownership", () => {
  it("allows server state transitions while rejecting client-authored state", () => {
    const { runtime } = newInterviewer();
    const nextState = { ...runtime.state, phase: "interviewing" as const };

    expect(() => runtime.validateStateChange(nextState, "server")).not.toThrow();
    expect(() => runtime.validateStateChange(nextState, connection("client", []))).toThrow(
      "Client state updates are not allowed.",
    );
  });

  it("replays a completed report when a replacement socket reconnects", () => {
    const { interviewer, runtime } = newInterviewer();
    runtime.state = {
      ...runtime.state,
      phase: "complete",
      reportId: "report-reconnect",
      evaluation: { outcome: "pass" } as PediatricInterviewerState["evaluation"],
    };
    const sent: string[] = [];

    interviewer.onConnect(connection("replacement", sent));

    const messages = sent
      .filter((payload) => payload !== "binary")
      .map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "interview_state",
        phase: "complete",
        reportId: "report-reconnect",
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "interview_report",
        reportId: "report-reconnect",
        reviewPath: "/interviewer/reports/report-reconnect.md",
      }),
    );
  });

  it("does not let an old finalizer clear a replacement device", () => {
    const { interviewer, runtime } = newInterviewer();
    const oldConnection = connection("old", []);
    const replacement = connection("replacement", []);
    runtime.device = replacement;

    runtime.closeLiveSession("old finalizer", oldConnection);

    expect(runtime.device).toBe(replacement);
  });

  it("queues reconnect when a replacement arrives during initial case generation", () => {
    const { runtime } = newInterviewer();
    const replacement = connection("replacement-during-generation", []);
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "generating-case",
      openingStage: "warming_up",
    };
    runtime.openingStage = "warming_up";
    runtime.connecting = true;
    runtime.scheduleGeminiReconnect = vi.fn();

    runtime.onConnect(replacement);

    expect(runtime.device).toBe(replacement);
    expect(runtime.scheduleGeminiReconnect).toHaveBeenCalledWith(
      replacement,
      "client reconnected",
    );
  });

  it("rejects a new start while report finalization is in flight", async () => {
    const { interviewer, runtime } = newInterviewer();
    runtime.finalizationPromise = new Promise<void>(() => undefined);
    const sent: string[] = [];

    await interviewer.onMessage(
      connection("new", sent),
      JSON.stringify({ type: "start_call", topic_id: "behavior_guidance" }),
    );

    const messages = sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "The previous review is still being prepared. Please wait a moment.",
      }),
    );
    expect(runtime.state.phase).toBe("idle");
  });

  it("rejects HTTP report recovery while the interview still has a live client", async () => {
    const { interviewer, runtime } = newInterviewer();
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      exchanges: [{ question: "What is your first step?", answer: "I assess safety." }],
    };
    runtime.device = connection("live-client", []);

    const response = await interviewer.onRequest(
      new Request("https://example.test/recover-report", { method: "POST" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "interview_still_active" });
    expect(runtime.device?.id).toBe("live-client");
  });

  it("accepts HTTP recovery when only a durable probed answer has been saved", async () => {
    const { interviewer, runtime } = newInterviewer();
    runtime.state = {
      ...runtime.state,
      phase: "evaluation_failed",
      interviewGeneration: "pending-only-generation",
      currentQuestion: "What else would you evaluate?",
      pendingExchange: {
        question: "What is your primary assessment?",
        answer: "I would assess pain and immediate safety.",
        followUps: [],
        activeQuestion: "What else would you evaluate?",
      },
    };
    runtime.finishInterview = vi.fn(async () => {
      runtime.state = {
        ...runtime.state,
        phase: "complete",
        reportId: "pending-only-report",
      };
    });

    const response = await interviewer.onRequest(
      new Request("https://example.test/recover-report", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reportId: "pending-only-report" });
    expect(runtime.finishInterview).toHaveBeenCalledOnce();
  });

  it("ends into evaluation when only a durable probed answer has been saved", async () => {
    const { interviewer, runtime } = newInterviewer();
    const activeConnection = connection("active", []);
    runtime.device = activeConnection;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "pending-end-generation",
      pendingExchange: {
        question: "What is your primary assessment?",
        answer: "I would assess pain and immediate safety.",
        followUps: [],
        activeQuestion: "What else would you evaluate?",
      },
    };
    runtime.finishInterview = vi.fn(async () => undefined);

    await interviewer.onMessage(activeConnection, JSON.stringify({ type: "end_call" }));

    expect(runtime.state.phase).toBe("evaluating");
    expect(runtime.finishInterview).toHaveBeenCalledOnce();
  });

  it("materializes a durable partial exchange once in the immutable report snapshot", () => {
    const { runtime } = newInterviewer();
    const exchange = {
      question: "What is your primary assessment?",
      answer: "I would assess pain and immediate safety.",
      followUps: [
        { question: "What comes next?", answer: "I would examine and obtain imaging." },
      ],
    };
    runtime.state = {
      ...runtime.state,
      interviewGeneration: "snapshot-generation",
      currentQuestion: "What additional issue matters?",
      pendingExchange: {
        ...exchange,
        activeQuestion: "What additional issue matters?",
      },
    };

    expect(
      runtime.buildFinalizationSnapshot("pending-report", "snapshot-generation").exchanges,
    ).toEqual([exchange]);

    runtime.state = { ...runtime.state, exchanges: [structuredClone(exchange)] };
    expect(
      runtime.buildFinalizationSnapshot("deduplicated-report", "snapshot-generation").exchanges,
    ).toEqual([exchange]);
  });

  it("does not reuse a handle from another interview generation", () => {
    const { runtime } = newInterviewer();
    runtime.sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(" ");
      if (statement.includes("PRAGMA")) {
        return [{ name: "id" }, { name: "interview_generation" }];
      }
      if (statement.includes("SELECT")) {
        return values[0] === "current-generation"
          ? [{ resumption_handle: "current-handle" }]
          : [];
      }
      return [];
    });

    expect(runtime.readResumptionHandle("current-generation")).toBe("current-handle");
    expect(runtime.readResumptionHandle("old-generation")).toBeUndefined();
  });

  it("fails fresh after a metadata read/write error", () => {
    const { runtime } = newInterviewer();
    runtime.sql = vi.fn(() => {
      throw new Error("SQLite unavailable");
    });

    expect(runtime.readResumptionHandle("current-generation")).toBeUndefined();
    expect(runtime.resumptionHandleUsable).toBe(false);
    expect(runtime.writeResumptionHandle("current-generation", "handle")).toBe(false);
  });

  it("owns opening fallback playback by Live generation, phase, and stage", () => {
    const { runtime } = newInterviewer();
    runtime.state = { ...runtime.state, phase: "interviewing" };
    runtime.liveGeneration = 7;
    runtime.openingStage = "presenting_case";

    expect(runtime.openingPlaybackIsCurrent(7, "case")).toBe(true);
    expect(runtime.openingPlaybackIsCurrent(8, "case")).toBe(false);
    expect(runtime.openingPlaybackIsCurrent(7, "first_question")).toBe(false);

    runtime.state = { ...runtime.state, phase: "idle" };
    expect(runtime.openingPlaybackIsCurrent(7, "case")).toBe(false);
  });

  it("does not let a stale fallback failure reset a replacement interview", () => {
    const { runtime } = newInterviewer();
    const replacement = connection("replacement", []);
    runtime.device = replacement;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      currentQuestion: "Replacement interview question",
    };
    runtime.liveGeneration = 12;
    runtime.openingStage = "presenting_case";

    runtime.failOpeningAudio(replacement, 11, "case");

    expect(runtime.state.phase).toBe("interviewing");
    expect(runtime.state.currentQuestion).toBe("Replacement interview question");
    expect(runtime.openingStage).toBe("presenting_case");
  });

  it("enters the scored interview as soon as the first clinical question is spoken", async () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    runtime.device = activeConnection;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "first-question-opening",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
    };
    runtime.liveGeneration = 17;
    runtime.openingStage = "asking_first_question";
    runtime.openingCaseText = runtime.state.casePresentation ?? "";
    runtime.outputTranscript = "How would you assess this child's immediate needs?";
    runtime.inputTranscript = "";
    runtime.turnProducedAudio = true;
    runtime.turnAudioDeliveryFailed = false;
    runtime.askGemini = vi.fn();

    await runtime.finishGeminiTurn(activeConnection, 17);

    expect(runtime.state.openingStage).toBe("complete");
    expect(runtime.state.casePresentation).toBe(
      "Here is your case. A four-year-old presents with pain.",
    );
    expect(runtime.state.currentQuestion).toBe("How would you assess this child's immediate needs?");
    expect(runtime.state.exchanges).toHaveLength(0);
    expect(runtime.askGemini).not.toHaveBeenCalled();
    expect(
      sent
        .map((payload) => JSON.parse(payload))
        .filter((payload) => payload.type === "transcript_end"),
    ).toEqual([
      {
        type: "transcript_end",
        role: "assistant",
        text: "How would you assess this child's immediate needs?",
      },
    ]);
    expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "status",
      status: "listening",
    });
  });

  it("plays the prevalidated durable case directly after the Live warm-up turn", async () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    runtime.device = activeConnection;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "structured-opening",
      openingStage: "warming_up",
      casePresentation:
        "Here is your case. A four-year-old child presents with pain and escalating dental anxiety during an urgent visit.",
    };
    runtime.liveGeneration = 16;
    runtime.openingStage = "warming_up";
    runtime.openingCaseText = runtime.state.casePresentation ?? "";
    runtime.outputTranscript = "Ready.";
    runtime.inputTranscript = "";
    runtime.turnProducedAudio = true;
    runtime.turnAudioDeliveryFailed = false;
    runtime.askGemini = vi.fn();

    await runtime.finishGeminiTurn(activeConnection, 16);

    expect(runtime.askGemini).toHaveBeenCalledOnce();
    expect(runtime.askGemini).toHaveBeenCalledWith(
      activeConnection,
      expect.objectContaining({
        turns: expect.stringContaining("BEGIN_INTERVIEW"),
        turnComplete: true,
      }),
    );
    expect(openingSpeechMocks.synthesize).toHaveBeenCalledWith(
      "test-gemini-key",
      "Here is your case. A four-year-old child presents with pain and escalating dental anxiety during an urgent visit.",
    );
    expect(openingSpeechMocks.synthesize).toHaveBeenCalledOnce();
    expect(runtime.state.openingStage).toBe("asking_first_question");
    expect(
      sent
        .filter((payload) => payload !== "binary")
        .map((payload) => JSON.parse(payload))
        .filter((payload) => payload.type === "transcript_end"),
    ).toEqual([
      {
        type: "transcript_end",
        role: "assistant",
        text:
          "Here is your case. A four-year-old child presents with pain and escalating dental anxiety during an urgent visit.",
      },
    ]);
  });

  it("shares one in-flight synthesis when prewarming durable case speech", async () => {
    const { runtime } = newInterviewer();
    const caseText =
      "Here is your case. A four-year-old child presents with pain and dental anxiety.";

    const [first, second] = await Promise.all([
      runtime.openingCaseSpeechForPlayback(caseText),
      runtime.openingCaseSpeechForPlayback(caseText),
    ]);

    expect(first).toBe(second);
    expect(openingSpeechMocks.synthesize).toHaveBeenCalledOnce();
    expect(openingSpeechMocks.synthesize).toHaveBeenCalledWith(
      "test-gemini-key",
      caseText,
    );
  });

  it("uses bounded TTS when the first question has a transcript but no Live audio", async () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    runtime.device = activeConnection;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "silent-first-question",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
    };
    runtime.liveGeneration = 18;
    runtime.openingStage = "asking_first_question";
    runtime.openingCaseText = runtime.state.casePresentation ?? "";
    runtime.outputTranscript = "What is your initial assessment?";
    runtime.inputTranscript = "";
    runtime.turnProducedAudio = false;
    runtime.turnAudioDeliveryFailed = false;
    runtime.askGemini = vi.fn();

    await runtime.finishGeminiTurn(activeConnection, 18);

    expect(runtime.askGemini).not.toHaveBeenCalled();
    expect(openingSpeechMocks.synthesize).toHaveBeenCalledWith(
      "test-gemini-key",
      "What is your initial assessment?",
    );
    expect(sent).toContain("binary");
    expect(
      sent
        .filter((payload) => payload !== "binary")
        .map((payload) => JSON.parse(payload))
        .filter((payload) => payload.type === "transcript_end"),
    ).toContainEqual({
      type: "transcript_end",
      role: "assistant",
      text: "What is your initial assessment?",
    });
    expect(runtime.state).toMatchObject({
      openingStage: "complete",
      currentQuestion: "What is your initial assessment?",
      exchanges: [],
    });
  });

  it("interrupts and retries a malformed first-question turn without opening input", async () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    runtime.device = activeConnection;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "invalid-first-question",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
    };
    runtime.liveGeneration = 19;
    runtime.openingStage = "asking_first_question";
    runtime.openingCaseText = runtime.state.casePresentation ?? "";
    runtime.outputTranscript = "Let us begin.";
    runtime.inputTranscript = "";
    runtime.turnProducedAudio = true;
    runtime.turnAudioDeliveryFailed = false;
    runtime.askGemini = vi.fn();

    await runtime.finishGeminiTurn(activeConnection, 19);

    expect(runtime.openingStage).toBe("asking_first_question");
    expect(runtime.state).toMatchObject({
      phase: "interviewing",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
      exchanges: [],
    });
    expect(runtime.askGemini).toHaveBeenCalledOnce();
    expect(runtime.askGemini).toHaveBeenCalledWith(
      activeConnection,
      expect.objectContaining({ turns: expect.stringContaining("BEGIN_INTERVIEW") }),
    );
    expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "playback_interrupt",
    });
    expect(
      sent
        .map((payload) => JSON.parse(payload))
        .some((payload) => payload.type === "transcript_end"),
    ).toBe(false);
  });

  it("preserves the exact opening checkpoint for a client reconnect", async () => {
    const { runtime } = newInterviewer();
    const provider = { close: vi.fn() };
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "opening-client-reconnect",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
    };
    runtime.gemini = provider;
    runtime.liveGeneration = 20;
    runtime.openingStage = "asking_first_question";
    runtime.openingCaseText = runtime.state.casePresentation ?? "";
    runtime.outputTranscript = "What is your initial assessment?";
    runtime.inputTranscript = "";
    runtime.turnProducedAudio = true;
    runtime.turnAudioDeliveryFailed = true;

    await runtime.finishGeminiTurn(connection("disconnected", []), 20);

    expect(provider.close).toHaveBeenCalledOnce();
    expect(runtime.state).toMatchObject({
      phase: "interviewing",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
    });
    expect(runtime.openingStage).toBe("asking_first_question");

    const replacement = connection("replacement", []);
    runtime.scheduleGeminiReconnect = vi.fn();
    runtime.onConnect(replacement);
    expect(runtime.scheduleGeminiReconnect).toHaveBeenCalledWith(
      replacement,
      "client reconnected",
    );
  });

  it("asks the first clinical question directly after a fresh Live reconnect", () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    const session = { sendRealtimeInput: vi.fn() };
    runtime.device = activeConnection;
    runtime.gemini = session;
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "first-question-prefill",
      openingStage: "asking_first_question",
      casePresentation: "Here is your case. A child presents with pain.",
    };
    runtime.liveGeneration = 19;
    runtime.openingStage = "asking_first_question";
    runtime.openingCaseText = "Here is your case. A child presents with pain.";

    runtime.resumeFreshGeminiSession(activeConnection);

    expect(session.sendRealtimeInput).toHaveBeenCalledOnce();
    expect(session.sendRealtimeInput).toHaveBeenCalledWith({
      text: expect.stringContaining("BEGIN_INTERVIEW"),
    });
    expect(openingSpeechMocks.synthesize).not.toHaveBeenCalled();
    expect(runtime.openingStage).toBe("asking_first_question");
    expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "status",
      status: "thinking",
    });
  });

  it("turns a malformed provider callback into owned reconnect recovery", () => {
    const { runtime } = newInterviewer();
    const activeConnection = connection("active", []);
    runtime.device = activeConnection;
    runtime.state = { ...runtime.state, phase: "interviewing" };
    runtime.liveGeneration = 18;
    runtime.handleGeminiMessage = vi.fn(() => {
      throw new Error("malformed provider PCM");
    });
    runtime.handleGeminiTransportFailure = vi.fn();

    runtime.handleGeminiMessageSafely({}, 18, activeConnection);

    expect(runtime.handleGeminiTransportFailure).toHaveBeenCalledWith(
      activeConnection,
      18,
      "message_callback_failed",
    );
  });

  it.each(["error", "close"] as const)(
    "contains a throwing %s callback and enters owned recovery",
    (operation) => {
      const { runtime } = newInterviewer();
      const activeConnection = connection("active", []);
      runtime.device = activeConnection;
      runtime.state = { ...runtime.state, phase: "interviewing" };
      runtime.liveGeneration = 20;
      runtime.handleGeminiTransportFailure = vi.fn();

      expect(() =>
        runtime.runGeminiCallbackSafely(operation, 20, activeConnection, () => {
          throw new Error(`${operation} callback failed`);
        }),
      ).not.toThrow();

      expect(runtime.handleGeminiTransportFailure).toHaveBeenCalledWith(
        activeConnection,
        20,
        `${operation}_callback_failed`,
      );
    },
  );

  it("recovers when asynchronous turn finalization rejects", async () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    const pending: PendingProviderTurn = {
      id: 20,
      kind: "candidate_text",
      text: "My candidate answer",
    };
    runtime.device = activeConnection;
    runtime.gemini = {};
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "turn-finalization-generation",
      openingStage: "complete",
    };
    runtime.openingStage = "complete";
    runtime.liveGeneration = 21;
    runtime.pendingProviderTurn = pending;
    runtime.clearResumptionHandle = vi.fn(() => true);
    runtime.finishGeminiTurn = vi.fn(async () => {
      throw new Error("finalization failed");
    });
    runtime.handleGeminiTransportFailure = vi.fn();

    runtime.handleGeminiMessage(
      { serverContent: { turnComplete: true } },
      21,
    );

    await vi.waitFor(() => {
      expect(runtime.handleGeminiTransportFailure).toHaveBeenCalledWith(
        activeConnection,
        21,
        "turn_finalization_failed",
      );
    });
    expect(runtime.pendingProviderTurn).toBe(pending);
    expect(runtime.clearResumptionHandle).toHaveBeenCalledWith(
      "turn-finalization-generation",
    );
    expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "turn_recovery",
      action: "retrying",
      message: "That turn could not be saved. Reconnecting and retrying it safely…",
    });
  });

  it("bounds a silent provider turn and starts owned reconnect recovery", () => {
    vi.useFakeTimers();
    try {
      const { runtime } = newInterviewer();
      const sent: string[] = [];
      const activeConnection = connection("active", sent);
      const pending: PendingProviderTurn = {
        id: 21,
        kind: "candidate_text",
        text: "My answer",
      };
      runtime.state = {
        ...runtime.state,
        phase: "interviewing",
        interviewGeneration: "interview-current",
      };
      runtime.device = activeConnection;
      runtime.liveGeneration = 8;
      runtime.pendingProviderTurn = pending;
      runtime.handleGeminiTransportFailure = vi.fn();

      runtime.armProviderResponseDeadline(pending, 8);
      vi.advanceTimersByTime(PROVIDER_RESPONSE_TIMEOUT_MS);

      expect(runtime.handleGeminiTransportFailure).toHaveBeenCalledWith(
        activeConnection,
        8,
        "response_timeout",
      );
      expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: "playback_interrupt",
      });
      expect(sent.map((payload) => JSON.parse(payload))).toContainEqual(
        expect.objectContaining({ type: "turn_recovery", action: "retrying" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the response inactivity deadline on meaningful provider progress", () => {
    vi.useFakeTimers();
    try {
      const { runtime } = newInterviewer();
      const activeConnection = connection("active", []);
      const pending: PendingProviderTurn = {
        id: 24,
        kind: "candidate_text",
        text: "My answer",
      };
      runtime.state = { ...runtime.state, phase: "interviewing" };
      runtime.device = activeConnection;
      runtime.liveGeneration = 13;
      runtime.pendingProviderTurn = pending;
      runtime.handleGeminiTransportFailure = vi.fn();

      runtime.armProviderResponseDeadline(pending, 13);
      vi.advanceTimersByTime(PROVIDER_RESPONSE_TIMEOUT_MS - 1);
      runtime.handleGeminiMessage(
        { serverContent: { outputTranscription: { text: "Beginning the response." } } },
        13,
      );
      vi.advanceTimersByTime(PROVIDER_RESPONSE_TIMEOUT_MS - 1);

      expect(runtime.handleGeminiTransportFailure).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(runtime.handleGeminiTransportFailure).toHaveBeenCalledWith(
        activeConnection,
        13,
        "response_timeout",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays committed PCM as one manually delimited candidate turn", () => {
    vi.useFakeTimers();
    try {
      const { runtime } = newInterviewer();
      const sent: string[] = [];
      const activeConnection = connection("active", sent);
      const realtimeInputs: unknown[] = [];
      const session = {
        sendRealtimeInput: vi.fn((input: unknown) => realtimeInputs.push(input)),
      };
      const pending: PendingProviderTurn = {
        id: 22,
        kind: "candidate_audio",
        chunks: [Uint8Array.from([1, 2]).buffer, Uint8Array.from([3, 4]).buffer],
        bytes: 4,
        committed: true,
        replayable: true,
      };
      runtime.state = {
        ...runtime.state,
        phase: "interviewing",
        interviewGeneration: "interview-current",
      };
      runtime.device = activeConnection;
      runtime.liveGeneration = 9;
      runtime.gemini = session;
      runtime.pendingProviderTurn = pending;

      expect(runtime.replayPendingProviderTurn(session, activeConnection, 9, pending)).toBe(true);
      expect(realtimeInputs).toEqual([
        { activityStart: {} },
        { audio: { data: "AQI=", mimeType: "audio/pcm;rate=24000" } },
        { audio: { data: "AwQ=", mimeType: "audio/pcm;rate=24000" } },
        { activityEnd: {} },
      ]);
      expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: "status",
        status: "thinking",
      });
      runtime.clearPendingProviderTurn();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses Gemini 3.1 realtime text updates for scripted and typed turns", async () => {
    const { interviewer, runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    const realtimeInputs: unknown[] = [];
    const session = {
      sendRealtimeInput: vi.fn((input: unknown) => realtimeInputs.push(input)),
    };
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "realtime-text",
      openingStage: "complete",
      currentQuestion: "What is your initial assessment?",
    };
    runtime.device = activeConnection;
    runtime.gemini = session;
    runtime.liveGeneration = 21;
    runtime.openingStage = "complete";
    runtime.lastStatus = "listening";

    runtime.askGemini(activeConnection, {
      turns: "RUNTIME_CONTROL. Continue the current interview.",
      turnComplete: true,
    });
    expect(realtimeInputs).toEqual([
      { text: "RUNTIME_CONTROL. Continue the current interview." },
    ]);
    runtime.clearPendingProviderTurn();
    runtime.lastStatus = "listening";

    await interviewer.onMessage(
      activeConnection,
      JSON.stringify({
        type: "candidate_text",
        text: "I would begin with a focused history and examination.",
      }),
    );

    expect(realtimeInputs).toEqual([
      { text: "RUNTIME_CONTROL. Continue the current interview." },
      { text: "I would begin with a focused history and examination." },
    ]);
    expect(session).not.toHaveProperty("sendClientContent");
    runtime.clearPendingProviderTurn();
  });

  it("lets typed input replace an uncommitted microphone turn", async () => {
    const { interviewer, runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    const realtimeInputs: unknown[] = [];
    const session = {
      sendRealtimeInput: vi.fn((input: unknown) => realtimeInputs.push(input)),
    };
    runtime.state = { ...runtime.state, phase: "interviewing" };
    runtime.device = activeConnection;
    runtime.gemini = session;
    runtime.lastStatus = "listening";

    runtime.forwardAudio(activeConnection, Uint8Array.from([1, 0]).buffer);
    await interviewer.onMessage(
      activeConnection,
      JSON.stringify({ type: "candidate_text", text: "I would use tell-show-do." }),
    );

    expect(realtimeInputs).toEqual([
      { activityStart: {} },
      {
        audio: {
          data: "AQA=",
          mimeType: "audio/pcm;rate=24000",
        },
      },
      { text: "I would use tell-show-do." },
      { activityEnd: {} },
    ]);
    expect(runtime.candidateActivityStarted).toBe(false);
    expect(runtime.pendingProviderTurn).toMatchObject({
      kind: "candidate_text",
      text: "I would use tell-show-do.",
    });
    expect(sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "candidate_text_ack",
      accepted: true,
      turnComplete: true,
    });
    runtime.clearPendingProviderTurn();
  });

  it("forces advancement before Gemini can speak a fifth probe", () => {
    const { runtime } = newInterviewer();
    const activeConnection = connection("active", []);
    const sendToolResponse = vi.fn();
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "probe-cap",
      openingStage: "complete",
      currentQuestion: "What communication strategy would you use?",
    };
    runtime.device = activeConnection;
    runtime.gemini = { sendToolResponse };
    runtime.liveGeneration = 22;
    runtime.openingStage = "complete";
    runtime.pendingQuestion = "How would you assess this child?";
    runtime.pendingAnswer = "I would assess development and cooperation.";
    runtime.pendingFollowUps = [
      { question: "Probe one?", answer: "Answer one." },
      { question: "Probe two?", answer: "Answer two." },
      { question: "Probe three?", answer: "Answer three." },
    ];
    runtime.activeQuestion = "What communication strategy would you use?";

    runtime.handleGeminiMessage(
      {
        toolCall: {
          functionCalls: [
            {
              id: "probe-cap-call",
              name: "record_turn_disposition",
              args: { disposition: "probe_current_answer" },
            },
          ],
        },
      },
      22,
    );

    expect(sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: "probe-cap-call",
          name: "record_turn_disposition",
          response: {
            output: expect.stringContaining("latest answer will become exchange 1"),
          },
        }),
      ],
    });
  });

  it("drops an incomplete audio turn without resuming its provider handle", () => {
    const { runtime } = newInterviewer();
    const pending: PendingProviderTurn = {
      id: 23,
      kind: "candidate_audio",
      chunks: [Uint8Array.from([1, 2]).buffer],
      bytes: 2,
      committed: false,
      replayable: true,
    };
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "interview-current",
    };
    runtime.pendingProviderTurn = pending;
    runtime.clearResumptionHandle = vi.fn(() => true);

    runtime.preparePendingTurnForReconnect(undefined);

    expect(runtime.clearResumptionHandle).toHaveBeenCalledWith("interview-current");
    expect(runtime.pendingProviderTurn).toBeUndefined();
  });

  it("does not start a replacement audio turn while reconnect is not listening", () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    const session = { sendRealtimeInput: vi.fn() };
    runtime.state = { ...runtime.state, phase: "interviewing" };
    runtime.device = activeConnection;
    runtime.gemini = session;
    runtime.lastStatus = "thinking";

    runtime.forwardAudio(activeConnection, new ArrayBuffer(2));

    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
    expect(runtime.pendingProviderTurn).toBeUndefined();
  });

  it("keeps listening while Gemini emits partial input transcription", () => {
    const { runtime } = newInterviewer();
    const sent: string[] = [];
    const activeConnection = connection("active", sent);
    runtime.state = { ...runtime.state, phase: "interviewing" };
    runtime.device = activeConnection;
    runtime.gemini = {};
    runtime.liveGeneration = 23;
    runtime.lastStatus = "listening";

    runtime.handleGeminiMessage(
      { serverContent: { inputTranscription: { text: "partial answer" } } },
      23,
    );

    expect(runtime.inputTranscript).toBe("partial answer");
    expect(runtime.lastStatus).toBe("listening");
    expect(
      sent
        .filter((payload) => payload !== "binary")
        .map((payload) => JSON.parse(payload))
        .some((payload) => payload.type === "status" && payload.status === "thinking"),
    ).toBe(false);
  });

  it("defers provider failure until terminal turn persistence releases its generation", () => {
    const { runtime } = newInterviewer();
    const activeConnection = connection("active", []);
    const session = {};
    runtime.state = { ...runtime.state, phase: "interviewing" };
    runtime.liveGeneration = 24;
    runtime.gemini = session;
    runtime.turnFinalizationGeneration = 24;

    runtime.handleGeminiTransportFailure(activeConnection, 24, "go_away");

    expect(runtime.deferredTransportFailure).toEqual({
      connection: activeConnection,
      generation: 24,
      reason: "go_away",
    });
    expect(runtime.liveGeneration).toBe(24);
    expect(runtime.gemini).toBe(session);
  });

  it("migrates a legacy readiness checkpoint to the first-question boundary on wake", async () => {
    const { runtime } = newInterviewer();
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "wake-generation",
      openingStage:
        "awaiting_confirmation" as unknown as PediatricInterviewerState["openingStage"],
      casePresentation: "Here is your case. A four-year-old presents with pain.",
      currentQuestion:
        "Here is your case. A four-year-old presents with pain. Are you ready to begin?",
    };
    runtime.sql = vi.fn(() => []);

    await runtime.onStart();

    expect(runtime.openingStage).toBe("asking_first_question");
    expect(runtime.state.openingStage).toBe("asking_first_question");
    expect(runtime.openingCaseText).toBe(
      "Here is your case. A four-year-old presents with pain.",
    );
    expect(runtime.lastStatus).toBe("thinking");
    expect(runtime.sql).toHaveBeenCalled();
  });

  it("migrates a legacy readiness question even when the stage was never persisted", async () => {
    const { runtime } = newInterviewer();
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "legacy-question-generation",
      openingStage: undefined,
      casePresentation: "Here is your case. A four-year-old presents with pain.",
      currentQuestion:
        "Here is your case. A four-year-old presents with pain. Are you ready to begin?",
    };

    await runtime.onStart();

    expect(runtime.openingStage).toBe("asking_first_question");
    expect(runtime.state.openingStage).toBe("asking_first_question");
  });

  it("restores a partial probed exchange without scoring or dropping it", async () => {
    const { runtime } = newInterviewer();
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "probe-generation",
      openingStage: "complete",
      casePresentation: "A four-year-old presents with pain.",
      currentQuestion: "What additional safety issue matters?",
      pendingExchange: {
        question: "What is your primary assessment?",
        answer: "I would assess pain and safety.",
        followUps: [
          { question: "What next?", answer: "I would examine and obtain imaging." },
        ],
        activeQuestion: "What additional safety issue matters?",
      },
    };

    await runtime.onStart();

    expect(runtime.pendingQuestion).toBe("What is your primary assessment?");
    expect(runtime.pendingAnswer).toBe("I would assess pain and safety.");
    expect(runtime.pendingFollowUps).toEqual([
      { question: "What next?", answer: "I would examine and obtain imaging." },
    ]);
    expect(runtime.activeQuestion).toBe("What additional safety issue matters?");
    expect(runtime.state.exchanges).toHaveLength(0);
  });

  it("replays only the authoritative pending probe after a fresh reconnect", async () => {
    const { runtime } = newInterviewer();
    const activeConnection = connection("active", []);
    const staleDisplay =
      "Here is your case. A four-year-old presents with pain. Are you ready to begin?";
    const pendingProbe = "What additional safety issue matters?";
    runtime.state = {
      ...runtime.state,
      phase: "interviewing",
      interviewGeneration: "probe-reconnect-generation",
      openingStage: "complete",
      casePresentation: "Here is your case. A four-year-old presents with pain.",
      currentQuestion: staleDisplay,
      pendingExchange: {
        question: "What is your primary assessment?",
        answer: "I would assess pain and immediate safety.",
        followUps: [],
        activeQuestion: pendingProbe,
      },
    };
    await runtime.onStart();
    runtime.askGemini = vi.fn();

    expect(runtime.authoritativeRecoveryQuestion()).toBe(pendingProbe);
    runtime.resumeFreshGeminiSession(activeConnection);

    expect(runtime.askGemini).toHaveBeenCalledOnce();
    const turn = vi.mocked(runtime.askGemini).mock.calls[0]?.[1] as {
      turns: string;
      turnComplete: true;
    };
    expect(turn.turnComplete).toBe(true);
    expect(turn.turns).toContain(pendingProbe);
    expect(turn.turns).not.toContain("Here is your case");
    expect(turn.turns).not.toContain("Are you ready to begin?");
  });

  it("bounds Gemini Live setup and closes a session that connects after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = newInterviewer();
      runtime.state = { ...runtime.state, phase: "interviewing" };
      runtime.liveGeneration = 31;
      let resolveConnect: ((session: unknown) => void) | undefined;
      genaiMocks.liveConnect.mockReturnValue(
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
      );
      const lateSession = { close: vi.fn() };
      const attempt = runtime.openGeminiSession(
        undefined,
        buildInterviewTopic(["behavior_guidance"]),
        {
          questionCount: 6,
          difficulty: "standard",
          topicIds: ["behavior_guidance"],
        },
        31,
      );
      const rejection = expect(attempt).rejects.toThrow(
        `Gemini Live setup exceeded ${GEMINI_CONNECT_TIMEOUT_MS} ms`,
      );

      await vi.advanceTimersByTimeAsync(GEMINI_CONNECT_TIMEOUT_MS);
      await rejection;
      resolveConnect?.(lateSession);
      await Promise.resolve();
      await Promise.resolve();

      expect(lateSession.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-commits a candidate turn at the bounded input deadline", async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = newInterviewer();
      const sent: string[] = [];
      const activeConnection = connection("active", sent);
      const realtimeInputs: unknown[] = [];
      const session = {
        sendRealtimeInput: vi.fn((input: unknown) => realtimeInputs.push(input)),
      };
      runtime.state = { ...runtime.state, phase: "interviewing" };
      runtime.device = activeConnection;
      runtime.gemini = session;
      runtime.liveGeneration = 32;
      runtime.lastStatus = "listening";
      runtime.connecting = false;

      runtime.forwardAudio(activeConnection, Uint8Array.from([1, 0]).buffer);
      await vi.advanceTimersByTimeAsync(CANDIDATE_TURN_TIMEOUT_MS);

      expect(realtimeInputs.at(-1)).toEqual({ activityEnd: {} });
      expect(runtime.pendingProviderTurn).toMatchObject({
        kind: "candidate_audio",
        committed: true,
      });
      expect(sent.map((payload) => JSON.parse(payload))).toContainEqual(
        expect.objectContaining({ type: "turn_recovery", action: "auto_committed" }),
      );
      runtime.clearPendingProviderTurn();
    } finally {
      vi.useRealTimers();
    }
  });
});
