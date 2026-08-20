import {
  PEDIATRIC_TOPICS,
  type InterviewTopic,
  type PediatricTopic,
  type PediatricTopicId,
} from "./interview-content";

export const DEFAULT_INTERVIEW_QUESTION_COUNT = 6;
export const MIN_INTERVIEW_QUESTION_COUNT = 3;
export const MAX_INTERVIEW_QUESTION_COUNT = 10;

export const INTERVIEW_DIFFICULTIES = ["easy", "standard", "hard"] as const;
export type InterviewDifficulty = (typeof INTERVIEW_DIFFICULTIES)[number];
export const DEFAULT_INTERVIEW_DIFFICULTY: InterviewDifficulty = "standard";

export type InterviewConfiguration = {
  topicIds: PediatricTopicId[];
  questionCount: number;
  difficulty: InterviewDifficulty;
};

function uniqueTopicIds(values: readonly string[]): PediatricTopicId[] | null {
  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.length > PEDIATRIC_TOPICS.length) return null;
  const topicIds = unique.filter((value): value is PediatricTopicId =>
    PEDIATRIC_TOPICS.some((topic) => topic.id === value),
  );
  return topicIds.length === unique.length ? topicIds : null;
}

export function resolveTopicIds(
  topicIds: readonly string[] | undefined,
  legacyTopicId: string | undefined,
): PediatricTopicId[] | null {
  const requested = topicIds?.length ? topicIds : [legacyTopicId ?? PEDIATRIC_TOPICS[0].id];
  return uniqueTopicIds(requested);
}

export function normalizeQuestionCount(value: number | undefined, topicCount = 1): number {
  const requested =
    value !== undefined && Number.isFinite(value)
      ? Math.trunc(value)
      : DEFAULT_INTERVIEW_QUESTION_COUNT;
  return Math.min(
    MAX_INTERVIEW_QUESTION_COUNT,
    Math.max(MIN_INTERVIEW_QUESTION_COUNT, topicCount, requested),
  );
}

export function normalizeDifficulty(value: string | undefined): InterviewDifficulty {
  return INTERVIEW_DIFFICULTIES.includes(value as InterviewDifficulty)
    ? (value as InterviewDifficulty)
    : DEFAULT_INTERVIEW_DIFFICULTY;
}

export function resolveInterviewConfiguration(input: {
  topicIds?: readonly string[];
  legacyTopicId?: string;
  questionCount?: number;
  difficulty?: string;
}): InterviewConfiguration | null {
  const topicIds = resolveTopicIds(input.topicIds, input.legacyTopicId);
  if (!topicIds) return null;
  return {
    topicIds,
    questionCount: normalizeQuestionCount(input.questionCount, topicIds.length),
    difficulty: normalizeDifficulty(input.difficulty),
  };
}

function selectedTopics(topicIds: readonly PediatricTopicId[]): PediatricTopic[] {
  return topicIds.flatMap((topicId) => {
    const topic = PEDIATRIC_TOPICS.find((candidate) => candidate.id === topicId);
    return topic ? [topic] : [];
  });
}

/**
 * Builds one coherent case brief from every selected domain. The flattened,
 * domain-prefixed competency list lets the prompt distribute questions across
 * topics without losing which blueprint area each target came from.
 */
export function buildInterviewTopic(topicIds: readonly PediatricTopicId[]): InterviewTopic {
  const topics = selectedTopics(topicIds);
  if (topics.length === 0) return PEDIATRIC_TOPICS[0];
  if (topics.length === 1) return topics[0];
  const competencyDepth = Math.max(...topics.map((topic) => topic.competencies.length));
  return {
    id: "combo",
    label: `Combo: ${topics.map((topic) => topic.label).join(" + ")}`,
    blueprintWeight: topics.reduce((total, topic) => total + topic.blueprintWeight, 0),
    studyMaterial: topics.map((topic) => topic.studyMaterial).join("; "),
    objectives: topics
      .map((topic) => `${topic.label}: ${topic.objectives}`)
      .join(" | "),
    caseScope:
      "Create one coherent pediatric patient scenario that naturally connects every selected domain. Use one patient, one timeline, and compatible findings throughout; do not present a sequence of unrelated mini-cases.",
    competencies: Array.from({ length: competencyDepth }, (_, index) =>
      topics.flatMap((topic) => {
        const competency = topic.competencies[index];
        return competency
          ? [
              {
                skillset: `${topic.label}: ${competency.skillset}`,
                cognitiveLevel: competency.cognitiveLevel,
              },
            ]
          : [];
      }),
    ).flat(),
  };
}

export function difficultyInstruction(difficulty: InterviewDifficulty): string {
  if (difficulty === "easy") {
    return "Use a common, straightforward presentation with clear initial findings. Test essential recognition and practical application without unnecessary ambiguity or rare complications.";
  }
  if (difficulty === "hard") {
    return "Use a complex but plausible presentation with meaningful uncertainty, competing priorities, and an evolving finding or constraint. Require the candidate to defend trade-offs, adapt the plan, and identify safety thresholds without relying on trivia.";
  }
  return "Use realistic board-style uncertainty and require patient-specific application, prioritization, communication, safety, and follow-up at the competency's stated cognitive level.";
}
