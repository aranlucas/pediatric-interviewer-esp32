export const INPUT_SAMPLE_RATE = 24_000;
export const DEFAULT_OUTPUT_VOLUME = 0.8;
const SILENCE_MS = 5_000;
const SPEECH_LEVEL = 0.025;
const MAX_PLAYBACK_QUEUE = 32;

type AudioCallbacks = {
  onCaptureUnavailable?: () => void;
  onLevel: (level: number) => void;
  onAutoCommit: () => void;
  onSpeakingChange: (speaking: boolean) => void;
};

type PlaybackChunk = { data: ArrayBuffer; sampleRate: number };

export class BrowserInterviewAudio {
  private context?: AudioContext;
  private media?: MediaStream;
  private captureSource?: MediaStreamAudioSourceNode;
  private captureNode?: AudioWorkletNode;
  private silentGain?: GainNode;
  private playbackGain?: GainNode;
  private playbackAt = 0;
  private playbackSources = new Set<AudioBufferSourceNode>();
  private playbackQueue: PlaybackChunk[] = [];
  private playbackDrain?: Promise<void>;
  private playbackGeneration = 0;
  private startPromise?: Promise<boolean>;
  private send?: (data: ArrayBuffer) => void;
  private listeningRequested = false;
  private captureEnabled = false;
  private muted = false;
  private heardSpeech = false;
  private lastSpeechAt = 0;
  private commitSent = false;
  private lastLevelEmittedAt = 0;
  private lifecycleGeneration = 0;

  constructor(private readonly callbacks: AudioCallbacks) {}

  async start(send: (data: ArrayBuffer) => void): Promise<boolean> {
    this.send = send;
    if (this.startPromise) return this.startPromise;
    const generation = this.lifecycleGeneration;
    const startPromise = this.initialize(generation);
    this.startPromise = startPromise;
    return startPromise.finally(() => {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    });
  }

  private async initialize(generation: number): Promise<boolean> {
    if (this.context && this.media) {
      const tracks = this.media.getAudioTracks();
      if (tracks.length > 0 && tracks.some((track) => track.readyState !== "ended")) {
        await this.context.resume();
        return generation === this.lifecycleGeneration;
      }
      this.cleanupCapture();
    }
    if (!this.context || !this.playbackGain) {
      if (this.context || this.media || this.captureNode) this.cleanup();
      try {
        const context = new AudioContext({
          latencyHint: "interactive",
          sampleRate: INPUT_SAMPLE_RATE,
        });
        this.context = context;
        this.playbackGain = context.createGain();
        this.playbackGain.gain.value = DEFAULT_OUTPUT_VOLUME;
        this.playbackGain.connect(context.destination);
        // Unlock playback while this method is still running from the topic-button gesture.
        await context.resume();
        if (generation !== this.lifecycleGeneration) {
          this.cleanup();
          return false;
        }
      } catch (error) {
        this.cleanup();
        throw error;
      }
    }

    return this.initializeCapture(generation);
  }

  private async initializeCapture(generation: number): Promise<boolean> {
    const context = this.context;
    if (!context) return false;
    try {
      await context.audioWorklet.addModule("/audio-capture.worklet.js");
      if (generation !== this.lifecycleGeneration || context !== this.context) return false;
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generation !== this.lifecycleGeneration || context !== this.context) {
        for (const track of media.getTracks()) track.stop();
        return false;
      }
      this.media = media;
      for (const track of media.getAudioTracks()) track.onended = this.handleCaptureEnded;
      this.syncMicrophoneTrack();
      this.captureSource = context.createMediaStreamSource(this.media);
      this.captureNode = new AudioWorkletNode(context, "pcm-capture");
      this.silentGain = context.createGain();
      this.silentGain.gain.value = 0;
      this.captureSource.connect(this.captureNode);
      this.captureNode.connect(this.silentGain).connect(context.destination);
      this.captureNode.port.onmessage = (
        event: MessageEvent<{ pcm: ArrayBuffer; level: number }>,
      ) => {
        this.handleCapture(event.data);
      };
      await context.resume();
      this.syncCaptureState();
      return true;
    } catch {
      // Microphone permission/device failures must not discard an already-unlocked
      // playback graph: the examiner can still speak while the candidate types.
      this.cleanupCapture();
      return false;
    }
  }

  private handleCapture({ pcm, level }: { pcm: ArrayBuffer; level: number }): void {
    const now = performance.now();
    if (now - this.lastLevelEmittedAt >= 80) {
      this.lastLevelEmittedAt = now;
      this.callbacks.onLevel(Math.min(1, level * 8));
    }
    if (!this.captureEnabled || this.muted) return;
    // Do not open a provider audio turn for ambient silence. Besides wasting
    // bandwidth, an empty audio turn prevents the candidate from switching to
    // the typed-answer fallback while the interviewer is listening.
    if (!this.heardSpeech && level < SPEECH_LEVEL) return;
    this.send?.(pcm);
    if (level >= SPEECH_LEVEL) {
      this.heardSpeech = true;
      this.lastSpeechAt = now;
      this.commitSent = false;
      return;
    }
    if (this.heardSpeech && !this.commitSent && now - this.lastSpeechAt >= SILENCE_MS) {
      this.commitSent = true;
      this.listeningRequested = false;
      this.captureEnabled = false;
      this.syncMicrophoneTrack();
      this.callbacks.onAutoCommit();
    }
  }

  setListening(listening: boolean): void {
    this.listeningRequested = listening;
    this.syncCaptureState();
  }

  private syncCaptureState(): void {
    const wasEnabled = this.captureEnabled;
    this.captureEnabled = this.listeningRequested && this.playbackSources.size === 0;
    this.syncMicrophoneTrack();
    if (this.captureEnabled && !wasEnabled) {
      this.heardSpeech = false;
      this.commitSent = false;
      this.lastSpeechAt = performance.now();
    }
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    // Speech heard before a mute boundary must never complete a later turn.
    // Reset VAD on both mute and unmute so a long mute cannot produce a stale
    // five-second-silence commit as soon as capture resumes.
    this.heardSpeech = false;
    this.commitSent = false;
    this.lastSpeechAt = performance.now();
    this.syncMicrophoneTrack();
  }

  private syncMicrophoneTrack(): void {
    const enabled = this.captureEnabled && !this.muted;
    for (const track of this.media?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  setVolume(volume: number): void {
    if (this.playbackGain) this.playbackGain.gain.value = Math.max(0, Math.min(1, volume));
  }

  private readonly handleCaptureEnded = (): void => {
    if (!this.media) return;
    this.cleanupCapture();
    this.callbacks.onCaptureUnavailable?.();
  };

  async playPcm16(data: ArrayBuffer, sampleRate = INPUT_SAMPLE_RATE): Promise<void> {
    if (data.byteLength < 2) return;
    if (data.byteLength % 2 !== 0) throw new Error("Received an invalid PCM16 frame.");
    if (!this.context || !this.playbackGain) return;

    if (this.playbackQueue.length >= MAX_PLAYBACK_QUEUE) {
      // Examiner audio is ephemeral. Drop the oldest queued frame rather than allowing
      // a delayed network burst to grow memory or play stale questions after recovery.
      this.playbackQueue.shift();
    }
    this.playbackQueue.push({ data, sampleRate });
    if (!this.playbackDrain) this.playbackDrain = this.drainPlayback();
    try {
      await this.playbackDrain;
    } catch (error) {
      this.playbackQueue = [];
      this.callbacks.onSpeakingChange(false);
      throw error;
    }
  }

  private async drainPlayback(): Promise<void> {
    try {
      while (this.playbackQueue.length > 0) {
        const chunk = this.playbackQueue.shift();
        if (!chunk) continue;
        await this.schedulePcm16(chunk.data, chunk.sampleRate, this.playbackGeneration);
      }
    } finally {
      this.playbackDrain = undefined;
    }
  }

  private async schedulePcm16(
    data: ArrayBuffer,
    sampleRate: number,
    generation: number,
  ): Promise<void> {
    const context = this.context;
    const playbackGain = this.playbackGain;
    if (!context || !playbackGain) return;
    await context.resume();
    if (generation !== this.playbackGeneration) return;
    const pcm = new Int16Array(data);
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackGain);
    const startAt = Math.max(context.currentTime + 0.025, this.playbackAt);
    this.playbackAt = startAt + buffer.duration;
    this.playbackSources.add(source);
    // The server can mark the next question as listening before the browser has
    // drained its scheduled PCM. Keep speaker output out of the microphone.
    this.syncCaptureState();
    this.callbacks.onSpeakingChange(true);
    source.onended = () => this.finishPlayback(source);
    try {
      source.start(startAt);
    } catch (error) {
      this.playbackSources.delete(source);
      this.syncCaptureState();
      throw error;
    }
  }

  private finishPlayback(source: AudioBufferSourceNode): void {
    this.playbackSources.delete(source);
    if (this.playbackSources.size !== 0 || this.playbackQueue.length !== 0) return;
    this.callbacks.onSpeakingChange(false);
    this.syncCaptureState();
  }

  interruptPlayback(): void {
    this.playbackGeneration += 1;
    this.playbackQueue = [];
    for (const source of this.playbackSources) {
      try {
        source.stop();
      } catch {
        // An already-ended source is safe to discard.
      }
    }
    this.playbackSources.clear();
    this.playbackAt = this.context?.currentTime ?? 0;
    this.callbacks.onSpeakingChange(false);
    this.syncCaptureState();
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.startPromise = undefined;
    this.listeningRequested = false;
    this.captureEnabled = false;
    this.interruptPlayback();
    this.cleanup();
  }

  private cleanup(): void {
    const context = this.context;
    this.cleanupCapture();
    this.playbackGain?.disconnect();
    this.playbackGain = undefined;
    this.context = undefined;
    this.send = undefined;
    this.playbackQueue = [];
    this.playbackDrain = undefined;
    if (context) void context.close().catch(() => undefined);
  }

  private cleanupCapture(): void {
    const media = this.media;
    this.media = undefined;
    for (const track of media?.getTracks() ?? []) {
      if (track.onended === this.handleCaptureEnded) track.onended = null;
      track.stop();
    }
    this.captureSource?.disconnect();
    this.captureNode?.disconnect();
    this.silentGain?.disconnect();
    this.captureSource = undefined;
    this.captureNode = undefined;
    this.silentGain = undefined;
    this.captureEnabled = false;
  }
}
