import { describe, expect, it } from "vitest";

import {
  serverMessageSchema,
  simulationCompleteSchema,
  storedReportSchema,
  webSocketBuffer,
} from "../tools/simulation-protocol.mjs";

describe("simulator payload validation", () => {
  it("accepts server events and ignores unrelated metadata", () => {
    expect(
      serverMessageSchema.parse({
        type: "interview_state",
        phase: "interviewing",
        questionNumber: 1,
        domain: "behavior_guidance",
        question: "What is your diagnosis?",
        answerCount: 0,
      }),
    ).toEqual({
      type: "interview_state",
      phase: "interviewing",
      questionNumber: 1,
      domain: "behavior_guidance",
      question: "What is your diagnosis?",
    });
  });

  it("allows optional fields to be absent and leaves unrelated events unhandled", () => {
    expect(
      serverMessageSchema.safeParse({
        type: "interview_state",
        phase: "idle",
        questionNumber: 0,
        domain: "behavior_guidance",
      }).success,
    ).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "welcome" }).success).toBe(false);
    expect(
      storedReportSchema.parse({ reportId: "report-1", evaluation: { exchanges: [] } }),
    ).toEqual({ reportId: "report-1", evaluation: { exchanges: [] } });
  });

  it("rejects malformed server fields before the simulator consumes them", () => {
    for (const message of [
      null,
      { type: "transcript", role: "user", text: 12 },
      { type: "interview_state", phase: "interviewing", questionNumber: "1", domain: "test" },
      { type: "opening_audio_fallback", stage: "case", bytes: -1 },
      { type: "turn_complete", answerCount: 0.5, questionNumber: 1 },
      { type: "interview_report", reportId: "", outcome: "pass", reviewPath: "/report" },
    ]) {
      expect(serverMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("requires stored report identity and an exchange array", () => {
    const stored = {
      reportId: "report-1",
      evaluatorModel: "test-model",
      evaluation: { exchanges: [{ question: "Example" }] },
      cheatsheet: { markdown: "Study notes" },
    };

    expect(storedReportSchema.parse(stored)).toEqual(stored);
    expect(storedReportSchema.safeParse({ evaluation: { exchanges: [] } }).success).toBe(false);
    expect(
      storedReportSchema.safeParse({ reportId: "report-1", evaluation: { exchanges: 6 } }).success,
    ).toBe(false);
  });

  it("requires a complete child-process summary rather than trusting its event name", () => {
    const summary = {
      event: "simulation_complete",
      answersSimulated: 1,
      stoppedBeforeQuestion: 2,
      commitsSent: 1,
      prematureStops: 0,
      followUps: { total: 0, perQuestion: [0] },
      candidateTranscripts: ["My answer"],
      primaryQuestions: ["Your diagnosis?"],
      openingTurns: [],
      openingAudioFallbacks: [],
      firstQuestionTurn: null,
      turnCompletions: [{ answerCount: 1, questionNumber: 2 }],
      openingTurnCompletionCount: 1,
      report: null,
      outputAudio: { frames: 1, bytes: 4800, maximumFrameBytes: 4800, oddFrames: 0 },
    };

    expect(simulationCompleteSchema.parse(summary)).toEqual(summary);
    expect(simulationCompleteSchema.safeParse({ event: "simulation_complete" }).success).toBe(
      false,
    );
    expect(
      simulationCompleteSchema.safeParse({ ...summary, candidateTranscripts: [123] }).success,
    ).toBe(false);
  });
});

describe("WebSocket raw data normalization", () => {
  it("preserves a Buffer including its byte offset", () => {
    const frame = Buffer.from([0, 1, 2, 3]).subarray(1, 3);
    expect(webSocketBuffer(frame)).toBe(frame);
    expect(webSocketBuffer(frame)).toEqual(Buffer.from([1, 2]));
  });

  it("joins fragmented frames in order", () => {
    expect(webSocketBuffer([Buffer.from([1, 2]), Buffer.from([3, 4])])).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("converts ArrayBuffer frames without losing their contents", () => {
    expect(webSocketBuffer(Uint8Array.from([1, 2, 3]).buffer)).toEqual(Buffer.from([1, 2, 3]));
  });
});
