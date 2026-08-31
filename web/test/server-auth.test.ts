import { describe, expect, it } from "vitest";

import {
  createAccessToken,
  getCookie,
  isReportId,
  isWebRoom,
  serializeSessionOwnerCookie,
  sessionOwnerCookieName,
  verifyAccessToken,
} from "../lib/server-auth";

const SECRET = "test-secret-that-is-long-enough";
const NOW = 1_700_000_000;
const CROSS_RUNTIME_SECRET = "test-web-token-secret-that-is-long-enough";
const CROSS_RUNTIME_CONNECT_TOKEN =
  "eyJ2IjoxLCJzdWIiOiJ3ZWItMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJleHAiOjE4MDAwMDAwNjAsInNjb3BlIjoiY29ubmVjdCJ9.wxFQDOYnvGHheuHtQc9M_KbwtJI7PqLYy7gNcTfovLw";

describe("web HMAC session tokens", () => {
  it("round-trips a scoped token and rejects the wrong scope", async () => {
    const token = await createAccessToken(SECRET, {
      v: 1,
      sub: "web-0123456789abcdef0123456789abcdef",
      exp: NOW + 90,
      scope: "connect",
    });

    await expect(verifyAccessToken(token, SECRET, "connect", NOW)).resolves.toMatchObject({
      v: 1,
      scope: "connect",
    });
    await expect(verifyAccessToken(token, SECRET, "report", NOW)).resolves.toBeNull();
    await expect(verifyAccessToken(token, SECRET, "owner", NOW)).resolves.toBeNull();
    await expect(verifyAccessToken(`${token}x`, SECRET, "connect", NOW)).resolves.toBeNull();
    await expect(verifyAccessToken(token, "wrong-secret", "connect", NOW)).resolves.toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await createAccessToken(SECRET, {
      v: 1,
      sub: "web-0123456789abcdef0123456789abcdef",
      exp: NOW,
      scope: "report",
    });
    await expect(verifyAccessToken(token, SECRET, "report", NOW)).resolves.toBeNull();
  });

  it("matches the Worker verifier's deterministic compatibility fixture", async () => {
    await expect(
      createAccessToken(CROSS_RUNTIME_SECRET, {
        v: 1,
        sub: "web-0123456789abcdef0123456789abcdef",
        exp: 1_800_000_060,
        scope: "connect",
      }),
    ).resolves.toBe(CROSS_RUNTIME_CONNECT_TOKEN);
    await expect(
      verifyAccessToken(
        CROSS_RUNTIME_CONNECT_TOKEN,
        CROSS_RUNTIME_SECRET,
        "connect",
        1_800_000_000,
      ),
    ).resolves.toMatchObject({
      sub: "web-0123456789abcdef0123456789abcdef",
      scope: "connect",
    });
  });
});

describe("web auth input validation", () => {
  it("requires a full 128-bit web room and UUID-v4 report ID", () => {
    expect(isWebRoom("web-0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isWebRoom("web-01234567")).toBe(false);
    expect(isWebRoom("esp32-0123456789abcdef0123456789abcdef")).toBe(false);
    expect(isReportId("01234567-89ab-4cde-8123-0123456789ab")).toBe(true);
    expect(isReportId("../../secret")).toBe(false);
  });

  it("parses only the requested cookie", () => {
    expect(getCookie("foo=bar; __Host-angry-cat-report=signed.value", "__Host-angry-cat-report")).toBe(
      "signed.value",
    );
    expect(getCookie("foo=bar", "__Host-angry-cat-report")).toBeNull();
  });

  it("derives an isolated owner cookie name from a validated room", () => {
    const room = "web-0123456789abcdef0123456789abcdef";
    const name = sessionOwnerCookieName(room);
    expect(name).toBe("__Host-angry-cat-owner-0123456789abcdef0123456789abcdef");
    expect(serializeSessionOwnerCookie("signed.value", room, 7200)).toBe(
      `${name}=signed.value; Max-Age=7200; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(sessionOwnerCookieName("not-a-room")).toBeNull();
  });
});
