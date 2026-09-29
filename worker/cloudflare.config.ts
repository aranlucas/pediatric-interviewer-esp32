import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    exports: {
      AngryCat: exports.durableObject({ state: "deleted" }),
      PediatricInterviewer: exports.durableObject({ storage: "sqlite" }),
    },
    name: "esp32-angry-cat",
    compatibilityDate: "2026-08-11",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        invocationLogs: false,
      },
    },
    env: {
      DEVICE_TOKEN: bindings.secret(),
      GEMINI_API_KEY: bindings.secret(),
      WEB_TOKEN_SECRET: bindings.secret(),
      WEB_ORIGINS: bindings.secret(),
      INTERVIEW_REPORTS: bindings.r2({
        name: "pediatric-oral-boards-reports",
      }),
      PEDIATRIC_INTERVIEWER: bindings.durableObject({
        worker: "esp32-angry-cat",
        exportName: "PediatricInterviewer",
      }),
      AI: bindings.ai({}),
      CONNECTION_RATE_LIMITER: bindings.rateLimit({
        namespace: "842176",
        simple: {
          limit: 30,
          period: 60,
        },
      }),
    },
  },
});
