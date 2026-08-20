import { describe, expect, it, vi } from "vitest";

import { requestBrowserSessionToken } from "../lib/session-token";

const SESSION_ID = "0123456789abcdef0123456789abcdef";

describe("browser session token acquisition", () => {
  it("deduplicates an in-flight React Strict Mode request", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const request = vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));

    const first = requestBrowserSessionToken(SESSION_ID, 101, request as typeof fetch);
    const second = requestBrowserSessionToken(SESSION_ID, 101, request as typeof fetch);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    resolveResponse?.(Response.json({
      token: "signed-room-token",
      expiresAt: Date.now() + 120_000,
    }));

    await expect(first).resolves.toEqual({
      token: "signed-room-token",
      expiresAt: expect.any(Number),
    });
    await expect(second).resolves.toMatchObject({ token: "signed-room-token" });
  });

  it("returns a stable rate-limit message without retrying automatically", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({ error: "rate_limited" }, { status: 429 }),
    );

    await expect(
      requestBrowserSessionToken(SESSION_ID, 102, request as typeof fetch),
    ).rejects.toThrow("Too many connection attempts");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects malformed and nearly expired token responses", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({
      token: "signed-room-token",
      expiresAt: Date.now() + 1_000,
    }));

    await expect(
      requestBrowserSessionToken(SESSION_ID, 103, request as typeof fetch),
    ).rejects.toThrow("invalid response");
  });
});
