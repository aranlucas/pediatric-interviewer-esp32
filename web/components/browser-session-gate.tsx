"use client";

import { type ReactNode, useEffect, useState } from "react";

import {
  requestBrowserSessionToken,
  type BrowserSessionToken,
} from "@/lib/session-token";

type BrowserSession = {
  connectionEnabled: boolean;
  refreshSession: () => void;
  sessionId: string;
  sessionToken: string;
};

function createSessionId(): string {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem("angry-cat-session");
  } catch {
    // Private browsing can deny storage; an in-memory ID remains sufficient.
  }
  if (stored && /^[0-9a-f]{32}$/u.test(stored)) return stored;
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This browser cannot create a secure interview session.");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const sessionId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem("angry-cat-session", sessionId);
  } catch {
    // Continue with the in-memory session for this page lifetime.
  }
  return sessionId;
}

export function BrowserSessionGate({
  children,
}: {
  children: (session: BrowserSession) => ReactNode;
}) {
  const [sessionId, setSessionId] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<BrowserSessionToken>();
  const [setupError, setSetupError] = useState("");
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    try {
      setSessionId(createSessionId());
    } catch (failure) {
      setSetupError(
        failure instanceof Error ? failure.message : "Could not start a secure session.",
      );
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    setSetupError("");
    void requestBrowserSessionToken(sessionId, attempt)
      .then((next) => {
        if (!active) return;
        setSession(next);
        setRefreshing(false);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setSetupError(
          failure instanceof Error
            ? failure.message
            : "Could not reach secure interviewer setup. Check your connection and retry.",
        );
      });
    return () => {
      active = false;
    };
  }, [attempt, sessionId]);

  if (!sessionId || !session) {
    return (
      <main
        className="loading-shell"
        aria-label={setupError ? "Angry Cat connection error" : "Connecting securely to Angry Cat"}
      >
        {setupError ? (
          <section className="connection-fallback" role="alert">
            <div className="loading-cat" aria-hidden="true">AC</div>
            <h1>Secure connection unavailable</h1>
            <p>{setupError}</p>
            {sessionId && (
              <button type="button" onClick={() => setAttempt((current) => current + 1)}>
                Retry connection
              </button>
            )}
          </section>
        ) : (
          <div className="loading-cat" role="status" aria-label="Connecting securely">AC</div>
        )}
      </main>
    );
  }

  const refreshSession = (): void => {
    setRefreshing(true);
    setSetupError("");
    setAttempt((current) => current + 1);
  };

  return (
    <>
      {children({
        connectionEnabled: !refreshing,
        sessionId,
        sessionToken: session.token,
        refreshSession,
      })}
      {setupError && (
        <aside className="session-refresh-error" role="alert">
          <strong>Secure reconnect paused</strong>
          <span>{setupError}</span>
          <button type="button" onClick={refreshSession}>Retry connection</button>
        </aside>
      )}
    </>
  );
}
