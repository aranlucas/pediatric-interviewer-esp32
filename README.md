# A tiny cat. A full oral-boards grilling.

[![Web and Worker CI](https://github.com/aranlucas/pediatric-interviewer-esp32/actions/workflows/web-worker-ci.yml/badge.svg?branch=main)](https://github.com/aranlucas/pediatric-interviewer-esp32/actions/workflows/web-worker-ci.yml)
[![MIT License](https://img.shields.io/github/license/aranlucas/pediatric-interviewer-esp32)](LICENSE)
![ESP32](https://img.shields.io/badge/ESP32-S3-E7352C?logo=espressif&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Worker-F38020?logo=cloudflare&logoColor=white)

![Angry Cat, the pediatric dentistry examiner mascot](web/public/angry-cat-examiner.png)

**Six pediatric-dentistry questions. One grumpy cat. A handheld oral-boards practice session.**

Angry Cat is a training project for the Waveshare ESP32-S3-Touch-LCD-3.5B. Set up a case in the web client, run the interview on the device, and finish with a bounded review. The connected Cloudflare Worker supports the web and device workflow.

_The orange cat is the existing project mascot; it is not a clinical examiner._

## The practice loop

1. Set up a pediatric dentistry case in the web client.
2. Work through a six-question interview on the touch display.
3. Review a concise summary of the session.

The repository includes the Arduino firmware, a web client and Worker, and a Wokwi simulator project. The trainer is for study and practice, not diagnosis or treatment advice. Review clinical answers against the [AAPD Reference Manual](https://www.aapd.org/research/oral-health-policies--recommendations/).

## Build the device

The supported board is the Waveshare ESP32-S3-Touch-LCD-3.5B. With the device connected, use the repository Makefile:

```sh
make setup
make compile
make upload
make monitor
```

The firmware sketch and interview client live in firmware/angry_cat_pediatric_interviewer. Simulator files are in simulator/wokwi/.

## Web and Worker development

The web client is in `web/`; the interviewer Worker is in `worker/`. Run `pnpm install` from the repository root. The web development command runs Cloudflare type generation before starting Next.js; the firmware retains its separate Make workflow.

Keep device tokens, provider credentials, and private interview reports out of Git.

## Local URLs with Portless

The Worker and Next.js client run as separate processes so they receive different
backend ports. The web command preserves its Cloudflare type-generation step.

The standard development command uses [Portless](https://github.com/vercel-labs/portless).
Install its pinned CLI once with Node.js 24 or newer, then run this repository's command after the
normal dependency and environment setup:

```sh
npm install -g portless@0.15.7
pnpm dev
```

The main checkout uses `https://api.pediatric-interviewer-esp32.localhost` with the default proxy settings.
Use the URL printed by Portless if you have changed its proxy port, TLS, or TLD.
Linked Git worktrees get a branch prefix, so each checkout has its own origin.
The first HTTPS run can request local administrator permission to bind port 443,
trust its development certificate, and synchronize local hostnames. Ctrl+C stops
the child server and removes its route. The direct fallback below starts the
server without the proxy.

`pnpm dev` starts both applications. To run one service, use `pnpm dev:web` or
`pnpm dev:worker`. The web client's default URL is `https://pediatric-interviewer-esp32.localhost`. For a fully local
pair, set `NEXT_PUBLIC_AGENT_HOST=api.pediatric-interviewer-esp32.localhost` in
`web/.env.local`, and set `WEB_ORIGINS` in the interviewer's local secret file to the
exact web origin. Use the printed branch-prefixed hostnames for linked worktrees.
Keep HTTPS enabled for this app's existing Secure cookies and agent connection policy.
The local OpenNext and interviewer Workers still need the same development-only
`WEB_TOKEN_SECRET` and their existing Cloudflare bindings. Follow the current
web/Worker binding setup for private reports and session routes; Portless only
provides local routing and HTTPS. Do not use production secrets for this setup.

HTTPS supports the existing Secure cookies and browser microphone requirements.
This `.localhost` route is for a browser on the development computer; the physical
ESP32 retains its configured, reachable Worker host. Use `pnpm dev:direct` for both direct servers, or `pnpm --dir web dev:direct`
and `pnpm --dir worker dev:direct` individually. Firmware commands are unchanged.
