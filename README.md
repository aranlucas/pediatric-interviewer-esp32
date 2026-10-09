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

The web client is in `web/`; the interviewer Worker is in `worker/`. Run `pnpm install` from the repository root, then `pnpm dev` to start both through [Portless](https://github.com/vercel-labs/portless) (a dev dependency); its first run may ask for `sudo` to bind port 443 and trust a local certificate. The web client is at `https://pediatric-interviewer-esp32.localhost` and the Worker at `https://api.pediatric-interviewer-esp32.localhost`. For a fully local pair, set `NEXT_PUBLIC_AGENT_HOST=api.pediatric-interviewer-esp32.localhost` in `web/.env.local` and `WEB_ORIGINS` in the Worker's local secrets to the web origin. The ESP32 keeps its configured, reachable Worker host.

Keep device tokens, provider credentials, and private interview reports out of Git.
