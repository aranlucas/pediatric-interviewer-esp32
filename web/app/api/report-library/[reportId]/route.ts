import {
  configuredReportsSecret,
  reportsAdminFromCookie,
  reportsEnvironment,
} from "@/lib/reports-admin";
import { reportObjectKey } from "@/lib/reports";

export const dynamic = "force-dynamic";

function json(data: unknown, status: number): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<Response> {
  const { reportId } = await params;
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "json" && kind !== "report" && kind !== "cheatsheet") {
    return json({ error: "invalid_report" }, 400);
  }
  const key = reportObjectKey(reportId, kind);
  if (!key) return json({ error: "invalid_report" }, 400);

  const env = await reportsEnvironment();
  const secret = configuredReportsSecret(env);
  if (!env?.INTERVIEW_REPORTS || !secret) {
    return json({ error: "report_service_not_configured" }, 503);
  }
  if (!(await reportsAdminFromCookie(request.headers.get("cookie"), secret))) {
    return json({ error: "unauthorized" }, 401);
  }

  const object = await env.INTERVIEW_REPORTS.get(key);
  if (!object) return json({ error: "report_not_found" }, 404);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="angry-cat-${reportId.toLowerCase()}${kind === "cheatsheet" ? "-cheatsheet" : ""}.${kind === "json" ? "json" : "md"}"`,
    "Content-Type": kind === "json"
      ? "application/json; charset=utf-8"
      : "text/markdown; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(object.body, { headers });
}
