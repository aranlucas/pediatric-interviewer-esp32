import { act, fireEvent, render, screen } from "@testing-library/react";
import { useAgent } from "agents/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SessionTokenModule from "../lib/session-token";

import { AngryCatApp } from "../components/angry-cat-app";
import { BrowserInterviewAudio } from "../lib/browser-audio";
import { requestBrowserSessionToken } from "../lib/session-token";

vi.mock("agents/react", () => ({ useAgent: vi.fn() }));
vi.mock("../lib/session-token", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTokenModule>()),
  requestBrowserSessionToken: vi.fn(),
}));
vi.mock("../lib/browser-audio", () => ({
  DEFAULT_OUTPUT_VOLUME: 0.8,
  BrowserInterviewAudio: vi.fn(
    class {
      start = vi.fn().mockResolvedValue(true);
      stop = vi.fn();
      setListening = vi.fn();
      setMuted = vi.fn();
      setVolume = vi.fn();
      interruptPlayback = vi.fn();
      playPcm16 = vi.fn().mockResolvedValue(undefined);
    },
  ),
}));

const socket = {
  OPEN: 1,
  readyState: 1,
  bufferedAmount: 0,
  binaryType: "blob" as const,
  send: vi.fn(),
};

function agentOptions() {
  const options = vi.mocked(useAgent).mock.lastCall?.[0];

  if (!options) throw new Error("The interview has not connected");

  return options;
}

function activeAudio() {
  const audio = vi.mocked(BrowserInterviewAudio).mock.results.at(-1)?.value;

  if (!audio) throw new Error("The audio lifecycle has not started");

  return audio as BrowserInterviewAudio;
}

async function renderConnectedApp() {
  const view = render(
    <StrictMode>
      <AngryCatApp />
    </StrictMode>,
  );
  await screen.findByRole("radiogroup", { name: "Difficulty level" });
  act(() => agentOptions().onOpen?.(new Event("open")));

  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  socket.readyState = socket.OPEN;
  vi.mocked(useAgent, { partial: true }).mockReturnValue(socket);
  vi.mocked(requestBrowserSessionToken).mockResolvedValue({
    room: "web-0123456789abcdef0123456789abcdef",
    token: "test-session-token",
    expiresAt: Date.now() + 120_000,
  });
});

describe("interview experience lifecycle", () => {
  it("uses native difficulty radios and sends their selected value", async () => {
    await renderConnectedApp();
    const hard = screen.getByRole<HTMLInputElement>("radio", { name: "Hard" });
    const standard = screen.getByRole<HTMLInputElement>("radio", { name: "Standard" });

    expect(standard.checked).toBe(true);
    fireEvent.click(hard);
    expect(hard.checked).toBe(true);
    expect(standard.checked).toBe(false);

    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Start 6-question interview" }));
    });

    expect(hard.disabled).toBe(true);
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "start_call",
        topic_id: "behavior_guidance",
        topic_ids: ["behavior_guidance"],
        question_count: 6,
        difficulty: "hard",
      }),
    );
  });

  it("replaces Strict Mode audio instances and stops the active one on unmount", async () => {
    const { unmount } = await renderConnectedApp();
    const instances = vi
      .mocked(BrowserInterviewAudio)
      .mock.results.map(({ value }) => value as BrowserInterviewAudio);

    expect(instances).toHaveLength(2);
    expect(instances[0].stop).toHaveBeenCalledOnce();
    expect(instances[1].stop).not.toHaveBeenCalled();
    unmount();
    expect(instances[1].stop).toHaveBeenCalledOnce();
  });

  it("does not start an interview after microphone setup is cancelled", async () => {
    await renderConnectedApp();
    const audio = activeAudio();
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(audio.start).mockReturnValueOnce(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: "Start 6-question interview" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel start" }));
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });

    expect(audio.stop).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Start 6-question interview" })
        .disabled,
    ).toBe(false);
  });

  it("closes typed answers and disables capture when evaluation begins", async () => {
    await renderConnectedApp();
    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Start 6-question interview" }));
    });
    act(() =>
      agentOptions().onMessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "status", status: "listening" }),
        }),
      ),
    );
    const typeAnswer = screen.getByRole("button", { name: "Type answer" });
    fireEvent.click(typeAnswer);
    expect(typeAnswer.getAttribute("aria-expanded")).toBe("true");

    act(() =>
      agentOptions().onMessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "status", status: "evaluating" }),
        }),
      ),
    );

    expect(typeAnswer.getAttribute("aria-expanded")).toBe("false");
    expect(activeAudio().setListening).toHaveBeenLastCalledWith(false);
  });
});
