import { z } from "zod";

const deviceMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_call"),
    topic_id: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal("end_call") }),
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
  | "complete";

export function parseInterviewerDeviceMessage(message: string) {
  try {
    const result = deviceMessageSchema.safeParse(JSON.parse(message));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
