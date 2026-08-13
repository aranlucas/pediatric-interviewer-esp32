import { Buffer } from "node:buffer";

export function decodeBase64(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

export function encodeBase64(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64");
}

/** Collects arbitrary PCM chunks into fixed-size frames without concatenation. */
export class PcmFramer {
  private frame: Uint8Array<ArrayBuffer>;
  private length = 0;

  constructor(private readonly frameBytes: number) {
    if (frameBytes < 2 || frameBytes % 2 !== 0) {
      throw new Error("PCM frame size must be a positive, even number.");
    }
    this.frame = new Uint8Array(frameBytes);
  }

  *write(input: Uint8Array): Generator<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(this.frameBytes - this.length, input.byteLength - offset);
      this.frame.set(input.subarray(offset, offset + copied), this.length);
      this.length += copied;
      offset += copied;

      if (this.length === this.frameBytes) {
        const completed = this.frame;
        this.frame = new Uint8Array(this.frameBytes);
        this.length = 0;
        yield completed;
      }
    }
  }

  flush(): Uint8Array<ArrayBuffer> | null {
    const length = this.length - (this.length % 2);
    const tail = length > 0 ? this.frame.slice(0, length) : null;
    this.clear();
    return tail;
  }

  clear(): void {
    this.frame = new Uint8Array(this.frameBytes);
    this.length = 0;
  }
}

export function resamplePcm16(
  input: Uint8Array,
  inputRate: number,
  outputRate: number,
): Uint8Array {
  if (input.byteLength < 2 || input.byteLength % 2 !== 0) {
    throw new Error("Audio provider returned invalid 16-bit PCM audio.");
  }
  if (inputRate <= 0 || outputRate <= 0) {
    throw new Error("PCM sample rates must be positive.");
  }
  if (inputRate === outputRate) return input.slice();

  const inputSamples = input.byteLength / 2;
  const outputSamples = Math.max(1, Math.floor((inputSamples * outputRate) / inputRate));
  const aligned = input.byteOffset % 2 === 0 ? input : input.slice();
  const source = new Int16Array(aligned.buffer, aligned.byteOffset, inputSamples);
  const output = new Int16Array(outputSamples);
  const ratio = inputRate / outputRate;

  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * ratio;
    const lower = Math.min(Math.floor(position), inputSamples - 1);
    const upper = Math.min(lower + 1, inputSamples - 1);
    const fraction = position - lower;
    output[index] = Math.round(source[lower] + (source[upper] - source[lower]) * fraction);
  }
  return new Uint8Array(output.buffer);
}
