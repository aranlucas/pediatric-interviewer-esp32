import { describe, expect, it, vi } from "vitest";

import { BrowserInterviewAudio } from "../lib/browser-audio";
import type {
  AudioGain,
  AudioGraphNode,
  CaptureNode,
  CaptureStream,
  CaptureTrack,
  InterviewAudioContext,
  InterviewAudioPlatform,
  PlaybackSource,
} from "../lib/audio-platform";

class FakeNode implements AudioGraphNode {
  connect = vi.fn((destination: AudioGraphNode) => destination);
  disconnect = vi.fn();
}

class FakeSource extends FakeNode implements PlaybackSource {
  buffer: PlaybackSource["buffer"] = null;
  onended: PlaybackSource["onended"] = null;
  start = vi.fn();
  stop = vi.fn();
  finish() {
    this.onended?.(new Event("ended"));
  }
}

class FakeTrack implements CaptureTrack {
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  onended: CaptureTrack["onended"] = null;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  end() {
    this.readyState = "ended";
    this.onended?.(new Event("ended"));
  }
}

class FakeCapture extends FakeNode implements CaptureNode {
  port: CaptureNode["port"] = { onmessage: null };
  emit(level: number) {
    this.port.onmessage?.(
      new MessageEvent("message", { data: { pcm: new ArrayBuffer(2), level } }),
    );
  }
}

function audioHarness() {
  let now = 100;
  const track = new FakeTrack();
  const source = new FakeSource();
  const capture = new FakeCapture();
  const gain: AudioGain = Object.assign(new FakeNode(), { gain: { value: 1 } });

  const stream: CaptureStream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    createSource: () => new FakeNode(),
  };

  const acquireMedia = vi.fn<InterviewAudioContext["acquireMedia"]>().mockResolvedValue(stream);

  const context: InterviewAudioContext = {
    currentTime: 0,
    destination: new FakeNode(),
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createGain: () => gain,
    createBuffer: (_channels, length, rate) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => source,
    acquireMedia,
    createCaptureNode: () => capture,
  };

  const platform: InterviewAudioPlatform = { createContext: () => context, now: () => now };
  const onAutoCommit = vi.fn();
  const onCaptureUnavailable = vi.fn();
  const send = vi.fn();

  const audio = new BrowserInterviewAudio(
    { onCaptureUnavailable, onLevel: vi.fn(), onAutoCommit, onSpeakingChange: vi.fn() },
    platform,
  );

  return {
    audio,
    track,
    source,
    capture,
    gain,
    stream,
    context,
    acquireMedia,
    onAutoCommit,
    onCaptureUnavailable,
    send,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function startedAudio() {
  const harness = audioHarness();
  await harness.audio.start(harness.send);

  return harness;
}

describe("BrowserInterviewAudio microphone gating", () => {
  it("enables capture only during the listening state", async () => {
    const { audio, track } = await startedAudio();
    audio.setListening(false);
    expect(track.enabled).toBe(false);
    audio.setListening(true);
    expect(track.enabled).toBe(true);
    audio.setListening(false);
    expect(track.enabled).toBe(false);
  });

  it("does not open an audio turn until speech is detected", async () => {
    const { audio, capture, send } = await startedAudio();
    audio.setListening(true);
    capture.emit(0);
    expect(send).not.toHaveBeenCalled();
    capture.emit(0.03);
    capture.emit(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the microphone disabled while muted", async () => {
    const { audio, track } = await startedAudio();
    audio.setListening(true);
    audio.setMuted(true);
    expect(track.enabled).toBe(false);
    audio.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  it("does not submit stale speech after a long mute boundary", async () => {
    const { audio, capture, advance, onAutoCommit } = await startedAudio();
    audio.setListening(true);
    capture.emit(0.03);
    audio.setMuted(true);
    advance(10_000);
    audio.setMuted(false);
    capture.emit(0);
    expect(onAutoCommit).not.toHaveBeenCalled();
  });

  it("opens the fallback path when an active microphone track ends", async () => {
    const { onCaptureUnavailable, track } = await startedAudio();
    track.end();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(onCaptureUnavailable).toHaveBeenCalledOnce();
  });

  it("waits for queued examiner audio to finish before enabling the microphone", async () => {
    const { audio, track, source } = await startedAudio();
    await audio.playPcm16(new ArrayBuffer(2));
    audio.setListening(true);
    expect(track.enabled).toBe(false);
    source.finish();
    expect(track.enabled).toBe(true);
  });

  it("commits an answer after five seconds of silence", async () => {
    const { audio, capture, advance, onAutoCommit, track } = await startedAudio();
    audio.setListening(true);
    capture.emit(0.03);
    advance(4_900);
    capture.emit(0);
    expect(track.enabled).toBe(true);
    expect(onAutoCommit).not.toHaveBeenCalled();
    advance(200);
    capture.emit(0);
    expect(track.enabled).toBe(false);
    expect(onAutoCommit).toHaveBeenCalledOnce();
  });
});

describe("BrowserInterviewAudio startup resilience", () => {
  it("keeps playback available when microphone acquisition fails and retries capture later", async () => {
    const { audio, acquireMedia, stream, gain, context, track, send } = audioHarness();
    acquireMedia
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(stream);
    await expect(audio.start(send)).resolves.toBe(false);
    expect(gain.gain.value).toBe(0.8);
    expect(context.close).not.toHaveBeenCalled();
    await expect(audio.start(send)).resolves.toBe(true);
    expect(acquireMedia).toHaveBeenCalledTimes(2);
    audio.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("stops a microphone stream that resolves after startup was cancelled", async () => {
    const { audio, acquireMedia, stream, context, track, send } = audioHarness();
    let resolveMedia: ((stream: CaptureStream) => void) | undefined;
    acquireMedia.mockImplementationOnce(
      () =>
        new Promise<CaptureStream>((resolve) => {
          resolveMedia = resolve;
        }),
    );
    const starting = audio.start(send);
    await vi.waitFor(() => expect(resolveMedia).toBeTypeOf("function"));
    audio.stop();
    resolveMedia?.(stream);
    await expect(starting).resolves.toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
