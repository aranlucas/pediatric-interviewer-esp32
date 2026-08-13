import { z } from "zod";

import { type CognitiveLevel, type PediatricTopic } from "./interview-content";

export const INTERVIEW_QUESTION_COUNT = 6;
export const EVALUATION_MODEL = "gemini-3.1-flash-lite" as const;

export const PRACTICE_SCORE_RUBRIC = {
  3: "Full command of the assessed knowledge and skill, with clinical reasoning, communication, and professionalism supporting safe and effective practice.",
  2: "Less than full command of the assessed task; the response is partly sound but has clinically meaningful omissions, weak reasoning, or incomplete communication.",
  1: "The response does not demonstrate accurate command of the assessed task or does not support safe and effective practice.",
} as const;

const skillSchema = z.enum(["remember", "understand_apply", "analyze_evaluate"]);
const outcomeSchema = z.enum(["pass", "borderline", "not_yet"]);

export const interviewExchangeSchema = z.object({
  question: z.string().min(1).max(1_200),
  answer: z.string().min(1).max(4_000),
});

export const evaluatedExchangeSchema = interviewExchangeSchema.extend({
  feedback: z.string().min(1).max(2_000),
  idealResponse: z.string().min(1).max(4_000),
  skillset: z.string().min(1).max(120),
  skill: skillSchema,
  score: z.number().int().min(1).max(3),
});

export const interviewEvaluationSchema = z.object({
  outcome: outcomeSchema,
  examinerSummary: z.string().min(1).max(4_000),
  scoreSummary: z
    .array(
      z.object({
        skillset: z.string().min(1).max(120),
        skill: skillSchema,
        score: z.number().int().min(1).max(3),
        rationale: z.string().min(1).max(1_000),
      }),
    )
    .min(1)
    .max(INTERVIEW_QUESTION_COUNT),
  exchanges: z.array(evaluatedExchangeSchema).length(INTERVIEW_QUESTION_COUNT),
});

export type InterviewExchange = z.infer<typeof interviewExchangeSchema>;
export type InterviewEvaluation = z.infer<typeof interviewEvaluationSchema>;

export type StoredInterviewReport = {
  schemaVersion: 1;
  reportId: string;
  sessionId: string;
  generatedAt: string;
  evaluatorModel: typeof EVALUATION_MODEL;
  topic: {
    id: PediatricTopic["id"];
    label: string;
    blueprintWeight: number;
    blueprintSource: string;
    studyMaterial: string;
    objectives: string;
    competencies: Array<{
      skillset: string;
      cognitiveLevel: CognitiveLevel;
    }>;
  };
  evaluation: InterviewEvaluation;
};

export const interviewEvaluationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: outcomeSchema.options },
    examinerSummary: { type: "string" },
    scoreSummary: {
      type: "array",
      minItems: 1,
      maxItems: INTERVIEW_QUESTION_COUNT,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          skillset: { type: "string" },
          skill: { type: "string", enum: skillSchema.options },
          score: { type: "integer", minimum: 1, maximum: 3 },
          rationale: { type: "string" },
        },
        required: ["skillset", "skill", "score", "rationale"],
      },
    },
    exchanges: {
      type: "array",
      minItems: INTERVIEW_QUESTION_COUNT,
      maxItems: INTERVIEW_QUESTION_COUNT,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
          feedback: { type: "string" },
          idealResponse: { type: "string" },
          skillset: { type: "string" },
          skill: { type: "string", enum: skillSchema.options },
          score: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["question", "answer", "feedback", "idealResponse", "skillset", "skill", "score"],
      },
    },
  },
  required: ["outcome", "examinerSummary", "scoreSummary", "exchanges"],
} as const;

function clean(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function transcriptForEvaluation(exchanges: InterviewExchange[]): InterviewExchange[] {
  return exchanges.map(({ question, answer }) => ({
    question: clean(question, 1_200),
    answer: clean(answer, 4_000),
  }));
}

export async function evaluateInterview(
  apiKey: string,
  topic: PediatricTopic,
  exchanges: InterviewExchange[],
): Promise<InterviewEvaluation> {
  const transcript = transcriptForEvaluation(exchanges);
  if (transcript.length !== INTERVIEW_QUESTION_COUNT) {
    throw new Error(
      `Cannot evaluate ${transcript.length} exchanges; ${INTERVIEW_QUESTION_COUNT} are required.`,
    );
  }
  if (!apiKey.trim()) throw new Error("GEMINI_API_KEY is not configured.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EVALUATION_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a pediatric dentistry oral-board practice evaluator. Evaluate only the supplied six exchanges, competency plan, cognitive levels, and study map. This is educational feedback, not patient-specific medical advice. " +
                `Apply these ABPD-aligned practice anchors independently to every response: Score 3 means ${PRACTICE_SCORE_RUBRIC[3]} Score 2 means ${PRACTICE_SCORE_RUBRIC[2]} Score 1 means ${PRACTICE_SCORE_RUBRIC[1]} ` +
                "Judge the whole demonstrated response: factual knowledge, application or analysis at the requested cognitive level, clinical reasoning and prioritization, communication with patients or guardians, professionalism, and whether the plan supports safe and effective care. Do not award a 3 for merely naming many facts without applying them to the generated vignette. A clinically unsafe decision or failure to recognize a material safety issue cannot receive a 3. " +
                "For every exchange, preserve the supplied question and answer verbatim. Write feedback as concise contrastive coaching: state what the candidate did well and what clinically material content was missing for a score of 3. " +
                "Write idealResponse as a complete natural first-person answer an excellent candidate could say aloud. Use connected clinical reasoning, not bullets, headings, fragments, citations, source names, or an answer-key format. " +
                "Assign each exchange to the best-matching supplied competency. Scores are integers from 1 to 3. Use exactly remember, understand_apply, or analyze_evaluate for skill. " +
                "The final outcome is only a practice summary, not an official ABPD outcome: use pass when the responses consistently support safe and effective practice with no score of 1; borderline when performance is incomplete but no critical unsafe pattern dominates; and not_yet when one or more material safety failures or repeated inaccurate responses require remediation. Do not claim this predicts ABPD certification performance or reproduce ABPD scaled scoring.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  topic: {
                    label: topic.label,
                    studyMaterial: topic.studyMaterial,
                    objectives: topic.objectives,
                    blueprintWeight: topic.blueprintWeight,
                    competencies: topic.competencies,
                  },
                  exchanges: transcript,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8_192,
          responseMimeType: "application/json",
          responseJsonSchema: interviewEvaluationJsonSchema,
        },
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 600);
    throw new Error(`Gemini evaluation failed with HTTP ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini evaluation returned no structured result.");

  const evaluation = interviewEvaluationSchema.parse(JSON.parse(text));
  for (let index = 0; index < transcript.length; index += 1) {
    evaluation.exchanges[index].question = transcript[index].question;
    evaluation.exchanges[index].answer = transcript[index].answer;
  }
  return evaluation;
}

function outcomeLabel(outcome: InterviewEvaluation["outcome"]): string {
  if (outcome === "pass") return "On track to pass";
  if (outcome === "borderline") return "Borderline";
  return "Not yet passing";
}

function skillLabel(skill: InterviewEvaluation["scoreSummary"][number]["skill"]): string {
  if (skill === "understand_apply") return "Understand / Apply";
  if (skill === "analyze_evaluate") return "Analyze / Evaluate";
  return "Remember";
}

function markdownText(value: string): string {
  return value.replaceAll("|", "\\|").trim();
}

export function buildInterviewMarkdown(report: StoredInterviewReport): string {
  const lines = [
    "# Pediatric Oral Boards Practice Report",
    "",
    `Generated ${report.generatedAt}`,
    `Report ID: ${report.reportId}`,
    "",
    "## Practice outcome",
    "",
    `**${outcomeLabel(report.evaluation.outcome)}**`,
    "",
    "> Study estimate only. This does not predict certification performance or replace current clinical guidance.",
    "",
    "## Study domain",
    "",
    report.topic.label,
    "",
    `Study map: ${report.topic.studyMaterial}`,
    `Blueprint weight: ${report.topic.blueprintWeight}%`,
    `Scoring reference: ${report.topic.blueprintSource}`,
    "",
    "## Practice scoring anchors",
    "",
    `- **3:** ${PRACTICE_SCORE_RUBRIC[3]}`,
    `- **2:** ${PRACTICE_SCORE_RUBRIC[2]}`,
    `- **1:** ${PRACTICE_SCORE_RUBRIC[1]}`,
    "",
    "These are ABPD-aligned practice anchors. The official examination uses calibrated examiner ratings and scaled scoring; this report is not an official result.",
    "",
    "## Skillset scores",
    "",
    "| Skillset | Skill | Score | Rationale |",
    "| --- | --- | ---: | --- |",
    ...report.evaluation.scoreSummary.map(
      (row) =>
        `| ${markdownText(row.skillset)} | ${skillLabel(row.skill)} | ${row.score}/3 | ${markdownText(row.rationale)} |`,
    ),
    "",
    "## Examiner summary",
    "",
    report.evaluation.examinerSummary,
    "",
    "## Question review",
    "",
  ];

  for (const [index, exchange] of report.evaluation.exchanges.entries()) {
    lines.push(
      `### Question ${index + 1}`,
      "",
      "**Examiner**",
      "",
      exchange.question,
      "",
      "**Your answer**",
      "",
      exchange.answer,
      "",
      `**Assessment:** ${exchange.skillset} - ${skillLabel(exchange.skill)} - ${exchange.score}/3`,
      "",
      "**Examiner feedback**",
      "",
      exchange.feedback,
      "",
      "**Model answer**",
      "",
      exchange.idealResponse,
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

export function reportObjectKeys(report: StoredInterviewReport): {
  json: string;
  markdown: string;
} {
  const prefix = `pediatric-oral-boards/reports/${report.reportId}`;
  return { json: `${prefix}.json`, markdown: `${prefix}.md` };
}

export async function storeInterviewReport(
  bucket: R2Bucket,
  report: StoredInterviewReport,
): Promise<{ jsonKey: string; markdownKey: string }> {
  const keys = reportObjectKeys(report);
  const metadata = {
    reportId: report.reportId,
    sessionId: report.sessionId,
    topicId: report.topic.id,
    outcome: report.evaluation.outcome,
    schemaVersion: String(report.schemaVersion),
  };
  const writes = await Promise.allSettled([
    bucket.put(keys.json, JSON.stringify(report, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: metadata,
    }),
    bucket.put(keys.markdown, buildInterviewMarkdown(report), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: metadata,
    }),
  ]);
  const failedWrite = writes.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedWrite) {
    await bucket.delete([keys.json, keys.markdown]).catch(() => undefined);
    throw failedWrite.reason;
  }
  return { jsonKey: keys.json, markdownKey: keys.markdown };
}
