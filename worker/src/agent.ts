import {
  WorkersAINova3STT,
  type StreamingTTSProvider,
  type TTSProvider,
  type Transcriber,
  type VoiceTurnContext,
  withVoice,
} from "@cloudflare/voice";
import { Agent, type Connection } from "agents";
import { isStepCount, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

import { sanitizeLine } from "./lib";
import {
  DEVICE_GPIO_HEADER_PIN,
  DEVICE_GPIO_PIN,
  DEVICE_GPIO_TOOL,
  parseClientToolResult,
  type DeviceGpioState,
} from "./device-tools";
import {
  getAirQuality,
  getCurrentWeather,
  getForecast,
  type WeatherLocation,
} from "./weather-tools";
import { NOVA_3_QUERY_MODEL, requestedTranscriptionModel } from "./voice-config";

const TRANSCRIPTION_MODEL = "@cf/deepgram/nova-3" as const;
const CONVERSATION_MODEL = "@cf/zai-org/glm-4.7-flash" as const;
const SPEECH_MODEL = "@cf/deepgram/aura-2-en" as const;
const SPEECH_SPEAKER = "draco" as const;
const SPEECH_SAMPLE_RATE = 16_000;
const PCM_FRAME_BYTES = 640;
const MAX_FACTS = 8;
const MAX_FACT_LENGTH = 120;
const CLIENT_TOOL_TIMEOUT_MS = 8_000;

type PendingClientTool = {
  connectionId: string;
  tool: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export const CAT_ANIMATIONS = [
  "idle",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "thinking",
  "review",
] as const;

const EMPTY_INPUT = z.object({});
const FORECAST_INPUT = z.object({
  days: z.number().int().min(1).max(5).default(5),
});
const REMEMBER_FACT_INPUT = z.object({
  fact: z.string().max(MAX_FACT_LENGTH),
});
const ANIMATION_INPUT = z.object({ animation: z.enum(CAT_ANIMATIONS) });
const VOLUME_INPUT = z.object({
  level: z.number().int().min(0).max(21),
});
const GPIO_INPUT = z.object({
  pin: z.literal(DEVICE_GPIO_PIN),
  state: z.enum(["on", "off"]),
});

export type CatAnimation = (typeof CAT_ANIMATIONS)[number];

export type AngryCatState = {
  facts: string[];
  interactionCount: number;
  lastAnimation: CatAnimation;
  volume: number;
};

const VoiceAgent = withVoice(Agent, {
  audioFormat: "pcm16",
  sampleRate: SPEECH_SAMPLE_RATE,
  historyLimit: 12,
  maxMessageCount: 100,
});

export class WorkersAIPcmTTS implements TTSProvider, StreamingTTSProvider {
  constructor(private readonly ai: Ai) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of this.synthesizeStream(text, signal)) {
      const bytes = new Uint8Array(chunk);
      chunks.push(bytes);
      length += bytes.byteLength;
    }
    if (length === 0) return null;
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined.buffer;
  }

  async *synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
    const response = await this.ai.run(
      SPEECH_MODEL,
      {
        text,
        speaker: SPEECH_SPEAKER,
        encoding: "linear16",
        container: "none",
        sample_rate: SPEECH_SAMPLE_RATE,
      },
      {
        returnRawResponse: true,
        signal,
        tags: ["esp32-angry-cat-streaming-voice"],
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Aura 2 failed with HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
      );
    }
    if (!response.body) throw new Error("Aura 2 returned no audio stream");

    const reader = response.body.getReader({ mode: "byob" });
    try {
      while (true) {
        const { done, value } = await reader.readAtLeast(
          PCM_FRAME_BYTES,
          new Uint8Array(PCM_FRAME_BYTES),
        );
        if (done) break;
        if (signal?.aborted) return;
        const length = value.byteLength - (value.byteLength % 2);
        if (length === value.buffer.byteLength) {
          yield value.buffer;
        } else if (length > 0) {
          yield value.slice(0, length).buffer;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function sendDeviceAction(connection: Connection, action: Record<string, unknown>): void {
  connection.send(JSON.stringify({ type: "device_action", ...action }));
}

function cleanFact(value: string): string {
  const fact = value.replace(/\s+/g, " ").trim();
  if (!fact || fact.length > MAX_FACT_LENGTH) {
    throw new Error("fact must be short and non-empty");
  }
  return fact;
}

export class AngryCat extends VoiceAgent<Env, AngryCatState> {
  private readonly pendingClientTools = new Map<string, PendingClientTool>();
  private readonly workersAI = createWorkersAI({ binding: this.env.AI });
  private readonly location: WeatherLocation = {
    name: this.env.WEATHER_LOCATION,
    latitude: Number(this.env.WEATHER_LATITUDE),
    longitude: Number(this.env.WEATHER_LONGITUDE),
  };

  initialState: AngryCatState = {
    facts: [],
    interactionCount: 0,
    lastAnimation: "idle",
    volume: 18,
  };

  createTranscriber(connection: Connection): Transcriber {
    const model = requestedTranscriptionModel(connection.uri);
    if (model !== NOVA_3_QUERY_MODEL) {
      throw new Error(`Unsupported transcription model: ${model ?? "missing"}; expected nova-3`);
    }
    console.log(JSON.stringify({ event: "voice_transcriber_selected", model }));
    return new WorkersAINova3STT(this.env.AI, {
      language: "en",
      endpointingMs: 500,
      utteranceEndMs: 1_200,
      smartFormat: true,
      punctuate: true,
      keyterms: ["Angry Cat", "AQI", "PM2.5", "Seattle"],
      sampleRate: SPEECH_SAMPLE_RATE,
    });
  }

  tts = new WorkersAIPcmTTS(this.env.AI);

  onMessage(connection: Connection, message: unknown): void {
    if (typeof message !== "string") return;
    const result = parseClientToolResult(message);
    if (!result) return;
    const pending = this.pendingClientTools.get(result.id);
    if (!pending || pending.connectionId !== connection.id || pending.tool !== result.tool) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingClientTools.delete(result.id);
    if (result.ok) {
      pending.resolve(result.result ?? { ok: true });
    } else {
      pending.reject(new Error(result.error?.slice(0, 160) || "Device tool failed"));
    }
  }

  onClose(connection: Connection): void {
    for (const [id, pending] of this.pendingClientTools) {
      if (pending.connectionId !== connection.id) continue;
      clearTimeout(pending.timeout);
      this.pendingClientTools.delete(id);
      pending.reject(new Error("Device disconnected during tool call"));
    }
  }

  private requestClientTool(
    connection: Connection,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingClientTools.delete(id);
        reject(new Error(`Device tool ${toolName} timed out`));
      }, CLIENT_TOOL_TIMEOUT_MS);
      this.pendingClientTools.set(id, {
        connectionId: connection.id,
        tool: toolName,
        resolve,
        reject,
        timeout,
      });
      try {
        connection.send(
          JSON.stringify({
            type: "client_tool_call",
            id,
            tool: toolName,
            arguments: arguments_,
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pendingClientTools.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  afterTranscribe(transcript: string): string | null {
    const cleaned = transcript.replace(/\s+/g, " ").trim().slice(0, 240);
    return cleaned.length >= 2 ? cleaned : null;
  }

  beforeSynthesize(text: string): string {
    return sanitizeLine(text);
  }

  async onTurn(transcript: string, voice: VoiceTurnContext) {
    const current = this.state;
    this.setState({
      ...current,
      interactionCount: current.interactionCount + 1,
    });
    const facts = current.facts.length > 0 ? current.facts.join("; ") : "None yet.";
    const usingTool = (name: string) => {
      console.log(JSON.stringify({ event: "agent_tool_call", tool: name }));
      sendDeviceAction(voice.connection, { tool: name });
    };

    const result = streamText({
      model: this.workersAI(CONVERSATION_MODEL, {
        chat_template_kwargs: { enable_thinking: false },
      }),
      system:
        "You are Angry Cat, a grumpy but lovable British tuxedo cat living on a tiny weather display. " +
        "Reply with one useful sentence of at most 14 words. Be dry and mildly sarcastic, never cruel. " +
        "No quotes, emoji, markdown, or stage directions. Use a server tool for every weather, forecast, " +
        "air-quality, pollution, or UV question; never guess live values from conversation history. " +
        "Call the server tool immediately without announcing it, then answer only from its result. " +
        "Use action tools only when requested or when an animation strongly suits the reply. " +
        `For GPIO requests, the only controllable output is GPIO ${DEVICE_GPIO_PIN} on J8 header pin ${DEVICE_GPIO_HEADER_PIN}; use set_gpio and report its readback. ` +
        `Remembered user facts: ${facts}. Current speaker volume: ${current.volume}/21.`,
      messages: [
        ...voice.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: "user" as const, content: transcript },
      ],
      tools: {
        get_current_weather: tool({
          description:
            "Fetch live current weather from Open-Meteo. Call for current conditions, temperature, humidity, wind, rain, sunset, or UV.",
          inputSchema: EMPTY_INPUT,
          execute: async () => {
            usingTool("get_current_weather");
            return getCurrentWeather(this.location);
          },
        }),
        get_forecast: tool({
          description:
            "Fetch the live daily forecast from Open-Meteo. Call for today, tomorrow, or the next five days.",
          inputSchema: FORECAST_INPUT,
          execute: async ({ days }) => {
            usingTool("get_forecast");
            return getForecast(this.location, days);
          },
        }),
        get_air_quality: tool({
          description:
            "Fetch live air quality from Open-Meteo. Call for AQI, PM2.5, PM10, ozone, pollution, smoke, or UV.",
          inputSchema: EMPTY_INPUT,
          execute: async () => {
            usingTool("get_air_quality");
            return getAirQuality(this.location);
          },
        }),
        remember_fact: tool({
          description:
            "Remember a short user fact only when the user explicitly asks you to remember it.",
          inputSchema: REMEMBER_FACT_INPUT,
          execute: async ({ fact: rawFact }) => {
            const fact = cleanFact(rawFact);
            const latest = this.state;
            const alreadySaved = latest.facts.some(
              (saved) => saved.toLowerCase() === fact.toLowerCase(),
            );
            const facts = alreadySaved ? latest.facts : [...latest.facts, fact].slice(-MAX_FACTS);
            this.setState({ ...latest, facts });
            return { remembered: fact };
          },
        }),
        set_animation: tool({
          description:
            "Choose the physical cat animation when the user requests a motion or one strongly matches the reply.",
          inputSchema: ANIMATION_INPUT,
          execute: async ({ animation }) => {
            const latest = this.state;
            this.setState({ ...latest, lastAnimation: animation });
            sendDeviceAction(voice.connection, { animation });
            return { animation };
          },
        }),
        set_volume: tool({
          description:
            "Set speaker volume only when explicitly requested. Use 0 for mute and 21 for maximum.",
          inputSchema: VOLUME_INPUT,
          execute: async ({ level }) => {
            const latest = this.state;
            this.setState({ ...latest, volume: level });
            sendDeviceAction(voice.connection, { volume: level });
            return { volume: level };
          },
        }),
        set_gpio: tool({
          description:
            `Turn the physical ESP32 output GPIO ${DEVICE_GPIO_PIN} on or off. ` +
            `It is exposed on J8 header pin ${DEVICE_GPIO_HEADER_PIN}. Use only when explicitly requested.`,
          inputSchema: GPIO_INPUT,
          execute: async ({ state }: { state: DeviceGpioState }) => {
            usingTool(DEVICE_GPIO_TOOL);
            return this.requestClientTool(voice.connection, DEVICE_GPIO_TOOL, {
              pin: DEVICE_GPIO_PIN,
              state,
            });
          },
        }),
        respond_without_tool: tool({
          description:
            "Use only when the request is casual conversation and no weather, air-quality, memory, animation, volume, or GPIO tool applies.",
          inputSchema: EMPTY_INPUT,
          execute: async () => {
            usingTool("respond_without_tool");
            return { instruction: "Answer the user directly and briefly." };
          },
        }),
      },
      // Make tool selection an explicit first model step. Later steps receive
      // the tool result and may produce the spoken answer normally.
      prepareStep: ({ stepNumber }) => ({
        toolChoice: stepNumber === 0 ? "required" : "auto",
      }),
      stopWhen: isStepCount(4),
      temperature: 0.6,
      maxOutputTokens: 120,
      abortSignal: voice.signal,
    });

    return result.fullStream;
  }
}

export const angryCatModels = {
  conversation: CONVERSATION_MODEL,
  transcription: TRANSCRIPTION_MODEL,
  speech: SPEECH_MODEL,
  speaker: SPEECH_SPEAKER,
} as const;
