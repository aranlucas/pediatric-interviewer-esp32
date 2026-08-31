import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  createAccessToken,
  getCookie,
  isWebRoom,
  serializeReportCookie,
  serializeSessionOwnerCookie,
  sessionOwnerCookieName,
  verifyAccessToken,
} from "@/lib/server-auth";

export const dynamic = "force-dynamic";

// The SDK reuses this room-scoped handshake credential across transient
// socket retries so its exponential backoff remains intact. Terminal auth
// failures are recovered explicitly by the UI with a newly minted token.
const CONNECT_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const REPORT_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const SESSION_OWNER_TTL_SECONDS = 2 * 60 * 60;

type SessionRateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};

type SessionEnv = CloudflareEnv & {
  WEB_TOKEN_SECRET?: string;
  SESSION_RATE_LIMITER?: SessionRateLimiter;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) {
    return json({ error: "origin_not_allowed" }, 403);
  }
  const requestedRoom = requestUrl.searchParams.get("room");
  if (requestedRoom !== null && !isWebRoom(requestedRoom)) {
    return json({ error: "invalid_room" }, 400);
  }

  let rawEnv: CloudflareEnv;
  try {
    ({ env: rawEnv } = await getCloudflareContext({ async: true }));
  } catch {
    return json({ error: "session_auth_not_configured" }, 503);
  }
  const env = rawEnv as SessionEnv;
  const secret = env.WEB_TOKEN_SECRET;
  if (!secret?.trim() || secret.length < 32 || !env.SESSION_RATE_LIMITER) {
    return json({ error: "session_auth_not_configured" }, 503);
  }

  // The first request creates the room on the server. A later request may
  // refresh its handshake token only when the browser presents the owner
  // capability issued for that exact room. The cookie name is derived from the
  // room for isolation, while the signed subject prevents name-only forgery.
  const room = requestedRoom ?? `web-${crypto.randomUUID().replaceAll("-", "")}`;
  if (!isWebRoom(room)) return json({ error: "invalid_room" }, 400);
  if (requestedRoom) {
    const ownerCookieName = sessionOwnerCookieName(room);
    const ownerToken = ownerCookieName
      ? getCookie(request.headers.get("Cookie"), ownerCookieName)
      : null;
    const owner = await verifyAccessToken(ownerToken, secret, "owner");
    if (!owner || owner.sub !== room) {
      return json({ error: "session_owner_required" }, 401);
    }
  }

  // CF-Connecting-IP is supplied by Cloudflare. Do not trust a caller-owned
  // X-Forwarded-For value as a rate-limit identity.
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "local";
  let allowed: { success: boolean };
  try {
    allowed = await env.SESSION_RATE_LIMITER.limit({ key: clientKey });
  } catch {
    return json({ error: "rate_limiter_unavailable" }, 503);
  }
  if (!allowed.success) return json({ error: "rate_limited" }, 429);

  const now = Math.floor(Date.now() / 1_000);
  const connectToken = await createAccessToken(secret, {
    v: 1,
    sub: room,
    exp: now + CONNECT_TOKEN_TTL_SECONDS,
    scope: "connect",
  });
  const reportToken = await createAccessToken(secret, {
    v: 1,
    sub: room,
    exp: now + REPORT_TOKEN_TTL_SECONDS,
    scope: "report",
  });

  const response = json({
    room,
    token: connectToken,
    expiresAt: (now + CONNECT_TOKEN_TTL_SECONDS) * 1_000,
  });
  if (!requestedRoom) {
    const ownerCookie = await createAccessToken(secret, {
      v: 1,
      sub: room,
      exp: now + SESSION_OWNER_TTL_SECONDS,
      scope: "owner",
    });
    const serializedOwnerCookie = serializeSessionOwnerCookie(
      ownerCookie,
      room,
      SESSION_OWNER_TTL_SECONDS,
    );
    if (!serializedOwnerCookie) return json({ error: "invalid_room" }, 400);
    response.headers.append("Set-Cookie", serializedOwnerCookie);
  }
  response.headers.append("Set-Cookie", serializeReportCookie(reportToken, REPORT_TOKEN_TTL_SECONDS));
  return response;
}
