import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import { GET as getReport } from "../app/api/reports/[reportId]/route";
import { POST as createSession } from "../app/api/session/route";
import {
  createAccessToken,
  REPORT_TOKEN_COOKIE,
  sessionOwnerCookieName,
  verifyAccessToken,
} from "../lib/server-auth";

const SECRET = "route-test-secret-that-is-long-enough";
const ROOM = "web-0123456789abcdef0123456789abcdef";
const REPORT_ID = "01234567-89ab-4cde-8123-0123456789ab";

beforeEach(() => {
  getCloudflareContext.mockReset();
});

describe("session token route", () => {
  it("creates a server-owned room and mints compatible scoped tokens", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    getCloudflareContext.mockResolvedValue({
      env: { WEB_TOKEN_SECRET: SECRET, SESSION_RATE_LIMITER: { limit } },
    });

    const response = await createSession(
      new Request("https://oral.example/api/session", {
        method: "POST",
        headers: {
          Origin: "https://oral.example",
          "CF-Connecting-IP": "192.0.2.10",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toContain(
      `${REPORT_TOKEN_COOKIE}=`,
    );
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=Strict");
    const payload = (await response.json()) as {
      expiresAt: number;
      room: string;
      token: string;
    };
    expect(payload.room).toMatch(/^web-[0-9a-f]{32}$/u);
    expect(payload.expiresAt).toBeGreaterThan(Date.now() + 7_100_000);
    await expect(verifyAccessToken(payload.token, SECRET, "connect")).resolves.toMatchObject({
      sub: payload.room,
    });
    const ownerCookieName = sessionOwnerCookieName(payload.room);
    expect(ownerCookieName).not.toBeNull();
    const ownerCookie = setCookie.match(new RegExp(`${ownerCookieName}=([^;]+)`, "u"))?.[1];
    expect(ownerCookie).toBeTruthy();
    await expect(verifyAccessToken(ownerCookie, SECRET, "owner")).resolves.toMatchObject({
      sub: payload.room,
    });
    expect(limit).toHaveBeenCalledWith({ key: "192.0.2.10" });
  });

  it("does not let a caller mint tokens for an existing room without its owner cookie", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    getCloudflareContext.mockResolvedValue({
      env: { WEB_TOKEN_SECRET: SECRET, SESSION_RATE_LIMITER: { limit } },
    });

    const response = await createSession(
      new Request(`https://oral.example/api/session?room=${ROOM}`, {
        method: "POST",
        headers: { Origin: "https://oral.example" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_owner_required" });
    expect(limit).not.toHaveBeenCalled();
  });

  it("refreshes an existing room only with a matching signed owner capability", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const ownerCookieName = sessionOwnerCookieName(ROOM);
    const ownerToken = await createAccessToken(SECRET, {
      v: 1,
      sub: ROOM,
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "owner",
    });
    getCloudflareContext.mockResolvedValue({
      env: { WEB_TOKEN_SECRET: SECRET, SESSION_RATE_LIMITER: { limit } },
    });

    const response = await createSession(
      new Request(`https://oral.example/api/session?room=${ROOM}`, {
        method: "POST",
        headers: {
          Origin: "https://oral.example",
          Cookie: `${ownerCookieName}=${ownerToken}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ room: ROOM });
    expect(response.headers.get("Set-Cookie")).toContain(`${REPORT_TOKEN_COOKIE}=`);
    expect(response.headers.get("Set-Cookie")).not.toContain(`${ownerCookieName}=`);
    expect(limit).toHaveBeenCalledWith({ key: "local" });
  });

  it("rejects a signed owner capability for a different room", async () => {
    const ownerToken = await createAccessToken(SECRET, {
      v: 1,
      sub: "web-fedcba9876543210fedcba9876543210",
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "owner",
    });
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        SESSION_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
      },
    });

    const response = await createSession(
      new Request(`https://oral.example/api/session?room=${ROOM}`, {
        method: "POST",
        headers: {
          Origin: "https://oral.example",
          Cookie: `${sessionOwnerCookieName(ROOM)}=${ownerToken}`,
        },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects cross-origin issuance before touching Cloudflare bindings", async () => {
    const response = await createSession(
      new Request("https://oral.example/api/session", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
    );

    expect(response.status).toBe(403);
    expect(getCloudflareContext).not.toHaveBeenCalled();
  });

  it("fails closed when the distributed rate limiter is unavailable", async () => {
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        SESSION_RATE_LIMITER: { limit: vi.fn().mockRejectedValue(new Error("offline")) },
      },
    });

    const response = await createSession(
      new Request("https://oral.example/api/session", {
        method: "POST",
        headers: { Origin: "https://oral.example" },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "rate_limiter_unavailable" });
  });
});

describe("private report proxy", () => {
  it("forwards a valid report-scoped cookie only through the service binding", async () => {
    const reportToken = await createAccessToken(SECRET, {
      v: 1,
      sub: ROOM,
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "report",
    });
    const serviceFetch = vi.fn().mockResolvedValue(
      new Response("private report", {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    );
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        INTERVIEWER_SERVICE: { fetch: serviceFetch },
      },
    });

    const response = await getReport(
      new Request(`https://oral.example/api/reports/${REPORT_ID}?kind=report`, {
        headers: { Cookie: `${REPORT_TOKEN_COOKIE}=${reportToken}` },
      }),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private report");
    expect(serviceFetch).toHaveBeenCalledOnce();
    const upstream = serviceFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(upstream.url).pathname).toBe(
      `/interviewer/reports/${REPORT_ID}.md`,
    );
    expect(upstream.headers.get("Authorization")).toBe(`Bearer ${reportToken}`);
  });

  it("rejects a missing report cookie without calling the service binding", async () => {
    const serviceFetch = vi.fn();
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        INTERVIEWER_SERVICE: { fetch: serviceFetch },
      },
    });

    const response = await getReport(
      new Request(`https://oral.example/api/reports/${REPORT_ID}?kind=report`),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(401);
    expect(serviceFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid report identifiers and kinds before loading bindings", async () => {
    const response = await getReport(
      new Request("https://oral.example/api/reports/not-a-report?kind=raw"),
      { params: Promise.resolve({ reportId: "not-a-report" }) },
    );

    expect(response.status).toBe(400);
    expect(getCloudflareContext).not.toHaveBeenCalled();
  });

  it("rejects expired and wrong-subject report tokens", async () => {
    const expired = await createAccessToken(SECRET, {
      v: 1,
      sub: ROOM,
      exp: Math.floor(Date.now() / 1_000) - 1,
      scope: "report",
    });
    const wrongSubject = await createAccessToken(SECRET, {
      v: 1,
      sub: "device-room",
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "report",
    });
    const serviceFetch = vi.fn();
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        INTERVIEWER_SERVICE: { fetch: serviceFetch },
      },
    });

    for (const token of [expired, wrongSubject]) {
      const response = await getReport(
        new Request(`https://oral.example/api/reports/${REPORT_ID}?kind=report`, {
          headers: { Cookie: `${REPORT_TOKEN_COOKIE}=${token}` },
        }),
        { params: Promise.resolve({ reportId: REPORT_ID }) },
      );
      expect(response.status).toBe(401);
    }
    expect(serviceFetch).not.toHaveBeenCalled();
  });

  it("uses the cheat-sheet suffix and preserves a private upstream 404", async () => {
    const reportToken = await createAccessToken(SECRET, {
      v: 1,
      sub: ROOM,
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "report",
    });
    const serviceFetch = vi.fn().mockResolvedValue(
      Response.json({ error: "not_found" }, { status: 404 }),
    );
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        INTERVIEWER_SERVICE: { fetch: serviceFetch },
      },
    });

    const response = await getReport(
      new Request(`https://oral.example/api/reports/${REPORT_ID}?kind=cheatsheet`, {
        headers: { Cookie: `${REPORT_TOKEN_COOKIE}=${reportToken}` },
      }),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const upstream = serviceFetch.mock.calls[0]?.[0] as Request;
    expect(new URL(upstream.url).pathname).toBe(
      `/interviewer/reports/${REPORT_ID}-cheatsheet.md`,
    );
  });

  it("returns a generic 502 when the private service binding fails", async () => {
    const reportToken = await createAccessToken(SECRET, {
      v: 1,
      sub: ROOM,
      exp: Math.floor(Date.now() / 1_000) + 300,
      scope: "report",
    });
    getCloudflareContext.mockResolvedValue({
      env: {
        WEB_TOKEN_SECRET: SECRET,
        INTERVIEWER_SERVICE: { fetch: vi.fn().mockRejectedValue(new Error("internal")) },
      },
    });

    const response = await getReport(
      new Request(`https://oral.example/api/reports/${REPORT_ID}?kind=report`, {
        headers: { Cookie: `${REPORT_TOKEN_COOKIE}=${reportToken}` },
      }),
      { params: Promise.resolve({ reportId: REPORT_ID }) },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "report_unavailable" });
  });
});
