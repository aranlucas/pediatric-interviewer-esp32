# A tiny cat. A full oral-boards grilling.

[![CI](https://github.com/aranlucas/pediatric-interviewer-esp32/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aranlucas/pediatric-interviewer-esp32/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/aranlucas/pediatric-interviewer-esp32)](LICENSE)
![ESP32](https://img.shields.io/badge/ESP32-S3-E7352C?logo=espressif&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Worker-F38020?logo=cloudflare&logoColor=white)

![Angry Cat, the pediatric dentistry examiner mascot](web/public/angry-cat-examiner.png)

**Pediatric-dentistry oral-boards practice with a grumpy cat.**

Practice in the browser or on a Waveshare ESP32-S3-Touch-LCD-3.5B. Both clients
use the Cloudflare interviewer Worker and receive a review after the interview.
The device uses six questions; the browser supports 3–10. Web-to-device case
handoff is a [proposed feature](ROADMAP.md), not an existing workflow.

This is study and practice software, not diagnosis, treatment advice or a
validated assessment. Use synthetic cases without patient or guardian
identifiers, and review clinical answers against the
[AAPD Reference Manual](https://www.aapd.org/research/oral-health-policies--recommendations/).

## Build the device

Install Arduino CLI, then run `make setup` to initialize vendor submodules and
install the pinned board core and libraries. Copy
[`interviewer_config.h.example`](firmware/angry_cat_pediatric_interviewer/interviewer_config.h.example)
to `interviewer_config.h` beside it. Supply the reachable Worker WebSocket URL,
matching `DEVICE_TOKEN`, and trusted root CA certificate; keep TLS verification
enabled. Without configuration, the interview remains unavailable.

With the board connected:

```sh
make compile
make upload
make monitor
```

Override the Makefile's serial port with `PORT=/dev/cu.<your-device>` for upload
and monitor. See the [Wokwi guide](simulator/wokwi/README.md) for hardware-free
checks and their limits, and the [board vendor](https://github.com/waveshareteam/ESP32-S3-Touch-LCD-3.5B)
for hardware resources.

## Web and Worker development

Run `pnpm install --frozen-lockfile` at the repository root using the Node and
pnpm versions in `.node-version` and `package.json`. Configure development
secrets and bindings using the [Worker guide](worker/README.md#local-development)
and [web guide](web/README.md#local-development), then run `pnpm dev` to start
both through Portless. Its first run may request `sudo` to bind port 443 and
trust a local certificate.

The web origin is `https://pediatric-interviewer-esp32.localhost`; the Worker is
`https://api.pediatric-interviewer-esp32.localhost`. Set
`NEXT_PUBLIC_AGENT_HOST=api.pediatric-interviewer-esp32.localhost` in
`web/.env.local` and include the web origin in the Worker's `WEB_ORIGINS`.
The ESP32 needs its own reachable Worker host.

Keep device tokens, provider credentials, and private interview reports out of Git.

## Workspace checks

From the repository root, `pnpm test` runs the existing Worker and web Vitest
suites. `pnpm build` builds both JavaScript packages; firmware still uses
`make compile` and the native Arduino toolchain.
