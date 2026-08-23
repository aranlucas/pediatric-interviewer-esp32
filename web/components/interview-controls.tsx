"use client";

import { Mic } from "lucide-react";
import { useMemo } from "react";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error";

export function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const connected = state === "connected";
  const label =
    state === "connected"
      ? "Connected"
      : state === "reconnecting"
        ? "Reconnecting"
        : state === "error"
          ? "Connection error"
          : "Connecting";
  return (
    <div
      className="connection-indicator"
      data-connected={connected}
      data-state={state}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true" /> {label}
      <i aria-hidden="true"><b /><b /><b /></i>
    </div>
  );
}

export function QuestionProgress({ current, total }: { current: number; total: number }) {
  return (
    <div
      className="question-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={current ? `Question ${current} of ${total}` : "Getting ready"}
    >
      <strong>{current ? `Question ${current} of ${total}` : "Getting ready"}</strong>
      <div aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <i key={index} data-complete={current > index} data-current={current === index + 1} />
        ))}
      </div>
    </div>
  );
}

export function Waveform({ level, active }: { level: number; active: boolean }) {
  const bars = useMemo(
    () => [0.24, 0.48, 0.8, 0.55, 0.92, 0.62, 0.35, 0.7, 1, 0.58, 0.32, 0.72, 0.43, 0.2],
    [],
  );
  return (
    <div className="waveform" data-active={active} aria-hidden="true">
      {bars.map((height, index) => (
        <i
          key={index}
          style={{
            transform: `scaleY(${(8 + height * 30 * Math.max(0.18, level)) / 38})`,
          }}
        />
      ))}
    </div>
  );
}

export function ControlButton({
  icon: Icon,
  label,
  active,
  disabled = false,
  controls,
  expanded,
  onClick,
}: {
  icon: typeof Mic;
  label: string;
  active: boolean;
  disabled?: boolean;
  controls?: string;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="control-button"
      data-active={active}
      onClick={onClick}
      aria-pressed={active}
      aria-controls={controls}
      aria-expanded={expanded}
      disabled={disabled}
    >
      <span><Icon size={22} /></span>
      {label}
    </button>
  );
}
