import type { OxfmtConfig } from "oxfmt";
import base from "@aranlucas/oxforge/format-config";

const baseConfig: OxfmtConfig = base;

const config: OxfmtConfig = {
  ...baseConfig,
  ignorePatterns: [
    ...(baseConfig.ignorePatterns ?? []),
    "**/.cloudflare/**",
    "**/.open-next/**",
    "**/next-env.d.ts",
    "**/.opennext-wrangler.json",
  ],
};

export default config;
