import { spawnSync } from "node:child_process";
import { parseCfWranglerBuildArgs, runCfWranglerBuild } from "wrangler";
import { prepareOpenNextConfig } from "./opennext-config.ts";

function run(args) {
  const result = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit" });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "build": {
    // cf beta.13 detects Next.js and runs next build, which produces no cf
    // Build Output. Build OpenNext first, then use cf's own bundler delegate.
    const options = parseCfWranglerBuildArgs(args);
    const configPath = await prepareOpenNextConfig(options.mode);
    run(["opennextjs-cloudflare", "build", "--config", configPath]);
    process.exitCode = await runCfWranglerBuild(options);
    break;
  }

  case "dev":
    // Use cf's delegate to preview the built Worker, rather than next dev.
    run(["cf-wrangler", "dev", ...args]);
    break;
  default:
    throw new Error("Usage: node tools/cloudflare.mjs <build|dev>");
}
