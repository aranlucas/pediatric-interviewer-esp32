import { describe, expect, it } from "vitest";

import {
  averageScore,
  DEFAULT_DIFFICULTY,
  DIFFICULTY_OPTIONS,
  interviewKeepsScreenAwake,
  interviewIsRunning,
  interviewLocksSetup,
  outcomeLabel,
  questionCountForSelection,
  shouldCaptureInterviewAudio,
  statusAfterRejectedTextAnswer,
  statusCopy,
  TOPICS,
  topicSelectionLabel,
} from "../lib/interview";

describe("interview helpers", () => {
  it("keeps all firmware study topics", () => {
    expect(TOPICS).toHaveLength(10);
    expect(new Set(TOPICS.map((topic) => topic.id)).size).toBe(10);
  });

  it("summarizes scores and outcomes", () => {
    expect(
      averageScore({
        outcome: "pass",
        examinerSummary: "Good work",
        scoreSummary: [
          { skillset: "A", skill: "remember", score: 2, rationale: "" },
          { skillset: "B", skill: "analyze_evaluate", score: 3, rationale: "" },
        ],
      }),
    ).toBe(2.5);
    expect(outcomeLabel("not_yet")).toBe("Not yet");
    expect(statusCopy("listening").label).toBe("Listening");
  });

  it("supports multi-topic setup with bounded question counts and difficulty", () => {
    const selected = [TOPICS[0].id, TOPICS[3].id, TOPICS[6].id];
    expect(topicSelectionLabel(selected)).toBe("3-topic combo");
    expect(questionCountForSelection(3, selected.length)).toBe(3);
    expect(questionCountForSelection(3, 5)).toBe(5);
    expect(questionCountForSelection(99, 1)).toBe(10);
    expect(DIFFICULTY_OPTIONS.map((option) => option.id)).toEqual([
      "easy",
      "standard",
      "hard",
    ]);
    expect(DEFAULT_DIFFICULTY).toBe("standard");
    expect(statusCopy("idle", 8).detail).toContain("8-question");
  });

  it("keeps the screen awake only while an interview is in progress", () => {
    expect(interviewKeepsScreenAwake("thinking")).toBe(true);
    expect(interviewKeepsScreenAwake("listening")).toBe(true);
    expect(interviewKeepsScreenAwake("speaking")).toBe(true);
    expect(interviewKeepsScreenAwake("evaluating")).toBe(true);
    expect(interviewKeepsScreenAwake("idle")).toBe(false);
    expect(interviewKeepsScreenAwake("complete")).toBe(false);
    expect(interviewKeepsScreenAwake("error")).toBe(false);
  });

  it("keeps live interview navigation locked until capture and evaluation finish", () => {
    expect(interviewIsRunning("idle", true)).toBe(true);
    expect(interviewIsRunning("thinking")).toBe(true);
    expect(interviewIsRunning("listening")).toBe(true);
    expect(interviewIsRunning("speaking")).toBe(true);
    expect(interviewIsRunning("evaluating")).toBe(true);
    expect(interviewIsRunning("idle")).toBe(false);
    expect(interviewIsRunning("complete")).toBe(false);
    expect(interviewIsRunning("error")).toBe(false);
  });

  it("keeps setup locked when a persisted interview still needs resolution", () => {
    expect(interviewLocksSetup("error", "interviewing")).toBe(true);
    expect(interviewLocksSetup("error", "evaluation_failed")).toBe(true);
    expect(interviewLocksSetup("complete", "complete")).toBe(false);
    expect(interviewLocksSetup("error", "idle")).toBe(false);
  });

  it("restores authoritative server status after a rejected typed answer", () => {
    expect(statusAfterRejectedTextAnswer("speaking", "thinking")).toBe("speaking");
    expect(statusAfterRejectedTextAnswer("listening", "thinking")).toBe("listening");
    expect(statusAfterRejectedTextAnswer("listening", "evaluating")).toBe("evaluating");
  });

  it("never captures microphone audio while the typed-answer composer is open", () => {
    expect(shouldCaptureInterviewAudio("listening", false)).toBe(true);
    expect(shouldCaptureInterviewAudio("listening", true)).toBe(false);
    expect(shouldCaptureInterviewAudio("thinking", false)).toBe(false);
    expect(shouldCaptureInterviewAudio("speaking", false)).toBe(false);
  });
});
