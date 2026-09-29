import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "angry-cat-oral-boards",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: ".open-next/worker.js",
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
    env: {
      PUBLIC_REPORTS_ENABLED: bindings.text("false"),
      REPORTS_TIMEZONE: bindings.text("America/Los_Angeles"),
      WEB_TOKEN_SECRET: bindings.secret(),
      INTERVIEW_REPORTS: bindings.r2({
        name: "pediatric-oral-boards-reports",
        dev: {
          remote: true,
        },
      }),
      INTERVIEWER_SERVICE: bindings.worker({
        worker: "esp32-angry-cat",
      }),
      SESSION_RATE_LIMITER: bindings.rateLimit({
        namespace: "842177",
        simple: {
          limit: 12,
          period: 60,
        },
      }),
      ASSETS: bindings.assets(),
    },
  },
});
