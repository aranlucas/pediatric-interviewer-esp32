# Angry Cat web client

The browser interviewer runs on Cloudflare Workers through Next.js/OpenNext.
Use synthetic cases only; `/privacy` explains the practice-only data boundary.

## Local development

Install dependencies and start the pair from the
[repository root](../README.md#web-and-worker-development). In `web/`, create
an ignored `.dev.vars` with a development-only `WEB_TOKEN_SECRET` of at least
32 characters, matching the interviewer Worker's secret. Missing configuration
produces a recoverable secure-setup error.

Set `NEXT_PUBLIC_AGENT_HOST` in `.env.local` to the interviewer hostname and
optional port, without a path. The root guide gives the Portless hostname;
the default points at the deployed Worker, so set it explicitly for local work.
Include the web origin in the interviewer's `WEB_ORIGINS`.

From `web/`, `pnpm test` and `pnpm check` run the local checks; `check`
regenerates ignored Cloudflare types. `pnpm build` produces a Next.js build.
For a Cloudflare artifact, use `pnpm build:worker`; `pnpm preview` builds and
serves that artifact locally.

[`cloudflare.config.ts`](cloudflare.config.ts) owns bindings.
OpenNext's dev proxy and build use the derived, ignored
`.opennext-wrangler.json`; edit the source config rather than that file.
The build helper uses OpenNext plus Wrangler's bundler delegate to produce
`.cloudflare/output/v0/`. Wrangler remains required by this adapter.

The `INTERVIEW_REPORTS` binding has `dev: { remote: true }`: local report-library
routes can read the real R2 bucket. `PUBLIC_REPORTS_ENABLED=false` keeps the
library disabled by default. Local application execution alone is not proof
that every binding is local.

## Session and privacy boundary

`POST /api/session` requires the same origin and creates a random
`web-<32 lowercase hex>` room. It returns a two-hour room-scoped connection
token and sets separate signed owner/report capabilities in Secure, HttpOnly,
SameSite cookies. Refreshing with `?room=...` requires that room's owner cookie;
knowing a room name does not confer ownership. The rate limiter allows 12
session requests per client IP per minute.

The browser reuses its connection token across transient SDK reconnects;
a terminal failure exposes an explicit token-refresh action. Microphone failure
leaves playback, captions and typed answers available.

`/api/reports/<report-id>?kind=report|cheatsheet` proxies private downloads
through `INTERVIEWER_SERVICE` with the signed report token. The interviewer
checks the report's persisted session identity. Keep `WEB_TOKEN_SECRET`
server-side; it must never be a `NEXT_PUBLIC_*` variable. See the
[Worker contract](../worker/README.md#client-and-report-contracts) for token
format and device/operator access.

## Publishing a reviewed report collection

`/reports` and `/api/report-library/<report-id>` are a public, read-only library
only when `PUBLIC_REPORTS_ENABLED=true`. They read
`pediatric-oral-boards/public-reports/`, never the private
`pediatric-oral-boards/reports/` prefix.

To publish deliberately, create redacted JSON and Markdown copies under the
public prefix, review all artifacts for patient, guardian and other identifying
information, then enable the flag. Public JSON downloads additionally strip
`sessionId`; that is not a substitute for reviewing the full content. Keep the
public route separate from the private prefix.

## Rollout

Deploy the [interviewer Worker first](../worker/README.md#provisioning-and-rollout).
Supply the matching `WEB_TOKEN_SECRET` in ignored `web/.dev.vars.production`.
From `web/`:

```sh
pnpm test
pnpm check
pnpm build:worker
pnpm exec cf deploy --prebuilt --dry-run
pnpm exec cf deploy --prebuilt --secrets-file .dev.vars.production
```

Before treating rollout as complete, verify:

1. Same-origin `POST /api/session` creates a room and owner/report cookies;
   refreshing that room without its owner cookie returns `401`.
2. The browser connects without exposing `DEVICE_TOKEN`; a forced reconnect
   preserves saved answers.
3. Completed report/cheatsheet downloads work through `/api/reports`, while
   missing, expired and wrong-session credentials remain unauthorized.
4. The disabled library exposes no R2 content. An intentionally enabled library
   lists only reviewed public copies, and public JSON contains no room identifier.
