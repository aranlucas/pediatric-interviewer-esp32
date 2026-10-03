import { Agent, type Connection } from "agents";
import { GoogleGenAI } from "@google/genai/web";
import {
  InterviewerCore,
  type InterviewerEnv,
  type PediatricInterviewerState,
} from "./interviewer-core";
import { generateOpeningCase } from "./opening-case";
import { synthesizeOpeningSpeech } from "./opening-speech";
import { synthesizeCloudflareSpeech } from "./cloudflare-speech";
import { finalizeInterviewReport } from "./interview-finalization";

export {
  PEDIATRIC_TOPICS,
  DEVICE_SAMPLE_RATE,
  OUTPUT_PCM_FRAME_BYTES,
  PROVIDER_RESPONSE_TIMEOUT_MS,
  GEMINI_CONNECT_TIMEOUT_MS,
  CANDIDATE_TURN_TIMEOUT_MS,
  pediatricInterviewerModels,
  type OpeningStage,
  type InterviewPhase,
  type PediatricInterviewerState,
} from "./interviewer-core";

export class PediatricInterviewer extends Agent<Env & InterviewerEnv, PediatricInterviewerState> {
  private core = this.createCore();
  private createCore() {
    return new InterviewerCore(
      {
        getState: () => this.state,
        env: this.env,
        getName: () => this.name,
        setState: (next) => this.setState(next),
        sql: (strings, ...values) => this.sql(strings, ...values),
        keepAlive: () => this.keepAlive(),
        keepAliveWhile: (operation) => this.keepAliveWhile(operation),
        retry: (operation, options) => this.retry(operation, options),
      },
      {
        connect: (options) =>
          new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY }).live.connect(options),
        generateOpeningCase,
        synthesizeOpeningSpeech,
        synthesizeCloudflareSpeech,
        finalizeInterviewReport,
      },
    );
  }
  initialState = this.core.initialState;
  validateStateChange(next: PediatricInterviewerState, source: Connection | "server") {
    return this.core.validateStateChange(next, source);
  }
  onStart() {
    return this.core.onStart();
  }
  onRequest(request: Request) {
    return this.core.onRequest(request);
  }
  onConnect(connection: Connection) {
    return this.core.onConnect(connection);
  }
  onMessage(connection: Connection, message: string | ArrayBuffer) {
    return this.core.onMessage(connection, message);
  }
  onClose(connection: Connection) {
    return this.core.onClose(connection);
  }
}
