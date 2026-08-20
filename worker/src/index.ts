import { routeAgentRequest } from "agents";

import {
  interviewerLobbyKind,
  isAllowedWebOrigin,
  verifyWebToken,
} from "./web-token";

type WorkerEnv = Env;

const DURABLE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/i;
const REPORT_PATH_PREFIX = "/interviewer/reports/";
const REPORT_PATH_PATTERN =
  /^\/interviewer\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(-cheatsheet)?\.(json|md)$/i;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export { PediatricInterviewer } from "./interviewer";

function json(
  data: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(SECURITY_HEADERS);
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(data, { status, headers });
}

function errorResponse(
  code: string,
  status: number,
  extraHeaders: HeadersInit = {},
): Response {
  return json({ error: code }, status, extraHeaders);
}

function unauthorizedResponse(): Response {
  return errorResponse("unauthorized", 401);
}

function requestQueryToken(request: Request): string | null {
  return new URL(request.url).searchParams.get("token");
}

function requestDeviceHeaderToken(request: Request): string | null {
  return request.headers.get("X-Device-Token");
}

function requestBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization")?.trim();
  if (!authorization) return null;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

async function verifyDeviceToken(provided: string | null, expected: string): Promise<boolean> {
  if (!provided || !expected || provided.length > 256) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function allowConnectionAttempt(env: WorkerEnv, key: string): Promise<boolean> {
  try {
    const outcome = await env.CONNECTION_RATE_LIMITER.limit({ key });
    return outcome.success;
  } catch (error) {
    // A rate-limit binding outage should not turn an otherwise healthy Worker
    // into a total outage. Keep the failure visible without logging secrets.
    console.error(
      JSON.stringify({
        event: "connection_rate_limit_error",
        error: String(error).slice(0, 160),
      }),
    );
    return true;
  }
}

function supportedInterviewerLobby(lobby: { className: string; name: string }): boolean {
  return (
    lobby.className === "PEDIATRIC_INTERVIEWER" && interviewerLobbyKind(lobby.name) !== null
  );
}

type AuthorizedReport = {
  object: R2ObjectBody | null;
};

async function authorizedReport(
  request: Request,
  env: WorkerEnv,
  key: string,
): Promise<AuthorizedReport | null> {
  const bearer = requestBearerToken(request);
  if (bearer) {
    const claims = await verifyWebToken(bearer, env.WEB_TOKEN_SECRET, { scope: "report" });
    if (!claims) return null;
    const object = await env.INTERVIEW_REPORTS.get(key);
    // A signed report token is scoped to the persisted session. Return the
    // same 401 for a missing object and a mismatched session to avoid probing
    // report existence with a valid token for another session.
    if (!object || object.customMetadata?.sessionId !== claims.sub) return null;
    return { object };
  }

  // Device report access intentionally accepts only the header. Query-string
  // device tokens are never considered on HTTP report/recovery routes.
  if (!(await verifyDeviceToken(requestDeviceHeaderToken(request), env.DEVICE_TOKEN))) {
    return null;
  }
  return { object: await env.INTERVIEW_REPORTS.get(key) };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const reportMatch =
      request.method === "GET" && path.startsWith(REPORT_PATH_PREFIX)
        ? REPORT_PATH_PATTERN.exec(path)
        : null;
    if (reportMatch) {
      const [, rawReportId, cheatsheetSuffix, rawFormat] = reportMatch;
      const reportId = rawReportId.toLowerCase();
      const format = rawFormat.toLowerCase();
      // The cheat sheet is markdown only; there is no JSON variant of it.
      if (cheatsheetSuffix && format !== "md") {
        return errorResponse("report_not_found", 404);
      }
      const suffix = cheatsheetSuffix ? "-cheatsheet" : "";
      const key = `pediatric-oral-boards/reports/${reportId}${suffix}.${format}`;
      const access = await authorizedReport(request, env, key);
      if (!access) return unauthorizedResponse();
      if (!access.object) return errorResponse("report_not_found", 404);

      const headers = new Headers({
        "Content-Disposition": `attachment; filename="pediatric-oral-boards-${reportId}${suffix}.${format}"`,
        ETag: access.object.httpEtag,
      });
      access.object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(access.object.body, { headers });
    }

    if (request.method === "GET" && (path === "/health" || path === "/interviewer/health")) {
      return json({
        ok: true,
        protocolVersion: 2,
        capabilities: {
          deviceWebSocket: true,
          signedWebWebSocket: true,
          privateReports: true,
          reportRecovery: true,
        },
      });
    }

    if (request.method === "POST" && path === "/interviewer/recover-report") {
      if (!(await verifyDeviceToken(requestDeviceHeaderToken(request), env.DEVICE_TOKEN))) {
        return unauthorizedResponse();
      }
      const durableObjectId = request.headers.get("X-Durable-Object-Id") ?? "";
      if (!DURABLE_OBJECT_ID_PATTERN.test(durableObjectId)) {
        return errorResponse("invalid_durable_object_id", 400);
      }
      const id = env.PEDIATRIC_INTERVIEWER.idFromString(durableObjectId);
      const stub = env.PEDIATRIC_INTERVIEWER.get(id);
      return stub.fetch(
        new Request("https://internal/recover-report", {
          method: "POST",
          headers: { "x-partykit-room": `recovery-${durableObjectId.slice(0, 8)}` },
        }),
      );
    }

    const routed = await routeAgentRequest(request, env, {
      onBeforeRequest: async (agentRequest, lobby) => {
        if (!supportedInterviewerLobby(lobby)) {
          return errorResponse("not_found", 404);
        }
        // PartyServer otherwise forwards ordinary HTTP requests into the DO.
        // Reject before it can wake the object; only WebSocket upgrades enter
        // onBeforeConnect below.
        if (agentRequest.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return errorResponse("websocket_upgrade_required", 426, {
            Upgrade: "websocket",
          });
        }
      },
      onBeforeConnect: async (upgradeRequest, lobby) => {
        if (!supportedInterviewerLobby(lobby)) {
          return errorResponse("not_found", 404);
        }

        const ip = clientIp(upgradeRequest);
        if (!(await allowConnectionAttempt(env, `ip:${ip}`))) {
          return errorResponse("rate_limited", 429, { "Retry-After": "60" });
        }

        const kind = interviewerLobbyKind(lobby.name);
        if (kind === "web") {
          if (!isAllowedWebOrigin(upgradeRequest.headers.get("Origin"), env.WEB_ORIGINS)) {
            return errorResponse("origin_not_allowed", 403);
          }
          const claims = await verifyWebToken(requestQueryToken(upgradeRequest), env.WEB_TOKEN_SECRET, {
            scope: "connect",
            subject: lobby.name,
          });
          if (!claims) return unauthorizedResponse();
          if (!(await allowConnectionAttempt(env, `subject:${claims.sub}`))) {
            return errorResponse("rate_limited", 429, { "Retry-After": "60" });
          }
          return;
        }

        // Preserve the device protocol while allowing browser-incompatible
        // clients to use the query token. HTTP routes remain header-only.
        const deviceToken =
          requestQueryToken(upgradeRequest) ?? requestDeviceHeaderToken(upgradeRequest);
        if (!(await verifyDeviceToken(deviceToken, env.DEVICE_TOKEN))) {
          return unauthorizedResponse();
        }
      },
    });
    if (routed) return routed;

    return errorResponse("not_found", 404);
  },
} satisfies ExportedHandler<WorkerEnv>;
