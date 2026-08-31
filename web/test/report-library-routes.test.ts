import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import { GET as downloadReport } from "../app/api/report-library/[reportId]/route";

const REPORT_ID = "01234567-89ab-4cde-8123-0123456789ab";

beforeEach(() => {
  getCloudflareContext.mockReset();
});

describe("report library downloads", () => {
  it("returns a public R2 artifact without a cookie", async () => {
    const get = vi.fn().mockResolvedValue({
      body: new Response("# Public report").body,
    });
    getCloudflareContext.mockResolvedValue({
      env: { INTERVIEW_REPORTS: { get }, PUBLIC_REPORTS_ENABLED: "true" },
    });

    const response = await downloadReport(
      new Request(`https://oral.example/api/report-library/${REPORT_ID}?kind=report`),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Public report");
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Content-Disposition")).toContain(`${REPORT_ID}.md`);
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(get).toHaveBeenCalledWith(
      `pediatric-oral-boards/public-reports/${REPORT_ID}.md`,
    );
  });

  it("redacts private session metadata from an enabled public JSON download", async () => {
    const body = JSON.stringify({
      reportId: REPORT_ID,
      sessionId: "web-0123456789abcdef0123456789abcdef",
      evaluation: { outcome: "pass" },
    });
    const get = vi.fn().mockResolvedValue({
      size: body.length,
      text: async () => body,
    });
    getCloudflareContext.mockResolvedValue({
      env: { INTERVIEW_REPORTS: { get }, PUBLIC_REPORTS_ENABLED: "true" },
    });

    const response = await downloadReport(
      new Request(`https://oral.example/api/report-library/${REPORT_ID}?kind=json`),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reportId: REPORT_ID,
      evaluation: { outcome: "pass" },
    });
    expect(get).toHaveBeenCalledWith(
      `pediatric-oral-boards/public-reports/${REPORT_ID}.json`,
    );
  });

  it("returns not found for a missing public artifact", async () => {
    const get = vi.fn().mockResolvedValue(null);
    getCloudflareContext.mockResolvedValue({
      env: { INTERVIEW_REPORTS: { get }, PUBLIC_REPORTS_ENABLED: "true" },
    });

    const response = await downloadReport(
      new Request(`https://oral.example/api/report-library/${REPORT_ID}?kind=json`),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(404);
    expect(get).toHaveBeenCalledWith(
      `pediatric-oral-boards/public-reports/${REPORT_ID}.json`,
    );
  });

  it("does not read the bucket while public reports are disabled", async () => {
    const get = vi.fn();
    getCloudflareContext.mockResolvedValue({
      env: { INTERVIEW_REPORTS: { get }, PUBLIC_REPORTS_ENABLED: "false" },
    });

    const response = await downloadReport(
      new Request(`https://oral.example/api/report-library/${REPORT_ID}?kind=report`),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});
