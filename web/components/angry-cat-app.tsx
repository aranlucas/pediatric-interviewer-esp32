"use client";

import Image from "next/image";
import { useAgent } from "agents/react";
import {
  Activity,
  BookOpenText,
  Captions,
  Check,
  CircleAlert,
  ClipboardCheck,
  Headphones,
  HeartPulse,
  MessageCircleMore,
  Mic,
  MicOff,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Stethoscope,
  Volume1,
  Volume2,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BrowserInterviewAudio,
  DEFAULT_OUTPUT_VOLUME,
} from "@/lib/browser-audio";
import {
  averageScore,
  DEFAULT_DIFFICULTY,
  DIFFICULTY_OPTIONS,
  interviewKeepsScreenAwake,
  type InterviewDifficulty,
  type InterviewState,
  type InterviewStatus,
  QUESTION_COUNT_OPTIONS,
  questionCountForSelection,
  statusCopy,
  TOPICS,
  type TopicId,
  TOTAL_QUESTIONS,
  topicSelectionLabel,
} from "@/lib/interview";
import {
  holdScreenWakeLock,
  screenWakeLockWarning,
} from "@/lib/screen-wake-lock";
import {
  ConnectionIndicator,
  ControlButton,
  QuestionProgress,
  Waveform,
  type ConnectionState,
} from "@/components/interview-controls";
import { InterviewReview } from "@/components/interview-review";
import { BrowserSessionGate } from "@/components/browser-session-gate";

type TranscriptItem = { id: number; role: "examiner" | "candidate"; text: string };
type AgentSocket = {
  OPEN?: number;
  bufferedAmount?: number;
  send: (data: string | ArrayBuffer) => void;
  readyState: number;
};

const INTERVIEW_STATUSES = new Set<InterviewStatus>([
  "idle",
  "thinking",
  "listening",
  "evaluating",
  "speaking",
  "complete",
  "error",
]);

const EMPTY_STATE: InterviewState = {
  phase: "idle",
  topicId: "behavior_guidance",
  currentQuestion: "",
  exchanges: [],
  reportId: "",
};

const AGENT_HOST = (process.env.NEXT_PUBLIC_AGENT_HOST ?? "esp32-angry-cat.aranlucas.workers.dev")
  .replace(/^wss?:\/\//u, "")
  .replace(/^https?:\/\//u, "")
  .replace(/\/+$/u, "");
const MAX_AUDIO_BUFFERED_BYTES = 256_000;

const topicIcons = [
  Sparkles,
  Activity,
  ShieldCheck,
  Stethoscope,
  HeartPulse,
  Check,
  Sparkles,
  HeartPulse,
  MessageCircleMore,
  ClipboardCheck,
];

export function AngryCatApp() {
  return (
    <BrowserSessionGate>
      {({ connectionEnabled, sessionId, sessionToken, refreshSession }) => (
        <InterviewExperience
          connectionEnabled={connectionEnabled}
          sessionId={sessionId}
          sessionToken={sessionToken}
          onRefreshSession={refreshSession}
        />
      )}
    </BrowserSessionGate>
  );
}

function InterviewExperience({
  connectionEnabled,
  sessionId,
  sessionToken,
  onRefreshSession,
}: {
  connectionEnabled: boolean;
  sessionId: string;
  sessionToken: string;
  onRefreshSession: () => void;
}) {
  const [view, setView] = useState<"topics" | "interview" | "review">("topics");
  const [state, setState] = useState<InterviewState>(EMPTY_STATE);
  const [status, setStatus] = useState<InterviewStatus>("idle");
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [selectedTopics, setSelectedTopics] = useState<TopicId[]>(["behavior_guidance"]);
  const [questionCount, setQuestionCount] = useState(TOTAL_QUESTIONS);
  const [difficulty, setDifficulty] = useState<InterviewDifficulty>(DEFAULT_DIFFICULTY);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(DEFAULT_OUTPUT_VOLUME);
  const [level, setLevel] = useState(0);
  const [captions, setCaptions] = useState(true);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [textComposerOpen, setTextComposerOpen] = useState(false);
  const [error, setError] = useState("");
  const [reviewPage, setReviewPage] = useState(0);
  const [browserSpeaking, setBrowserSpeaking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endPending, setEndPending] = useState(false);
  const [wakeLockWarning, setWakeLockWarning] = useState("");
  const agentRef = useRef<AgentSocket | undefined>(undefined);
  const audioRef = useRef<BrowserInterviewAudio | undefined>(undefined);
  const transcriptId = useRef(0);
  const statusRef = useRef<InterviewStatus>("idle");
  const stateRef = useRef<InterviewState>(EMPTY_STATE);
  const hadConnectionRef = useRef(false);
  const recoveryPendingRef = useRef(false);
  const pendingEndRef = useRef(false);
  const startingRef = useRef(false);
  const startGenerationRef = useRef(0);

  const updateStatus = useCallback((next: InterviewStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const sendJson = useCallback((message: Record<string, unknown>): boolean => {
    const socket = agentRef.current;
    if (!socket || socket.readyState !== (socket.OPEN ?? 1)) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendAudio = useCallback((data: ArrayBuffer) => {
    const socket = agentRef.current;
    if (
      !socket ||
      socket.readyState !== (socket.OPEN ?? 1) ||
      (socket.bufferedAmount ?? 0) > MAX_AUDIO_BUFFERED_BYTES
    ) {
      return;
    }
    try {
      socket.send(data);
    } catch {
      // Audio frames are ephemeral. A dropped frame is safer than a queued stale frame.
    }
  }, []);

  if (!audioRef.current) {
    audioRef.current = new BrowserInterviewAudio({
      onCaptureUnavailable: () => {
        setAudioAvailable(false);
        setTextComposerOpen(true);
        setError("Microphone disconnected. Continue with typed answers; reconnect it before your next interview.");
      },
      onLevel: setLevel,
      onAutoCommit: () => {
        if (sendJson({ type: "commit_turn" })) {
          updateStatus("thinking");
        } else {
          setError("Your answer could not be submitted while reconnecting. Please try again.");
        }
      },
      onSpeakingChange: setBrowserSpeaking,
    });
  }

  const appendTranscript = useCallback((role: TranscriptItem["role"], text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    setTranscript((items) => [...items.slice(-7), { id: ++transcriptId.current, role, text: clean }]);
  }, []);

  const handleAudioFrame = useCallback(async (data: ArrayBuffer) => {
    try {
      await audioRef.current?.playPcm16(data);
    } catch {
      setAudioAvailable(false);
      setError("Examiner audio was interrupted. Continue with typed answers or retry the interview.");
    }
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const data = event.data as unknown;
      if (data instanceof ArrayBuffer) {
        void handleAudioFrame(data);
        return;
      }
      if (data instanceof Blob) {
        void data
          .arrayBuffer()
          .then((buffer) => handleAudioFrame(buffer))
          .catch(() => {
            setAudioAvailable(false);
            setError("Examiner audio could not be decoded. Continue with typed answers.");
          });
        return;
      }
      if (typeof data !== "string") return;
      try {
        const message = JSON.parse(data) as Record<string, unknown>;
        if (message.type === "status" && typeof message.status === "string") {
          if (!INTERVIEW_STATUSES.has(message.status as InterviewStatus)) return;
          const next = message.status as InterviewStatus;
          if (next !== "error") setError("");
          updateStatus(next);
          audioRef.current?.setListening(next === "listening");
          if (next === "complete") setView("review");
        } else if (message.type === "playback_interrupt") {
          audioRef.current?.interruptPlayback();
        } else if (message.type === "transcript" && message.role === "user") {
          appendTranscript("candidate", String(message.text ?? ""));
        } else if (message.type === "transcript_end" && message.role === "assistant") {
          appendTranscript("examiner", String(message.text ?? ""));
        } else if (message.type === "error") {
          setError(String(message.message ?? "The interviewer encountered an error."));
          updateStatus("error");
        } else if (message.type === "turn_recovery") {
          audioRef.current?.interruptPlayback();
          audioRef.current?.setListening(false);
          updateStatus("thinking");
          setError(
            String(
              message.message ??
                "The examiner connection is recovering. Your saved progress is safe.",
            ),
          );
        } else if (message.type === "candidate_text_ack" && message.accepted === false) {
          setError("The typed answer arrived outside the listening window. Please try again.");
        }
      } catch {
        // The Agents SDK also sends its own protocol messages through this socket.
      }
    },
    [appendTranscript, handleAudioFrame, updateStatus],
  );

  const agentQuery = useMemo(() => ({ token: sessionToken }), [sessionToken]);

  const agent = useAgent<InterviewState>({
    agent: "PediatricInterviewer",
    name: `web-${sessionId}`,
    host: AGENT_HOST,
    query: agentQuery,
    enabled: connectionEnabled,
    connectionTimeout: 10_000,
    minReconnectionDelay: 1_000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 1.8,
    onOpen: () => {
      const reconnecting = hadConnectionRef.current;
      hadConnectionRef.current = true;
      setConnected(true);
      setConnectionState("connected");
      const persistedEvaluation =
        stateRef.current.phase === "evaluating" || stateRef.current.phase === "evaluation_failed";
      if (pendingEndRef.current) {
        setError("Connection restored. Ending your interview safely…");
        audioRef.current?.interruptPlayback();
        audioRef.current?.setListening(false);
      } else if (reconnecting && persistedEvaluation && stateRef.current.exchanges.length > 0) {
        recoveryPendingRef.current = true;
        setError("Connection restored. Recovering your saved interview review…");
        updateStatus("evaluating");
        audioRef.current?.interruptPlayback();
        audioRef.current?.setListening(false);
      } else if (reconnecting && stateRef.current.phase === "interviewing") {
        // A transient socket loss should not turn a live interview into a report.
        // Preserve the current status and let the Worker restore the active turn.
        setError("Connection restored. Continuing your interview…");
        audioRef.current?.setListening(statusRef.current === "listening");
      } else {
        setError("");
      }
    },
    onClose: () => {
      setConnected(false);
      setConnectionState(hadConnectionRef.current ? "reconnecting" : "connecting");
      if (pendingEndRef.current) {
        setError("Reconnecting to finish ending your interview…");
      } else if (stateRef.current.phase !== "idle" && stateRef.current.phase !== "complete") {
        audioRef.current?.interruptPlayback();
        audioRef.current?.setListening(false);
        setError("Connection interrupted. Reconnecting; your saved answers are being preserved…");
      } else {
        setError(
          hadConnectionRef.current
            ? "Connection interrupted. Retrying automatically…"
            : "The interviewer is taking longer to connect. Retrying automatically…",
        );
      }
    },
    onMessage: handleMessage,
    onStateUpdate: (next) => {
      stateRef.current = next;
      setState(next);
      if (next.phase !== "idle") {
        setSelectedTopics(next.topicIds?.length ? next.topicIds : [next.topicId]);
        setQuestionCount(next.questionCount ?? TOTAL_QUESTIONS);
        setDifficulty(next.difficulty ?? DEFAULT_DIFFICULTY);
      }
      if (next.phase === "complete") {
        recoveryPendingRef.current = false;
        updateStatus("complete");
        setView("review");
      } else if (next.phase === "evaluating") updateStatus("evaluating");
      else if (next.phase === "evaluation_failed") {
        updateStatus("error");
        setError("Your answers are safe, but the review was not saved. Retry the review.");
      }
      if (
        recoveryPendingRef.current &&
        next.exchanges.length > 0 &&
        ["evaluating", "evaluation_failed"].includes(next.phase)
      ) {
        recoveryPendingRef.current = false;
        if (!sendJson({ type: "recover_report" })) {
          setError("Connection restored, but report recovery could not be sent. Please retry.");
          updateStatus("error");
        }
      }
    },
    onConnectionError: (connectionError) => {
      setConnected(false);
      setConnectionState("error");
      setError(
        connectionError.reason
          ? "The secure interviewer connection was rejected. Retry to request a fresh session."
          : "Could not connect to the interviewer.",
      );
      updateStatus("error");
    },
  });

  useEffect(() => {
    agentRef.current = agent;
    agent.binaryType = "arraybuffer";
  }, [agent]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      startGenerationRef.current += 1;
      startingRef.current = false;
      pendingEndRef.current = false;
      audio?.stop();
    };
  }, []);

  useEffect(() => {
    if (!connected || !pendingEndRef.current) return;
    if (!sendJson({ type: "end_call" })) {
      setError("Connection returned, but ending the interview could not be sent. Retry connection.");
      return;
    }
    pendingEndRef.current = false;
    setEndPending(false);
    setError("");
    const hasAnswers = stateRef.current.exchanges.length > 0;
    updateStatus(hasAnswers ? "evaluating" : "idle");
    if (!hasAnswers) setView("topics");
  }, [connected, sendJson, updateStatus]);

  const keepScreenAwake = interviewKeepsScreenAwake(status);
  useEffect(() => {
    if (!keepScreenAwake) return;
    return holdScreenWakeLock({
      onStateChange: (wakeLockState) => {
        setWakeLockWarning(
          screenWakeLockWarning(wakeLockState, {
            maxTouchPoints: navigator.maxTouchPoints,
            standalone:
              (navigator as Navigator & { standalone?: boolean }).standalone ===
              true,
            userAgent: navigator.userAgent,
          }),
        );
      },
    });
  }, [keepScreenAwake]);

  const activeTopics = TOPICS.filter((topic) => selectedTopics.includes(topic.id));
  const activeTopic = activeTopics[0] ?? TOPICS[0];
  const activeTopicLabel = topicSelectionLabel(selectedTopics);
  const plannedQuestionCount =
    state.phase === "idle" ? questionCount : state.questionCount ?? questionCount;
  const questionNumber =
    state.phase === "idle"
      ? 0
      : Math.min(state.exchanges.length + 1, plannedQuestionCount);
  const copy = statusCopy(status, plannedQuestionCount);
  const catIsTalking = status === "speaking" || browserSpeaking;
  const interviewRunning =
    starting ||
    status === "thinking" ||
    status === "listening" ||
    status === "speaking" ||
    status === "evaluating";
  const difficultyDetail =
    DIFFICULTY_OPTIONS.find((option) => option.id === difficulty)?.detail ?? "";

  const toggleTopic = useCallback((topicId: TopicId) => {
    setSelectedTopics((current) => {
      const next = current.includes(topicId)
        ? current.filter((id) => id !== topicId)
        : [...current, topicId];
      setQuestionCount((count) => questionCountForSelection(count, Math.max(1, next.length)));
      return next;
    });
  }, []);

  const startInterview = useCallback(
    async () => {
      if (selectedTopics.length === 0 || !connected || interviewRunning) return;
      const generation = startGenerationRef.current + 1;
      startGenerationRef.current = generation;
      startingRef.current = true;
      setStarting(true);
      pendingEndRef.current = false;
      setEndPending(false);
      setError("");
      setWakeLockWarning("");
      setTranscript([]);
      setReviewPage(0);
      setTextComposerOpen(false);
      setView("interview");
      updateStatus("thinking");
      let microphoneReady = false;
      try {
        microphoneReady = (await audioRef.current?.start(sendAudio)) ?? false;
        setAudioAvailable(microphoneReady);
        if (!microphoneReady) {
          setTextComposerOpen(true);
          setError("Microphone access was unavailable. You can still listen and type answers.");
        }
      } catch {
        setAudioAvailable(false);
        setTextComposerOpen(true);
        setError("Browser audio is unavailable. Continue with typed answers and live captions.");
      }
      if (generation !== startGenerationRef.current || !startingRef.current) return;
      if (!sendJson({
        type: "start_call",
        topic_id: selectedTopics[0],
        topic_ids: selectedTopics,
        question_count: questionCount,
        difficulty,
      })) {
        startingRef.current = false;
        setStarting(false);
        audioRef.current?.stop();
        setError("The interviewer connection is not ready. Retry before starting again.");
        updateStatus("error");
        setView("topics");
        return;
      }
      startingRef.current = false;
      setStarting(false);
      if (!microphoneReady) audioRef.current?.setListening(false);
    },
    [connected, difficulty, interviewRunning, questionCount, selectedTopics, sendAudio, sendJson, updateStatus],
  );

  const endInterview = useCallback(() => {
    audioRef.current?.setListening(false);
    if (startingRef.current) {
      startGenerationRef.current += 1;
      startingRef.current = false;
      setStarting(false);
      audioRef.current?.stop();
      setError("");
      updateStatus("idle");
      setView("topics");
      return;
    }
    const currentState = stateRef.current;
    if (currentState.phase === "evaluation_failed") {
      if (sendJson({ type: "recover_report" })) {
        setError("");
        updateStatus("evaluating");
      } else {
        setError("The connection is not ready. Reconnect before retrying the review.");
      }
      return;
    }
    if (!sendJson({ type: "end_call" })) {
      pendingEndRef.current = true;
      setEndPending(true);
      audioRef.current?.interruptPlayback();
      setError("Connection interrupted. Your request to end will be sent automatically after reconnecting.");
      return;
    }
    pendingEndRef.current = false;
    setEndPending(false);
    const hasAnswers = currentState.exchanges.length > 0;
    updateStatus(hasAnswers ? "evaluating" : "idle");
    if (!hasAnswers) setView("topics");
  }, [sendJson, updateStatus]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      audioRef.current?.setMuted(!current);
      return !current;
    });
  }, []);

  const updateVolume = useCallback((next: number) => {
    setVolume(next);
    audioRef.current?.setVolume(next);
  }, []);

  const submitTypedAnswer = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const text = typedAnswer.trim();
      if (!text || statusRef.current !== "listening") return;
      audioRef.current?.setListening(false);
      if (!sendJson({ type: "candidate_text", text })) {
        setError("The interviewer connection is not ready. Please retry your answer.");
        return;
      }
      setTypedAnswer("");
      setTextComposerOpen(false);
      updateStatus("thinking");
    },
    [sendJson, typedAnswer, updateStatus],
  );

  const retryConnection = useCallback(() => {
    setError("");
    setConnectionState("connecting");
    onRefreshSession();
  }, [onRefreshSession]);

  const evaluation = state.evaluation;
  const average = averageScore(evaluation);
  const reviewItems = evaluation?.scoreSummary ?? [];
  const reviewPageCount = Math.max(1, reviewItems.length + 1);

  return (
    <main className="app-shell">
      <aside className="topic-rail" aria-label="Study topics">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">AC</div>
          <div>
            <h1>Angry Cat</h1>
            <p>Oral Boards</p>
          </div>
        </div>

        <div className="rail-heading">
          <span>Select one or more topics</span>
          <button className="mobile-close" onClick={() => setView("interview")} aria-label="Close topics">
            <X size={18} />
          </button>
        </div>
        <nav className="topic-list">
          {TOPICS.map((topic, index) => {
            const Icon = topicIcons[index];
            const selected = selectedTopics.includes(topic.id);
            return (
              <button
                className="topic-button"
                data-selected={selected}
                key={topic.id}
                onClick={() => toggleTopic(topic.id)}
                aria-pressed={selected}
                disabled={interviewRunning}
              >
                <span className="topic-check" aria-hidden="true">
                  {selected ? <Check size={14} strokeWidth={3} /> : index + 1}
                </span>
                <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
                <span>{topic.short}</span>
              </button>
            );
          })}
        </nav>

        <section className="interview-setup" aria-label="Interview settings">
          <div className="setup-heading">
            <strong>Interview setup</strong>
            <span>{selectedTopics.length || 0} selected</span>
          </div>
          <label className="question-count-field">
            <span>Questions</span>
            <select
              value={questionCount}
              onChange={(event) =>
                setQuestionCount(
                  questionCountForSelection(Number(event.target.value), selectedTopics.length),
                )
              }
              disabled={interviewRunning}
            >
              {QUESTION_COUNT_OPTIONS.map((count) => (
                <option key={count} value={count} disabled={count < selectedTopics.length}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <div className="difficulty-field">
            <span>Difficulty</span>
            <div role="radiogroup" aria-label="Difficulty level">
              {DIFFICULTY_OPTIONS.map((option) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={difficulty === option.id}
                  data-selected={difficulty === option.id}
                  disabled={interviewRunning}
                  key={option.id}
                  onClick={() => setDifficulty(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <small>{difficultyDetail}</small>
          </div>
          <button
            type="button"
            className="start-interview-button"
            onClick={() => void startInterview()}
            disabled={connectionState !== "connected" || selectedTopics.length === 0 || interviewRunning}
          >
            Start {questionCount}-question {selectedTopics.length > 1 ? "combo" : "interview"}
          </button>
          <div className="setup-connection" role="status" aria-live="polite">
            <ConnectionIndicator state={connectionState} />
            {connectionState !== "connected" && error && <p role="alert">{error}</p>}
            {connectionState !== "connected" && (
              <button type="button" className="retry-connection-button" onClick={retryConnection}>
                <RotateCcw size={15} aria-hidden="true" /> Retry connection
              </button>
            )}
          </div>
        </section>
        <div className="rail-note">
          <BookOpenText size={19} />
          <span>
            Multiple selections become one coherent combo case. Each selected domain gets a
            question target.
          </span>
        </div>
      </aside>

      <section
        className="interview-stage"
        data-audio-playing={browserSpeaking}
        data-connection={connectionState}
      >
        <header className="mobile-header">
          <div className="brand-mark small">AC</div>
          <strong>Angry Cat Oral Boards</strong>
          <ConnectionIndicator state={connectionState} />
        </header>

        {view === "topics" && (
          <div className="mobile-topic-intro">
            <Image
              src="/angry-cat-examiner-tuxedo.png"
              alt="Tuxedo Angry Cat examiner"
              width={1311}
              height={1200}
              priority
            />
            <h2>Build your practice case</h2>
            <p>
              Select one or more topics, then choose the question count and difficulty before
              starting.
            </p>
          </div>
        )}

        {view !== "topics" && (
          <>
            <div className="stage-topline">
              <button className="domain-button" onClick={() => setView("topics")}>
                <Stethoscope size={18} />
                <span>{activeTopicLabel}</span>
              </button>
              <QuestionProgress current={questionNumber} total={plannedQuestionCount} />
            </div>

            <div
              className="cat-stage"
              data-status={status}
              data-talking={catIsTalking}
            >
              <div className="cat-glow" />
              <div className="cat-art">
                <Image
                  className="cat-image"
                  src="/angry-cat-examiner-tuxedo.png"
                  alt="Tuxedo Angry Cat, your pediatric dentistry examiner"
                  width={1311}
                  height={1200}
                  sizes="(max-width: 640px) 185px, (max-height: 850px) 235px, 310px"
                  priority
                />
                <svg
                  className="cat-mouth"
                  viewBox="0 0 88 56"
                  aria-hidden="true"
                >
                  <path
                    className="cat-mouth-cavity"
                    d="M5 8C15 2 28 1 44 1s29 1 39 7c-2 26-17 43-39 43S7 34 5 8Z"
                  />
                  <path
                    className="cat-mouth-teeth"
                    d="M12 9c9-3 19-4 32-4s23 1 32 4c-8 7-19 10-32 10S20 16 12 9Z"
                  />
                  <path
                    className="cat-mouth-tongue"
                    d="M21 43c6-10 14-15 23-15s17 5 23 15c-6 6-14 9-23 9s-17-3-23-9Z"
                  />
                  <path className="cat-mouth-tongue-line" d="M44 31v16" />
                </svg>
                <div className="cat-voice-marks" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>

            <section className="question-panel">
              <p className="domain-label">
                {selectedTopics.length > 1 ? activeTopicLabel : activeTopic.label}
              </p>
              <h2>
                {state.currentQuestion ||
                  "Angry Cat is preparing a new oral-board vignette for your selected topic."}
              </h2>
              <div className="voice-state" data-status={status} role="status" aria-live="polite" aria-atomic="true">
                <div className="voice-icon">
                  {status === "evaluating" ? <ClipboardCheck /> : status === "error" ? <CircleAlert /> : <Mic />}
                </div>
                <div>
                  <strong>{copy.label}</strong>
                  <p>{error || (audioAvailable ? copy.detail : "Microphone unavailable. Type your answer below.")}</p>
                </div>
                <Waveform level={status === "listening" ? level : browserSpeaking ? 0.72 : 0.18} active={status !== "idle"} />
              </div>
              {keepScreenAwake && wakeLockWarning && (
                <div className="screen-wake-warning" role="status">
                  <CircleAlert size={18} aria-hidden="true" />
                  <span>{wakeLockWarning}</span>
                </div>
              )}
            </section>

            {captions && transcript.length > 0 && (
              <section className="caption-strip" aria-label="Live captions">
                <span>{transcript.at(-1)?.role === "candidate" ? "You" : "Examiner"}</span>
                <p>{transcript.at(-1)?.text}</p>
              </section>
            )}

            <div className="control-dock">
              <ControlButton
                icon={muted ? MicOff : Mic}
                label={muted ? "Unmute" : "Mute"}
                active={muted}
                onClick={toggleMute}
              />
              <div className="volume-control">
                {volume > 0.4 ? <Volume2 /> : <Volume1 />}
                <input
                  aria-label="Speaker volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(event) => updateVolume(Number(event.target.value))}
                />
                <span>Volume</span>
              </div>
              <button
                type="button"
                className="end-button"
                onClick={endInterview}
                disabled={status === "complete" || endPending}
              >
                <span>{state.phase === "evaluation_failed" ? <RotateCcw size={19} /> : <Square size={19} fill="currentColor" />}</span>
                {state.phase === "evaluation_failed"
                  ? "Retry review"
                  : endPending
                    ? "Ending after reconnect"
                    : starting
                      ? "Cancel start"
                      : "End interview"}
              </button>
              <ControlButton
                icon={MessageCircleMore}
                label="Type answer"
                active={textComposerOpen}
                onClick={() => setTextComposerOpen((open) => !open)}
              />
              <ControlButton
                icon={Captions}
                label="Captions"
                active={captions}
                onClick={() => setCaptions((current) => !current)}
              />
            </div>

            {textComposerOpen && (
              <form className="text-composer" onSubmit={submitTypedAnswer}>
                <label htmlFor="typed-answer">Type your answer</label>
                <textarea
                  id="typed-answer"
                  value={typedAnswer}
                  onChange={(event) => setTypedAnswer(event.target.value)}
                  placeholder="Answer the examiner in your own words…"
                  maxLength={1000}
                  autoFocus
                />
                <button type="submit" disabled={!typedAnswer.trim() || status !== "listening"}>
                  Send answer <Send size={17} />
                </button>
              </form>
            )}

            <div
              className="audio-meter"
              role="progressbar"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
              aria-valuetext={`${Math.round(level * 100)} percent`}
            >
              <span>Audio level</span>
              <div><i style={{ width: `${Math.max(4, level * 100)}%` }} /></div>
            </div>
          </>
        )}
      </section>

      <InterviewReview
        view={view}
        evaluation={evaluation}
        average={average}
        reviewItems={reviewItems}
        reviewPage={reviewPage}
        reviewPageCount={reviewPageCount}
        reportId={state.reportId}
        cheatsheetAvailable={Boolean(state.cheatsheetAvailable)}
        questionCount={questionCount}
        connectionState={connectionState}
        onClose={() => setView("interview")}
        onBuildAnother={() => setView("topics")}
        onReviewPage={setReviewPage}
      />

      <nav className="mobile-tabs" aria-label="App views">
        <button type="button" data-active={view === "topics"} aria-current={view === "topics" ? "page" : undefined} onClick={() => setView("topics")}><BookOpenText aria-hidden="true" />Topics</button>
        <button type="button" data-active={view === "interview"} aria-current={view === "interview" ? "page" : undefined} onClick={() => setView("interview")}><Headphones aria-hidden="true" />Interview</button>
        <button type="button" data-active={view === "review"} aria-current={view === "review" ? "page" : undefined} onClick={() => setView("review")}><ClipboardCheck aria-hidden="true" />Review</button>
      </nav>
    </main>
  );
}
