# Angry Cat Oral Boards — web client

Responsive Next.js version of the ESP32 pediatric dentistry interviewer. The app runs on Cloudflare Workers through OpenNext and uses Cloudflare Agents SDK `useAgent` for automatic WebSocket reconnection, synchronized Durable Object state, and the existing binary interview protocol.

The setup screen supports one or more checked study domains. Multiple domains
become one coherent combo case. The user can choose 3-10 questions and Easy,
Standard, or Hard difficulty before starting; the default remains six questions
at Standard difficulty.

## Architecture

- The browser captures 24 kHz mono PCM16 in an AudioWorklet, streams it through the Agents SDK connection, and schedules returned PCM16 through Web Audio.
- The Agents SDK connects to the `esp32-angry-cat` Worker using a 128-bit `web-<32 hex>` Durable Object name. A same-origin session route mints a two-hour, room-scoped HMAC connection token and stores a two-hour report-scope token in an HttpOnly cookie.
- Session authentication is fetched once per explicit connection attempt and passed through the SDK's supported static query contract. Transient sockets therefore use the library's exponential reconnect backoff instead of minting a new token on every failed handshake; a terminal failure exposes one explicit token-refresh action.
- `WEB_TOKEN_SECRET` is a Worker secret shared by the web OpenNext Worker and the interviewer Worker. Configure it with `wrangler secret put WEB_TOKEN_SECRET`; it must never be a `NEXT_PUBLIC_*` variable.
- Interview reports remain private R2 objects. The browser downloads them through `/api/reports/<report-id>?kind=report|cheatsheet`; the web Worker proxies the request over the `INTERVIEWER_SERVICE` binding with an Authorization bearer token.
- A web `start_call` sends `topic_ids`, `question_count`, and `difficulty`; the Worker persists those settings in synchronized state and the private report.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm cf-typegen
pnpm cf-typecheck
pnpm build
pnpm exec opennextjs-cloudflare build
pnpm exec wrangler deploy --dry-run
pnpm preview
pnpm deploy
```

Provide the current Worker host while building or developing:

```sh
NEXT_PUBLIC_AGENT_HOST=esp32-angry-cat.<account>.workers.dev \
pnpm dev
```

The local OpenNext preview requires local Cloudflare bindings/secrets for the
session and report routes. Without `WEB_TOKEN_SECRET`, the UI stays visible but
shows a recoverable secure-setup error instead of silently falling back to a
shared browser token.

## Production bindings and rollout

`wrangler.jsonc` declares the private `INTERVIEWER_SERVICE` service binding,
the required `WEB_TOKEN_SECRET`, and a Cloudflare Rate Limiting binding. The
session endpoint accepts only a same-origin `POST` and allows 12 token requests
per client IP per minute. Use a random secret of at least 32 characters and set
the exact same value on the interviewer Worker:

```sh
pnpm exec wrangler secret put WEB_TOKEN_SECRET
```

Deploy the interviewer Worker first because it owns the Durable Object route,
origin allowlist, token verification, and private R2 objects. Then build and
deploy this OpenNext Worker. A production smoke test should verify:

1. `POST /api/session?room=web-<32 lowercase hex>` returns `200`, a scoped
   token, and the private report cookie from the production web origin.
2. The browser connects without exposing `DEVICE_TOKEN`, survives a forced
   WebSocket reconnect, and preserves already-saved answers.
3. A completed report and optional cheat sheet download through `/api/reports`
   while missing, expired, and wrong-session credentials remain unauthorized.

The app intentionally keeps microphone failure non-fatal: examiner playback,
captions, and typed answers remain available. Audio capture is transactional,
bounded, muted outside listening turns, and stopped if the user cancels while
the browser permission prompt is open.
