import { describe, expect, it, vi } from "vitest";

import {
  holdScreenWakeLock,
  screenWakeLockWarning,
} from "../lib/screen-wake-lock";

const IOS_SAFARI_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 " +
  "Mobile/15E148 Safari/604.1";

class FakeVisibilityDocument {
  visibilityState: DocumentVisibilityState = "visible";
  private listeners = new Set<() => void>();

  addEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.delete(listener);
  }

  setVisibility(visibilityState: DocumentVisibilityState) {
    this.visibilityState = visibilityState;
    for (const listener of this.listeners) listener();
  }
}

function fakeSentinel() {
  let releaseListener: (() => void) | undefined;
  const sentinel = {
    released: false,
    addEventListener: vi.fn(
      (_type: "release", listener: () => void) => (releaseListener = listener),
    ),
    release: vi.fn(async () => {
      sentinel.released = true;
      releaseListener?.();
    }),
  };
  return sentinel;
}

describe("screen wake lock", () => {
  it("holds a lock until the interview lifecycle cleanup runs", async () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const sentinel = fakeSentinel();
    const onStateChange = vi.fn();
    const request = vi.fn(async () => sentinel as unknown as WakeLockSentinel);

    const stop = holdScreenWakeLock({
      document: visibilityDocument,
      onStateChange,
      wakeLock: { request },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    expect(onStateChange).toHaveBeenCalledWith("active");

    stop();
    await vi.waitFor(() => expect(sentinel.release).toHaveBeenCalledOnce());
  });

  it("requests a fresh lock when an active interview becomes visible again", async () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const firstSentinel = fakeSentinel();
    const secondSentinel = fakeSentinel();
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstSentinel as unknown as WakeLockSentinel)
      .mockResolvedValueOnce(secondSentinel as unknown as WakeLockSentinel);

    const stop = holdScreenWakeLock({
      document: visibilityDocument,
      wakeLock: { request },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    visibilityDocument.setVisibility("hidden");
    await firstSentinel.release();
    visibilityDocument.setVisibility("visible");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    stop();
    await vi.waitFor(() => expect(secondSentinel.release).toHaveBeenCalledOnce());
  });

  it("reacquires a lock that the OS releases while the page remains visible", async () => {
    const visibilityDocument = new FakeVisibilityDocument();
    const firstSentinel = fakeSentinel();
    const secondSentinel = fakeSentinel();
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstSentinel as unknown as WakeLockSentinel)
      .mockResolvedValueOnce(secondSentinel as unknown as WakeLockSentinel);

    const stop = holdScreenWakeLock({
      document: visibilityDocument,
      wakeLock: { request },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    await firstSentinel.release();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    stop();
    await vi.waitFor(() => expect(secondSentinel.release).toHaveBeenCalledOnce());
  });

  it("degrades safely when the browser does not support wake locks", () => {
    const onStateChange = vi.fn();
    expect(() =>
      holdScreenWakeLock({
        document: new FakeVisibilityDocument(),
        onStateChange,
      })(),
    ).not.toThrow();
    expect(onStateChange).toHaveBeenCalledWith("unsupported");
  });

  it("reports a denied wake lock so Safari users get a fallback", async () => {
    const onStateChange = vi.fn();
    holdScreenWakeLock({
      document: new FakeVisibilityDocument(),
      onStateChange,
      wakeLock: { request: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    await vi.waitFor(() =>
      expect(onStateChange).toHaveBeenCalledWith("request-failed"),
    );
  });
});

describe("Safari screen wake lock compatibility", () => {
  it("directs older iOS Safari users to the supported version", () => {
    expect(
      screenWakeLockWarning("unsupported", {
        userAgent: IOS_SAFARI_USER_AGENT,
      }),
    ).toContain("iOS or iPadOS 16.4 or newer");
  });

  it("handles the older iOS Home Screen wake lock gap", () => {
    const warning = screenWakeLockWarning("request-failed", {
      standalone: true,
      userAgent: IOS_SAFARI_USER_AGENT,
    });

    expect(warning).toContain("18.4 or newer");
    expect(warning).toContain("reopen the interview in Safari");
  });

  it("gives Safari users an Auto-Lock fallback after a denied request", () => {
    expect(
      screenWakeLockWarning("request-failed", {
        userAgent: IOS_SAFARI_USER_AGENT,
      }),
    ).toContain("Auto-Lock to Never");
  });
});
