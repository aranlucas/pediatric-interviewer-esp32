import type { NextConfig } from "next";

const configuredAgentHost =
  process.env.NEXT_PUBLIC_AGENT_HOST ?? "esp32-angry-cat.aranlucas.workers.dev";
const configuredAgentAuthority = configuredAgentHost
  .trim()
  .replace(/^wss?:\/\//u, "")
  .replace(/^https?:\/\//u, "")
  .replace(/\/+$/u, "");
const agentUrl = new URL(`https://${configuredAgentAuthority}`);
if (
  agentUrl.username ||
  agentUrl.password ||
  agentUrl.pathname !== "/" ||
  agentUrl.search ||
  agentUrl.hash
) {
  throw new Error("NEXT_PUBLIC_AGENT_HOST must contain only a hostname and optional port.");
}
const agentHost = agentUrl.host;
const localAgent = ["localhost", "127.0.0.1", "[::1]"].includes(agentUrl.hostname);
const agentConnectSources = localAgent
  ? `http://${agentHost} ws://${agentHost}`
  : `https://${agentHost} wss://${agentHost}`;
const developmentScriptSources =
  process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const securityHeaders = [
  { key: "Content-Security-Policy", value: [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src 'self' ${agentConnectSources}`,
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${developmentScriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ") },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();
