"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  requestBrowserSessionToken,
  SessionSetupError,
  type BrowserSessionToken,
} from "@/lib/session-token";

type BrowserSession = {
  connectionEnabled: boolean;
  refreshSession: () => void;
  room: string;
  sessionToken: string;
};

type BrowserSessionGateProps = {
  children: (session: BrowserSession) => ReactNode;
};

export function BrowserSessionGate({ children }: BrowserSessionGateProps) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<BrowserSessionToken>();
  const sessionRef = useRef<BrowserSessionToken | undefined>(undefined);
  const [setupError, setSetupError] = useState("");
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let active = true;
    const existingRoom = sessionRef.current?.room ?? null;

    const acquireSession = async (): Promise<BrowserSessionToken> => {
      try {
        return await requestBrowserSessionToken(existingRoom, attempt);
      } catch (failure) {
        // An expired owner cookie cannot recover the old Durable Object. Start
        // a fresh server-owned room rather than leaving the UI permanently
        // stuck behind the failed refresh.
        if (
          active &&
          existingRoom &&
          failure instanceof SessionSetupError &&
          failure.status === 401
        ) {
          sessionRef.current = undefined;

          return requestBrowserSessionToken(null, attempt);
        }

        throw failure;
      }
    };

    const setupSession = async (): Promise<void> => {
      try {
        const next = await acquireSession();

        if (!active) {
          return;
        }

        sessionRef.current = next;
        setSession(next);
        setRefreshing(false);
      } catch (failure) {
        if (!active) {
          return;
        }

        setSetupError(
          failure instanceof Error
            ? failure.message
            : "Could not reach secure interviewer setup. Check your connection and retry.",
        );
      }
    };

    void setupSession().catch(() => {
      if (active) {
        setSetupError("Could not complete secure interviewer setup. Please retry.");
      }
    });

    return () => {
      active = false;
    };
  }, [attempt]);

  const refreshSession = (): void => {
    setRefreshing(true);
    setSetupError("");
    setAttempt((current) => current + 1);
  };

  if (!session) {
    return (
      <main
        className="loading-shell"
        aria-label={setupError ? "Angry Cat connection error" : "Connecting securely to Angry Cat"}
      >
        {setupError ? (
          <section className="connection-fallback" role="alert">
            <div className="loading-cat" aria-hidden="true">
              AC
            </div>
            <h1>Secure connection unavailable</h1>
            <p>{setupError}</p>
            <button type="button" onClick={refreshSession}>
              Retry connection
            </button>
          </section>
        ) : (
          <output className="loading-cat" aria-label="Connecting securely">
            AC
          </output>
        )}
      </main>
    );
  }

  return (
    <>
      {children({
        connectionEnabled: !refreshing,
        room: session.room,
        sessionToken: session.token,
        refreshSession,
      })}
      {setupError && (
        <aside className="session-refresh-error" role="alert">
          <strong>Secure reconnect paused</strong>
          <span>{setupError}</span>
          <button type="button" onClick={refreshSession}>
            Retry connection
          </button>
        </aside>
      )}
    </>
  );
}
