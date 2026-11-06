import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
  tests: "e2e/**/*.e2e.ts",
  targets: [
    {
      engine: web({ viewport: { width: 1440, height: 1000 } }),
      app: {
        url: "http://127.0.0.1:3000",
        command: {
          executable: "pnpm",
          args: ["--dir", "web", "exec", "next", "start", "--hostname", "127.0.0.1"],
        },
      },
    },
  ],
  workers: 1,
  retries: 0,
  trace: "retain-on-failure",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
