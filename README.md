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