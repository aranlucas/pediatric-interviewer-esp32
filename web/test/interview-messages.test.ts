import { describe, expect, it } from "vitest";
import {
  interviewMessageText,
  parseInterviewMessage,
  parseInterviewStatus,
} from "@/lib/interview-messages";

describe("interview wire envelope", () => {
  it("retains extension fields and JSON values without imposing another message's fields", () => {
    const wire = { type: "error", message: 23, status: { future: true }, extra: null };
    expect(parseInterviewMessage(JSON.stringify(wire))).toEqual(wire);
    expect(parseInterviewStatus(wire.status)).toBeNull();
  });
  it.each(["null", "[]", "23", "invalid JSON"])("rejects a non-object envelope %s", (wire) => {
    expect(() => parseInterviewMessage(wire)).toThrow(Error);
  });
  it("displays only textual message fields", () => {
    expect(interviewMessageText("Ready")).toBe("Ready");
    expect(interviewMessageText({ nested: true })).toBe("");
    expect(interviewMessageText(23, "Try again")).toBe("Try again");
    expect(interviewMessageText(undefined, "Try again")).toBe("Try again");
  });
  it("accepts known statuses and rejects invalid status values", () => {
    expect(parseInterviewStatus("listening")).toBe("listening");
    expect(parseInterviewStatus("unknown")).toBeNull();
    expect(parseInterviewStatus(undefined)).toBeNull();
    expect(parseInterviewStatus(42)).toBeNull();
  });
});
