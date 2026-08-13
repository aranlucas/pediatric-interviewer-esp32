# Wokwi simulator profile

This profile runs the production Arduino sketch on Wokwi's ESP32-S3 model with
16 MB flash and 8 MB octal PSRAM. The automation scenario verifies:

- firmware boot and PSRAM framebuffer allocation;
- the simulator-only audio loopback seam;
- connection to Wokwi's virtual Wi-Fi network;
- serial-injected touch routing to the first study topic;
- the safe guard that prevents an interview without credentials; and
- FreeRTOS queue delivery of an interviewer state event; and
- a 40-second paced PCM stream through the 64 KiB PSRAM ring, including ring
  wraparound and byte-for-byte playback validation.

Simulator builds define `ANGRY_CAT_SIMULATOR`. That build never includes local
interviewer credentials and cannot contact the production Worker.

The simulator fixture is implemented in `fixtures/AngryCatSimulator.cpp`.
`make stage-simulator` copies the production sketch and that fixture into a
generated sketch under `build/`, then Arduino CLI compiles the staged copy.
This keeps simulator implementations and the generated speech bytes out of the
production firmware source tree; `AngryCatSimulator.h` contains declarations
only.

## Live integration test

`make compile-simulator-integration` builds an explicit opt-in integration
profile. It uses the ignored local `interviewer_config.h`, the real TLS
WebSocket Worker route, and Wokwi's virtual Wi-Fi. Its default automated mode
streams a short generated candidate answer at 24 kHz to test the normal PCM
transport boundary. Because a real interview asks dynamic questions, an
interactive mode also accepts a new typed answer for every question and sends
it into the same authenticated Gemini Live conversation. Both modes wait for
the real interview to complete, download the private R2 report, and validate
its score entries on the simulated ESP32-S3.

With a Wokwi CLI token, run the complete scenario with:

```sh
WOKWI_CLI_TOKEN=... make simulate-integration
```

For the fastest agent loop, avoid the VS Code terminal and run the official
Wokwi CLI in interactive mode:

```sh
WOKWI_CLI_TOKEN=... make simulate-integration-interactive
```

The process exposes ESP32 serial on stdin/stdout, so an agent can wait for
`SIM_MIC: awaiting answer` and write a question-specific `a <answer>` line
directly. `make simulate-turn-complete` provides a shorter deterministic gate
that asserts both `client turn complete=true` and the subsequent
`Gemini turn complete` event. `make wokwi-mcp` starts Wokwi CLI's experimental
MCP server when direct MCP integration is preferred.

Standard and live-integration firmware now compile into separate build and
staging directories. After a successful link, the selected profile atomically
updates `build/wokwi-active`; Wokwi never observes a half-cleaned build
directory, and concurrent standard/integration compiles cannot delete each
other's objects.

For the visual local flow, run `make compile-simulator-integration`, start the
Wokwi extension, and type `s` into Wokwi Terminal. Success ends with
`SIM_INTEGRATION: END_TO_END_PASSED`. This test contacts the deployed service
and creates a real private interview report.

The live interview runs only under the VS Code extension, which bundles the
Wokwi IoT Gateway and gives the simulated radio real network access. It is not
a license tier: `wokwi-cli` implements no gateway at all, so it always routes
through Wokwi's cloud gateway, which does not complete the ESP32-S3 WebSocket
TLS handshake to the Worker. The firmware refuses to fall back to plaintext or
disable certificate validation, so `make simulate-integration` and
`make simulate-turn-complete` fail with `Could not connect to Cloudflare voice`
regardless of `WOKWI_CLI_TOKEN`. Running `wokwigw` locally does not help: the
CLI has no option to point at it. Use the VS Code flow for the live path, and
`cd worker && npm run simulate:interview` for a headless end-to-end check.

For a question-aware interactive interview, type `i` before `s`. Whenever the
terminal prints `SIM_MIC: awaiting answer`, enter a new response as:

```text
a I would first assess the child's immediate safety and ask the caregiver for specific examples.
```

The `a ` prefix is a simulator command and is not included in the candidate
answer. The custom microphone display shows whether it is waiting or has queued
text, and the Wokwi Chips output logs the supplied text. Type `i` again to
return to the automated PCM fixture. Typed answers are an integration-test
seam only; the production firmware continues to use the physical microphone.

The Worker repository also provides a hardware-free integration suite that
streams synthesized speech through the deployed Worker and Gemini Live, then
fetches the completed report from private R2:

```sh
cd ../waveshare_touch_demo/cloudflare/angry-cat-worker
npm run simulate:suite
```

## Local visual UI

1. Run `make compile-simulator` or `make compile-simulator-integration` from
   the repository root.
2. Open this `simulator/wokwi` directory as a VS Code workspace.
3. Install the official Wokwi Simulator extension.
4. Run `Wokwi: Start Simulator` from the command palette.

The Wokwi window displays the virtual ESP32-S3 board, the live serial terminal,
and four custom peripherals:

- a 320 x 480 Angry Cat display with coordinate touch controls;
- a terminal-fed text microphone status display for dynamic interviews;
- a Wi-Fi monitor driven by the ESP32's Wokwi-native radio state; and
- a 24 kHz PCM speaker/DAC with a live level meter and audible buzzer sink.

Simulator builds mirror the production `Arduino_Canvas` framebuffer over a
dedicated SPI test seam on GPIO 9, 10, and 11. The seam sends only the changed
rectangle after each flush, so screen transitions and animation remain
responsive. The Wi-Fi and speaker monitors share the SPI clock/data pins and
use chip selects on GPIO 19 and 18. None of these seams are compiled into the
production firmware. Their virtual wires remain electrically connected but are
kept in a wiring bay to the left of the display so they do not cover the
framebuffer.

Click the custom display to open its controls. Set **Touch X** and **Touch Y**
to a screen coordinate, turn **Touch pressed** on, then turn it off to release.
The ESP32-S3 polls those coordinates over simulator-only SPI MISO on GPIO 17,
and the production touch state machine handles the resulting tap, hold, or
swipe.
Wokwi custom framebuffers do not expose pointer coordinates, so these controls
provide coordinate-accurate touch input rather than direct mouse clicks on the
pixels.

Type `p` in Wokwi Terminal to play a half-second 440 Hz speaker test. Real
interviewer PCM uses the same bridge. Wi-Fi networking itself is not replaced
by the status chip: the ESP32 connects to Wokwi's `Wokwi-GUEST` virtual access
point and retains the simulator's real TCP/TLS stack. The chip reflects that
connection and its signal strength.

Interviewer playback uses a 64 KiB PSRAM ring with a 24 KiB startup prebuffer.
The Worker sends each 4,800-byte PCM frame at its 100 ms playback duration, so
the device no longer needs a blocking high/low-water backpressure loop. Type
`b` in Wokwi Terminal to run the deterministic ring-wrap and playback test.

Wokwi does not provide the board's AXS15231B QSPI display as a standard visual
part. The custom display is therefore a pixel-accurate visual mirror rather
than an electrical model of the physical controller.

Wokwi does not currently emulate ESP32-S3 I2S or the exact Waveshare
ESP32-S3-Touch-LCD-3.5B. The AXS15231B electrical protocol, AXS5106L I2C
protocol, TCA9554 reset path, and ES8311 register/I2S behavior therefore remain
physical-device acceptance tests. The simulator exercises their application
boundaries through the display, touch, microphone fixture, Wi-Fi, and speaker
bridges. The production build does not use any simulator seams.
