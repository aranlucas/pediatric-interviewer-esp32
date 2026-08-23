import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import { POST as accessReports } from "../app/api/report-library/access/route";
import { GET as downloadReport } from "../app/api/report-library/[reportId]/route";
import {
  createReportsAdminToken,
  REPORTS_ADMIN_COOKIE,
} from "../lib/reports-admin";

const SECRET = "reports-admin-secret-that-is-long-enough";
const REPORT_ID = "01234567-89ab-4cde-8123-0123456789ab";

beforeEach(() => {
  getCloudflareContext.mockReset();
});

describe("report library access", () => {
  it("exchanges a same-origin operator key for an HttpOnly admin cookie", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    getCloudflareContext.mockResolvedValue({
      env: { REPORTS_ADMIN_SECRET: SECRET, SESSION_RATE_LIMITER: { limit } },
    });
    const body = new FormData();
    body.set("accessKey", SECRET);

    const response = await accessReports(
      new Request("https://oral.example/api/report-library/access", {
        method: "POST",
        headers: { Origin: "https://oral.example", "CF-Connecting-IP": "192.0.2.20" },
        body,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("https://oral.example/reports");
    expect(response.headers.get("Set-Cookie")).toContain(`${REPORTS_ADMIN_COOKIE}=`);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    expect(limit).toHaveBeenCalledWith({ key: "reports:192.0.2.20" });
  });

  it("rejects cross-origin and invalid operator credentials", async () => {
    const crossOrigin = await accessReports(
      new Request("https://oral.example/api/report-library/access", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(getCloudflareContext).not.toHaveBeenCalled();

    getCloudflareContext.mockResolvedValue({
      env: {
        REPORTS_ADMIN_SECRET: SECRET,
        SESSION_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      },
    });
    const body = new FormData();
    body.set("accessKey", "incorrect-key-that-is-long-enough");
    const invalid = await accessReports(
      new Request("https://oral.example/api/report-library/access", {
        method: "POST",
        headers: { Origin: "https://oral.example" },
        body,
      }),
    );
    expect(invalid.status).toBe(303);
    expect(invalid.headers.get("Location")).toContain("error=invalid");
    expect(invalid.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("report library downloads", () => {
  it("returns a private R2 artifact only for an admin session", async () => {
    const token = await createReportsAdminToken(SECRET);
    const get = vi.fn().mockResolvedValue({
      body: new Response("# Private report").body,
    });
    getCloudflareContext.mockResolvedValue({
      env: { REPORTS_ADMIN_SECRET: SECRET, INTERVIEW_REPORTS: { get } },
    });

    const response = await downloadReport(
      new Request(`https://oral.example/api/report-library/${REPORT_ID}?kind=report`, {
        headers: { Cookie: `${REPORTS_ADMIN_COOKIE}=${token}` },
      }),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Private report");
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Content-Disposition")).toContain(`${REPORT_ID}.md`);
    expect(get).toHaveBeenCalledWith(
      `pediatric-oral-boards/reports/${REPORT_ID}.md`,
    );
  });

  it("does not reveal report existence without an admin session", async () => {
    const get = vi.fn();
    getCloudflareContext.mockResolvedValue({
      env: { REPORTS_ADMIN_SECRET: SECRET, INTERVIEW_REPORTS: { get } },
    });

    const response = await downloadReport(
      new Request(`https://oral.example/api/report-library/${REPORT_ID}?kind=json`),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });
});
