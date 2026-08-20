import { type OpeningSpeech } from "./opening-speech";

export const CLOUDFLARE_TTS_MODEL = "@cf/deepgram/aura-2-en" as const;
export const CLOUDFLARE_TTS_SAMPLE_RATE = 24_000;

const MAX_TTS_TEXT_CHARACTERS = 4_000;
const MAX_TTS_PCM_BYTES = 2_400_000;

async function readBoundedAudio(response: Response): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`Cloudflare TTS failed with HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TTS_PCM_BYTES) {
    throw new Error("Cloudflare TTS returned oversized audio.");
  }
  if (!response.body) throw new Error("Cloudflare TTS returned no audio body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_TTS_PCM_BYTES) {
        await reader.cancel("audio response too large").catch(() => undefined);
        throw new Error("Cloudflare TTS returned oversized audio.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (received < 2 || received % 2 !== 0) {
    throw new Error("Cloudflare TTS returned invalid PCM16 audio.");
  }
  const pcm = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // `container: none` must be raw PCM. Reject a provider regression to WAV or
  // another container instead of sending file headers to the audio device.
  if (
    pcm.byteLength >= 12 &&
    String.fromCharCode(...pcm.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...pcm.subarray(8, 12)) === "WAVE"
  ) {
    throw new Error("Cloudflare TTS unexpectedly returned a WAV container.");
  }
  return pcm;
}

/** Generates raw PCM through the Worker binding without exposing credentials. */
export async function synthesizeCloudflareSpeech(
  ai: Ai,
  text: string,
): Promise<OpeningSpeech> {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > MAX_TTS_TEXT_CHARACTERS) {
    throw new Error("Cloudflare TTS input is invalid.");
  }
  const response = await ai.run(
    CLOUDFLARE_TTS_MODEL,
    {
      text: normalized,
      speaker: "orpheus",
      encoding: "linear16",
      container: "none",
      sample_rate: CLOUDFLARE_TTS_SAMPLE_RATE,
    },
    {
      returnRawResponse: true,
      signal: AbortSignal.timeout(30_000),
      tags: ["angry-cat", "opening-tts"],
    },
  );
  return {
    pcm: await readBoundedAudio(response),
    sampleRate: CLOUDFLARE_TTS_SAMPLE_RATE,
  };
}
