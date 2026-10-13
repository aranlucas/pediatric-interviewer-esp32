import base from "@aranlucas/oxforge/format-config";

const config = {
  ...base,
  ignorePatterns: [...(base.ignorePatterns ?? []), ...[".cloudflare/**", ".open-next/**"]],
};

export default config;
