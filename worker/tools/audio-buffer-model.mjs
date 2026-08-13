const PCM_BYTES_PER_MILLISECOND = (16_000 * 2) / 1_000;

export function simulatePlaybackBuffer({
  durationMs = 30_000,
  frameBytes = 3_200,
  nominalFrameMs = 100,
  maximumJitterMs = 350,
  prebufferBytes = 16 * 1_024,
  capacityBytes = 128 * 1_024,
} = {}) {
  const arrivals = [];
  let previousArrival = 0;
  for (let ideal = 0, index = 0; ideal < durationMs; ideal += nominalFrameMs, index += 1) {
    const delayed = index % 10 === 6 ? maximumJitterMs : 0;
    const arrival = Math.max(previousArrival, ideal + delayed);
    arrivals.push(arrival);
    previousArrival = arrival;
  }

  let buffered = 0;
  let playbackStarted = false;
  let previousTime = 0;
  let underruns = 0;
  let overflows = 0;
  let maximumBufferedBytes = 0;
  let maximumArrivalGapMs = 0;

  for (const [index, arrival] of arrivals.entries()) {
    const elapsed = arrival - previousTime;
    if (index > 0) maximumArrivalGapMs = Math.max(maximumArrivalGapMs, elapsed);
    if (playbackStarted) {
      const drained = elapsed * PCM_BYTES_PER_MILLISECOND;
      if (drained >= buffered) {
        if (buffered > 0 && drained > buffered) underruns += 1;
        buffered = 0;
        playbackStarted = false;
      } else {
        buffered -= drained;
      }
    }
    buffered += frameBytes;
    if (buffered > capacityBytes) {
      overflows += 1;
      buffered = capacityBytes;
    }
    maximumBufferedBytes = Math.max(maximumBufferedBytes, buffered);
    if (!playbackStarted && buffered >= prebufferBytes) playbackStarted = true;
    previousTime = arrival;
  }

  return {
    arrivals: arrivals.length,
    maximumArrivalGapMs,
    maximumBufferedBytes,
    underruns,
    overflows,
    passed: underruns === 0 && overflows === 0,
  };
}
