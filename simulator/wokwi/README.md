# Wokwi simulator

The standard profile compiles the production sketch for Wokwi's ESP32-S3 model.
It excludes local interviewer credentials and tests boot, the unconfigured
interview guard, event delivery, speaker output and paced PCM ring playback.
Live integration is a separate opt-in profile that uses local credentials,
contacts the configured Worker/Gemini service and creates a private R2 report.

## Standard local flow

1. Complete the [firmware toolchain setup](../../README.md#build-the-device).
2. From the repository root, run `make compile-simulator`.
3. Open `simulator/wokwi/` as a VS Code workspace with the official Wokwi
   Simulator extension, then run **Wokwi: Start Simulator**.

`make simulate` runs the checked-in standard scenario with Wokwi CLI and
`WOKWI_CLI_TOKEN`. It compiles first. `make simulator-config-check` only parses
the diagram and scenario files; it does not run firmware.

Builds stage copies of the sketch and fixtures under `build/`; edit source in
`firmware/` or `simulator/wokwi/fixtures/`, not the staged copy. Standard and
integration outputs are separate. The last successful compile selects
`build/wokwi-active`, which the checked-in `wokwi.toml` loads. Recompile the
standard profile after live testing to return to credential-free simulation.

## Controls

The custom display mirrors the framebuffer. Open its controls, set **Touch X**
and **Touch Y**, then toggle **Touch pressed** on and off for a tap. These
coordinate controls support the production touch state machine; clicking pixels
directly does not supply touch coordinates.

In Wokwi Terminal:

- `p` plays a half-second 440 Hz speaker test.
- `b` runs the deterministic PCM ring-wrap/playback check.
- `t` tests the unconfigured topic guard and `e` tests event-queue delivery
  in the standard profile.

The Wi-Fi and speaker peripherals show connection/signal and audio activity;
the microphone display shows queued text in interactive live mode. The bridges
are simulator-only; Wi-Fi still uses Wokwi's virtual radio and TCP/TLS stack.

## Live integration

Configure the ignored firmware `interviewer_config.h` with the reachable Worker
URL, matching device token and trusted CA as described in the root guide.
From the repository root, run `make compile-simulator-integration`, start the
VS Code simulator, and type `s` in Wokwi Terminal. The automated fixture streams
generated candidate PCM and checks the completed private report. Success ends
with `SIM_INTEGRATION: END_TO_END_PASSED`.

For question-specific answers, type `i` before `s`. Each time
`SIM_MIC: awaiting answer` appears, enter a response:

```text
a I would first assess immediate safety and ask the caregiver for specific examples.
```

The `a ` prefix is a simulator command, not part of the answer. Type `i` again
to return to automated PCM. Typed text is an integration seam; production
firmware uses the physical microphone.

The CLI live targets (`simulate-integration`, `simulate-turn-complete`, and
`simulate-integration-interactive`) have a recorded gateway/TLS failure to the
Worker: `Could not connect to Cloudflare voice`. Use the VS Code extension's
IoT Gateway for this path if the CLI cannot connect. Preserve TLS certificate
validation. The turn-completion scenario checks candidate acceptance and the
subsequent Gemini completion, rather than a full report.

For headless host-to-service verification, use the
[Worker live simulator](../../worker/README.md#live-verification-and-hardware-limits)
from this repository's `worker/` directory. It also contacts real providers and
creates private reports; it does not execute ESP32 firmware.

## Hardware acceptance limits

The custom display is a framebuffer mirror, not an electrical model of the
AXS15231B controller. Wokwi does not model this exact Waveshare board or its
ESP32-S3 I2S path. The AXS15231B QSPI protocol, AXS5106L I2C touch protocol,
TCA9554 reset path, ES8311 codec/register behavior, microphone, power and real
Wi-Fi/RF stability still require physical-device validation. Simulator success
establishes application-boundary behavior only.
