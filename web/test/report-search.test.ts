import { describe, expect, it } from "vitest";

import { reportMatchesQuery } from "../lib/report-search";
import type { ReportListItem } from "../lib/report-search";

const REPORT: ReportListItem = {
  reportId: "123e4567-e89b-42d3-a456-426614174000",
  generatedAt: "2026-08-23T18:30:00.000Z",
  outcome: "not_yet",
  averageScore: 2.5,
  answeredQuestions: 3,
  configuredQuestions: 4,
  difficulty: "Hard",
  topicLabel: "Behavior Guidance",
  fileCount: 2,
};

describe("report search", () => {
  it("matches candidate-facing report fields", () => {
    expect(reportMatchesQuery(REPORT, "behavior", "America/Los_Angeles")).toBe(true);
    expect(reportMatchesQuery(REPORT, "not yet", "America/Los_Angeles")).toBe(true);
    expect(reportMatchesQuery(REPORT, "2.5/3", "America/Los_Angeles")).toBe(true);
    expect(reportMatchesQuery(REPORT, "hard", "America/Los_Angeles")).toBe(true);
    expect(reportMatchesQuery(REPORT, "Aug 23", "America/Los_Angeles")).toBe(true);
  });

  it("handles empty and unmatched queries", () => {
    expect(reportMatchesQuery(REPORT, "   ", "America/Los_Angeles")).toBe(true);
    expect(reportMatchesQuery(REPORT, "pulp therapy", "America/Los_Angeles")).toBe(false);
  });
});
