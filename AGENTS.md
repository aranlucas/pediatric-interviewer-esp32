# ESP32 Hardware Workspace

## Board

The connected target is a **Waveshare ESP32-S3-Touch-LCD-3.5B**:

## Build and device workflow

```sh
make setup
make compile
make upload
make monitor
```

## Resources

- https://github.com/waveshareteam/ESP32-S3-Touch-LCD-3.5/

## Simulation

Running wokwiki simulator if there is no physical hardware

## Scripts: native first

Before adding a script file (`scripts/`, `bin/`, `tools/`, root `*.sh|*.py|*.mjs`) or a package script that runs one, take the first rung that works:

1. A flag or subcommand of a tool the repo already uses (`<tool> --help`).
2. Declarative config for that tool (`Makefile`, `pnpm-workspace.yaml`, `worker/cloudflare.config.ts`, `web/next.config.mts`, `worker/vitest.config.ts`, `web/vitest.config.mts`, `oxfmt.config.ts`).
3. A maintained plugin for that tool.
4. A one-line Makefile target or package.json script that calls a native command.
5. A test in the existing runner (Vitest in worker/ or web/), for anything that asserts.
6. A custom script, only for behavior specific to this repo. Its first comment names the native rung it couldn't use and why. It has a test in the existing runner, and the PR that adds it quotes that comment.

## Code: libraries first

Before hand-writing general-purpose code, use a well-maintained library: actively released, widely adopted, typed, and a fit for this stack. Reach for one already in the dependencies first. Write custom code for domain logic and for the glue no library covers. A PR that adds a dependency says why it was picked; a PR that hand-writes something a library covers names the library and why it didn't fit.

- Interview message and report validation → `zod`.
- Worker HTTP routing → `hono`.
- Stateful interview sessions and client connections → `agents` and `agents/react`.
- Gemini live audio sessions → `@google/genai` (`GoogleGenAI`).
