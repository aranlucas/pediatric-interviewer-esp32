import { defineWranglerConfig } from "wrangler/experimental-config";

export const assetsDirectory = ".open-next/assets";

export default defineWranglerConfig({
  types: {
    generate: true,
  },
  assetsDirectory,
});
