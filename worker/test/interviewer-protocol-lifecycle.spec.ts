import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "agents";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai/web";

const adapters = vi.hoisted(() => ({
  connect: vi.fn(),
  generateCase: vi.fn(),
  synthesizeSpeech: vi.fn(),
  keepAlive: vi.fn(),
}));

// Substitute only persistence/runtime and external providers. Scenarios drive
// the same socket callbacks and provider events as production, never private
// interviewer fields or methods.
vi.mock("agents", () => ({
  Agent: class {
    initialState: unknown;
    private savedState: unknown;
    env = { GEMINI_API_KEY: "synthetic-test-key", INTERVIEW_REPORTS: {} };
    name = "synthetic-protocol-test";
    sql = vi.fn(() => []);

    get state(): unknown {
      return (this.savedState ??= structuredClone(this.initialState));
    }

    setState(next: unknown): void {
      this.savedState = structuredClone(next);
    }

    keepAlive = adapters.keepAlive;

    async keepAliveWhile<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    }
  },
}));

vi.mock("@google/genai/web", () => ({
  GoogleGenAI: class {
    live = { connect: adapters.connect };
  },
  Modality: { AUDIO: "AUDIO" },
  ThinkingLevel: { MINIMAL: "MINIMAL" },
}));

vi.mock("../src/opening-case", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/opening-case")>()),
  generateOpeningCase: adapters.generateCase,
}));

vi.mock("../src/opening-speech", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/opening-speech")>()),
  synthesizeOpeningSpeech: adapters.synthesizeSpeech,
}));

import { PediatricInterviewer } from "../src/interviewer";

const CASE = "Here is your case. This is a synthetic training scenario.";
const PCM = new Uint8Array([1, 0, 2, 0]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function client(id: string) {
  const frames: Array<Record<string, unknown> | Uint8Array> = [];
  const connection = {
    id,
    send(payload: string | ArrayBuffer | Uint8Array) {
      frames.push(typeof payload === "string" ? JSON.parse(payload) : new Uint8Array(payload));
    },
  } as unknown as Connection;
  return { connection, frames };
}

function provider() {
  return { sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() };
}

function emit(content: LiveServerMessage["serverContent"], sessionIndex = 0) {
  const options = adapters.connect.mock.calls[sessionIndex][0] as LiveConnectParameters;
  options.callbacks.onmessage?.({ serverContent: content } as LiveServerMessage);
}

function start(interviewer: PediatricInterviewer, connection: Connection) {
  return interviewer.onMessage(connection, JSON.stringify({ type: "start_call" }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  adapters.generateCase.mockResolvedValue(CASE);
  adapters.synthesizeSpeech.mockResolvedValue({ pcm: PCM, sampleRate: 24_000 });
  adapters.keepAlive.mockResolvedValue(vi.fn());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("interviewer public lifecycle protocol", () => {
  it("starts the provider turn for the socket that replaces the client during setup", async () => {
    const pending = deferred<ReturnType<typeof provider>>();
    const live = provider();
    adapters.connect.mockReturnValue(pending.promise);
    const interviewer = new PediatricInterviewer();
    const original = client("original");
    const replacement = client("replacement");
    interviewer.onConnect(original.connection);
    const starting = start(interviewer, original.connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapters.connect).toHaveBeenCalledOnce();

    interviewer.onConnect(replacement.connection);
    interviewer.onClose(original.connection);
    pending.resolve(live);
    await starting;

    expect(live.sendRealtimeInput).toHaveBeenCalledExactlyOnceWith({
      text: expect.stringContaining("WARM_UP"),
    });
    expect(replacement.frames).toContainEqual({
      type: "audio_config",
      format: "pcm16",
      sampleRate: 24_000,
    });
    expect(live.close).not.toHaveBeenCalled();
  });

  it("releases setup without a socket so a later connection can resume the saved opening", async () => {
    const pending = deferred<ReturnType<typeof provider>>();
    const abandoned = provider();
    const resumed = provider();
    adapters.connect.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(resumed);
    const interviewer = new PediatricInterviewer();
    const original = client("original");
    interviewer.onConnect(original.connection);
    const starting = start(interviewer, original.connection);
    await vi.advanceTimersByTimeAsync(0);
    interviewer.onClose(original.connection);
    pending.resolve(abandoned);
    await starting;

    expect(abandoned.close).toHaveBeenCalledOnce();
    const replacement = client("replacement");
    interviewer.onConnect(replacement.connection);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapters.generateCase).toHaveBeenCalledOnce();
    expect(resumed.sendRealtimeInput).toHaveBeenCalledExactlyOnceWith({
      text: expect.stringContaining("WARM_UP"),
    });
    expect(replacement.frames).toContainEqual(
      expect.objectContaining({ type: "interview_state", phase: "interviewing" }),
    );
  });

  it("resynchronizes the latest socket when provider reconnection finishes", async () => {
    const pendingReconnect = deferred<ReturnType<typeof provider>>();
    const originalProvider = provider();
    const resumedProvider = provider();
    adapters.connect
      .mockResolvedValueOnce(originalProvider)
      .mockReturnValueOnce(pendingReconnect.promise);
    const interviewer = new PediatricInterviewer();
    const original = client("original");
    interviewer.onConnect(original.connection);
    await start(interviewer, original.connection);
    const options = adapters.connect.mock.calls[0][0] as LiveConnectParameters;
    options.callbacks.onclose?.({
      code: 1006,
      reason: "synthetic disconnect",
      wasClean: false,
    } as CloseEvent);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapters.connect).toHaveBeenCalledTimes(2);

    const replacement = client("replacement");
    interviewer.onConnect(replacement.connection);
    interviewer.onClose(original.connection);
    pendingReconnect.resolve(resumedProvider);
    await vi.advanceTimersByTimeAsync(0);

    expect(replacement.frames).toContainEqual({
      type: "audio_config",
      format: "pcm16",
      sampleRate: 24_000,
    });
    expect(resumedProvider.sendRealtimeInput).toHaveBeenCalledExactlyOnceWith({
      text: expect.stringContaining("WARM_UP"),
    });
    // A callback from the retired provider must not disconnect its successor.
    options.callbacks.onclose?.({
      code: 1006,
      reason: "stale close",
      wasClean: false,
    } as CloseEvent);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapters.connect).toHaveBeenCalledTimes(2);
    expect(resumedProvider.close).not.toHaveBeenCalled();
  });

  it("does not let a cancelled startup release a newer startup's reconnect guard", async () => {
    const firstCase = deferred<string>();
    const secondCase = deferred<string>();
    adapters.generateCase
      .mockReturnValueOnce(firstCase.promise)
      .mockReturnValueOnce(secondCase.promise);
    adapters.connect.mockResolvedValue(provider());
    const interviewer = new PediatricInterviewer();
    const original = client("original");
    interviewer.onConnect(original.connection);
    const firstStart = start(interviewer, original.connection);
    await vi.advanceTimersByTimeAsync(0);
    await interviewer.onMessage(original.connection, JSON.stringify({ type: "end_call" }));
    const secondStart = start(interviewer, original.connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapters.generateCase).toHaveBeenCalledTimes(2);

    firstCase.resolve(CASE);
    await firstStart;
    const replacement = client("replacement");
    interviewer.onConnect(replacement.connection);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapters.connect).not.toHaveBeenCalled();

    secondCase.resolve(CASE);
    await secondStart;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapters.connect).toHaveBeenCalledOnce();
  });

  it("releases a keep-alive acquired after the caller has stopped setup", async () => {
    const pendingHold = deferred<() => void>();
    const release = vi.fn();
    adapters.keepAlive.mockReturnValueOnce(pendingHold.promise);
    const interviewer = new PediatricInterviewer();
    const original = client("original");
    interviewer.onConnect(original.connection);
    const starting = start(interviewer, original.connection);
    await vi.advanceTimersByTimeAsync(0);
    await interviewer.onMessage(original.connection, JSON.stringify({ type: "end_call" }));
    pendingHold.resolve(release);
    await starting;

    expect(release).toHaveBeenCalledOnce();
    expect(adapters.generateCase).not.toHaveBeenCalled();
    expect(adapters.connect).not.toHaveBeenCalled();
  });

  it("delivers trailing provider audio before listening after generation completion", async () => {
    const live = provider();
    adapters.connect.mockResolvedValue(live);
    const interviewer = new PediatricInterviewer();
    const active = client("active");
    interviewer.onConnect(active.connection);
    await start(interviewer, active.connection);
    emit({ turnComplete: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(live.sendRealtimeInput).toHaveBeenCalledWith({
      text: expect.stringContaining("BEGIN_INTERVIEW"),
    });
    active.frames.length = 0;

    emit({ outputTranscription: { text: "What would you do first?" }, generationComplete: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(active.frames).not.toContainEqual({ type: "status", status: "listening" });
    emit({
      modelTurn: {
        parts: [{ inlineData: { data: "AQACAA==", mimeType: "audio/pcm;rate=24000" } }],
      },
    });
    emit({ turnComplete: true });
    await vi.advanceTimersByTimeAsync(0);

    const audioIndex = active.frames.findIndex((frame) => frame instanceof Uint8Array);
    const listeningIndex = active.frames.findIndex(
      (frame) =>
        !(frame instanceof Uint8Array) && frame.type === "status" && frame.status === "listening",
    );
    expect(audioIndex).toBeGreaterThanOrEqual(0);
    expect(listeningIndex).toBeGreaterThan(audioIndex);
    expect(active.frames).toContainEqual(
      expect.objectContaining({ type: "turn_complete", answerCount: 0 }),
    );
  });
});
