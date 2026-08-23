export const TOTAL_QUESTIONS = 6;
export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 10;
export const QUESTION_COUNT_OPTIONS = Array.from(
  { length: MAX_QUESTIONS - MIN_QUESTIONS + 1 },
  (_, index) => MIN_QUESTIONS + index,
);

export const DIFFICULTY_OPTIONS = [
  { id: "easy", label: "Easy", detail: "Clear findings and core decisions" },
  { id: "standard", label: "Standard", detail: "Realistic board-style uncertainty" },
  { id: "hard", label: "Hard", detail: "Complex trade-offs and evolving findings" },
] as const;
export type InterviewDifficulty = (typeof DIFFICULTY_OPTIONS)[number]["id"];
export const DEFAULT_DIFFICULTY: InterviewDifficulty = "standard";

export const TOPICS = [
  { id: "behavior_guidance", label: "Behavior Guidance", short: "Behavior Guidance" },
  { id: "growth_development", label: "Growth & Development", short: "Growth & Development" },
  {
    id: "facial_injury_emergency_surgery",
    label: "Oral Facial Injury, Emergency Care & Oral Surgery",
    short: "Oral Facial Injury",
  },
  {
    id: "diagnosis_pathology_radiology_medicine",
    label: "Diagnosis, Oral Pathology, Oral Radiology & Oral Medicine",
    short: "Diagnosis & Pathology",
  },
  { id: "prevention_health_promotion", label: "Prevention & Health Promotion", short: "Prevention" },
  {
    id: "caries_management_restorative",
    label: "Caries Diagnosis, Management & Restorative Treatment",
    short: "Caries & Restorative",
  },
  { id: "pulp_therapy", label: "Pulp Therapy", short: "Pulp Therapy" },
  {
    id: "special_health_care_needs",
    label: "Special Health Care Needs",
    short: "Special Health Care Needs",
  },
  { id: "advocacy_education", label: "Advocacy & Education", short: "Advocacy & Education" },
  {
    id: "pediatric_dental_practice",
    label: "Elements of Pediatric Dental Practice",
    short: "Pediatric Dental Practice",
  },
] as const;

export type TopicId = (typeof TOPICS)[number]["id"];
export type InterviewStatus =
  | "idle"
  | "thinking"
  | "listening"
  | "evaluating"
  | "speaking"
  | "complete"
  | "error";

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
  if (!evaluation?.scoreSummary.length) return null;
  return evaluation.scoreSummary.reduce((total, item) => total + item.score, 0) /
    evaluation.scoreSummary.length;
}

export function outcomeLabel(outcome?: Evaluation["outcome"]): string {
  if (outcome === "pass") return "Pass";
  if (outcome === "borderline") return "Borderline";
  if (outcome === "not_yet") return "Not yet";
  return "Pending";
}

export function questionCountForSelection(requested: number, topicCount: number): number {
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, topicCount, Math.trunc(requested)));
}

export function topicSelectionLabel(topicIds: readonly TopicId[]): string {
  const topics = TOPICS.filter((topic) => topicIds.includes(topic.id));
  if (topics.length === 1) return topics[0].short;
  return `${topics.length}-topic combo`;
}

export function statusCopy(
  status: InterviewStatus,
  questionCount = TOTAL_QUESTIONS,
): { label: string; detail: string } {
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
      return { label: "Complete", detail: "Your private interview review is ready." };
    case "error":
      return { label: "Needs attention", detail: "The interview connection needs attention." };
    default:
      return {
        label: "Ready",
        detail: `Choose topics and settings to begin a ${questionCount}-question interview.`,
      };
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
