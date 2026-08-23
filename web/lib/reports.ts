import { isReportId } from "@/lib/server-auth";

const REPORT_PREFIX = "pediatric-oral-boards/reports/";
const REPORT_KEY_PATTERN =
  /^pediatric-oral-boards\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(-cheatsheet)?\.(json|md)$/iu;
const MAX_REPORT_BYTES = 1_000_000;
const MAX_MARKDOWN_BYTES = 500_000;

type JsonRecord = Record<string, unknown>;

type ReportArtifacts = {
  reportId: string;
  json?: string;
  markdown?: string;
  cheatsheet?: string;
  lastModified: string;
};

export type CompletedReport = {
  reportId: string;
  sessionId: string | null;
  generatedAt: string;
  outcome: string;
  averageScore: number | null;
  answeredQuestions: number;
  configuredQuestions: number;
  difficulty: string | null;
  topicLabel: string;
  topicId: string | null;
  evaluatorModel: string | null;
  artifacts: {
    json: boolean;
    markdown: boolean;
    cheatsheet: boolean;
  };
};

export type ReportDocumentKind = "report" | "cheatsheet";

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function reportArtifacts(objects: R2Object[]): ReportArtifacts[] {
  const grouped = new Map<string, ReportArtifacts>();
  for (const object of objects) {
    const match = REPORT_KEY_PATTERN.exec(object.key);
    if (!match) continue;
    const [, rawReportId, cheatsheetSuffix, extension] = match;
    const reportId = rawReportId.toLowerCase();
    const current = grouped.get(reportId) ?? {
      reportId,
      lastModified: object.uploaded.toISOString(),
    };
    if (cheatsheetSuffix) current.cheatsheet = object.key;
    else if (extension.toLowerCase() === "json") {
      current.json = object.key;
      current.lastModified = object.uploaded.toISOString();
    } else current.markdown = object.key;
    grouped.set(reportId, current);
  }
  return [...grouped.values()].filter((entry) => entry.json);
}

async function parseReportObject(object: R2ObjectBody): Promise<JsonRecord> {
  if (object.size > MAX_REPORT_BYTES) throw new Error("stored report is too large");
  const parsed = JSON.parse(await object.text()) as unknown;
  const value = record(parsed);
  if (!value) throw new Error("stored report is not a JSON object");
  return value;
}

export function summarizeStoredReport(
  report: JsonRecord,
  artifacts: ReportArtifacts,
): CompletedReport {
  const configuration = record(report.configuration);
  const topic = record(report.topic);
  const evaluation = record(report.evaluation);
  const exchanges = Array.isArray(evaluation?.exchanges) ? evaluation.exchanges : [];
  const scoreSummary = Array.isArray(evaluation?.scoreSummary) ? evaluation.scoreSummary : [];
  const scores = scoreSummary.flatMap((entry) => {
    const score = finiteNumber(record(entry)?.score);
    return score === null ? [] : [score];
  });
  const averageScore = scores.length
    ? scores.reduce((total, score) => total + score, 0) / scores.length
    : null;
  const configuredQuestions =
    finiteNumber(configuration?.questionCount) ?? exchanges.length;
  return {
    reportId: artifacts.reportId,
    sessionId: cleanString(report.sessionId),
    generatedAt: validDate(report.generatedAt, artifacts.lastModified),
    outcome: cleanString(evaluation?.outcome) ?? "unknown",
    averageScore,
    answeredQuestions: exchanges.length,
    configuredQuestions,
    difficulty: cleanString(configuration?.difficulty),
    topicLabel: cleanString(topic?.label) ?? cleanString(topic?.id) ?? "Unknown topic",
    topicId: cleanString(topic?.id),
    evaluatorModel: cleanString(report.evaluatorModel),
    artifacts: {
      json: Boolean(artifacts.json),
      markdown: Boolean(artifacts.markdown),
      cheatsheet: Boolean(artifacts.cheatsheet),
    },
  };
}

async function listReportObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: REPORT_PREFIX,
      limit: 1_000,
      cursor,
    });
    objects.push(...page.objects);
    if (page.truncated && !page.cursor) {
      throw new Error("R2 report listing was truncated without a cursor");
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function listCompletedReports(bucket: R2Bucket): Promise<CompletedReport[]> {
  const artifacts = reportArtifacts(await listReportObjects(bucket));
  const reports = await Promise.all(
    artifacts.map(async (entry) => {
      const object = await bucket.get(entry.json!);
      if (!object) return null;
      try {
        return summarizeStoredReport(await parseReportObject(object), entry);
      } catch {
        return null;
      }
    }),
  );
  return reports
    .filter((report): report is CompletedReport => report !== null)
    .toSorted(
      (left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt),
    );
}

export async function getCompletedReport(
  bucket: R2Bucket,
  reportId: string,
): Promise<CompletedReport | null> {
  if (!isReportId(reportId)) return null;
  const normalizedId = reportId.toLowerCase();
  const prefix = `${REPORT_PREFIX}${normalizedId}`;
  const [jsonObject, markdownObject, cheatsheetObject] = await Promise.all([
    bucket.get(`${prefix}.json`),
    bucket.head(`${prefix}.md`),
    bucket.head(`${prefix}-cheatsheet.md`),
  ]);
  if (!jsonObject) return null;
  try {
    return summarizeStoredReport(await parseReportObject(jsonObject), {
      reportId: normalizedId,
      json: `${prefix}.json`,
      ...(markdownObject ? { markdown: `${prefix}.md` } : {}),
      ...(cheatsheetObject ? { cheatsheet: `${prefix}-cheatsheet.md` } : {}),
      lastModified: jsonObject.uploaded.toISOString(),
    });
  } catch {
    return null;
  }
}

export function reportObjectKey(
  reportId: string,
  kind: "json" | ReportDocumentKind,
): string | null {
  if (!isReportId(reportId)) return null;
  const prefix = `${REPORT_PREFIX}${reportId.toLowerCase()}`;
  if (kind === "json") return `${prefix}.json`;
  return kind === "cheatsheet" ? `${prefix}-cheatsheet.md` : `${prefix}.md`;
}

export async function getReportMarkdown(
  bucket: R2Bucket,
  reportId: string,
  kind: ReportDocumentKind,
): Promise<string | null> {
  const key = reportObjectKey(reportId, kind);
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > MAX_MARKDOWN_BYTES) throw new Error("stored Markdown is too large");
  return object.text();
}
