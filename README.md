# Angry Cat Pediatric Dentistry Interviewer

Firmware and a Cloudflare Worker for a six-question pediatric dentistry oral-boards trainer on the Waveshare ESP32-S3-Touch-LCD-3.5B. A web client provides case setup; the device runs the interview and shows a bounded review.

## Build and upload

```bash
make setup
make compile
make upload
make monitor
```

The Arduino sketch is in `firmware/angry_cat_pediatric_interviewer`. The web client is in `web/`.

## Privacy

Keep device tokens, credentials, and private interview reports out of Git. Review clinical answers against the [AAPD Reference Manual](https://www.aapd.org/research/oral-health-policies--recommendations/).
