# Wokwi simulator profile

This profile runs the production Arduino sketch on Wokwi's ESP32-S3 model with
16 MB flash and 8 MB octal PSRAM. The automation scenario verifies:

- firmware boot and PSRAM framebuffer allocation;
- the simulator-only audio loopback seam;
- connection to Wokwi's virtual Wi-Fi network;
- serial-injected touch routing to the first study topic;
- the safe guard that prevents an interview without credentials; and
- FreeRTOS queue delivery of an interviewer state event.

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
WebSocket Worker route, and Wokwi's virtual Wi-Fi. A short generated candidate
answer replaces only the unavailable I2S microphone boundary. The firmware
streams that PCM answer at 24 kHz for each of the six turns, waits for the real
interview to complete, downloads the private R2 report, and validates its score
entries on the simulated ESP32-S3.

With a Wokwi CLI token, run the complete scenario with:

```sh
WOKWI_CLI_TOKEN=... make simulate-integration
```

For the visual local flow, run `make compile-simulator-integration`, start the
Wokwi extension, and type `s` into Wokwi Terminal. Success ends with
`SIM_INTEGRATION: END_TO_END_PASSED`. This test contacts the deployed service
and creates a real private interview report. It requires Wokwi's Private IoT
Gateway. The Community license's Public Gateway can reach ordinary HTTPS but
did not complete the ESP32-S3 WebSocket TLS handshake; the simulator refuses
to fall back to plaintext or disable certificate validation.

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

The Wokwi window displays the virtual ESP32-S3 board and its live serial
terminal. The current profile intentionally uses an offscreen 320 x 480
framebuffer, so it validates UI rendering memory and state transitions but does
not display the Angry Cat pixels. Wokwi does not provide the board's
AXS15231B QSPI display as a standard visual part.

Wokwi does not currently emulate ESP32-S3 I2S or the exact Waveshare
ESP32-S3-Touch-LCD-3.5B. The AXS15231B QSPI panel, AXS5106L touch protocol,
TCA9554 reset path, ES8311 codec, microphone, and speaker therefore remain
physical-device acceptance tests. The production build does not use any of the
simulator seams.
