export type AccessTokenScope = "connect" | "owner" | "report";

export type AccessTokenPayload = {
  v: 1;
  sub: string;
  exp: number;
  scope: AccessTokenScope;
};

export const REPORT_TOKEN_COOKIE = "__Host-angry-cat-report";
export const SESSION_OWNER_COOKIE_PREFIX = "__Host-angry-cat-owner-";

const encoder = new TextEncoder();

function base64UrlEncode(value: string | ArrayBuffer | Uint8Array): string {
  const bytes =
    typeof value === "string"
      ? encoder.encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function createAccessToken(
  secret: string,
  payload: AccessTokenPayload,
): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    encoder.encode(encodedPayload),
  );
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

export async function verifyAccessToken(
  token: string | null | undefined,
  secret: string,
  scope: AccessTokenScope,
  now = Math.floor(Date.now() / 1_000),
): Promise<AccessTokenPayload | null> {
  if (!token || !secret || token.length > 2_048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as Partial<
      AccessTokenPayload
    >;
    if (
      payload.v !== 1 ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= now ||
      payload.scope !== scope
    ) {
      return null;
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      base64UrlDecode(parts[1]),
      encoder.encode(parts[0]),
    );
    return valid ? (payload as AccessTokenPayload) : null;
  } catch {
    return null;
  }
}

export function getCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function isWebRoom(value: string | null): value is `web-${string}` {
  return typeof value === "string" && /^web-[0-9a-f]{32}$/u.test(value);
}

export function sessionOwnerCookieName(room: string): string | null {
  if (!isWebRoom(room)) return null;
  return `${SESSION_OWNER_COOKIE_PREFIX}${room.slice("web-".length)}`;
}

export function isReportId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export function serializeReportCookie(token: string, maxAgeSeconds: number): string {
  return `${REPORT_TOKEN_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function serializeSessionOwnerCookie(
  token: string,
  room: string,
  maxAgeSeconds: number,
): string | null {
  const name = sessionOwnerCookieName(room);
  if (!name) return null;
  return `${name}=${token}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
