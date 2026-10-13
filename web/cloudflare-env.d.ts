// OpenNext expects this interface; cf generates Cloudflare.Env from the config.
// oxlint-disable-next-line typescript/no-empty-object-type -- OpenNext merges this global interface with generated Cloudflare bindings.
interface CloudflareEnv extends Cloudflare.Env {}
