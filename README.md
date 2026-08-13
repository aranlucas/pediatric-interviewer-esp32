# Angry Cat Pediatric Dentistry Interviewer

A dedicated full-screen app for the Waveshare ESP32-S3-Touch-LCD-3.5B. The
opening screen is a two-column list of the ten oral-board study domains. Choose one and Angry
Cat runs a six-question pediatric dentistry interview over one persistent voice
session. Answer each question aloud and the next question starts automatically.
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

```sh
make setup
make compile
make upload
make monitor
```

The project vendors Waveshare's official `es8311` and
`esp_lcd_touch_axs15231b` Arduino drivers from board-support commit
`840daf2df7cb6b1f023fafc435371016e66f2ae0`. Small sketch-local build adapters
under `src` compile these vendored libraries with the pinned Arduino profile.
The vendored drivers carry small reliability fixes for allocation and I2C
failures, complete touch results, and released-touch state.

The app reuses the existing local Cloudflare device credentials when built next
to `waveshare_touch_demo`. For a standalone copy, duplicate
`interviewer_config.h.example` as the ignored `interviewer_config.h` and fill in
the Worker endpoint, shared device token, and CA certificate.

The corresponding Worker is in
`../waveshare_touch_demo/cloudflare/angry-cat-worker`. Its interviewer route is
`/agents/pediatric-interviewer/esp32`; it uses one Gemini Live voice session and
durable six-question interview state.
