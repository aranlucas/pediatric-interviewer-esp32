/** Browser capabilities consumed by the audio lifecycle, with no platform globals in tests. */
export interface AudioGraphNode {
  connect(destination: AudioGraphNode): AudioGraphNode;
  disconnect(): void;
}

export interface AudioGain extends AudioGraphNode {
  gain: { value: number };
}

export interface PcmBuffer {
  duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface PlaybackSource extends AudioGraphNode {
  buffer: PcmBuffer | null;
  onended: ((event: Event) => void) | null;
  start(at: number): void;
  stop(): void;
}

export interface CaptureTrack {
  enabled: boolean;
  readyState: MediaStreamTrackState;
  onended: ((event: Event) => void) | null;
  stop(): void;
}

export interface CaptureStream {
  getAudioTracks(): CaptureTrack[];
  getTracks(): CaptureTrack[];
  createSource(): AudioGraphNode;
}

export interface CaptureNode extends AudioGraphNode {
  port: { onmessage: ((event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => void) | null };
}

export interface InterviewAudioContext {
  readonly currentTime: number;
  destination: AudioGraphNode;
  audioWorklet: { addModule(url: string): Promise<void> };
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): AudioGain;
  createBuffer(channels: number, length: number, rate: number): PcmBuffer;
  createBufferSource(): PlaybackSource;
  acquireMedia(constraints: MediaStreamConstraints): Promise<CaptureStream>;
  createCaptureNode(): CaptureNode;
}

export interface InterviewAudioPlatform {
  createContext(options: AudioContextOptions): InterviewAudioContext;
  now(): number;
}

export const browserAudioPlatform: InterviewAudioPlatform = {
  now: () => performance.now(),
  createContext(options) {
    const context = new AudioContext(options);

    return {
      get currentTime() {
        return context.currentTime;
      },
      destination: context.destination,
      audioWorklet: context.audioWorklet,
      resume: () => context.resume(),
      close: () => context.close(),
      createGain: () => context.createGain(),
      createBuffer: (channels, length, rate) => context.createBuffer(channels, length, rate),
      createBufferSource: () => context.createBufferSource(),
      async acquireMedia(constraints) {
        const media = await navigator.mediaDevices.getUserMedia(constraints);

        return {
          getAudioTracks: () => media.getAudioTracks(),
          getTracks: () => media.getTracks(),
          createSource: () => context.createMediaStreamSource(media),
        };
      },
      createCaptureNode: () => new AudioWorkletNode(context, "pcm-capture"),
    };
  },
};
