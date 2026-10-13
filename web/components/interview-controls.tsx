"use client";

import type { Mic } from "lucide-react";
import { useMemo } from "react";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error";

type ConnectionIndicatorProps = { state: ConnectionState };

export function ConnectionIndicator({ state }: ConnectionIndicatorProps) {
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
    <output
      className="connection-indicator"
      data-connected={connected}
      data-state={state}
      aria-live="polite"
    >
      <span aria-hidden="true" /> {label}
      <i aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
    </output>
  );
}

type QuestionProgressProps = { current: number; total: number };

export function QuestionProgress({ current, total }: QuestionProgressProps) {
  return (
    <div className="question-progress">
      <progress
        className="visually-hidden"
        aria-label="Interview questions"
        max={total}
        value={current}
        aria-valuetext={current ? `Question ${current} of ${total}` : "Getting ready"}
      />
      <strong>{current ? `Question ${current} of ${total}` : "Getting ready"}</strong>
      <div aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <i key={index} data-complete={current > index} data-current={current === index + 1} />
        ))}
      </div>
    </div>
  );
}

type WaveformProps = { level: number; active: boolean };

export function Waveform({ level, active }: WaveformProps) {
  const bars = useMemo(
    () => [0.24, 0.48, 0.8, 0.55, 0.92, 0.62, 0.35, 0.7, 1, 0.58, 0.32, 0.72, 0.43, 0.2],
    [],
  );

  return (
    <span className="waveform" data-active={active} aria-hidden="true">
      {bars.map((height) => (
        <i
          key={height}
          style={{
            transform: `scaleY(${(8 + height * 30 * Math.max(0.18, level)) / 38})`,
          }}
        />
      ))}
    </span>
  );
}

type ControlButtonProps = {
  icon: typeof Mic;
  label: string;
  active: boolean;
  disabled?: boolean;
  controls?: string;
  expanded?: boolean;
  onClick: () => void;
};

export function ControlButton({
  icon: Icon,
  label,
  active,
  disabled = false,
  controls,
  expanded,
  onClick,
}: ControlButtonProps) {
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
      <span>
        <Icon size={22} />
      </span>
      {label}
    </button>
  );
}
