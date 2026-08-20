/** Pure guards and timing helpers for the Gemini Live/DO transport boundary. */

/** Maximum PCM payload accepted from one device WebSocket frame. */
export const MAX_INPUT_PCM_BYTES = 32 * 1024;
export const MAX_INPUT_PCM_BYTES_PER_SECOND = 128 * 1024;
export const MAX_TRANSCRIPT_CHARACTERS = 4_000;
export const MAX_PROVIDER_AUDIO_BASE64_CHARACTERS = 512 * 1024;

/** Keeps incremental provider transcription bounded before turn normalization. */
export function appendBoundedTranscript(
  current: string,
  fragment: string,
  maxCharacters = MAX_TRANSCRIPT_CHARACTERS,
): string {
  const limit = Math.max(0, Math.trunc(maxCharacters));
  if (limit === 0 || current.length >= limit) return current.slice(0, limit);
  if (!current || !fragment) return `${current}${fragment}`.slice(0, limit);
  const needsWordBoundary =
    !/\s$/u.test(current) &&
    !/^[\s,.;:!?…\])}'’"—-]/u.test(fragment) &&
    !/[\[({'’"—-]$/u.test(current);
  return `${current}${needsWordBoundary ? " " : ""}${fragment}`.slice(0, limit);
}

/** Rejects implausibly large provider PCM chunks before base64 decoding. */
export function isBoundedProviderAudio(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PROVIDER_AUDIO_BASE64_CHARACTERS;
}

/**
 * Gemini receives signed 16-bit PCM. Rejecting malformed or unbounded frames
 * before base64 encoding keeps bad device data from becoming a provider error
 * or an avoidable Durable Object memory spike.
 */
export function isValidPcm16Input(audio: ArrayBuffer): boolean {
  return audio.byteLength > 0 && audio.byteLength <= MAX_INPUT_PCM_BYTES && audio.byteLength % 2 === 0;
}

/** Small bounded backoff for a provider transport reconnect. */
export function liveReconnectDelayMs(attempt: number, baseDelayMs: number): number {
  const boundedAttempt = Math.max(1, Math.min(4, Math.trunc(attempt)));
  return Math.max(0, baseDelayMs) * boundedAttempt;
}

/**
 * Drops audio from a buggy or hostile client that exceeds real-time PCM by a
 * wide margin. A 24 kHz mono PCM16 stream is 48,000 bytes/second; the default
 * budget leaves ample room for jitter and batched frames without allowing an
 * unbounded encode/provider-send loop.
 */
export class PcmInputRateGuard {
  private windowStartedAt = 0;
  private bytesInWindow = 0;

  constructor(
    private readonly maxBytes = MAX_INPUT_PCM_BYTES_PER_SECOND,
    private readonly windowMs = 1_000,
  ) {}

  accept(bytes: number, now = Date.now()): boolean {
    if (this.windowStartedAt === 0 || now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.bytesInWindow = 0;
    }
    if (bytes <= 0 || this.bytesInWindow + bytes > this.maxBytes) return false;
    this.bytesInWindow += bytes;
    return true;
  }

  reset(): void {
    this.windowStartedAt = 0;
    this.bytesInWindow = 0;
  }
}
