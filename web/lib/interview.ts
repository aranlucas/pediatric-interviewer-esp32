import {
  DEFAULT_INTERVIEW_QUESTION_COUNT as TOTAL_QUESTIONS,
  MIN_INTERVIEW_QUESTION_COUNT as MIN_QUESTIONS,
  MAX_INTERVIEW_QUESTION_COUNT as MAX_QUESTIONS,
  TOPIC_IDS,
  INTERVIEW_DIFFICULTIES,
  type TopicId,
  type InterviewDifficulty,
  type InterviewStatus,
} from "../../shared/interview-contract";
export {
  DEFAULT_INTERVIEW_QUESTION_COUNT as TOTAL_QUESTIONS,
  MIN_INTERVIEW_QUESTION_COUNT as MIN_QUESTIONS,
  MAX_INTERVIEW_QUESTION_COUNT as MAX_QUESTIONS,
  DEFAULT_INTERVIEW_DIFFICULTY as DEFAULT_DIFFICULTY,
  type TopicId,
  type InterviewDifficulty,
  type InterviewStatus,
} from "../../shared/interview-contract";

const topicCopy = {
  behavior_guidance: { label: "Behavior Guidance", short: "Behavior Guidance" },
  growth_development: { label: "Growth & Development", short: "Growth & Development" },
  facial_injury_emergency_surgery: {
    label: "Oral Facial Injury, Emergency Care & Oral Surgery",
    short: "Oral Facial Injury",
  },
  diagnosis_pathology_radiology_medicine: {
    label: "Diagnosis, Oral Pathology, Oral Radiology & Oral Medicine",
    short: "Diagnosis & Pathology",
  },
  prevention_health_promotion: {
    label: "Prevention & Health Promotion",
    short: "Prevention",
  },
  caries_management_restorative: {
    label: "Caries Diagnosis, Management & Restorative Treatment",
    short: "Caries & Restorative",
  },
  pulp_therapy: { label: "Pulp Therapy", short: "Pulp Therapy" },
  special_health_care_needs: {
    label: "Special Health Care Needs",
    short: "Special Health Care Needs",
  },
  advocacy_education: { label: "Advocacy & Education", short: "Advocacy & Education" },
  pediatric_dental_practice: {
    label: "Elements of Pediatric Dental Practice",
    short: "Pediatric Dental Practice",
  },
} as const satisfies Record<TopicId, { label: string; short: string }>;

export const TOPICS = TOPIC_IDS.map((id) => ({ id, ...topicCopy[id] }));

export const QUESTION_COUNT_OPTIONS = Array.from(
  { length: MAX_QUESTIONS - MIN_QUESTIONS + 1 },
  (_, index) => MIN_QUESTIONS + index,
);

const difficultyCopy = {
  easy: { label: "Easy", detail: "Clear findings and core decisions" },
  standard: { label: "Standard", detail: "Realistic board-style uncertainty" },
  hard: { label: "Hard", detail: "Complex trade-offs and evolving findings" },
} as const satisfies Record<InterviewDifficulty, { label: string; detail: string }>;

export const DIFFICULTY_OPTIONS = INTERVIEW_DIFFICULTIES.map((id) => ({
  id,
  ...difficultyCopy[id],
}));

export type Score = {
  skillset: string;
  skill: "remember" | "understand_apply" | "analyze_evaluate";
  score: 1 | 2 | 3;
  rationale: string;
};

export type Evaluation = {
  outcome: "pass" | "borderline" | "not_yet";
  examinerSummary: string;
  scoreSummary: Score[];
};

export type InterviewState = {
  phase: "idle" | "interviewing" | "evaluating" | "evaluation_failed" | "complete";
  topicId: TopicId;
  topicIds?: TopicId[];
  questionCount?: number;
  difficulty?: InterviewDifficulty;
  openingStage?:
    | "warming_up"
    | "presenting_case"
    | "asking_first_question"
    | "asking_readiness"
    | "awaiting_confirmation"
    | "complete";
  casePresentation?: string;
  currentQuestion: string;
  pendingExchange?: {
    question: string;
    answer: string;
    followUps: Array<{ question: string; answer: string }>;
    activeQuestion: string;
  };
  exchanges: Array<{ question: string; answer: string }>;
  reportId: string;
  cheatsheetAvailable?: boolean;
  evaluation?: Evaluation;
};

export function averageScore(evaluation?: Evaluation): number | null {
  if (!evaluation?.scoreSummary.length) {
    return null;
  }

  return (
    evaluation.scoreSummary.reduce((total, item) => total + item.score, 0) /
    evaluation.scoreSummary.length
  );
}

export function outcomeLabel(outcome?: Evaluation["outcome"]): string {
  if (outcome === "pass") {
    return "Pass";
  }

  if (outcome === "borderline") {
    return "Borderline";
  }

  if (outcome === "not_yet") {
    return "Not yet";
  }

  return "Pending";
}

export function questionCountForSelection(requested: number, topicCount: number): number {
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, topicCount, Math.trunc(requested)));
}

export function topicSelectionLabel(topicIds: readonly TopicId[]): string {
  const topics = TOPICS.filter((topic) => topicIds.includes(topic.id));

  if (topics.length === 1) {
    return topics[0].short;
  }

  return `${topics.length}-topic combo`;
}

export function statusCopy(status: InterviewStatus, questionCount = TOTAL_QUESTIONS) {
  switch (status) {
    case "listening":
      return { label: "Listening", detail: "Speak naturally. Angry Cat advances when you pause." };
    case "speaking":
      return { label: "Speaking", detail: "Listen to the examiner, then answer aloud." };
    case "thinking":
      return { label: "Thinking", detail: "Your answer is being considered." };
    case "evaluating":
      return { label: "Evaluating", detail: "Scoring your answers and preparing feedback." };
    case "complete":
      return { label: "Complete", detail: "Your review is ready and published in Reports." };
    case "error":
      return { label: "Needs attention", detail: "The interview connection needs attention." };
    case "idle":
      return {
        label: "Ready",
        detail: `Choose topics and settings to begin a ${questionCount}-question interview.`,
      };
    default:
      throw new Error(`Unsupported interview status: ${String(status)}`);
  }
}

export function statusAfterRejectedTextAnswer(
  serverStatus: InterviewStatus,
  currentStatus: InterviewStatus,
): InterviewStatus {
  return currentStatus === "thinking" ? serverStatus : currentStatus;
}

export function shouldCaptureInterviewAudio(
  status: InterviewStatus,
  textComposerOpen: boolean,
): boolean {
  return status === "listening" && !textComposerOpen;
}

export function interviewKeepsScreenAwake(status: InterviewStatus): boolean {
  return (
    status === "thinking" ||
    status === "listening" ||
    status === "speaking" ||
    status === "evaluating"
  );
}

export function interviewIsRunning(status: InterviewStatus, starting = false): boolean {
  return (
    starting ||
    status === "thinking" ||
    status === "listening" ||
    status === "speaking" ||
    status === "evaluating"
  );
}

export function interviewLocksSetup(
  status: InterviewStatus,
  phase: InterviewState["phase"],
  starting = false,
): boolean {
  return (
    interviewIsRunning(status, starting) ||
    phase === "interviewing" ||
    phase === "evaluating" ||
    phase === "evaluation_failed"
  );
}
