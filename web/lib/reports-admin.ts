import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  createAccessToken,
  getCookie,
  verifyAccessToken,
} from "@/lib/server-auth";

export const REPORTS_ADMIN_COOKIE = "__Host-angry-cat-reports-admin";
export const REPORTS_ADMIN_SUBJECT = "reports-admin";
export const REPORTS_ADMIN_TTL_SECONDS = 12 * 60 * 60;
export const DEFAULT_REPORTS_TIMEZONE = "America/Los_Angeles";

export type ReportsEnv = CloudflareEnv & {
  INTERVIEW_REPORTS?: R2Bucket;
  REPORTS_ADMIN_SECRET?: string;
  REPORTS_TIMEZONE?: string;
  SESSION_RATE_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
};

export async function reportsEnvironment(): Promise<ReportsEnv | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return env as ReportsEnv;
  } catch {
    return null;
  }
}

export function configuredReportsSecret(env: ReportsEnv | null): string | null {
  const secret = env?.REPORTS_ADMIN_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

export function reportsTimezone(env: ReportsEnv): string {
  const timezone = env.REPORTS_TIMEZONE?.trim() || DEFAULT_REPORTS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_REPORTS_TIMEZONE;
  }
}

export async function createReportsAdminToken(secret: string, now = Date.now()): Promise<string> {
  return createAccessToken(secret, {
    v: 1,
    sub: REPORTS_ADMIN_SUBJECT,
    exp: Math.floor(now / 1_000) + REPORTS_ADMIN_TTL_SECONDS,
    scope: "reports_admin",
  });
}

export async function verifyReportsAdminToken(
  token: string | null | undefined,
  secret: string,
  now?: number,
): Promise<boolean> {
  const payload = await verifyAccessToken(token, secret, "reports_admin", now);
  return payload?.sub === REPORTS_ADMIN_SUBJECT;
}

export async function reportsAdminFromCookie(
  cookieHeader: string | null,
  secret: string,
): Promise<boolean> {
  return verifyReportsAdminToken(getCookie(cookieHeader, REPORTS_ADMIN_COOKIE), secret);
}

export async function reportsAdminSecretMatches(
  provided: string,
  expected: string,
): Promise<boolean> {
  if (!provided || provided.length > 512 || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

export function serializeReportsAdminCookie(token: string, maxAge = REPORTS_ADMIN_TTL_SECONDS) {
  return `${REPORTS_ADMIN_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
