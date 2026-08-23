import {
  configuredReportsSecret,
  createReportsAdminToken,
  reportsAdminSecretMatches,
  reportsEnvironment,
  serializeReportsAdminCookie,
} from "@/lib/reports-admin";

export const dynamic = "force-dynamic";

function redirect(request: Request, target: string, cookie?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: new URL(target, request.url).toString(),
    "Referrer-Policy": "no-referrer",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) {
    return Response.json(
      { error: "origin_not_allowed" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (requestUrl.searchParams.get("action") === "logout") {
    return redirect(request, "/reports", serializeReportsAdminCookie("", 0));
  }

  const env = await reportsEnvironment();
  const secret = configuredReportsSecret(env);
  if (!secret || !env?.SESSION_RATE_LIMITER) {
    return redirect(request, "/reports?error=configuration");
  }

  const clientKey = request.headers.get("CF-Connecting-IP") ?? "local";
  try {
    const allowed = await env.SESSION_RATE_LIMITER.limit({ key: `reports:${clientKey}` });
    if (!allowed.success) return redirect(request, "/reports?error=rate-limited");
  } catch {
    return redirect(request, "/reports?error=configuration");
  }

  const form = await request.formData();
  const provided = form.get("accessKey");
  if (
    typeof provided !== "string" ||
    !(await reportsAdminSecretMatches(provided, secret))
  ) {
    return redirect(request, "/reports?error=invalid");
  }

  const token = await createReportsAdminToken(secret);
  return redirect(request, "/reports", serializeReportsAdminCookie(token));
}
