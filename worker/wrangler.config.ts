import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  dev: {
    // Portless assigns PORT; Wrangler does not read it on its own.
    port: Number(process.env.PORT) || undefined,
  },
  types: {
    generate: true,
  },
});
