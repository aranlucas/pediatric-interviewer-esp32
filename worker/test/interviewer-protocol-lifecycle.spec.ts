import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveServerMessage } from "@google/genai/web";

import { testInterviewer, fakeLiveSession } from "./interviewer-harness";
import type {
  InterviewerCore,
  InterviewServices,
  InterviewHost,
  InterviewConnection,
} from "../src/interviewer-core";
import { z } from "zod";

const adapters = {
  connect: vi.fn<InterviewServices["connect"]>(),
  generateCase: vi.fn<InterviewServices["generateOpeningCase"]>(),
  synthesizeSpeech: vi.fn<InterviewServices["synthesizeOpeningSpeech"]>(),
  keepAlive: vi.fn<InterviewHost["keepAlive"]>(),
};

function newInterviewer() {
  return testInterviewer(
    {
      connect: adapters.connect,
      generateOpeningCase: adapters.generateCase,
      synthesizeOpeningSpeech: adapters.synthesizeSpeech,
    },
    { keepAlive: adapters.keepAlive },
  );
}

const frameSchema = () => z.record(z.string(), z.json());

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
  const frames: Array<z.infer<ReturnType<typeof frameSchema>> | Uint8Array> = [];

  const connection: InterviewConnection = {
    id,
    send(payload: string | ArrayBuffer | Uint8Array) {
      frames.push(
        payload instanceof ArrayBuffer || payload instanceof Uint8Array
          ? new Uint8Array(payload)
          : frameSchema().parse(JSON.parse(payload)),
      );
    },
  };

  return { connection, frames };
}

function provider() {
  return fakeLiveSession();
}

function emit(content: LiveServerMessage["serverContent"], sessionIndex = 0) {
  const options = adapters.connect.mock.calls[sessionIndex][0];
  options.callbacks.onmessage?.(Object.assign(new LiveServerMessage(), { serverContent: content }));
}

function start(interviewer: InterviewerCore, connection: InterviewConnection) {
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
    const interviewer = newInterviewer();
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
    const interviewer = newInterviewer();
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
    const interviewer = newInterviewer();
    const original = client("original");
    interviewer.onConnect(original.connection);
    await start(interviewer, original.connection);
    const options = adapters.connect.mock.calls[0][0];
    options.callbacks.onclose?.(
      new CloseEvent("close", {
        code: 1006,
        reason: "synthetic disconnect",
        wasClean: false,
      }),
    );
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
    options.callbacks.onclose?.(
      new CloseEvent("close", {
        code: 1006,
        reason: "stale close",
        wasClean: false,
      }),
    );
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
    const interviewer = newInterviewer();
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
    const interviewer = newInterviewer();
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
    const interviewer = newInterviewer();
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
