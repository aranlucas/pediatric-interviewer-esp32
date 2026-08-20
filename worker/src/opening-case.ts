import { GoogleGenAI } from "@google/genai/web";

import {
  difficultyInstruction,
  type InterviewDifficulty,
} from "./interview-config";
import { type InterviewTopic } from "./interview-content";
import { isValidOpeningCasePresentation } from "./gemini-live-protocol";

/** Stable, low-latency structured-output model used before the Live session. */
export const GEMINI_OPENING_CASE_MODEL = "gemini-3.5-flash-lite" as const;

const MAX_OPENING_CASE_RESPONSE_CHARACTERS = 4_000;
const MAX_OPENING_CASE_ATTEMPTS = 2;
const MIN_VIGNETTE_WORDS = 20;
const MAX_VIGNETTE_WORDS = 60;

export const OPENING_CASE_REQUEST_OPTIONS = {
  timeout: 20_000,
  maxRetries: 1,
} as const;

export const openingCaseJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    vignette: {
      type: "string",
      description:
        "A 20 to 60 spoken-word synthetic pediatric dentistry presentation with no question, diagnosis, answer, readiness prompt, or introductory label.",
    },
  },
  required: ["vignette"],
} as const;

export function openingCaseInteraction(
  topic: InterviewTopic,
  difficulty: InterviewDifficulty,
) {
  return {
    model: GEMINI_OPENING_CASE_MODEL,
    store: false,
    system_instruction:
      "Generate one synthetic pediatric dentistry oral-board opening vignette. " +
      "This is educational simulation content, not patient-specific medical advice. " +
      "Follow the requested domain boundary exactly and return only the schema-constrained JSON.",
    input:
      `Domain: ${topic.label}\n\n` +
      `Objectives: ${topic.objectives}\n\n` +
      `Case boundary: ${topic.caseScope}\n\n` +
      `Difficulty: ${difficulty}. ${difficultyInstruction(difficulty)}\n\n` +
      `Write ${MIN_VIGNETTE_WORDS} to ${MAX_VIGNETTE_WORDS} spoken words. ` +
      "Start with the child's age and presenting situation. Include only facts a candidate would reasonably receive at presentation. " +
      "Do not reveal the diagnosis, hidden findings, ideal plan, or answer. Do not ask a question. " +
      'Do not include "Here is your case" or "Are you ready to begin"; the runtime adds those exact boundaries.',
    response_format: {
      type: "text" as const,
      mime_type: "application/json" as const,
      schema: openingCaseJsonSchema,
    },
    generation_config: {
      thinking_level: "minimal" as const,
      max_output_tokens: 256,
    },
  };
}

function wordCount(value: string): number {
  return value.split(/\s+/u).filter(Boolean).length;
}

/**
 * Converts the structured response into the exact runtime-owned opening.
 * Schema conformance is not semantic validation, so every safety and product
 * boundary is checked again before the text can enter Durable Object state.
 */
export function parseOpeningCaseResponse(outputText: string | undefined): string {
  if (!outputText || outputText.length > MAX_OPENING_CASE_RESPONSE_CHARACTERS) {
    throw new Error("Gemini opening case returned an empty or oversized response.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("Gemini opening case returned invalid JSON.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { vignette?: unknown }).vignette !== "string"
  ) {
    throw new Error("Gemini opening case omitted the vignette.");
  }
  const rawVignette = (parsed as { vignette: string }).vignette;
  const vignette = rawVignette
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^here is your case(?:[.:,])?\s*/iu, "")
    .trim();
  const words = wordCount(vignette);
  if (
    words < MIN_VIGNETTE_WORDS ||
    words > MAX_VIGNETTE_WORDS ||
    vignette.includes("?") ||
    /\bare you ready to begin\b/iu.test(vignette)
  ) {
    throw new Error("Gemini opening case violated the spoken vignette boundary.");
  }
  const casePresentation = `Here is your case. ${vignette}`;
  if (!isValidOpeningCasePresentation(casePresentation)) {
    throw new Error("Gemini opening case failed runtime validation.");
  }
  return casePresentation;
}

/** Generates and semantically validates a synthetic case before Live connects. */
export async function generateOpeningCase(
  apiKey: string,
  topic: InterviewTopic,
  difficulty: InterviewDifficulty,
): Promise<string> {
  if (!apiKey.trim()) throw new Error("GEMINI_API_KEY is not configured.");
  const ai = new GoogleGenAI({ apiKey });
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_OPENING_CASE_ATTEMPTS; attempt += 1) {
    try {
      const interaction = await ai.interactions.create(
        openingCaseInteraction(topic, difficulty),
        OPENING_CASE_REQUEST_OPTIONS,
      );
      return parseOpeningCaseResponse(interaction.output_text);
    } catch (error) {
      lastError = error;
      console.warn(
        JSON.stringify({
          event: "gemini_opening_case_retry",
          attempt,
          reason: error instanceof Error ? error.message.slice(0, 160) : "unknown failure",
        }),
      );
    }
  }
  throw new Error("Gemini could not generate a valid opening case.", { cause: lastError });
}
