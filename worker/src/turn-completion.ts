/**
 * Turn-boundary decisions for the Gemini Live stream.
 *
 * Gemini reports `generationComplete` when it stops generating and follows it
 * with `turnComplete` when the turn is actually over. Audio for the turn can
 * still be arriving between the two. Treating the earlier signal as the end of
 * a turn ends it before its audio is queued, which truncated the spoken case
 * presentation and let one response advance the opening handshake twice.
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
 * While the opening handshake runs, only the definitive `turnComplete` ends a
 * turn. Once the interview is under way the earlier signal is accepted so the
 * candidate is not left waiting on a turn Gemini has already finished.
 */
export function shouldEndTurn(signal: CompletionSignal, openingInProgress: boolean): boolean {
  if (!isResponseComplete(signal)) return false;
  if (openingInProgress && signal.generationComplete && !signal.turnComplete) {
    return false;
  }
  return true;
}
