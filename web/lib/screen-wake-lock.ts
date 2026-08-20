type ScreenWakeLockProvider = {
  request(type: "screen"): Promise<WakeLockSentinel>;
};

type VisibilityDocument = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

type ScreenWakeLockEnvironment = {
  document?: VisibilityDocument;
  onStateChange?: (state: ScreenWakeLockState) => void;
  wakeLock?: ScreenWakeLockProvider;
};

export type ScreenWakeLockState =
  | "active"
  | "request-failed"
  | "unsupported";

type ScreenWakeLockBrowser = {
  maxTouchPoints?: number;
  standalone?: boolean;
  userAgent: string;
};

export function screenWakeLockWarning(
  state: ScreenWakeLockState,
  browser: ScreenWakeLockBrowser,
): string {
  if (state === "active") return "";

  const isAppleMobile =
    /iPad|iPhone|iPod/.test(browser.userAgent) ||
    (/Macintosh/.test(browser.userAgent) &&
      (browser.maxTouchPoints ?? 0) > 1);
  const isSafari =
    /Version\/[\d.]+.*Safari/.test(browser.userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS/.test(browser.userAgent);

  if (state === "unsupported" && isAppleMobile) {
    return "Screen stay-awake requires iOS or iPadOS 16.4 or newer. Update iOS, or temporarily set Auto-Lock to Never.";
  }
  if (state === "unsupported" && isSafari) {
    return "Screen stay-awake requires Safari 16.4 or newer. Update Safari, or keep this device awake manually.";
  }
  if (isAppleMobile && browser.standalone) {
    return "Safari could not keep the screen awake in this Home Screen app. Update to iOS or iPadOS 18.4 or newer, or reopen the interview in Safari.";
  }
  if (isAppleMobile || isSafari) {
    return "Safari could not keep the screen awake. Keep this tab visible and temporarily set Auto-Lock to Never.";
  }
  if (state === "unsupported") {
    return "This browser cannot keep the screen awake. Keep the device awake manually during the interview.";
  }
  return "The browser could not keep the screen awake. Keep the device awake manually during the interview.";
}

/**
 * Holds a screen wake lock until the returned cleanup function is called.
 * Browsers release wake locks when a document is hidden, so the lock is
 * requested again when an active interview becomes visible again.
 */
export function holdScreenWakeLock(
  environment: ScreenWakeLockEnvironment = {},
): () => void {
  const visibilityDocument =
    environment.document ??
    (typeof document === "undefined" ? undefined : document);
  const wakeLock =
    environment.wakeLock ??
    (typeof navigator !== "undefined" && "wakeLock" in navigator
      ? navigator.wakeLock
      : undefined);

  if (!visibilityDocument || !wakeLock) {
    environment.onStateChange?.("unsupported");
    return () => undefined;
  }

  let requesting = false;
  let releaseRetries = 0;
  let stopped = false;
  let sentinel: WakeLockSentinel | undefined;

  const request = async () => {
    if (
      stopped ||
      requesting ||
      visibilityDocument.visibilityState !== "visible" ||
      (sentinel && !sentinel.released)
    ) {
      return;
    }

    requesting = true;
    try {
      const nextSentinel = await wakeLock.request("screen");
      if (stopped) {
        await nextSentinel.release();
        return;
      }
      sentinel = nextSentinel;
      environment.onStateChange?.("active");
      nextSentinel.addEventListener(
        "release",
        () => {
          if (sentinel === nextSentinel) sentinel = undefined;
          if (stopped || visibilityDocument.visibilityState !== "visible") return;
          if (releaseRetries >= 2) {
            environment.onStateChange?.("request-failed");
            return;
          }
          releaseRetries += 1;
          // The OS may revoke an advisory lock while the tab stays visible.
          // Reacquire on a microtask so the released sentinel has fully settled.
          queueMicrotask(() => void request());
        },
        { once: true },
      );
    } catch {
      // Wake locks are advisory and may be denied by the browser or OS.
      environment.onStateChange?.("request-failed");
    } finally {
      requesting = false;
    }
  };

  const handleVisibilityChange = () => {
    if (visibilityDocument.visibilityState === "visible") {
      releaseRetries = 0;
      void request();
    }
  };

  visibilityDocument.addEventListener(
    "visibilitychange",
    handleVisibilityChange,
  );
  void request();

  return () => {
    stopped = true;
    visibilityDocument.removeEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );
    const activeSentinel = sentinel;
    sentinel = undefined;
    if (activeSentinel && !activeSentinel.released) {
      void activeSentinel.release();
    }
  };
}
