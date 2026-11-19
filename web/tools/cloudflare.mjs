import { spawnSync } from "node:child_process";
import { parseCfWranglerBuildArgs, runCfWranglerBuild } from "wrangler";
import { prepareOpenNextConfig } from "./opennext-config.ts";

/** @param {string[]} args */
function run(args) {
  const result = spawnSync("pnpm", ["exec", ...args], { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "build": {
    // OpenNext builds the Worker and assets. Wrangler then bundles them into
    // the Cloudflare Build Output consumed by cf deploy --prebuilt.
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
