import { vi } from "vitest";
import {
  InterviewerCore,
  initialInterviewState,
  type InterviewHost,
  type InterviewServices,
  type LiveSession,
} from "../src/interviewer-core";
import { finalizeInterviewReport } from "../src/interview-finalization";

export function fakeLiveSession(overrides: Partial<LiveSession> = {}) {
  return {
    sendRealtimeInput: vi.fn<LiveSession["sendRealtimeInput"]>(),
    sendToolResponse: vi.fn<LiveSession["sendToolResponse"]>(),
    close: vi.fn<LiveSession["close"]>(),
    ...overrides,
  };
}

export function testInterviewer(
  services: Partial<InterviewServices> = {},
  hostOverrides: Partial<InterviewHost> = {},
) {
  let state = initialInterviewState();

  const host: InterviewHost = {
    getState: () => state,
    env: {
      GEMINI_API_KEY: "test-gemini-key",
      INTERVIEW_REPORTS: { put: vi.fn().mockResolvedValue(null) },
    },
    getName: () => "synthetic-protocol-test",
    setState(next) {
      state = structuredClone(next);
    },
    sql: vi.fn(() => []),
    keepAlive: vi.fn(async () => () => undefined),
    keepAliveWhile: async (operation) => operation(),
    retry: async (operation) => operation(1),
    ...hostOverrides,
  };

  return new InterviewerCore(host, {
    connect: async () => {
      throw new Error("No synthetic Live provider configured");
    },
    generateOpeningCase: async () => {
      throw new Error("No synthetic case provider configured");
    },
    synthesizeOpeningSpeech: async () => {
      throw new Error("No synthetic speech provider configured");
    },
    synthesizeCloudflareSpeech: async () => {
      throw new Error("No synthetic Cloudflare speech configured");
    },
    finalizeInterviewReport,
    ...services,
  });
}
