# Project conventions

Firmware targets the Waveshare ESP32-S3-Touch-LCD-3.5B. Use the
[README](README.md) for setup and the [Wokwi guide](simulator/wokwi/README.md)
when hardware is unavailable; simulator success does not validate the physical board.

## Scripts: native first

Before adding a script or a package command that invokes one, use the first viable rung:

1. A flag or subcommand of an existing tool (`<tool> --help`).
2. Declarative configuration for that tool.
3. A maintained plugin for that tool.
4. A one-line Makefile target or package.json script that calls a native command.
5. A test in the existing runner (Vitest in worker/ or web/), for anything that asserts.
6. A custom script, only for behavior specific to this repo. Its first comment names the native rung it couldn't use and why. It has a test in the existing runner, and the PR that adds it quotes that comment.

## Code: libraries first

Use an existing dependency first, then an actively maintained, widely used typed library that fits this stack. Reserve custom code for domain logic and uncovered glue. In PRs, justify new dependencies or name the relevant library and explain why it did not fit.

- Interview message and report validation → `zod`.
- Worker HTTP routing → `hono`.
- Stateful interview sessions and client connections → `agents` and `agents/react`.
- Gemini live audio sessions → `@google/genai` (`GoogleGenAI`).
