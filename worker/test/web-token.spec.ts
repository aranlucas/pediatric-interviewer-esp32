import { describe, expect, it } from "vitest";

import {
  interviewerLobbyKind,
  isAllowedWebOrigin,
  signWebToken,
  verifyWebToken,
} from "../src/web-token";

const SECRET = "test-web-token-secret-that-is-long-enough";
const NOW = 1_800_000_000;
const CROSS_RUNTIME_CONNECT_TOKEN =
  "eyJ2IjoxLCJzdWIiOiJ3ZWItMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJleHAiOjE4MDAwMDAwNjAsInNjb3BlIjoiY29ubmVjdCJ9.wxFQDOYnvGHheuHtQc9M_KbwtJI7PqLYy7gNcTfovLw";

describe("signed web tokens", () => {
  it("round-trips the exact versioned payload and compact format", async () => {
    const token = await signWebToken(
      { sub: "web-0123456789abcdef0123456789abcdef", exp: NOW + 60, scope: "connect" },
      SECRET,
    );

    expect(token.split(".")).toHaveLength(2);
    await expect(
      verifyWebToken(token, SECRET, {
        now: NOW,
        scope: "connect",
        subject: "web-0123456789abcdef0123456789abcdef",
      }),
    ).resolves.toEqual({
      v: 1,
      sub: "web-0123456789abcdef0123456789abcdef",
      exp: NOW + 60,
      scope: "connect",
    });
  });

  it("matches the web token broker's deterministic compatibility fixture", async () => {
    await expect(
      signWebToken(
        {
          sub: "web-0123456789abcdef0123456789abcdef",
          exp: NOW + 60,
          scope: "connect",
        },
        SECRET,
      ),
    ).resolves.toBe(CROSS_RUNTIME_CONNECT_TOKEN);
  });

  it("rejects expired tokens", async () => {
    const token = await signWebToken(
      { sub: "web-0123456789abcdef0123456789abcdef", exp: NOW - 1, scope: "connect" },
      SECRET,
    );

    await expect(verifyWebToken(token, SECRET, { now: NOW })).resolves.toBeNull();
  });

  it("rejects tampered payloads and signatures", async () => {
    const token = await signWebToken(
      { sub: "web-0123456789abcdef0123456789abcdef", exp: NOW + 60, scope: "connect" },
      SECRET,
    );
    const [payload, signature] = token.split(".");
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;
    const tamperedSignature = `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    await expect(verifyWebToken(tamperedPayload, SECRET, { now: NOW })).resolves.toBeNull();
    await expect(verifyWebToken(tamperedSignature, SECRET, { now: NOW })).resolves.toBeNull();
  });

  it("enforces scope and subject constraints", async () => {
    const token = await signWebToken(
      { sub: "web-0123456789abcdef0123456789abcdef", exp: NOW + 60, scope: "connect" },
      SECRET,
    );

    await expect(
      verifyWebToken(token, SECRET, { now: NOW, scope: "report" }),
    ).resolves.toBeNull();
    await expect(
      verifyWebToken(token, SECRET, {
        now: NOW,
        scope: "connect",
        subject: "web-fedcba9876543210fedcba9876543210",
      }),
    ).resolves.toBeNull();
  });
});

describe("web origin and lobby boundaries", () => {
  it("allows only a configured serialized origin", () => {
    const configured = " https://oral-boards.example , http://localhost:3000 ";

    expect(isAllowedWebOrigin("https://oral-boards.example", configured)).toBe(true);
    expect(isAllowedWebOrigin("http://localhost:3000", configured)).toBe(true);
    expect(isAllowedWebOrigin("https://evil.example", configured)).toBe(false);
    expect(isAllowedWebOrigin(null, configured)).toBe(false);
    expect(isAllowedWebOrigin("https://oral-boards.example/path", configured)).toBe(false);
  });

  it("accepts only the device and 32-hex web room formats", () => {
    expect(interviewerLobbyKind("esp32")).toBe("device");
    expect(interviewerLobbyKind("esp32-deadbeef")).toBe("device");
    expect(interviewerLobbyKind("web-0123456789abcdef0123456789abcdef")).toBe("web");
    expect(interviewerLobbyKind("web-01234567")).toBeNull();
    expect(interviewerLobbyKind("web-0123456789abcdef0123456789abcdeg")).toBeNull();
  });
});
