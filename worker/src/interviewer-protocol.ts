import { z } from "zod";

import {
  INTERVIEW_DIFFICULTIES,
  MAX_INTERVIEW_QUESTION_COUNT,
  MIN_INTERVIEW_QUESTION_COUNT,
} from "./interview-config";

const deviceMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_call"),
    topic_id: z.string().max(64).optional(),
    topic_ids: z.array(z.string().max(64)).min(1).max(10).optional(),
    question_count: z
      .number()
      .int()
      .min(MIN_INTERVIEW_QUESTION_COUNT)
      .max(MAX_INTERVIEW_QUESTION_COUNT)
      .optional(),
    difficulty: z.enum(INTERVIEW_DIFFICULTIES).optional(),
  }),
  z.object({ type: z.literal("end_call") }),
  z.object({ type: z.literal("recover_report") }),
  z.object({ type: z.literal("commit_turn") }),
  z.object({
    type: z.literal("candidate_text"),
    text: z.string().trim().min(1).max(1_000),
  }),
]);

export type DeviceStatus =
  | "idle"
  | "thinking"
  | "listening"
  | "evaluating"
  | "speaking"
  | "error"
  | "complete";

export function parseInterviewerDeviceMessage(message: string) {
  try {
    const result = deviceMessageSchema.safeParse(JSON.parse(message));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
