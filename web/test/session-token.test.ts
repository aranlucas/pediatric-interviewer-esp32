import { describe, expect, it, vi } from "vitest";

import { requestBrowserSessionToken } from "../lib/session-token";

const ROOM = "web-0123456789abcdef0123456789abcdef";

describe("browser session token acquisition", () => {
  it("deduplicates an in-flight React Strict Mode request", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;

    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    const first = requestBrowserSessionToken(null, 101, request);
    const second = requestBrowserSessionToken(null, 101, request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    resolveResponse?.(
      Response.json({
        room: ROOM,
        token: "signed-room-token",
        expiresAt: Date.now() + 120_000,
      }),
    );

    await expect(first).resolves.toEqual({
      room: ROOM,
      token: "signed-room-token",
      expiresAt: expect.any(Number),
    });
    await expect(second).resolves.toMatchObject({ token: "signed-room-token" });
    expect(request).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("requests an existing room only when refreshing its owner session", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        room: ROOM,
        token: "signed-room-token",
        expiresAt: Date.now() + 120_000,
      }),
    );

    await expect(requestBrowserSessionToken(ROOM, 104, request)).resolves.toMatchObject({
      room: ROOM,
    });
    expect(request).toHaveBeenCalledWith(
      `/api/session?room=${encodeURIComponent(ROOM)}`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns a stable rate-limit message without retrying automatically", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "rate_limited" }, { status: 429 }));

    await expect(requestBrowserSessionToken(null, 102, request)).rejects.toThrow(
      "Too many connection attempts",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects malformed and nearly expired token responses", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        token: "signed-room-token",
        expiresAt: Date.now() + 1_000,
      }),
    );

    await expect(requestBrowserSessionToken(null, 103, request)).rejects.toThrow(
      "invalid response",
    );
  });
});

describe("session handshake boundary validation", () => {
  it.each([
    null,
    [],
    "token",
    { room: ROOM, token: 42, expiresAt: 9e15 },
    { room: ROOM, token: "token", expiresAt: "9000000000000000" },
  ])("rejects malformed wire payload %j", async (payload) => {
    const request = vi.fn(async () => Response.json(payload));
    await expect(requestBrowserSessionToken(null, 1001, request)).rejects.toThrow(
      "invalid response",
    );
  });

  it("rejects another room even when the response is otherwise valid", async () => {
    const request = vi.fn(async () =>
      Response.json({
        room: "web-fedcba9876543210fedcba9876543210",
        token: "synthetic",
        expiresAt: Date.now() + 120000,
      }),
    );

    await expect(requestBrowserSessionToken(ROOM, 1002, request)).rejects.toThrow(
      "invalid response",
    );
  });
});
