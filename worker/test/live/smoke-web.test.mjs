import { test } from "vitest";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { webSocketBuffer } from "../../tools/simulation-protocol.mjs";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://angry-cat-oral-boards.aranlucas.workers.dev";

const AGENT_HOST = process.env.AGENT_HOST ?? "esp32-angry-cat.aranlucas.workers.dev";

const EXPECTED_TOKEN_TTL_MS = 2 * 60 * 60 * 1_000;

const TTL_TOLERANCE_MS = 2 * 60 * 1_000;

const TIMEOUT_MS = 15_000;

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function roomName() {
  return `web-${randomBytes(16).toString("hex")}`;
}

/** @param {string} room */
async function fetchSession(room) {
  const response = await fetch(`${WEB_ORIGIN}/api/session?room=${room}`, {
    method: "POST",
    headers: { Origin: WEB_ORIGIN },
  });

  assert(response.status === 200, `session endpoint returned ${response.status}`);

  const payload = z
    .object({
      room: z.string(),
      token: z.string().min(41),
      expiresAt: z.number().int(),
    })
    .parse(await response.json());

  assert(payload.room === room, "session endpoint returned the wrong room");
  assert(Number.isSafeInteger(payload.expiresAt), "missing token expiry");

  const remainingMs = payload.expiresAt - Date.now();
  assert(
    remainingMs >= EXPECTED_TOKEN_TTL_MS - TTL_TOLERANCE_MS &&
      remainingMs <= EXPECTED_TOKEN_TTL_MS + TTL_TOLERANCE_MS,
    "connect token does not have the expected two-hour lifetime",
  );

  const cookie = response.headers.get("set-cookie") ?? "";
  assert(cookie.startsWith("__Host-angry-cat-report="), "missing host-scoped report cookie");

  for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) {
    assert(cookie.includes(attribute), `report cookie is missing ${attribute}`);
  }

  return payload.token;
}

/** @param {string} room */
async function assertHttpGuards(room) {
  const crossOrigin = await fetch(`${WEB_ORIGIN}/api/session?room=${room}`, {
    method: "POST",
    headers: { Origin: "https://example.invalid" },
  });

  assert(crossOrigin.status === 403, `cross-origin session request returned ${crossOrigin.status}`);

  const privateReport = await fetch(`${WEB_ORIGIN}/api/reports/${randomUUID()}?kind=report`, {
    redirect: "manual",
  });

  assert(
    privateReport.status === 401,
    `unauthenticated report request returned ${privateReport.status}`,
  );
}

/**
 * @param {string} room
 * @param {string} token
 */
async function assertWebSocket(room, token) {
  const url = `wss://${AGENT_HOST}/agents/pediatric-interviewer/${room}?token=${encodeURIComponent(token)}`;
  /** @type {Set<string>} */
  const observed = new Set();

  await new Promise(
    /** @param {(value?: void) => void} resolve */ (resolve, reject) => {
      const socket = new WebSocket(url, { origin: WEB_ORIGIN, handshakeTimeout: TIMEOUT_MS });
      let settled = false;

      const timeout = setTimeout(() => {
        finish(new Error("signed browser WebSocket did not initialize before the timeout"));
      }, TIMEOUT_MS);

      /** @param {Error} [error] */
      const finish = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);

        if (error) {
          socket.terminate();
          reject(error);

          return;
        }

        socket.close(1000, "production smoke complete");
        resolve();
      };

      socket.on("error", () => finish(new Error("signed browser WebSocket handshake failed")));
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          return;
        }

        try {
          const parsed = z
            .object({ type: z.string() })
            .safeParse(JSON.parse(webSocketBuffer(data).toString()));

          if (parsed.success) {
            observed.add(parsed.data.type);
          }
        } catch {
          return;
        }

        if (observed.has("welcome") && observed.has("interview_state")) {
          finish();
        }
      });
    },
  );

  assert(observed.has("welcome"), "missing WebSocket welcome message");
  assert(observed.has("interview_state"), "missing initial interview state");
}

async function main() {
  const parsedOrigin = new URL(WEB_ORIGIN);
  assert(parsedOrigin.origin === WEB_ORIGIN, "WEB_ORIGIN must be a serialized origin");
  assert(
    /^[A-Za-z0-9.-]+(?::\d+)?$/u.test(AGENT_HOST),
    "AGENT_HOST must be a hostname and optional port",
  );

  const room = roomName();
  const token = await fetchSession(room);
  await assertHttpGuards(room);
  await assertWebSocket(room, token);
  console.log("Production web smoke passed: session, cookie, HTTP guards, and signed WebSocket.");
}

test("production web session, cookie, HTTP guards, and signed WebSocket", main, 60_000);
