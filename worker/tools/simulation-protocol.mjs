import { z } from "zod";

// Validate the wire fields these tools consume. Unrelated server fields are
// intentionally ignored so new protocol metadata remains backwards compatible.
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: z.string() }),
  z.object({
    type: z.literal("interview_state"),
    phase: z.string(),
    questionNumber: z.number().int().nonnegative(),
    domain: z.string(),
    question: z.string().optional(),
  }),
  z.object({ type: z.literal("transcript"), role: z.string(), text: z.string() }),
  z.object({ type: z.literal("transcript_end"), role: z.string(), text: z.string() }),
  z.object({
    type: z.literal("turn_complete"),
    answerCount: z.number().int().nonnegative(),
    questionNumber: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("interview_report"),
    reportId: z.string().min(1),
    outcome: z.string(),
    reviewPath: z.string(),
  }),
  z.object({
    type: z.literal("opening_audio_fallback"),
    stage: z.enum(["case", "first_question"]),
    bytes: z.number().int().positive(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("turn_recovery"), action: z.string(), message: z.string() }),
]);

export const interviewReportSchema = z.object({
  reportId: z.string().min(1),
  outcome: z.string(),
  reviewPath: z.string(),
});

const audioTurnSchema = z.object({
  text: z.string(),
  audio: z.object({ bytes: z.number(), peak: z.number(), nonzeroSamples: z.number() }),
});

export const simulationResultSchema = z.object({
  answersSimulated: z.number().int().nonnegative(),
  stoppedBeforeQuestion: z.number().int().nonnegative().optional(),
  phase: z.string().optional(),
  commitsSent: z.number().int().nonnegative(),
  prematureStops: z.number().int().nonnegative(),
  followUps: z.object({ total: z.number(), perQuestion: z.array(z.number()) }),
  candidateTranscripts: z.array(z.string()),
  primaryQuestions: z.array(z.string()),
  openingTurns: z.array(audioTurnSchema),
  openingAudioFallbacks: z.array(
    z.object({ stage: z.enum(["case", "first_question"]), bytes: z.number() }),
  ),
  firstQuestionTurn: audioTurnSchema.nullable(),
  turnCompletions: z.array(z.object({ answerCount: z.number(), questionNumber: z.number() })),
  openingTurnCompletionCount: z.number(),
  report: interviewReportSchema.nullable(),
  outputAudio: z.object({
    frames: z.number(),
    bytes: z.number(),
    maximumFrameBytes: z.number(),
    oddFrames: z.number(),
  }),
});

export const simulationCompleteSchema = simulationResultSchema.extend({
  event: z.literal("simulation_complete"),
});

export const storedReportSchema = z.object({
  reportId: z.string().min(1),
  evaluatorModel: z.string().optional(),
  evaluation: z.object({ exchanges: z.array(z.unknown()) }),
  cheatsheet: z.unknown().optional(),
});

/** @typedef {z.infer<typeof simulationResultSchema>} SimulationResult */
/** @typedef {z.infer<typeof interviewReportSchema>} InterviewReport */
/** @typedef {{ baseUrl: string, token: string }} InterviewerSettings */

/**
 * ws emits buffers, buffer fragments, or an ArrayBuffer depending on binaryType.
 * Normalize all supported forms before decoding JSON or reading PCM samples.
 * @param {import("ws").RawData} data
 * @returns {Buffer}
 */
export function webSocketBuffer(data) {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);

  return data;
}
