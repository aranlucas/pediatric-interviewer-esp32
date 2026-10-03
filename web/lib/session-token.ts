import { z } from "zod";

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
    .then(() =>
      request(room ? `/api/session?room=${encodeURIComponent(room)}` : "/api/session", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(SESSION_HANDSHAKE_TIMEOUT_MS),
      }),
    )
    .then(async (response) => {
      if (!response.ok) {
        throw new SessionSetupError(
          response.status === 429
            ? "Too many connection attempts. Wait a moment, then retry."
            : "Secure interviewer setup is unavailable. Please retry in a moment.",
          response.status,
        );
      }

      const parsed = z
        .object({
          room: z.string().regex(WEB_ROOM_PATTERN),
          token: z.string().min(1),
          expiresAt: z.number().finite(),
        })
        .safeParse(await response.json().catch(() => null));

      if (
        !parsed.success ||
        (room !== null && parsed.data.room !== room) ||
        parsed.data.expiresAt <= Date.now() + 30_000
      ) {
        throw new SessionSetupError(
          "Secure interviewer setup returned an invalid response. Please retry.",
        );
      }

      const payload = parsed.data;

      return { room: payload.room, token: payload.token, expiresAt: payload.expiresAt };
    })
    .catch((error) => {
      if (error instanceof SessionSetupError) throw error;
      throw new Error("Could not reach secure interviewer setup. Check your connection and retry.");
    })
    .finally(() => {
      if (pendingRequests.get(key) === promise) pendingRequests.delete(key);
    });

  pendingRequests.set(key, promise);

  return promise;
}
