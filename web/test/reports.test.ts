import { describe, expect, it, vi } from "vitest";

import {
  getPublicReportJson,
  listCompletedReports,
  publicReportObjectKey,
  summarizeStoredReport,
} from "../lib/reports";

const REPORT_ID = "01234567-89ab-4cde-8123-0123456789ab";

describe("completed report library", () => {
  it("summarizes a stored report for the index", () => {
    const summary = summarizeStoredReport(
      {
        reportId: REPORT_ID,
        sessionId: "web-0123456789abcdef0123456789abcdef",
        generatedAt: "2026-08-23T02:46:59.913Z",
        evaluatorModel: "gemini-test",
        configuration: { questionCount: 3, difficulty: "standard" },
        topic: { id: "behavior_guidance", label: "Behavior Guidance" },
        evaluation: {
          outcome: "pass",
          scoreSummary: [
            { skillset: "Opening", score: 3 },
            { skillset: "Plan", score: 2 },
          ],
          exchanges: [{ question: "One", answer: "Answer" }],
        },
      },
      {
        reportId: REPORT_ID,
        json: `pediatric-oral-boards/public-reports/${REPORT_ID}.json`,
        markdown: `pediatric-oral-boards/public-reports/${REPORT_ID}.md`,
        cheatsheet: `pediatric-oral-boards/public-reports/${REPORT_ID}-cheatsheet.md`,
        lastModified: "2026-08-23T02:47:00.000Z",
      },
    );

    expect(summary).toMatchObject({
      reportId: REPORT_ID,
      averageScore: 2.5,
      answeredQuestions: 1,
      configuredQuestions: 3,
      outcome: "pass",
      topicLabel: "Behavior Guidance",
      artifacts: { json: true, markdown: true, cheatsheet: true },
    });
    expect(summary).not.toHaveProperty("sessionId");
  });

  it("builds only deterministic, validated public object keys", () => {
    expect(publicReportObjectKey(REPORT_ID, "report")).toBe(
      `pediatric-oral-boards/public-reports/${REPORT_ID}.md`,
    );
    expect(publicReportObjectKey(REPORT_ID, "cheatsheet")).toBe(
      `pediatric-oral-boards/public-reports/${REPORT_ID}-cheatsheet.md`,
    );
    expect(publicReportObjectKey(REPORT_ID, "json")).toBe(
      `pediatric-oral-boards/public-reports/${REPORT_ID}.json`,
    );
    expect(publicReportObjectKey("../../private", "report")).toBeNull();
  });

  it("paginates the curated R2 report archive", async () => {
    const olderId = "11111111-1111-4111-8111-111111111111";
    const newerId = "22222222-2222-4222-8222-222222222222";
    const uploaded = new Date("2026-08-23T02:47:00.000Z");
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: `pediatric-oral-boards/public-reports/${olderId}.json`, uploaded }],
        truncated: true,
        cursor: "page-two",
      })
      .mockResolvedValueOnce({
        objects: [{ key: `pediatric-oral-boards/public-reports/${newerId}.json`, uploaded }],
        truncated: false,
      });
    const get = vi.fn(async (key: string) => {
      const reportId = key.includes(newerId) ? newerId : olderId;
      const generatedAt = reportId === newerId
        ? "2026-08-23T03:00:00.000Z"
        : "2026-08-23T01:00:00.000Z";
      const body = JSON.stringify({
        reportId,
        generatedAt,
        configuration: { questionCount: 1 },
        topic: { label: "Behavior Guidance" },
        evaluation: { outcome: "pass", exchanges: [], scoreSummary: [] },
      });
      return { size: body.length, text: async () => body };
    });

    const reports = await listCompletedReports({ list, get } as unknown as R2Bucket);

    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "pediatric-oral-boards/public-reports/",
      limit: 1_000,
      cursor: undefined,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "pediatric-oral-boards/public-reports/",
      limit: 1_000,
      cursor: "page-two",
    });
    expect(reports.map((report) => report.reportId)).toEqual([newerId, olderId]);
  });

  it("redacts the private room identifier from public JSON downloads", async () => {
    const body = JSON.stringify({
      reportId: REPORT_ID,
      sessionId: "web-0123456789abcdef0123456789abcdef",
      evaluation: { outcome: "pass" },
    });
    const get = vi.fn().mockResolvedValue({
      size: body.length,
      text: async () => body,
    });

    const publicBody = await getPublicReportJson({ get } as unknown as R2Bucket, REPORT_ID);

    expect(JSON.parse(publicBody!)).toEqual({
      reportId: REPORT_ID,
      evaluation: { outcome: "pass" },
    });
    expect(get).toHaveBeenCalledWith(`pediatric-oral-boards/public-reports/${REPORT_ID}.json`);
  });
});
