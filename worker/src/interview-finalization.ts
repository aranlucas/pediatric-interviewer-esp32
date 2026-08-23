import {
  ABPD_OCE_BLUEPRINT_URL,
  type InterviewTopic,
  type PediatricTopicId,
} from "./interview-content";
import {
  EVALUATION_MODEL,
  evaluateInterview,
  buildInterviewCheatsheet,
  shouldRetryGeminiError,
  storeInterviewReport,
  type InterviewCheatsheet,
  type InterviewEvaluation,
  type InterviewExchange,
  type StoredInterviewReport,
} from "./interview-report";
import type { InterviewDifficulty } from "./interview-config";
import { workerLog } from "./log";

export type InterviewFinalizationSnapshot = {
  apiKey: string;
  reportId: string;
  sessionId: string;
  interviewGeneration: string;
  topicIds: PediatricTopicId[];
  topic: InterviewTopic;
  questionCount: number;
  difficulty: InterviewDifficulty;
  exchanges: InterviewExchange[];
};

export type InterviewRetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown, nextAttempt: number) => boolean;
};

export type InterviewRetry = <T>(
  operation: (attempt: number) => Promise<T>,
  options: InterviewRetryOptions,
) => Promise<T>;

export type FinalizedInterview = {
  evaluation: InterviewEvaluation;
  cheatsheet?: InterviewCheatsheet;
};

export function cloneInterviewExchanges(
  exchanges: readonly InterviewExchange[],
): InterviewExchange[] {
  return exchanges.map((exchange) => ({
    ...exchange,
    ...(exchange.followUps
      ? { followUps: exchange.followUps.map((followUp) => ({ ...followUp })) }
      : {}),
  }));
}

/**
 * Evaluates and stores one immutable interview snapshot. The Durable Object
 * remains responsible for phase transitions, client notifications, and Live
 * transport cleanup; this helper owns only the report-producing side effects.
 */
export async function finalizeInterviewReport(
  snapshot: InterviewFinalizationSnapshot,
  reports: R2Bucket,
  retry: InterviewRetry,
): Promise<FinalizedInterview> {
  const evaluation = await retry(
    () =>
      evaluateInterview(
        snapshot.apiKey,
        snapshot.topic,
        snapshot.exchanges,
        snapshot.questionCount,
        snapshot.difficulty,
      ),
    {
      maxAttempts: 3,
      baseDelayMs: 300,
      maxDelayMs: 3_000,
      shouldRetry: (error) => shouldRetryGeminiError(error),
    },
  );

  // The cheat sheet is a study aid, not the result. A failure here must never
  // cost the candidate the report they just earned.
  let cheatsheet: InterviewCheatsheet | undefined;
  try {
    cheatsheet = await retry(
      () => buildInterviewCheatsheet(snapshot.apiKey, snapshot.topic, evaluation),
      {
        maxAttempts: 2,
        baseDelayMs: 300,
        maxDelayMs: 2_000,
        shouldRetry: (error) => shouldRetryGeminiError(error),
      },
    );
  } catch (error) {
    workerLog("error", "cheatsheet_generation_failed", {
      reportId: snapshot.reportId,
      error: String(error).slice(0, 200),
    });
  }

  const report: StoredInterviewReport = {
    schemaVersion: 2,
    reportId: snapshot.reportId,
    sessionId: snapshot.sessionId,
    generatedAt: new Date().toISOString(),
    evaluatorModel: EVALUATION_MODEL,
    configuration: {
      topicIds: snapshot.topicIds,
      questionCount: snapshot.questionCount,
      difficulty: snapshot.difficulty,
    },
    topic: {
      id: snapshot.topic.id,
      label: snapshot.topic.label,
      blueprintWeight: snapshot.topic.blueprintWeight,
      blueprintSource: ABPD_OCE_BLUEPRINT_URL,
      studyMaterial: snapshot.topic.studyMaterial,
      objectives: snapshot.topic.objectives,
      competencies: snapshot.topic.competencies.map((competency) => ({ ...competency })),
    },
    evaluation,
    ...(cheatsheet ? { cheatsheet } : {}),
  };

  await retry(() => storeInterviewReport(reports, report), {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 2_000,
  });

  return { evaluation, ...(cheatsheet ? { cheatsheet } : {}) };
}
