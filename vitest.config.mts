import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: "./worker/vitest.config.ts",
        test: { name: "worker", root: "./worker" },
      },
      {
        extends: "./web/vitest.config.mts",
        test: {
          name: "web-node",
          root: "./web",
          environment: "node",
          include: ["test/**/*.test.ts"],
          globals: false,
        },
      },
      {
        extends: "./web/vitest.config.mts",
        test: {
          name: "web-browser",
          root: "./web",
          environment: "jsdom",
          include: ["test/**/*.test.tsx"],
          setupFiles: ["./test/vitest.setup.ts"],
          globals: false,
        },
      },
    ],
  },
});
