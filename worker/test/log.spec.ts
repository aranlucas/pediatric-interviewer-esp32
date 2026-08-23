import { afterEach, describe, expect, it, vi } from "vitest";

import { workerLog } from "../src/log";

describe("workerLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["info", "log"],
    ["warn", "warn"],
    ["error", "error"],
  ] as const)("emits a structured %s record with a useful title", (level, method) => {
    const output = vi.spyOn(console, method).mockImplementation(() => undefined);

    workerLog(level, "gemini_reconnected", {
      message: "message",
      event: "old_event",
      resumed: true,
      answerCount: 2,
    });

    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toEqual({
      message: "gemini_reconnected",
      event: "gemini_reconnected",
      resumed: true,
      answerCount: 2,
    });
  });
});
