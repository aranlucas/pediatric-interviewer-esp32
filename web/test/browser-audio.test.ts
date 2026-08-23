import { describe, expect, it, vi } from "vitest";

import { BrowserInterviewAudio } from "../lib/browser-audio";

function audioWithTrack() {
  const track = {
    enabled: true,
    onended: null as ((event: Event) => void) | null,
    readyState: "live" as MediaStreamTrackState,
    stop: vi.fn(),
  };
  const onAutoCommit = vi.fn();
  const onCaptureUnavailable = vi.fn();
  const audio = new BrowserInterviewAudio({
    onCaptureUnavailable,
    onLevel: vi.fn(),
    onAutoCommit,
    onSpeakingChange: vi.fn(),
  });
  (audio as unknown as {
    media: {
      getAudioTracks: () => typeof track[];
      getTracks: () => typeof track[];
    };
  }).media = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  return { audio, onAutoCommit, onCaptureUnavailable, track };
}

describe("BrowserInterviewAudio microphone gating", () => {
  it("enables capture only during the listening state", () => {
    const { audio, track } = audioWithTrack();

    audio.setListening(false);
    expect(track.enabled).toBe(false);

    audio.setListening(true);
    expect(track.enabled).toBe(true);

    audio.setListening(false);
    expect(track.enabled).toBe(false);
  });

  it("does not open an audio turn until speech is detected", () => {
    const { audio } = audioWithTrack();
    const send = vi.fn();
    const internals = audio as unknown as {
      send: (data: ArrayBuffer) => void;
      handleCapture: (data: { pcm: ArrayBuffer; level: number }) => void;
    };
    internals.send = send;
    audio.setListening(true);

    internals.handleCapture({ pcm: new ArrayBuffer(2), level: 0 });
    expect(send).not.toHaveBeenCalled();

    internals.handleCapture({ pcm: new ArrayBuffer(2), level: 0.03 });
    internals.handleCapture({ pcm: new ArrayBuffer(2), level: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the microphone disabled while muted", () => {
    const { audio, track } = audioWithTrack();

    audio.setListening(true);
    audio.setMuted(true);
    expect(track.enabled).toBe(false);

    audio.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  it("does not submit stale speech after a long mute boundary", () => {
    const { audio, onAutoCommit } = audioWithTrack();
    audio.setListening(true);
    const internals = audio as unknown as {
      heardSpeech: boolean;
      lastSpeechAt: number;
      handleCapture: (data: { pcm: ArrayBuffer; level: number }) => void;
    };
    internals.heardSpeech = true;
    internals.lastSpeechAt = performance.now() - 10_000;

    audio.setMuted(true);
    audio.setMuted(false);
    internals.handleCapture({ pcm: new ArrayBuffer(2), level: 0 });

    expect(onAutoCommit).not.toHaveBeenCalled();
  });

  it("opens the fallback path when an active microphone track ends", () => {
    const { audio, onCaptureUnavailable, track } = audioWithTrack();
    const internals = audio as unknown as { handleCaptureEnded: () => void };

    internals.handleCaptureEnded();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(onCaptureUnavailable).toHaveBeenCalledOnce();
  });

  it("waits for queued examiner audio to finish before enabling the microphone", () => {
    const { audio, track } = audioWithTrack();
    const source = {} as AudioBufferSourceNode;
    const internals = audio as unknown as {
      playbackSources: Set<AudioBufferSourceNode>;
      finishPlayback: (endedSource: AudioBufferSourceNode) => void;
    };
    internals.playbackSources.add(source);

    audio.setListening(true);
    expect(track.enabled).toBe(false);

    internals.finishPlayback(source);
    expect(track.enabled).toBe(true);
  });

  it("commits an answer after five seconds of silence", () => {
    const { audio, onAutoCommit, track } = audioWithTrack();
    audio.setListening(true);
    const internals = audio as unknown as {
      heardSpeech: boolean;
      lastSpeechAt: number;
      handleCapture: (data: { pcm: ArrayBuffer; level: number }) => void;
    };
    internals.heardSpeech = true;
    internals.lastSpeechAt = performance.now() - 4_900;

    internals.handleCapture({ pcm: new ArrayBuffer(2), level: 0 });

    expect(track.enabled).toBe(true);
    expect(onAutoCommit).not.toHaveBeenCalled();

    internals.lastSpeechAt = performance.now() - 5_100;

    internals.handleCapture({ pcm: new ArrayBuffer(2), level: 0 });

    expect(track.enabled).toBe(false);
    expect(onAutoCommit).toHaveBeenCalledOnce();
  });
});

describe("BrowserInterviewAudio startup resilience", () => {
  it("keeps playback available when microphone acquisition fails and retries capture later", async () => {
    const track = { enabled: true, stop: vi.fn() };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(() => gain),
      disconnect: vi.fn(),
    };
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      currentTime: 0,
      destination: {},
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => gain),
      createMediaStreamSource: vi.fn(() => source),
    };
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(stream);
    vi.stubGlobal(
      "AudioContext",
      function MockAudioContext() {
        return context;
      },
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      function MockAudioWorkletNode() {
        return {
          connect: vi.fn(() => gain),
          disconnect: vi.fn(),
          port: { onmessage: undefined },
        };
      },
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const audio = new BrowserInterviewAudio({
      onLevel: vi.fn(),
      onAutoCommit: vi.fn(),
      onSpeakingChange: vi.fn(),
    });

    await expect(audio.start(vi.fn())).resolves.toBe(false);
    expect(gain.gain.value).toBe(0.8);
    expect(context.close).not.toHaveBeenCalled();
    await expect(audio.start(vi.fn())).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    audio.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("stops a microphone stream that resolves after startup was cancelled", async () => {
    let resolveMedia: ((stream: MediaStream) => void) | undefined;
    const track = { enabled: true, stop: vi.fn() };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(() => gain),
      disconnect: vi.fn(),
    };
    const context = {
      destination: {},
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => gain),
    };
    vi.stubGlobal("AudioContext", function MockAudioContext() { return context; });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => {
          resolveMedia = resolve;
        })),
      },
    });

    const audio = new BrowserInterviewAudio({
      onLevel: vi.fn(),
      onAutoCommit: vi.fn(),
      onSpeakingChange: vi.fn(),
    });
    const starting = audio.start(vi.fn());
    await vi.waitFor(() => expect(resolveMedia).toBeTypeOf("function"));
    audio.stop();
    resolveMedia?.(stream);

    await expect(starting).resolves.toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
