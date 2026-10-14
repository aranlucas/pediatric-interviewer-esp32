import { z } from "zod";

const messageSchema = z.record(z.string(), z.json());

const statusSchema = z.enum([
  "idle",
  "thinking",
  "listening",
  "evaluating",
  "speaking",
  "complete",
  "error",
]);

export function parseInterviewMessage(text: string) {
  return messageSchema.parse(JSON.parse(text));
}

export function parseInterviewStatus(value: z.infer<ReturnType<typeof z.json>> | undefined) {
  const result = statusSchema.safeParse(value);

  return result.success ? result.data : null;
}

/** Only display textual protocol fields; nested JSON is not user-facing copy. */
export function interviewMessageText(
  value: z.infer<ReturnType<typeof z.json>> | undefined,
  fallback = "",
): string {
  return z.string().safeParse(value).data ?? fallback;
}
