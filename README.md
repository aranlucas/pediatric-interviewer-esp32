# Angry Cat Pediatric Dentistry Interviewer

A full-stack pediatric oral-boards trainer for the Waveshare
ESP32-S3-Touch-LCD-3.5B. This repository contains the device firmware, Wokwi
simulator, and its Cloudflare Worker. The opening screen is a two-column list
of the ten oral-board study domains. Choose one and Angry Cat runs a
six-question pediatric dentistry interview over one persistent voice session.
Answer each question aloud and the next question starts automatically.
Normal taps are ignored once the interview begins, so an accidental tap cannot
tear down the call. Hold for 2.5 seconds to end an interview; hold from the topic
screen to reopen Wi-Fi setup.

After a completed interview, the device uses its existing private device token
to fetch the saved JSON report from R2 through the Worker. It retains a bounded
device review containing the outcome, examiner summary, and up to six scored
skill areas. The review opens automatically: swipe left or right between pages,
tap to advance, or hold for 2.5 seconds to return to the topic menu. The complete
JSON and Markdown reports remain privately stored in R2.

The menu uses the supplied ABPD-style domains verbatim, from Behavior Guidance
through Elements of Pediatric Dental Practice. The interviewer gives only a brief neutral transition and
does not score or invent clinical corrections. Review answers against the
current AAPD Reference Manual:
https://www.aapd.org/research/oral-health-policies--recommendations/

## Build and device workflow

The Arduino sketch lives in
`firmware/angry_cat_pediatric_interviewer`; the root Makefile keeps the normal
workflow independent of the repository's checkout directory name.

```sh
make setup
make compile
make upload
make monitor
```

### Simulator

The Wokwi profile exercises ESP32-S3 boot, the PSRAM framebuffer, Wi-Fi, topic
routing, and FreeRTOS interviewer-event handling without a physical device. It
uses deterministic display, touch, and audio seams because Wokwi does not
simulate the Waveshare board or ESP32-S3 I2S.

```sh
make compile-simulator
make simulator-config-check
WOKWI_CLI_TOKEN=... make simulate
WOKWI_CLI_TOKEN=... make simulate-integration
```

The test never loads local interviewer credentials or contacts the production
Worker. The separate integration target is opt-in: it loads the ignored local
interviewer configuration, runs all six turns against the deployed Worker, and
verifies the saved report can be downloaded and parsed. For a local visual
board and serial console, open `simulator/wokwi` in VS Code with the official
Wokwi extension and run `Wokwi: Start Simulator`. See
`simulator/wokwi/README.md` for coverage and limitations.

The display uses `GFX Library for Arduino`'s `Arduino_AXS15231B` driver and the
codec uses `arduino-audio-driver` v0.3.0's ES8311 implementation through a
commit-pinned Git submodule. The board's AXS15231B touch protocol is not
provided by Arduino_GFX, so its official Waveshare touch driver remains
vendored from board-support commit
`840daf2df7cb6b1f023fafc435371016e66f2ae0`. A sketch-local adapter under
`firmware/angry_cat_pediatric_interviewer/src/board` compiles that driver with
the pinned Arduino profile. It carries small reliability fixes for I2C
failures, complete touch results, and released-touch state.

Duplicate
`firmware/angry_cat_pediatric_interviewer/interviewer_config.h.example` as
`interviewer_config.h` in the same directory and fill in the Worker endpoint,
shared device token, and CA certificate.

## Cloudflare Worker

The deployable Worker lives in `worker`. Its interviewer route is
`/agents/pediatric-interviewer/esp32`; it uses one Gemini Live voice session,
durable six-question interview state, and private R2 report storage. Gemini's
native 24 kHz PCM output is preserved through the Worker, I2S bus, and ES8311
codec instead of being downsampled to 16 kHz before playback.

```sh
cd worker
pnpm install --frozen-lockfile
pnpm test
pnpm run check
pnpm exec wrangler secret put DEVICE_TOKEN
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm run deploy
```

`worker/wrangler.jsonc` declares the Workers AI, Durable Object, and R2
bindings. Secrets remain encrypted in Cloudflare and are not committed. The
Worker also retains the original `/agents/angry-cat/esp32` voice route used by
the weather display because both routes share the deployed Worker entrypoint.
See `worker/README.md` for provisioning and live simulation commands.

## License

This project is licensed under GNU GPL version 3. The audio-driver dependency
is distributed under the same license; its ES8311 codec implementation retains
the upstream notices in the submodule.
