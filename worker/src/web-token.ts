import { z } from "zod";

const TOKEN_ENCODER = new TextEncoder();

const TOKEN_DECODER = new TextDecoder();

const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

const MAX_TOKEN_LENGTH = 4_096;

const MAX_SUBJECT_LENGTH = 256;

export type WebTokenScope = "connect" | "report";

export type WebTokenPayload = {
  v: 1;
  sub: string;
  exp: number;
  scope: WebTokenScope;
};

export type WebTokenClaims = Omit<WebTokenPayload, "v">;

export type WebTokenVerificationOptions = {
  now?: number;
  scope?: WebTokenScope;
  subject?: string;
};

export type InterviewerLobbyKind = "device" | "web";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;

  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;

    const binary = atob(padded);

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", TOKEN_ENCODER.encode(secret), HMAC_ALGORITHM, false, [
    "sign",
    "verify",
  ]);
}

const webTokenClaimsSchema = z.object({
  sub: z.string().min(1).max(MAX_SUBJECT_LENGTH),
  exp: z
    .number()
    .refine(Number.isSafeInteger)
    .refine((value) => value > 0),
  scope: z.enum(["connect", "report"]),
});

function validClaims(claims: WebTokenClaims): boolean {
  return webTokenClaimsSchema.safeParse(claims).success;
}

/**
 * Signs the compact two-part token used by the browser-facing Worker surface.
 * The caller is responsible for choosing an expiry appropriate to the flow.
 */
export async function signWebToken(claims: WebTokenClaims, secret: string): Promise<string> {
  if (!secret || !validClaims(claims)) throw new Error("Invalid web token claims.");
  const payload: WebTokenPayload = { v: 1, ...claims };
  const encodedPayload = encodeBase64Url(TOKEN_ENCODER.encode(JSON.stringify(payload)));
  const key = await importSigningKey(secret);

  const signature = await crypto.subtle.sign("HMAC", key, TOKEN_ENCODER.encode(encodedPayload));

  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verifies signature, version, expiry, scope, and (when supplied) subject.
 * Invalid input always returns null so callers can use one non-enumerating
 * unauthorized response for malformed, expired, or mismatched credentials.
 */
export async function verifyWebToken(
  token: string | null | undefined,
  secret: string,
  options: WebTokenVerificationOptions = {},
): Promise<WebTokenPayload | null> {
  if (!token || !secret || token.length > MAX_TOKEN_LENGTH) return null;
  const pieces = token.split(".");

  if (pieces.length !== 2) return null;
  const [encodedPayload, encodedSignature] = pieces;
  const signature = decodeBase64Url(encodedSignature);

  if (!signature || signature.byteLength !== 32) return null;

  let payload: unknown;
  const payloadBytes = decodeBase64Url(encodedPayload);

  if (!payloadBytes || payloadBytes.byteLength > 1_024) return null;

  try {
    payload = JSON.parse(TOKEN_DECODER.decode(payloadBytes));
  } catch {
    return null;
  }

  const parsed = webTokenClaimsSchema.extend({ v: z.literal(1) }).safeParse(payload);

  if (!parsed.success) return null;
  const normalized: WebTokenPayload = parsed.data;

  let signatureValid = false;

  try {
    const key = await importSigningKey(secret);
    signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      TOKEN_ENCODER.encode(encodedPayload),
    );
  } catch {
    return null;
  }

  if (!signatureValid) return null;

  const now = options.now ?? Math.floor(Date.now() / 1_000);

  if (normalized.exp <= now) return null;

  if (options.scope && normalized.scope !== options.scope) return null;

  if (options.subject !== undefined && normalized.sub !== options.subject) return null;

  return normalized;
}

function canonicalOrigin(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed || trimmed === "null") return null;

  try {
    const url = new URL(trimmed);

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowedWebOrigin(origin: string | null, configuredOrigins: string): boolean {
  const canonicalRequestOrigin = origin ? canonicalOrigin(origin) : null;

  if (!canonicalRequestOrigin) return false;

  return configuredOrigins
    .split(",")
    .map(canonicalOrigin)
    .some((configuredOrigin) => configuredOrigin === canonicalRequestOrigin);
}

export function interviewerLobbyKind(name: string): InterviewerLobbyKind | null {
  if (name === "esp32" || /^esp32-[0-9a-f]{8}$/u.test(name)) return "device";

  if (/^web-[0-9a-f]{32}$/u.test(name)) return "web";

  return null;
}
