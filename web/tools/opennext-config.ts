import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { convertToWranglerConfig, loadAndParseConfig } from "@cloudflare/config";
import { assetsDirectory } from "../wrangler.config.ts";

// OpenNext still requires legacy config for its build and Next.js dev proxy.
// Generate it from the cf config so bindings have a single source of truth.
export async function prepareOpenNextConfig(mode?: string): Promise<string> {
  const { result } = await loadAndParseConfig(resolve("cloudflare.config.ts"), {
    mode,
    isPreview: false,
  });

  if (!result.success) {
    throw result.error;
  }

  const config = convertToWranglerConfig(result.data);
  config.assets = { ...config.assets, directory: assetsDirectory };
  // Keep the file beside .dev.vars so OpenNext's dev proxy loads local secrets.
  const configPath = resolve(".opennext-wrangler.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return configPath;
}
