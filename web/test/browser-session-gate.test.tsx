import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SessionTokenModule from "../lib/session-token";

import { BrowserSessionGate } from "../components/browser-session-gate";
import {
  requestBrowserSessionToken,
  SessionSetupError,
  type BrowserSessionToken,
} from "../lib/session-token";

vi.mock("../lib/session-token", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTokenModule>()),
  requestBrowserSessionToken: vi.fn(),
}));

const ROOM = "web-0123456789abcdef0123456789abcdef";
const OTHER_ROOM = "web-fedcba9876543210fedcba9876543210";
const requestSession = vi.mocked(requestBrowserSessionToken);

function token(room = ROOM): BrowserSessionToken {
  return { room, token: `token-${room}`, expiresAt: Date.now() + 120_000 };
}

function renderGate() {
  return render(
    <BrowserSessionGate>
      {({ connectionEnabled, room, refreshSession }) => (
        <>
          <output aria-label="Session room">{room}</output>
          <output aria-label="Connection enabled">{String(connectionEnabled)}</output>
          <button type="button" onClick={refreshSession}>
            Refresh session
          </button>
        </>
      )}
    </BrowserSessionGate>,
  );
}

beforeEach(() => requestSession.mockReset());

describe("browser session setup lifecycle", () => {
  it("shows a native loading status before enabling the session", async () => {
    requestSession.mockResolvedValueOnce(token());
    renderGate();

    expect(screen.getByRole("status", { name: "Connecting securely" })).toBeDefined();
    await waitFor(() => expect(screen.getByLabelText("Session room").textContent).toBe(ROOM));
    expect(screen.getByLabelText("Connection enabled").textContent).toBe("true");
    expect(requestSession).toHaveBeenCalledWith(null, 0);
  });

  it("clears an initial error immediately when retrying and can refresh again", async () => {
    const pending = Promise.withResolvers<BrowserSessionToken>();
    requestSession
      .mockRejectedValueOnce(new Error("Temporary setup failure"))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(token());
    renderGate();
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status", { name: "Connecting securely" })).toBeDefined();
    await act(async () => {
      pending.resolve(token());
      await pending.promise;
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    expect(screen.getByLabelText("Connection enabled").textContent).toBe("false");
    await waitFor(() =>
      expect(screen.getByLabelText("Connection enabled").textContent).toBe("true"),
    );
    expect(requestSession.mock.calls).toEqual([
      [null, 0],
      [null, 1],
      [ROOM, 2],
    ]);
  });

  it("replaces an expired room with a new server-owned session", async () => {
    requestSession
      .mockResolvedValueOnce(token())
      .mockRejectedValueOnce(new SessionSetupError("Owner expired", 401))
      .mockResolvedValueOnce(token(OTHER_ROOM));
    renderGate();
    await screen.findByRole("button", { name: "Refresh session" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await waitFor(() => expect(screen.getByLabelText("Session room").textContent).toBe(OTHER_ROOM));
    expect(screen.getByLabelText("Connection enabled").textContent).toBe("true");
    expect(requestSession.mock.calls).toEqual([
      [null, 0],
      [ROOM, 1],
      [null, 1],
    ]);
  });

  it("does not start a replacement request after an in-flight refresh is unmounted", async () => {
    const pending = Promise.withResolvers<BrowserSessionToken>();
    requestSession.mockResolvedValueOnce(token()).mockReturnValueOnce(pending.promise);
    const { unmount } = renderGate();
    await screen.findByRole("button", { name: "Refresh session" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    unmount();

    await act(async () => {
      pending.reject(new SessionSetupError("Owner expired", 401));
      await pending.promise.catch(() => undefined);
    });
    expect(requestSession.mock.calls).toEqual([
      [null, 0],
      [ROOM, 1],
    ]);
  });
});
