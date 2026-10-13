import base from "@aranlucas/oxforge/format-config";

const config = {
  ...base,
  ignorePatterns: [
    ...(base.ignorePatterns ?? []),
    ...[".next/**", "out/**", "build/**", "next-env.d.ts", ".cloudflare/**", ".open-next/**"],
  ],
};

export default config;
