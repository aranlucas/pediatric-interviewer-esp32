# Pediatric Interviewer Worker

This directory contains the Cloudflare Worker backend for the pediatric
dentistry oral-board interviewer. It uses one Cloudflare Agents Durable Object
(`PediatricInterviewer`) per interview session. The Durable Object persists
interview state and exchanges in SQLite, keeps the Gemini Live transport alive
while provider work is running, and stores completed reviews in private R2.

The Worker has two clients:

- The ESP32 uses the device WebSocket protocol at
  `/agents/pediatric-interviewer/esp32` or
  `/agents/pediatric-interviewer/esp32-<8 lowercase hex>`. Device WebSocket
  authentication uses the shared `DEVICE_TOKEN` (query token is supported;
  the existing `X-Device-Token` WebSocket header remains accepted for device
  compatibility).
- The web service uses `/agents/pediatric-interviewer/web-<32 lowercase hex>`.
  It obtains a short-lived signed connection token from its `/api/session`
  route. The Worker requires the token to have `scope: "connect"`, a subject
  exactly equal to the room name, and an `Origin` listed in `WEB_ORIGINS`.

Ordinary HTTP requests under `/agents/...` are rejected before they can wake a
Durable Object. `GET /health` and `GET /interviewer/health` are public and
return only the protocol version and capability flags.

## Interview and Gemini Live contract

The default interview is six substantive questions. `start_call` may choose
one or more pediatric domains, `question_count` from 3 through 10, and
`difficulty` of `easy`, `standard`, or `hard`. The selected configuration is
persisted in Durable Object state and in the report.

Only a substantive answer advances the persisted exchange count. Readiness,
clarification, case-information, and probe turns remain inside the current
exchange. The runtime exchange count—not model wording or raw conversation
turns—owns completion. By default, the sixth persisted exchange triggers
evaluation; an explicit stop or an unrecoverable transport interruption
produces a partial review when at least one answer was saved. There is no local
whole-interview cutoff. Individual provider turns have a bounded response
deadline, while provider `GoAway` notices and resumable-session events drive
session rotation.

Gemini Live uses `gemini-3.1-flash-live-preview` through `@google/genai`:

- native audio input and output with input/output transcription;
- native 24 kHz PCM output, delivered to the device as ordered binary frames;
- explicit `activityStart`/`activityEnd` from the device, with provider
  automatic activity detection disabled;
- a schema-constrained case authored by stable `gemini-3.5-flash-lite`,
  semantically validated and persisted before playback; exact case audio is
  prewarmed in parallel with the cold-session Live warm-up, followed directly
  by the first focused clinical question;
- post-setup scripted prompts and typed candidate turns sent through current
  Live realtime text input rather than initial-history client content;
- generation-scoped session resumption with the provider handle kept in
  private Durable Object SQLite metadata, never in public interview state;
  the Enterprise-only transparent-replay option is not sent to the Developer
  API, so an unusable handle starts a fresh model context from the persisted
  interview summary;
- bounded client reconnect grace and provider reconnect attempts, with saved
  exchanges salvaged into a report after an unexpected close;
- a 45-second provider-response inactivity watchdog, refreshed by meaningful
  transcription, audio, completion, or tool progress, that replaces a true
  stalled Thinking state with generation-owned recovery, plus a 15-second Live
  setup deadline;
  committed candidate PCM is retained for at most 90 seconds (4,320,000 bytes)
  and replayed into a fresh session with the original case and authoritative
  unanswered-prompt context,
  while uncommitted or oversized audio is explicitly requested again;
- a 90-second ceiling on an uncommitted candidate turn, after which the Worker
  commits the bounded audio already received instead of waiting forever;
- a maximum accepted input PCM frame of 32 KiB, a 128 KiB/s input envelope,
  4,800-byte output frames, 4,000-character transcript tails, and a 512 KiB
  maximum provider audio field before base64 decoding.

Provider message processing is exception-contained: a malformed Live payload
or any SDK message/error/close callback failure enters the owned reconnect path
instead of tearing down the candidate socket.

The persisted case is spoken through bounded Cloudflare Workers AI using
`@cf/deepgram/aura-2-en` as raw 24 kHz PCM16. The separately validated
`gemini-3.1-flash-tts-preview` Interactions path is a provider fallback. Gemini
Live then asks the first clinical question directly; there is no candidate
readiness gate. Live system and recovery instructions declare that runtime-owned
case boundary, so the Worker does not inject unsupported model-role history
mid-session and Live cannot replace or repeat the case.

The opening stage, exact presented case, and any partially completed
question/answer/probe exchange are also persisted. On a Durable Object wake,
the Worker invalidates process-bound provider handles and reconstructs the exact
opening or unanswered active-probe context through the fresh session instruction.
Silent recovery context is never a presentation command, and a fresh-session
replay speaks only the authoritative pending clinical prompt. If
the client disappears during opening playback, the durable stage and exact case
are kept for replay after reconnect instead of resetting the interview to idle.
If interruption ends the interview during a probe, that answered partial
exchange is included exactly once in the recovery report and is cleared only
after the report is saved successfully.

The current PCM replay envelope remains process-local: a hard eviction during
candidate speech asks the candidate to repeat that one answer rather than
risk scoring partial or duplicated audio.

Cloudflare speech requests have a 30-second deadline and a 2.4 MB response
ceiling. The Worker requires even-length raw mono PCM16 and rejects an
unexpected container before playback. If Cloudflare is unavailable, the Gemini
fallback requests only the official audio response type, validates bounded raw
PCM or RIFF metadata, and resamples to 24 kHz. Both paths are paced in realtime
4,800-byte frames; readiness cannot begin unless the case was actually played.
If both providers fail, the interview returns to a retryable idle state instead
of asking the candidate to continue without hearing the case.

The case author, evaluator, and cheatsheet generator use stable
`gemini-3.5-flash-lite`; the Live voice session remains
`gemini-3.1-flash-live-preview`. Structured provider requests have bounded
response sizes and deadlines, and transient failures are retried. A cheatsheet
failure does not discard the main report.

## Authentication and report access

### Required Worker bindings and secrets

`worker/wrangler.jsonc` declares the non-secret `AI` binding used for primary
opening speech, the private `INTERVIEW_REPORTS` R2 bucket, the
`PEDIATRIC_INTERVIEWER` Durable Object, and `CONNECTION_RATE_LIMITER`.

`worker/wrangler.jsonc` declares these required secrets and generated Env
types:

- `DEVICE_TOKEN`: shared ESP32 authentication secret.
- `GEMINI_API_KEY`: server-only Gemini credential; it never reaches the ESP32
  or browser.
- `WEB_TOKEN_SECRET`: HMAC-SHA256 signing secret. The web service must use the
  same value to mint connect and report tokens.
- `WEB_ORIGINS`: comma-separated serialized origins, for example
  `https://oral-boards.example,http://localhost:3000`. The Worker requires an
  exact origin match for web WebSocket upgrades.

Web tokens are compact HMAC-SHA256 values with this payload and format:

```text
{ "v": 1, "sub": "web-<32 hex>", "exp": <unix seconds>, "scope": "connect" | "report" }
<base64url-json>.<base64url-signature>
```

The web `/api/session` route issues a two-hour, room-scoped `connect` token and sets a
two-hour `report` token in an HttpOnly, Secure, SameSite cookie. The browser
does not receive a global device secret. Web report downloads go through the
web `/api/reports/:reportId` route; that route forwards the signed report token
through the `INTERVIEWER_SERVICE` binding.

Direct Worker report access is also available for device/operator tooling:

```sh
curl \
  --header "X-Device-Token: $DEVICE_TOKEN" \
  --output review.md \
  "https://esp32-angry-cat.<account>.workers.dev/interviewer/reports/$REPORT_ID.md"
```

The report and recovery HTTP routes accept static device authentication only
through `X-Device-Token`; query-string device tokens are not accepted there.
Signed `Authorization: Bearer <report-token>` access is limited to a token
whose subject matches the R2 object's `sessionId` metadata. Invalid, expired,
missing, or mismatched signed report credentials return the same unauthorized
result without revealing whether an object exists.

## R2 reports and recovery

The private `pediatric-oral-boards-reports` bucket stores JSON and Markdown for
each report, plus an optional Markdown cheatsheet. Every object includes
`sessionId`, report configuration, outcome, and schema metadata. The report ID
is returned to the client, but report bodies and provider credentials are never
sent to the ESP32.

Recovery is intentionally separate from starting a new interview. A device can
send the `recover_report` WebSocket message after reconnecting, or an operator
can call:

```sh
curl -X POST \
  --header "X-Device-Token: $DEVICE_TOKEN" \
  --header "X-Durable-Object-Id: $DURABLE_OBJECT_ID" \
  "https://esp32-angry-cat.<account>.workers.dev/interviewer/recover-report"
```

`DURABLE_OBJECT_ID` must be the 64-hex ID of the interview object. Recovery
re-evaluates the exchanges already persisted in that object; it does not reset
or invent answers. A recovery attempt with no saved answers is rejected.

The Worker also defines `CONNECTION_RATE_LIMITER` at 30 connection-attempt
tokens per 60 seconds. It is keyed by Cloudflare client IP for attempts and by
the signed web subject after successful web-token validation. The configured
numeric namespace ID (`842176`) must remain unique to this Cloudflare account.

## Local setup and verification

From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run generate-types
pnpm test
pnpm run check
pnpm exec wrangler deploy --dry-run
pnpm run smoke:web
```

For local `wrangler dev`, create an untracked `worker/.dev.vars` containing
test/development values for all required bindings:

```text
DEVICE_TOKEN=...
GEMINI_API_KEY=...
WEB_TOKEN_SECRET=...
WEB_ORIGINS=http://localhost:3000
```

Run the local Worker with:

```sh
pnpm run dev
```

`pnpm test` covers the protocol, interview state, report contract, lifecycle
guards, and signed web-token/origin helpers. `pnpm run check` regenerates no
files; it verifies that Wrangler's generated Env types are current and then
runs TypeScript. The dry run verifies the Durable Object, Workers AI, R2,
required-secret, and RateLimit bindings without publishing a version.

## Live simulator and hardware limits

The macOS simulator exercises the deployed Worker, Gemini Live, Durable Object,
transcripts, report evaluation, and private R2 path without using the ESP32
microphone:

```sh
pnpm run simulate:interview --topic behavior_guidance
pnpm run simulate:interview --turns 1 --pause-ms 2000
pnpm run simulate:interview --turns 1 --wait-report
pnpm run simulate:interview --help
```

It synthesizes 24 kHz mono PCM with the macOS `say` and `afconvert` tools,
streams the device-default six answers, and reads the device URL/token from the
local firmware interviewer configuration without printing them. To override
that configuration, set both variables:

```sh
INTERVIEWER_WS_URL=wss://esp32-angry-cat.<account>.workers.dev/agents/pediatric-interviewer/esp32 \
DEVICE_TOKEN=... \
pnpm run simulate:interview --turns 6
```

`--wait-report` cleanly ends a partial run, waits for evaluation, authenticates
to the private JSON report route, and verifies that R2 contains exactly the
simulated scored exchanges. Full six-answer runs perform the same private
report check automatically.

Run the complete deployment regression suite with:

```sh
pnpm run simulate:suite
```

After both services are deployed, `pnpm run smoke:web` verifies the production
web session endpoint, secure report cookie, cross-origin rejection, private
report rejection, and a signed browser WebSocket handshake without printing
either signed token. Override `WEB_ORIGIN` or `AGENT_HOST` only when testing a
non-default deployment.

The suite checks paused speech, explicit commit timing, noisy-room commit,
350 ms ordered WebSocket playback jitter, and a complete six-answer interview
whose report is fetched from private R2. It writes the ignored
`simulation-report.json`. These are host/live service checks; microphone
analog behavior, codec operation, Wi-Fi/RF stability, power, and physical
display behavior still require the connected ESP32 and serial diagnostics.

## Provisioning and deployment order

Create the private bucket once, then provision the Worker secrets:

```sh
pnpm exec wrangler r2 bucket create pediatric-oral-boards-reports --location=wnam
pnpm exec wrangler secret put DEVICE_TOKEN
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put WEB_TOKEN_SECRET
pnpm exec wrangler secret put WEB_ORIGINS
```

The `AI` binding is account-native and configured in `wrangler.jsonc`; it does
not require a secret.

Deploy in this order:

1. From `worker/`, run the frozen install, tests, type check, and dry run. Deploy
   the Worker with `pnpm run deploy`, then verify `/health` and an authenticated
   report/recovery path.
2. In the `web/` deployment, configure the same `WEB_TOKEN_SECRET`, the public
   web origin in the Worker `WEB_ORIGINS`, and the existing
   `INTERVIEWER_SERVICE` service binding to `esp32-angry-cat`. The web Wrangler
   config also owns its `SESSION_RATE_LIMITER` binding.
3. Build and deploy the web service only after the Worker service exists:

   ```sh
   cd ../web
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm test
   pnpm run build
   pnpm run deploy
   ```

4. Verify that `POST /api/session?room=web-<32 hex>` returns a scoped token,
   the browser WebSocket origin is accepted, a reconnect can recover saved
   answers, and `/api/reports/<reportId>?kind=report` and
   `?kind=cheatsheet` return the private review.

Never deploy a Worker version with missing required secrets, stale generated
types, or a failing test/check gate. Do not treat the simulator's modeled
transport results as physical-board validation.
