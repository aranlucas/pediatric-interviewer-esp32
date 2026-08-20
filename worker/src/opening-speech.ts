import { GoogleGenAI } from "@google/genai/web";

import { decodeBase64 } from "./pcm-audio";

export const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview" as const;

const DEFAULT_SAMPLE_RATE = 24_000;
const MAX_OPENING_TEXT_CHARACTERS = 4_000;
const MAX_OPENING_PCM_BYTES = 2_400_000;
const MAX_OPENING_WAV_BYTES = MAX_OPENING_PCM_BYTES + 64 * 1024;
const MAX_OPENING_AUDIO_BASE64_CHARACTERS = Math.ceil((MAX_OPENING_WAV_BYTES * 4) / 3) + 4;

export const OPENING_TTS_REQUEST_OPTIONS = {
  timeout: 30_000,
  maxRetries: 1,
} as const;

export type OpeningSpeechAudio = {
  channels?: number;
  data?: string;
  mime_type?: string;
  sample_rate?: number;
};

export type OpeningSpeech = {
  pcm: Uint8Array;
  sampleRate: number;
};

type OpeningAudioFormat = {
  kind: "pcm" | "wav";
  sampleRate?: number;
};

export function openingSpeechInteraction(text: string) {
  return {
    model: GEMINI_TTS_MODEL,
    input: text,
    store: false,
    response_format: {
      type: "audio" as const,
    },
    generation_config: {
      speech_config: [{ voice: "Charon" }],
    },
  };
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function openingAudioFormat(mimeType: string | undefined): OpeningAudioFormat | undefined {
  if (!mimeType) return undefined;
  const [mediaType, ...parameters] = mimeType
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  const kind =
    mediaType === "audio/wav" || mediaType === "audio/x-wav"
      ? "wav"
      : mediaType === "audio/l16" || mediaType === "audio/pcm"
        ? "pcm"
        : undefined;
  if (!kind) throw new Error("Gemini TTS returned an unexpected audio format.");

  let sampleRate: number | undefined;
  for (const parameter of parameters) {
    if (!parameter) continue;
    const [name, value] = parameter.split("=", 2).map((part) => part.trim());
    if (name === "codec" && value === "pcm") continue;
    if (name === "channels" && value === "1") continue;
    if ((name === "bits" || name === "bit_depth") && value === "16") continue;
    if (name !== "rate" || !/^\d{4,6}$/u.test(value ?? "")) {
      throw new Error(
        `Gemini TTS returned invalid audio format metadata: ${mimeType.slice(0, 120)}`,
      );
    }
    const parsed = Number(value);
    if (sampleRate !== undefined && sampleRate !== parsed) {
      throw new Error("Gemini TTS returned conflicting sample rates.");
    }
    sampleRate = parsed;
  }
  return { kind, sampleRate };
}

function decodePcmWav(bytes: Uint8Array): OpeningSpeech {
  if (
    bytes.byteLength < 44 ||
    fourCc(bytes, 0) !== "RIFF" ||
    fourCc(bytes, 8) !== "WAVE"
  ) {
    throw new Error("Gemini TTS returned an invalid WAV container.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEnd = view.getUint32(4, true) + 8;
  if (declaredEnd < 12 || declaredEnd > bytes.byteLength) {
    throw new Error("Gemini TTS returned a truncated WAV container.");
  }
  let format:
    | { channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number }
    | undefined;
  let pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= declaredEnd; ) {
    const chunkId = fourCc(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > declaredEnd) {
      throw new Error("Gemini TTS returned a malformed WAV chunk.");
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || view.getUint16(chunkStart, true) !== 1) {
        throw new Error("Gemini TTS returned unsupported WAV encoding.");
      }
      format = {
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    } else if (chunkId === "data" && !pcm) {
      pcm = bytes.slice(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  if (
    !format ||
    format.channels !== 1 ||
    format.bitsPerSample !== 16 ||
    format.blockAlign !== 2
  ) {
    throw new Error("Gemini TTS returned non-mono PCM16 WAV audio.");
  }
  if (
    !Number.isInteger(format.sampleRate) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 48_000
  ) {
    throw new Error("Gemini TTS returned an invalid WAV sample rate.");
  }
  if (
    !pcm ||
    pcm.byteLength < 2 ||
    pcm.byteLength % 2 !== 0 ||
    pcm.byteLength > MAX_OPENING_PCM_BYTES
  ) {
    throw new Error("Gemini TTS returned invalid or oversized WAV audio.");
  }
  return { pcm, sampleRate: format.sampleRate };
}

/** Validates bounded raw PCM or WAV Gemini TTS output. */
export function decodeOpeningSpeech(audio: OpeningSpeechAudio | undefined): OpeningSpeech {
  if (!audio?.data) throw new Error("Gemini TTS returned no audio data.");
  if (audio.data.length > MAX_OPENING_AUDIO_BASE64_CHARACTERS) {
    throw new Error("Gemini TTS returned oversized encoded audio.");
  }
  if (audio.channels !== undefined && audio.channels !== 1) {
    throw new Error("Gemini TTS returned non-mono audio.");
  }
  const format = openingAudioFormat(audio.mime_type);
  const bytes = Uint8Array.from(decodeBase64(audio.data));
  const hasWavHeader =
    bytes.byteLength >= 12 && fourCc(bytes, 0) === "RIFF" && fourCc(bytes, 8) === "WAVE";
  if (format?.kind === "wav" || (!format && hasWavHeader)) {
    const speech = decodePcmWav(bytes);
    const declaredSampleRate = audio.sample_rate ?? format?.sampleRate;
    if (
      audio.sample_rate !== undefined &&
      format?.sampleRate !== undefined &&
      audio.sample_rate !== format.sampleRate
    ) {
      throw new Error("Gemini TTS metadata has conflicting sample rates.");
    }
    if (declaredSampleRate !== undefined && declaredSampleRate !== speech.sampleRate) {
      throw new Error("Gemini TTS WAV metadata has a conflicting sample rate.");
    }
    return speech;
  }
  if (
    audio.sample_rate !== undefined &&
    format?.sampleRate !== undefined &&
    audio.sample_rate !== format.sampleRate
  ) {
    throw new Error("Gemini TTS metadata has conflicting sample rates.");
  }
  const sampleRate = audio.sample_rate ?? format?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
    throw new Error("Gemini TTS returned an invalid sample rate.");
  }
  const pcm = bytes;
  if (
    pcm.byteLength < 2 ||
    pcm.byteLength % 2 !== 0 ||
    pcm.byteLength > MAX_OPENING_PCM_BYTES
  ) {
    throw new Error("Gemini TTS returned invalid or oversized PCM audio.");
  }
  return { pcm, sampleRate };
}

/**
 * Uses the current Interactions API for exact-text speech when a Live turn
 * produces transcription but no PCM. The official TTS contract requests only
 * the audio modality; explicitly negotiating either L16 or WAV currently
 * fails against the deployed preview model. The response is not stored, and
 * its bounded raw PCM (or WAV, if returned) is validated before playback.
 */
export async function synthesizeOpeningSpeech(
  apiKey: string,
  text: string,
): Promise<OpeningSpeech> {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!apiKey.trim() || !normalized || normalized.length > MAX_OPENING_TEXT_CHARACTERS) {
    throw new Error("Opening speech input is invalid.");
  }
  const ai = new GoogleGenAI({ apiKey });
  const interaction = await ai.interactions.create(
    openingSpeechInteraction(normalized),
    OPENING_TTS_REQUEST_OPTIONS,
  );
  return decodeOpeningSpeech(interaction.output_audio);
}
