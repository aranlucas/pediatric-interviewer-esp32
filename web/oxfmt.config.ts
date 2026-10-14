import type { OxfmtConfig } from "oxfmt";
import base from "@aranlucas/oxforge/format-config";

const baseConfig: OxfmtConfig = base;

const config: OxfmtConfig = {
  ...baseConfig,
  ignorePatterns: [
    ...(baseConfig.ignorePatterns ?? []),
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".cloudflare/**",
    ".open-next/**",
  ],
};

export default config;
