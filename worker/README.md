# Angry Cat Pediatric Interviewer Worker

This is the Cloudflare backend for the pediatric interviewer firmware in this
repository. The same deployed Worker also retains the weather display's Angry
Cat streaming voice route. It uses a Cloudflare Agents SDK Durable Object per
device, including embedded SQLite state and a bounded turn history. Workers AI runs
`@cf/deepgram/nova-3` for continuous transcription and turn detection,
`@cf/zai-org/glm-4.7-flash` for multi-turn dialogue and tool calling, and
`@cf/deepgram/aura-2-en` for text-to-speech. No provider API key is stored on
the ESP32. Each stage has one selected model; failures are returned instead of
silently switching providers. Angry Cat uses the masculine British `draco`
speaker.

The ESP32 connects to `/agents/angry-cat/esp32` with the shared
`X-Device-Token` header and the required `?model=nova-3` query, matching
`useVoiceAgent({ query: { model: "nova-3" } })`. It sends 16 kHz mono PCM as binary WebSocket frames
and receives status, transcripts, device actions, and 20 ms PCM speech frames on that same
connection. Weather and air quality are ordinary server-side Agent tools that
fetch Open-Meteo only when the model calls them; the ESP32 does not upload a
sensor snapshot before a voice turn. The model can call
`get_current_weather`, `get_forecast`, `get_air_quality`, `remember_fact`,
`set_animation`, `set_volume`, and the ESP32-executed `set_gpio` client tool.
`set_gpio` is restricted to GPIO 21 (J8 header pin 6), waits for the correlated
device readback, and rejects other pins. The first model step must select a tool;
`respond_without_tool` is the explicit route for casual conversation. The
token is stored as an encrypted Worker secret and in the local, uncommitted
firmware `interviewer_config.h`. `GET /health` is public.

```sh
pnpm install --frozen-lockfile
pnpm run generate-types
pnpm test
pnpm run check
pnpm exec wrangler secret put DEVICE_TOKEN
pnpm run deploy
```

Workers AI runs remotely, including during local development. Requests can
incur Workers AI usage.

## Pediatric Oral Boards reports

The pediatric interviewer keeps one Durable Object session per topic tap and
requires six answered questions. After answer six, the Worker sends the exact
six-question transcript to `gemini-3.1-flash-lite` for a structured study
review. The result follows the Oral Boards report contract: outcome, examiner
summary, 1-3 skill scores, contrastive feedback, and a natural spoken model
answer for every question.

Neutral clarification probes remain within the current scored exchange, and a
candidate can request relevant case information without consuming an answer.
Only a substantive response advances to the next of the six skillsets.

Each completed review is stored in the private
`pediatric-oral-boards-reports` R2 bucket as both JSON and Markdown. The ESP32
receives the report ID; report bodies and the Gemini key never reach the
device. Retrieve a report with the same device token used for its WebSocket:

```sh
curl \
  --header "X-Device-Token: $DEVICE_TOKEN" \
  --output review.md \
  "https://esp32-angry-cat.aranlucas.workers.dev/interviewer/reports/$REPORT_ID.md"
```

Provisioning requires the private bucket and two encrypted Worker secrets:

```sh
pnpm exec wrangler r2 bucket create pediatric-oral-boards-reports --location=wnam
pnpm exec wrangler secret put DEVICE_TOKEN
pnpm exec wrangler secret put GEMINI_API_KEY
```

The pediatric interviewer uses one `gemini-3.1-flash-live-preview` WebSocket
for native audio input, reasoning, input/output transcripts, and native audio
output. Gemini's native 24 kHz PCM output stays at 24 kHz through the Worker,
WebSocket stream, ESP32 I2S bus, and ES8311 codec. The shared full-duplex bus
also captures 24 kHz microphone PCM, which Gemini accepts and resamples to its
native 16 kHz input rate. The device owns turn detection: five seconds of local
silence commits an answer, while a tap commits immediately in a noisy room.
Each turn is sent to Gemini with explicit activity-start/activity-end signals,
so the provider cannot cut off an ordinary thinking pause. The general Angry
Cat weather app still uses the Workers AI voice pipeline.

### Simulate candidate speech

On macOS, run a complete spoken interview without using the ESP32 microphone:

```sh
pnpm run simulate:interview -- --topic behavior_guidance
```

The simulator uses the system `say` voice, converts it to 16 kHz mono PCM,
streams six answers at real-time device cadence, and inserts a two-second
thinking pause inside every answer. It reads the local device URL and token
from `../firmware/angry_cat_pediatric_interviewer/interviewer_config.h`
without printing them. Set both `INTERVIEWER_WS_URL` and `DEVICE_TOKEN` to
override that file. A shorter VAD regression run is:

```sh
pnpm run simulate:interview -- --turns 1 --pause-ms 2000
```

Use `pnpm run simulate:interview -- --help` for voice, speech-rate, topic, pause,
turn-count, and timeout options.

Run the deployment regression gate with:

```sh
pnpm run simulate:suite
```

It checks a two-second thinking pause, an explicit commit after four seconds,
cafe chatter with tap-equivalent commit, an ordered 350 ms WebSocket-jitter
model using the ESP32 buffer sizes, and a complete six-turn interview whose
report is fetched back from private R2. Results are written to the ignored
`simulation-report.json`. The jitter gate is a deterministic host model; analog
microphone, codec, Wi-Fi radio, and power behavior still require the physical
board and serial diagnostics.
