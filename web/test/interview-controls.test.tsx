import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionIndicator, QuestionProgress } from "@/components/interview-controls";

describe("interview controls accessibility", () => {
  it("announces connection transitions through a native status element", () => {
    const { rerender } = render(<ConnectionIndicator state="connecting" />);
    const status = screen.getByRole("status");
    expect(status.tagName).toBe("OUTPUT");
    expect(status.textContent).toContain("Connecting");

    rerender(<ConnectionIndicator state="connected" />);
    expect(status.textContent).toContain("Connected");
    expect(status.dataset.connected).toBe("true");

    rerender(<ConnectionIndicator state="error" />);
    expect(status.textContent).toContain("Connection error");
    expect(status.dataset.connected).toBe("false");
  });

  it("exposes native progress values while keeping the segmented visual", () => {
    const { rerender, container } = render(<QuestionProgress current={0} total={5} />);
    const progress = screen.getByRole("progressbar", { name: "Interview questions" });
    expect(progress.tagName).toBe("PROGRESS");
    expect(progress.getAttribute("value")).toBe("0");
    expect(progress.getAttribute("max")).toBe("5");
    expect(progress.getAttribute("aria-valuetext")).toBe("Getting ready");

    rerender(<QuestionProgress current={3} total={5} />);
    expect(progress.getAttribute("value")).toBe("3");
    expect(progress.getAttribute("aria-valuetext")).toBe("Question 3 of 5");
    expect(container.querySelectorAll("i[data-complete='true']")).toHaveLength(3);
  });
});
