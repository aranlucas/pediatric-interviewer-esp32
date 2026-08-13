const DISPLAY_TEXT_LIMIT = 380;

function normalizeDisplayText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function finalQuestion(value: string): string {
  const questionEnd = value.lastIndexOf("?");
  if (questionEnd < 0) return "";
  const beforeQuestion = value.slice(0, questionEnd + 1);
  const sentenceStart = Math.max(
    beforeQuestion.lastIndexOf(". ", questionEnd - 1),
    beforeQuestion.lastIndexOf("! ", questionEnd - 1),
  );
  return beforeQuestion.slice(sentenceStart < 0 ? 0 : sentenceStart + 2).trim();
}

/** Extracts the final spoken question for the device's compact prompt view. */
export function questionForDisplay(value: string, limit = 1_200): string {
  const cleaned = normalizeDisplayText(value);
  return (finalQuestion(cleaned) || cleaned).slice(0, limit);
}

/**
 * Fits the generated opening vignette into the ESP32 question view. When the
 * examiner is verbose, preserve both the clinical setup and the final question.
 */
export function openingPresentationForDisplay(value: string, limit = DISPLAY_TEXT_LIMIT): string {
  const cleaned = normalizeDisplayText(value);
  if (cleaned.length <= limit) return cleaned;

  const question = finalQuestion(cleaned);
  if (!question || question.length >= limit - 8) {
    return `${cleaned.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
  }

  const separator = "... ";
  const prefixLength = limit - separator.length - question.length;
  return `${cleaned.slice(0, prefixLength).trimEnd()}${separator}${question}`;
}
