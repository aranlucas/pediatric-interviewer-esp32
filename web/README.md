# Angry Cat Oral Boards — web client

Responsive Next.js version of the ESP32 pediatric dentistry interviewer. The app runs on Cloudflare Workers through OpenNext and uses Cloudflare Agents SDK `useAgent` for automatic WebSocket reconnection, synchronized Durable Object state, and the existing binary interview protocol.

The setup screen supports one or more checked study domains. Multiple domains
become one coherent combo case. The user can choose 3-10 questions and Easy,
Standard, or Hard difficulty before starting; the default remains six questions
at Standard difficulty.

## Architecture

- The browser captures 24 kHz mono PCM16 in an AudioWorklet, streams it through the Agents SDK connection, and schedules returned PCM16 through Web Audio.
- The Agents SDK connects to the `esp32-angry-cat` Worker using a 128-bit `web-<32 hex>` Durable Object name. A same-origin session route creates that room server-side, issues a two-hour room-scoped HMAC connection token, and stores separate signed owner and report capabilities in Secure, HttpOnly cookies. Refreshing an existing room requires its owner capability.
- Session authentication is fetched once per explicit connection attempt and passed through the SDK's supported static query contract. Transient sockets therefore use the library's exponential reconnect backoff instead of minting a new token on every failed handshake; a terminal failure exposes one explicit token-refresh action.
- `WEB_TOKEN_SECRET` is a Worker secret shared by the web OpenNext Worker and the interviewer Worker. Supply it with `cf deploy --secrets-file .dev.vars.production`; it must never be a `NEXT_PUBLIC_*` variable.
- Interview reports remain private R2 objects at rest. The current interview downloads them through `/api/reports/<report-id>?kind=report|cheatsheet`; the web Worker proxies the request over the `INTERVIEWER_SERVICE` binding with an Authorization bearer token.
- `/reports` is disabled by default. If `PUBLIC_REPORTS_ENABLED=true`, it is a public, read-only library of only redacted artifacts deliberately copied under `pediatric-oral-boards/public-reports/`. It never lists the private `pediatric-oral-boards/reports/` prefix, and public JSON downloads defensively remove the private `sessionId` field.
- The interviewer and report pages link to `/privacy`, which explains the practice-only data boundary. Never enter patient, guardian, or other identifying information.
- A web `start_call` sends `topic_ids`, `question_count`, and `difficulty`; the Worker persists those settings in synchronized state and the published report.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm cf-typegen
pnpm typecheck
pnpm build
pnpm build:worker
pnpm exec cf deploy --prebuilt --dry-run
pnpm preview
pnpm deploy
```

`cloudflare.config.ts` is the source of truth for Worker settings and bindings.
`cf workers types` writes ignored types under `.cloudflare/types/`; the small
`cloudflare-env.d.ts` file gives OpenNext its expected interface name.

OpenNext currently needs a legacy configuration for its build and Next.js dev
proxy. `tools/opennext-config.ts` derives the ignored `.opennext-wrangler.json`
from the Cloudflare config and bundler settings. Do not edit that generated file.

With `cf@1.0.0-beta.13`, `cf build` in a Next.js package runs `next build` without
producing Cloudflare Build Output. `pnpm build:worker` runs OpenNext and then the
same Wrangler bundler delegate used by `cf`, producing `.cloudflare/output/v0/`.
`pnpm preview` uses that delegate to serve the built Worker locally. Deployments
and CI validation use `cf deploy --prebuilt`. The Wrangler dependency and
`wrangler.config.ts` remain required for this bundler; the hand-maintained
`wrangler.jsonc` has been removed.

The pnpm patch in `patches/@opennextjs__cloudflare@1.20.9.patch` includes
Next.js 16.4's required `preview-props.json` in OpenNext's manifest bundle,
matching [the upstream fix](https://github.com/opennextjs/opennextjs-cloudflare/pull/1356).
Remove the patch after upgrading to an adapter release that includes that fix.

Provide the current Worker host while building or developing:

```sh
NEXT_PUBLIC_AGENT_HOST=esp32-angry-cat.<account>.workers.dev \
pnpm dev
```

The local OpenNext development server and preview require Cloudflare bindings
and local secrets for the session and room-scoped report routes. Put a development-only `WEB_TOKEN_SECRET`
value of at least 32 characters in `.dev.vars` (which is gitignored). Without it,
the affected interview UI stays visible but shows a recoverable secure-setup
error instead of silently falling back to an insecure token. The
`INTERVIEW_REPORTS` binding is marked `dev: { remote: true }`, so local `/reports` can
read the real R2 bucket while the application code continues to run locally.
The checked-in `PUBLIC_REPORTS_ENABLED=false` default keeps that page from
listing anything until a deployment operator intentionally enables a reviewed
public collection.

## Production bindings and rollout

`cloudflare.config.ts` declares the private `INTERVIEWER_SERVICE` service binding,
the `INTERVIEW_REPORTS` R2 binding, the required shared secret, and a Cloudflare
Rate Limiting binding. The session endpoint accepts only same-origin `POST`
requests and has a 12-request-per-client-IP-per-minute limit. Use a random secret
of at least 32 characters. `WEB_TOKEN_SECRET` must have the exact same value on
the interviewer Worker. Put it in the gitignored `.dev.vars.production` file
using `WEB_TOKEN_SECRET=<production value>`, then upload it with the deployment:

```sh
pnpm build:worker
pnpm exec cf deploy --prebuilt --secrets-file .dev.vars.production
```

Deploy the interviewer Worker first because it owns the Durable Object route,
origin allowlist, token verification, and private R2 objects. Then build and
deploy this OpenNext Worker. A production smoke test should verify:

1. A same-origin `POST /api/session` returns `200`, a server-generated
   `web-<32 lowercase hex>` room, a scoped token, and both signed owner/report
   cookies. A second `POST /api/session?room=...` without the matching owner
   cookie must return `401`.
2. The browser connects without exposing `DEVICE_TOKEN`, survives a forced
   WebSocket reconnect, and preserves already-saved answers.
3. A completed report and optional cheat sheet download through `/api/reports`
   while missing, expired, and wrong-session credentials remain unauthorized.
4. With `PUBLIC_REPORTS_ENABLED=false`, `/reports` and public report downloads
   expose no R2 content. If the operator intentionally enables the library,
   it must list only reviewed artifacts under the `public-reports/` prefix and
   public JSON must not contain `sessionId` or room identifiers.

To publish a report deliberately, first create a redacted copy of its JSON and
Markdown artifacts under `pediatric-oral-boards/public-reports/`, review the
content for patient or identifying information, and only then set
`PUBLIC_REPORTS_ENABLED` to `true`. Never point the public route at the private
`pediatric-oral-boards/reports/` prefix.

The app intentionally keeps microphone failure non-fatal: examiner playback,
captions, and typed answers remain available. Audio capture is transactional,
bounded, muted outside listening turns, and stopped if the user cancels while
the browser permission prompt is open.
