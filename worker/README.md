# Pediatric Interviewer Worker

The interviewer uses one Agents Durable Object per session, SQLite for saved
exchanges, Gemini Live for voice, and private R2 objects for completed reviews.

## Local development

Install workspace dependencies from the [repository root](../README.md#web-and-worker-development).
Create an ignored `worker/.dev.vars` with development values:

```text
DEVICE_TOKEN=...
GEMINI_API_KEY=...
WEB_TOKEN_SECRET=...
WEB_ORIGINS=https://pediatric-interviewer-esp32.localhost
```

`DEVICE_TOKEN` authenticates devices; `GEMINI_API_KEY` stays server-side.
`WEB_TOKEN_SECRET` must match the web service and be at least 32 characters.
`WEB_ORIGINS` is a comma-separated list of exact serialized browser origins.
Never expose these secrets through `NEXT_PUBLIC_*` variables.

From `worker/`:

```sh
pnpm dev
pnpm test
pnpm check
pnpm build
```

`pnpm check` regenerates ignored Env types before linting and type checking.
Bindings, Worker identity and Durable Object lifecycle are declared in
[`cloudflare.config.ts`](cloudflare.config.ts). The Workers AI binding needs no secret.

## Client and report contracts

WebSocket routes are `/agents/pediatric-interviewer/<room>`:

- Device rooms are `esp32` or `esp32-<8 lowercase hex>`. Authenticate with
  `?token=<DEVICE_TOKEN>` or the `X-Device-Token` header.
- Browser rooms are `web-<32 lowercase hex>`. The web service creates the room
  through its same-origin `/api/session` route. The Worker requires an allowed
  `Origin` and a signed token with `scope: "connect"` and the exact room subject.
  Ordinary HTTP requests cannot enter an interview object through these routes.

Web tokens use HMAC-SHA256 over the base64url JSON payload:

```text
{ "v": 1, "sub": "web-<32 hex>", "exp": <unix seconds>, "scope": "connect" | "report" }
<base64url-json>.<base64url-signature>
```

The web service issues two-hour connection/report credentials and keeps the
report capability in a Secure, HttpOnly cookie. See the
[web session boundary](../web/README.md#session-and-privacy-boundary) for owner
capabilities and token refresh. Browsers never receive the shared device secret.

Clients exchange 24 kHz mono PCM16 audio and JSON control messages. The
[message schema](src/interviewer-protocol.ts) defines controls and limits;
[`start_call` configuration](src/interview-config.ts) defaults to six questions
at standard difficulty. Only saved substantive answers advance the question
count; clarification and probe turns remain in the current exchange.

The runtime owns the presented case and completion boundary. It saves the case
before playback, recovers the pending question/probe from durable state, and
salvages answered work into a partial report after an unrecoverable interruption.
Candidate audio replay is process-local: hard eviction can require repeating
that answer. Opening-speech failure returns to retryable idle; an optional
cheatsheet failure does not discard the main review.

`GET /health` and `/interviewer/health` are public capability checks. Private
artifacts are served from `/interviewer/reports/<report-id>.json`, `.md`, or
`<report-id>-cheatsheet.md`. Device/operator HTTP access requires
`X-Device-Token`; query-string device tokens work only for WebSocket upgrades.
Signed `Authorization: Bearer <report-token>` access requires the R2 object's
`sessionId` metadata to match the token subject. Invalid, expired, missing and
wrong-session signed credentials return the same unauthorized result.

For an authorized operator, download Markdown with:

```sh
curl \
  --header "X-Device-Token: $DEVICE_TOKEN" \
  --output review.md \
  "https://esp32-angry-cat.<account>.workers.dev/interviewer/reports/$REPORT_ID.md"
```

The bucket's `pediatric-oral-boards/reports/` prefix remains private. Reports
are not published automatically; the web service has a separate, disabled-by-default
[public collection](../web/README.md#publishing-a-reviewed-report-collection).

## Recover an interrupted report

Recovery evaluates already-saved answers without starting a new interview.
Stop an active interview first. A connected device can send `recover_report`;
an operator can use the HTTP route after the client and provider disconnect:

```sh
curl -X POST \
  --header "X-Device-Token: $DEVICE_TOKEN" \
  --header "X-Durable-Object-Id: $DURABLE_OBJECT_ID" \
  "https://esp32-angry-cat.<account>.workers.dev/interviewer/recover-report"
```

`DURABLE_OBJECT_ID` is the interview object's 64-hex ID. The HTTP route returns
`409` for an active interview or one without recoverable saved work. Successful
recovery returns the report ID; it does not reset or invent answers. If saving
fails, saved work remains available for another recovery attempt.

## Live verification and hardware limits

These commands contact the configured service and providers and create private
reports. They are separate from local tests. From `worker/` on macOS:

```sh
pnpm simulate:interview --topic behavior_guidance
pnpm simulate:interview --turns 1 --wait-report
pnpm simulate:suite
```

The simulator uses `say` and `afconvert`. It reads URL/token from the ignored
firmware `interviewer_config.h` without printing them, or accepts both
`INTERVIEWER_WS_URL` and `DEVICE_TOKEN` as environment overrides. Consult
`pnpm simulate:interview --help` for individual timing/noise options.
Full six-answer runs and partial runs with `--wait-report` fetch private R2
JSON and check the saved exchanges. The suite adds pause, explicit-commit and
noise checks, writing ignored `simulation-report.json`.

`smoke:web` is also a live-service test. It checks server-created rooms,
owner-authorized session refresh, private cookies, HTTP guards and the signed
WebSocket handshake. Run it explicitly against a configured deployment.

Host simulation does not validate the physical microphone, codec, Wi-Fi/RF,
power or display. Use the [Wokwi guide](../simulator/wokwi/README.md) for simulated
firmware boundaries and validate the board separately before a hardware release.

## Provisioning and rollout

Create the private bucket once, if it does not exist:

```sh
pnpm exec cf r2 buckets create --name pediatric-oral-boards-reports --location-hint wnam
```

Put production values for the four secrets above in ignored
`worker/.dev.vars.production`. Connection rate-limit namespace IDs must remain
unique within the Cloudflare account; preserve the separate web/session and
Worker/connection namespaces in their configs.

1. From `worker/`, run tests and `pnpm check`, then
   `pnpm exec cf deploy --dry-run`. With those passing and all required secrets
   supplied, deploy using `pnpm exec cf deploy --secrets-file .dev.vars.production`.
2. Verify `/health` and an authenticated report/recovery path. Configure the
   same `WEB_TOKEN_SECRET` on the web service, its public origin in Worker
   `WEB_ORIGINS`, and its `INTERVIEWER_SERVICE` binding to this Worker.
3. Follow the [web rollout procedure](../web/README.md#rollout) only after the
   interviewer Worker exists. Verify the session ownership, reconnect and
   private/public report boundaries there.
