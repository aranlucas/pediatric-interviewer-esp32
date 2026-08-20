import { beforeEach, describe, expect, it, vi } from "vitest";

const { routeAgentRequest } = vi.hoisted(() => ({
  routeAgentRequest: vi.fn(),
}));

vi.mock("agents", () => ({
  Agent: class {},
  routeAgentRequest,
}));

import worker from "../src/index";
import { signWebToken } from "../src/web-token";

const DEVICE_TOKEN = "device-test-secret";
const WEB_TOKEN_SECRET = "web-test-secret-that-is-long-enough";
const WEB_ROOM = "web-0123456789abcdef0123456789abcdef";
const REPORT_ID = "01234567-89ab-4cde-8123-0123456789ab";

function r2Object(sessionId = WEB_ROOM): R2ObjectBody {
  return {
    body: new Blob(["private report"]).stream(),
    customMetadata: { sessionId },
    httpEtag: '"report-etag"',
    writeHttpMetadata: () => undefined,
  } as unknown as R2ObjectBody;
}

function testEnv(object: R2ObjectBody | null = null): Env {
  return {
    DEVICE_TOKEN,
    WEB_TOKEN_SECRET,
    WEB_ORIGINS: "https://oral.example,http://localhost:3000",
    GEMINI_API_KEY: "gemini-test-key",
    CONNECTION_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    INTERVIEW_REPORTS: {
      get: vi.fn().mockResolvedValue(object),
    },
  } as unknown as Env;
}

beforeEach(() => {
  routeAgentRequest.mockReset().mockResolvedValue(undefined);
});

describe("Worker edge contract", () => {
  it("keeps public health minimal and non-cacheable", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/health"),
      testEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      protocolVersion: 2,
      capabilities: {
        deviceWebSocket: true,
        signedWebWebSocket: true,
        privateReports: true,
        reportRecovery: true,
      },
    });
  });

  it("ignores static device credentials in report query strings", async () => {
    const response = await worker.fetch(
      new Request(
        `https://worker.example/interviewer/reports/${REPORT_ID}.md?token=${DEVICE_TOKEN}`,
      ),
      testEnv(r2Object()),
    );

    expect(response.status).toBe(401);
  });

  it("serves a report only when the signed subject matches its R2 session", async () => {
    const reportToken = await signWebToken(
      {
        sub: WEB_ROOM,
        exp: Math.floor(Date.now() / 1_000) + 300,
        scope: "report",
      },
      WEB_TOKEN_SECRET,
    );
    const authorized = await worker.fetch(
      new Request(`https://worker.example/interviewer/reports/${REPORT_ID}.md`, {
        headers: { Authorization: `Bearer ${reportToken}` },
      }),
      testEnv(r2Object()),
    );
    const mismatched = await worker.fetch(
      new Request(`https://worker.example/interviewer/reports/${REPORT_ID}.md`, {
        headers: { Authorization: `Bearer ${reportToken}` },
      }),
      testEnv(r2Object("web-fedcba9876543210fedcba9876543210")),
    );

    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("private report");
    expect(mismatched.status).toBe(401);
  });

  it("rejects ordinary agent HTTP before a Durable Object is reached", async () => {
    routeAgentRequest.mockImplementation(async (request, _env, options) =>
      options.onBeforeRequest?.(request, {
        className: "PEDIATRIC_INTERVIEWER",
        name: WEB_ROOM,
      }),
    );

    const response = await worker.fetch(
      new Request(`https://worker.example/agents/pediatric-interviewer/${WEB_ROOM}`),
      testEnv(),
    );

    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toBe("websocket");
  });

  it("requires both exact origin and room-scoped connect token for web upgrades", async () => {
    routeAgentRequest.mockImplementation(async (request, _env, options) =>
      options.onBeforeConnect?.(request, {
        className: "PEDIATRIC_INTERVIEWER",
        name: WEB_ROOM,
      }),
    );
    const connectToken = await signWebToken(
      {
        sub: WEB_ROOM,
        exp: Math.floor(Date.now() / 1_000) + 90,
        scope: "connect",
      },
      WEB_TOKEN_SECRET,
    );
    const url = `https://worker.example/agents/pediatric-interviewer/${WEB_ROOM}?token=${connectToken}`;

    const allowed = await worker.fetch(
      new Request(url, {
        headers: { Origin: "https://oral.example", Upgrade: "websocket" },
      }),
      testEnv(),
    );
    const denied = await worker.fetch(
      new Request(url, {
        headers: { Origin: "https://evil.example", Upgrade: "websocket" },
      }),
      testEnv(),
    );

    expect(allowed.status).toBe(404);
    expect(denied.status).toBe(403);
  });
});
