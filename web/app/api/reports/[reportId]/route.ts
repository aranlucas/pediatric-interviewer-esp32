import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  getCookie,
  isReportId,
  isWebRoom,
  REPORT_TOKEN_COOKIE,
  verifyAccessToken,
} from "@/lib/server-auth";

export const dynamic = "force-dynamic";

type ReportEnv = CloudflareEnv & {
  INTERVIEWER_SERVICE?: Fetcher;
  WEB_TOKEN_SECRET?: string;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<Response> {
  const { reportId } = await params;
  const kind = new URL(request.url).searchParams.get("kind");
  if (!isReportId(reportId) || (kind !== "report" && kind !== "cheatsheet")) {
    return json({ error: "invalid_report" }, 400);
  }

  let rawEnv: CloudflareEnv;
  try {
    ({ env: rawEnv } = await getCloudflareContext({ async: true }));
  } catch {
    return json({ error: "report_service_not_configured" }, 503);
  }
  const env = rawEnv as ReportEnv;
  const secret = env.WEB_TOKEN_SECRET;
  const reportToken = getCookie(request.headers.get("cookie"), REPORT_TOKEN_COOKIE);
  const reportPayload = secret?.trim()
    ? await verifyAccessToken(reportToken, secret, "report")
    : null;
  if (!reportPayload || !isWebRoom(reportPayload.sub)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.INTERVIEWER_SERVICE) return json({ error: "report_service_not_configured" }, 503);

  const suffix = kind === "cheatsheet" ? "-cheatsheet" : "";
  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = `/interviewer/reports/${reportId}${suffix}.md`;
  upstreamUrl.search = "";

  try {
    const upstreamResponse = await env.INTERVIEWER_SERVICE.fetch(
      new Request(upstreamUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${reportToken}` },
      }),
    );
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const contentType = upstreamResponse.headers.get("Content-Type");
    if (contentType) headers.set("Content-Type", contentType);
    if (upstreamResponse.ok) {
      headers.set(
        "Content-Disposition",
        `attachment; filename="angry-cat-${kind}-${reportId}.md"`,
      );
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  } catch {
    return json({ error: "report_unavailable" }, 502);
  }
}
