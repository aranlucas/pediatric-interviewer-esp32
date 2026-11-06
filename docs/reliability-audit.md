# Correctness and reliability audit — 2026-11-06

Baseline: remote default `main`, `9da2067` (merged structural pass #75).
Static inspection only locally; all tests and builds run in CI. Public APIs and
intended interview behavior remain the compatibility boundary.

## Inventory and trust boundaries

- Browser: server-issued room and scoped HMAC token, owner cookie refresh,
  Agents WebSocket, topic/configuration selection, PCM microphone and speaker,
  typed fallback, review/download. Startup failure and explicit retry are user journeys.
- Web routes: same-origin session issuance with rate limiting; private report
  proxy uses signed report cookie. Curated public archive is separately gated,
  reads only `public-reports/`, strips session ID on JSON download.
- Worker: Hono edge authentication and origin/rate checks; Agents Durable Object
  owns one client interview, provider lifecycle, deadlines, bounded audio,
  transcript persistence, reconnect/replay and report recovery. Gemini and speech
  providers are external failure boundaries. SQL state and R2 report writes must
  survive transient client/provider failures without false completion.
- Firmware: TLS/device token WebSocket, touch controls, audio queues and reconnect;
  Waveshare vendor submodules and generated artwork are not first-party logic.
  Wokwi fixtures cannot validate physical board I/O or timing.
- CI/configuration/tools: existing Vitest, type/lint, OpenNext/Worker dry-run checks;
  native Arduino toolchain needed for board validation. No production operations.

## Findings recorded before fixes

### R1: stale audio initialization destroys a replacement graph (high confidence)

Location: `web/lib/browser-audio.ts`, `initialize` and `initializeCapture`.
Trigger: first startup awaits context resume or media acquisition; user stops and
starts a new interview before that promise settles. The obsolete resume branch
calls `cleanup()` on shared current fields; obsolete media rejection calls
`cleanupCapture()` on the replacement stream. Expected: obsolete startup returns
false and releases only its own resources. Actual: replacement graph/stream is
closed, so the new interview loses audio. Final capture resume also returns true
after cancellation. Regression: deferred first resume and deferred rejected first
media request, followed by a successful second startup; assert second capture
still sends PCM and its track/context remain active.

## Reconciled and rejected hypotheses

- Ordinary HTTP cannot enter the interview DO through the agent router: the
  before-request hook enforces WebSocket upgrade.
- A valid report credential for one room cannot read another room's private
  artifact: R2 session metadata is checked against signed subject.
- An arbitrary requested room cannot be claimed by refreshing tokens: the exact
  room owner capability is verified before issuance.
- Public report listing is not a private-bucket leak: dedicated curated prefix
  and explicit deployment enablement are required.
- A failed study-aid generation does not discard the evaluation: finalization
  catches it separately and stores the report. R2 multi-artifact partial writes
  are retried; publication occurs after finalization succeeds.

## Framework and validation plan

Requested framework: published `e2e@0.23.0`, `@e2e-dev/web@0.15.5` (peer range
`e2e >=0.22.1 <1`); Node requirement `^22.22.3 || >=24.8.0` is met by repository
Node 24.22.1. Read upstream quickstart and GitHub Actions docs on 2026-11-06.
Use real Next production server in CI and deterministic browser assertions for
secure setup failure/retry/recovery, with controlled session/network fixtures.
This covers the browser journey, not Gemini quality or physical firmware.
Worker API/protocol tests remain meaningful coverage for non-UI paths; e2e web
engine does not execute ESP32 firmware. No provider/model credentials are needed.

CI will run regressions against fixed sources and the same regression file against
baseline audio source, requiring the baseline run to fail for the intended tests.
Independent review and CI outcomes will be recorded before merge.
