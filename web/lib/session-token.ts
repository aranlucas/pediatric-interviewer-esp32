export type BrowserSessionToken = {
  expiresAt: number;
  room: string;
  token: string;
};

const pendingRequests = new Map<string, Promise<BrowserSessionToken>>();

const SESSION_HANDSHAKE_TIMEOUT_MS = 10_000;

export class SessionSetupError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SessionSetupError";
    this.status = status;
  }
}

const WEB_ROOM_PATTERN = /^web-[0-9a-f]{32}$/u;

/**
 * Dedupe React Strict Mode's development effect replay without caching an
 * already-settled handshake token. A later explicit retry always reaches the
 * server and receives a fresh token.
 */
export function requestBrowserSessionToken(
  room: string | null,
  attempt: number,
  request: typeof fetch = fetch,
): Promise<BrowserSessionToken> {
  const key = `${room ?? "new"}:${attempt}`;
  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const promise = Promise.resolve()
    .then(() => request(
      room ? `/api/session?room=${encodeURIComponent(room)}` : "/api/session",
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(SESSION_HANDSHAKE_TIMEOUT_MS),
      },
    ))
    .then(async (response) => {
      if (!response.ok) {
        throw new SessionSetupError(
          response.status === 429
            ? "Too many connection attempts. Wait a moment, then retry."
            : "Secure interviewer setup is unavailable. Please retry in a moment.",
          response.status,
        );
      }
      let payload: Partial<BrowserSessionToken>;
      try {
        payload = (await response.json()) as Partial<BrowserSessionToken>;
      } catch {
        throw new SessionSetupError(
          "Secure interviewer setup returned an invalid response. Please retry.",
        );
      }
      if (
        typeof payload.room !== "string" ||
        !WEB_ROOM_PATTERN.test(payload.room) ||
        (room !== null && payload.room !== room) ||
        typeof payload.token !== "string" ||
        !payload.token ||
        typeof payload.expiresAt !== "number" ||
        !Number.isFinite(payload.expiresAt) ||
        payload.expiresAt <= Date.now() + 30_000
      ) {
        throw new SessionSetupError(
          "Secure interviewer setup returned an invalid response. Please retry.",
        );
      }
      return { room: payload.room, token: payload.token, expiresAt: payload.expiresAt };
    })
    .catch((error: unknown) => {
      if (error instanceof SessionSetupError) throw error;
      throw new Error("Could not reach secure interviewer setup. Check your connection and retry.");
    })
    .finally(() => {
      if (pendingRequests.get(key) === promise) pendingRequests.delete(key);
    });

  pendingRequests.set(key, promise);
  return promise;
}
