const MAX_LINE_LENGTH = 88;

export function sanitizeLine(value: string): string {
  const compact = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "Even the clouds have nothing useful to say.";
  if (compact.length <= MAX_LINE_LENGTH) return compact;

  const shortened = compact.slice(0, MAX_LINE_LENGTH - 1);
  const wordBoundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, Math.max(wordBoundary, 60)).trim()}...`;
}
