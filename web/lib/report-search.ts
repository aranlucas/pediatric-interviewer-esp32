export type ReportListItem = {
  reportId: string;
  generatedAt: string;
  outcome: string;
  averageScore: number | null;
  answeredQuestions: number;
  configuredQuestions: number;
  difficulty: string | null;
  topicLabel: string;
  fileCount: number;
};

export function formatReportCompletedAt(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function reportScoreLabel(score: number | null): string {
  if (score === null) return "—";
  return `${Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1)}/3`;
}

export function reportOutcomeLabel(outcome: string): string {
  return outcome.replaceAll("_", " ");
}

export function reportMatchesQuery(
  report: ReportListItem,
  query: string,
  timezone: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [
    report.reportId,
    report.topicLabel,
    report.difficulty ?? "Unspecified difficulty",
    reportOutcomeLabel(report.outcome),
    reportScoreLabel(report.averageScore),
    formatReportCompletedAt(report.generatedAt, timezone),
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
