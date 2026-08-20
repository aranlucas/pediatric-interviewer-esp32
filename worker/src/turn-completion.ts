/**
 * Turn-boundary decisions for the Gemini Live stream.
 *
 * Gemini reports `generationComplete` when it stops generating and follows it
 * with `turnComplete` when the turn is actually over. Audio and transcription
 * can still be arriving between the two. Treating the earlier signal as the
 * end of a turn advances the interview before the complete response is queued.
 *
 * These predicates are pure so the sequencing can be tested without a live
 * Durable Object, a WebSocket, or Gemini.
 */

export interface CompletionSignal {
  generationComplete?: boolean;
  turnComplete?: boolean;
}

/** Whether a serverContent message reports any kind of response completion. */
export function isResponseComplete(signal: CompletionSignal): boolean {
  return Boolean(signal.generationComplete || signal.turnComplete);
}

/**
 * Whether a completion signal should end the current turn.
 *
 * `generationComplete` is a useful UI/input signal, but it is not the turn
 * boundary: the provider may still be draining playback. Every phase uses the
 * definitive `turnComplete` boundary so normal turns and opening turns have
 * identical ordering semantics.
 */
export function shouldEndTurn(signal: CompletionSignal, openingInProgress: boolean): boolean {
  void openingInProgress;
  return Boolean(signal.turnComplete);
}
