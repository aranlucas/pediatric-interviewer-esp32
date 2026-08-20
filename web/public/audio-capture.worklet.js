const TARGET_SAMPLE_RATE = 24000;
const TARGET_FRAME_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.02);

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.readPosition = 0;
    this.step = sampleRate / TARGET_SAMPLE_RATE;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    for (const sample of input) this.pending.push(sample);

    while (this.readPosition + 1 < this.pending.length) {
      const frame = new Float32Array(TARGET_FRAME_SAMPLES);
      let produced = 0;
      let position = this.readPosition;
      while (produced < frame.length && position + 1 < this.pending.length) {
        const lower = Math.floor(position);
        const fraction = position - lower;
        frame[produced] =
          this.pending[lower] * (1 - fraction) + this.pending[lower + 1] * fraction;
        produced += 1;
        position += this.step;
      }
      if (produced < frame.length) break;

      this.readPosition = position;
      const consumed = Math.max(0, Math.floor(this.readPosition));
      if (consumed > 0) {
        this.pending.splice(0, consumed);
        this.readPosition -= consumed;
      }

      let energy = 0;
      const pcm = new Int16Array(frame.length);
      for (let index = 0; index < frame.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, frame[index]));
        energy += sample * sample;
        pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      this.port.postMessage(
        { pcm: pcm.buffer, level: Math.sqrt(energy / frame.length) },
        [pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
