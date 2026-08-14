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

/**
 * Probes allowed on one skillset before the runtime forces the exchange to
 * advance. The examiner prompt asks for the same limit, but a live run showed
 * the model probing straight past it, and an exchange that never advances
 * never reaches six answers or a report at all.
 */
export const MAX_FOLLOW_UPS_PER_EXCHANGE = 4;

/** One examiner probe and the candidate's reply to it. */
export const interviewFollowUpSchema = z.object({
  question: z.string().min(1).max(1_200),
  answer: z.string().min(1).max(4_000),
});

export const interviewExchangeSchema = z.object({
  question: z.string().min(1).max(1_200),
  answer: z.string().min(1).max(4_000),
  followUps: z.array(interviewFollowUpSchema).max(MAX_FOLLOW_UPS_PER_EXCHANGE).optional(),
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
  // A full exam is six exchanges, but an interview ended early is still worth
  // grading on what the candidate actually answered.
  exchanges: z.array(evaluatedExchangeSchema).min(1).max(INTERVIEW_QUESTION_COUNT),
});

/**
 * The post-exam study aid. It is deliberately about *how to answer*, not about
 * this vignette's clinical content: the student sits a different case next
 * time, so only transferable structure is worth writing down.
 */
export const interviewCheatsheetSchema = z.object({
  headline: z.string().min(1).max(400),
  answerSpine: z
    .array(
      z.object({
        move: z.string().min(1).max(80),
        whatToSay: z.string().min(1).max(600),
      }),
    )
    .min(3)
    .max(6),
  questionPatterns: z
    .array(
      z.object({
        questionType: z.string().min(1).max(160),
        howToOpen: z.string().min(1).max(400),
        mustCover: z.array(z.string().min(1).max(200)).min(2).max(6),
        commonPitfall: z.string().min(1).max(400),
      }),
    )
    .min(1)
    .max(INTERVIEW_QUESTION_COUNT),
  phrasesToBorrow: z
    .array(
      z.object({
        dimension: z.string().min(1).max(80),
        phrase: z.string().min(1).max(300),
      }),
    )
    .min(2)
    .max(8),
  drills: z.array(z.string().min(1).max(400)).min(2).max(5),
});

export type InterviewExchange = z.infer<typeof interviewExchangeSchema>;
export type InterviewFollowUp = z.infer<typeof interviewFollowUpSchema>;
export type InterviewEvaluation = z.infer<typeof interviewEvaluationSchema>;
export type InterviewCheatsheet = z.infer<typeof interviewCheatsheetSchema>;

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
  /** Absent when the study-aid generation failed; the report still stands. */
  cheatsheet?: InterviewCheatsheet;
};

/**
 * The response schema is built per interview: an exam ended early has fewer
 * exchanges, and the model must be told the exact count so it cannot pad the
 * transcript back up to six with invented questions.
 */
export function interviewEvaluationJsonSchemaFor(exchangeCount: number) {
  return {
    ...interviewEvaluationJsonSchema,
    properties: {
      ...interviewEvaluationJsonSchema.properties,
      scoreSummary: {
        ...interviewEvaluationJsonSchema.properties.scoreSummary,
        maxItems: exchangeCount,
      },
      exchanges: {
        ...interviewEvaluationJsonSchema.properties.exchanges,
        minItems: exchangeCount,
        maxItems: exchangeCount,
      },
    },
  };
}

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
  return exchanges.map(({ question, answer, followUps }) => {
    const probes = (followUps ?? [])
      .slice(0, MAX_FOLLOW_UPS_PER_EXCHANGE)
      .map((followUp) => ({
        question: clean(followUp.question, 1_200),
        answer: clean(followUp.answer, 4_000),
      }))
      .filter((followUp) => followUp.question && followUp.answer);
    return {
      question: clean(question, 1_200),
      answer: clean(answer, 4_000),
      ...(probes.length > 0 ? { followUps: probes } : {}),
    };
  });
}

export async function evaluateInterview(
  apiKey: string,
  topic: PediatricTopic,
  exchanges: InterviewExchange[],
): Promise<InterviewEvaluation> {
  const transcript = transcriptForEvaluation(exchanges);
  if (transcript.length < 1 || transcript.length > INTERVIEW_QUESTION_COUNT) {
    throw new Error(
      `Cannot evaluate ${transcript.length} exchanges; expected 1 to ${INTERVIEW_QUESTION_COUNT}.`,
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
                `You are a pediatric dentistry oral-board practice evaluator. Evaluate only the ${transcript.length} supplied exchange${transcript.length === 1 ? "" : "s"}, competency plan, cognitive levels, and study map. This is educational feedback, not patient-specific medical advice. ` +
                (transcript.length < INTERVIEW_QUESTION_COUNT
                  ? `This interview ended after ${transcript.length} of ${INTERVIEW_QUESTION_COUNT} planned questions. Grade only what was answered and never invent or pad missing exchanges. Say in examinerSummary that the exam ended early and which competencies went untested, and do not lower any score for the questions that were never asked. `
                  : "") +
                `Apply these ABPD-aligned practice anchors independently to every response: Score 3 means ${PRACTICE_SCORE_RUBRIC[3]} Score 2 means ${PRACTICE_SCORE_RUBRIC[2]} Score 1 means ${PRACTICE_SCORE_RUBRIC[1]} ` +
                "Judge the whole demonstrated response: factual knowledge, application or analysis at the requested cognitive level, clinical reasoning and prioritization, communication with patients or guardians, professionalism, and whether the plan supports safe and effective care. Do not award a 3 for merely naming many facts without applying them to the generated vignette. A clinically unsafe decision or failure to recognize a material safety issue cannot receive a 3. " +
                "An exchange may carry a followUps array: examiner probes and the candidate's replies to them, in order. Grade the exchange as a whole, including everything said in the follow-ups; content the candidate produced only after a probe is still demonstrated knowledge and must be credited. But prompted content does not show the same command as content offered unprompted. An exchange that needed a probe before the candidate committed to a position, or before a clinically essential element such as safety, consent, or follow-up appeared at all, is normally a 2 rather than a 3 even when the final content is sound. An exchange that stayed vague through every probe is at most a 2, and a 1 when what was missing was material to safe care. Answers that were complete before any probe are judged on their content alone and are not penalized for having been probed. " +
                "For every exchange, preserve the supplied question and answer verbatim. Write feedback as concise contrastive coaching: state what the candidate did well and what clinically material content was missing for a score of 3. When probing was needed, name which elements only appeared after a probe, because volunteering them unprompted is the skill being trained. " +
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
          responseJsonSchema: interviewEvaluationJsonSchemaFor(transcript.length),
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
  // The model never echoes the transcript back; keeping it out of the response
  // schema saves output tokens and makes rewriting the candidate impossible.
  for (let index = 0; index < transcript.length; index += 1) {
    evaluation.exchanges[index].question = transcript[index].question;
    evaluation.exchanges[index].answer = transcript[index].answer;
    evaluation.exchanges[index].followUps = transcript[index].followUps;
  }
  return evaluation;
}

export const interviewCheatsheetJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    answerSpine: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          move: { type: "string" },
          whatToSay: { type: "string" },
        },
        required: ["move", "whatToSay"],
      },
    },
    questionPatterns: {
      type: "array",
      minItems: 1,
      maxItems: INTERVIEW_QUESTION_COUNT,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          questionType: { type: "string" },
          howToOpen: { type: "string" },
          mustCover: { type: "array", minItems: 2, maxItems: 6, items: { type: "string" } },
          commonPitfall: { type: "string" },
        },
        required: ["questionType", "howToOpen", "mustCover", "commonPitfall"],
      },
    },
    phrasesToBorrow: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimension: { type: "string" },
          phrase: { type: "string" },
        },
        required: ["dimension", "phrase"],
      },
    },
    drills: { type: "array", minItems: 2, maxItems: 5, items: { type: "string" } },
  },
  required: ["headline", "answerSpine", "questionPatterns", "phrasesToBorrow", "drills"],
} as const;

/**
 * Builds the post-exam cheat sheet from the finished evaluation. This is a
 * second model call rather than extra fields on the evaluation response: the
 * evaluation already fills much of its output budget with six sets of feedback
 * and model answers, and a truncated combined response would cost the student
 * the whole report instead of just the study aid.
 */
export async function buildInterviewCheatsheet(
  apiKey: string,
  topic: PediatricTopic,
  evaluation: InterviewEvaluation,
): Promise<InterviewCheatsheet> {
  if (!apiKey.trim()) throw new Error("GEMINI_API_KEY is not configured.");

  const probedExchanges = evaluation.exchanges.filter(
    (exchange) => (exchange.followUps?.length ?? 0) > 0,
  );
  const performance = {
    topic: { label: topic.label, objectives: topic.objectives, studyMaterial: topic.studyMaterial },
    outcome: evaluation.outcome,
    examinerSummary: evaluation.examinerSummary,
    probedExchangeCount: probedExchanges.length,
    exchanges: evaluation.exchanges.map((exchange) => ({
      question: exchange.question,
      skillset: exchange.skillset,
      skill: exchange.skill,
      score: exchange.score,
      feedback: exchange.feedback,
      probesNeeded: exchange.followUps?.length ?? 0,
      probeQuestions: (exchange.followUps ?? []).map((followUp) => followUp.question),
    })),
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EVALUATION_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You write a one-page cheat sheet a pediatric dentistry resident reads after a practice oral-board exam and takes into the next one. This is educational study material, not patient-specific medical advice. " +
                "Write about how to construct a spoken answer, not about this vignette's clinical facts. The student will face a different case next time, so only transferable structure, sequencing, and language are worth writing down. Never restate the case, its diagnosis, or its management plan as something to memorize. " +
                "Ground everything in the supplied performance: the scores, the feedback, and probesNeeded. probesNeeded is how many times the examiner had to probe before the answer was complete, and probeQuestions are what the examiner asked; a high count means the content was there but was not volunteered, which is a structure and habit problem the cheat sheet must target directly. " +
                "headline is one sentence naming the single highest-value habit this student should change, stated plainly and without praise padding. " +
                "answerSpine is the reusable order of moves for answering any oral-board question aloud: commit to a position, justify it from the findings, state the plan with specifics, address safety, address the caregiver conversation, close with follow-up and what would change the plan. Adapt the wording and emphasis to what this student actually dropped. Each whatToSay is practical instruction, not an example answer about this case. " +
                "questionPatterns covers the kinds of questions this student was asked, generalized into recognizable types such as an opening assessment question, a differential question, a management-choice question, or a safety question. howToOpen is the first sentence shape that commits to an answer. mustCover lists the elements an examiner is listening for in that question type. commonPitfall is what this student actually did, stated without blame. " +
                "phrasesToBorrow gives short, natural sentence stems the student can say aloud to cover a dimension they dropped, such as committing to a position, justifying from findings, raising safety unprompted, or opening the consent conversation. Keep each under twenty words and make it usable in any case. " +
                "drills are two to five concrete rehearsal actions, each doable in under fifteen minutes. " +
                "Use plain second person. No markdown, headings, bullet characters, citations, or source names inside any field.",
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(performance) }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4_096,
          responseMimeType: "application/json",
          responseJsonSchema: interviewCheatsheetJsonSchema,
        },
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 600);
    throw new Error(`Gemini cheat sheet failed with HTTP ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini cheat sheet returned no structured result.");
  return interviewCheatsheetSchema.parse(JSON.parse(text));
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
    );
    for (const followUp of exchange.followUps ?? []) {
      lines.push(
        "**Examiner follow-up**",
        "",
        followUp.question,
        "",
        "**Your answer**",
        "",
        followUp.answer,
        "",
      );
    }
    const probeCount = exchange.followUps?.length ?? 0;
    if (probeCount > 0) {
      lines.push(
        `_Graded on the whole exchange. ${probeCount === 1 ? "One follow-up was" : `${probeCount} follow-ups were`} needed before this answer was complete; volunteering that content unprompted is what earns a 3._`,
        "",
      );
    }
    lines.push(
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
  if (report.cheatsheet) {
    lines.push("", buildCheatsheetMarkdown(report).trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

/**
 * The cheat sheet as its own document, so the student can carry it into the
 * next practice exam without the transcript and scores attached.
 */
export function buildCheatsheetMarkdown(report: StoredInterviewReport): string {
  const cheatsheet = report.cheatsheet;
  if (!cheatsheet) return "";
  const probedExchanges = report.evaluation.exchanges.filter(
    (exchange) => (exchange.followUps?.length ?? 0) > 0,
  ).length;
  const lines = [
    "## Cheat sheet: how to answer next time",
    "",
    cheatsheet.headline,
    "",
    probedExchanges > 0
      ? `You needed a follow-up on ${probedExchanges} of ${report.evaluation.exchanges.length} questions. The content was reachable; the habit to build is saying it without being asked.`
      : "You answered every question without needing a follow-up. Keep that structure and push on specificity.",
    "",
    "### The answer spine",
    "",
    "Run this order out loud for any question. It is the shape examiners are listening for.",
    "",
    ...cheatsheet.answerSpine.map(
      (step, index) => `${index + 1}. **${markdownText(step.move)}** - ${markdownText(step.whatToSay)}`,
    ),
    "",
    "### Question types and how to open them",
    "",
  ];
  for (const pattern of cheatsheet.questionPatterns) {
    lines.push(
      `#### ${markdownText(pattern.questionType)}`,
      "",
      `**Open with:** ${markdownText(pattern.howToOpen)}`,
      "",
      "**An examiner is listening for:**",
      "",
      ...pattern.mustCover.map((item) => `- ${markdownText(item)}`),
      "",
      `**Watch for:** ${markdownText(pattern.commonPitfall)}`,
      "",
    );
  }
  lines.push(
    "### Phrases to borrow",
    "",
    "| When you need to | Say something like |",
    "| --- | --- |",
    ...cheatsheet.phrasesToBorrow.map(
      (phrase) => `| ${markdownText(phrase.dimension)} | ${markdownText(phrase.phrase)} |`,
    ),
    "",
    "### Before your next attempt",
    "",
    ...cheatsheet.drills.map((drill) => `- ${markdownText(drill)}`),
    "",
    "Study aid only. This does not predict certification performance or replace current clinical guidance.",
  );
  return `${lines.join("\n").trim()}\n`;
}

export function reportObjectKeys(report: StoredInterviewReport): {
  json: string;
  markdown: string;
  cheatsheet: string;
} {
  const prefix = `pediatric-oral-boards/reports/${report.reportId}`;
  return {
    json: `${prefix}.json`,
    markdown: `${prefix}.md`,
    cheatsheet: `${prefix}-cheatsheet.md`,
  };
}

export async function storeInterviewReport(
  bucket: R2Bucket,
  report: StoredInterviewReport,
): Promise<{ jsonKey: string; markdownKey: string; cheatsheetKey?: string }> {
  const keys = reportObjectKeys(report);
  const metadata = {
    reportId: report.reportId,
    sessionId: report.sessionId,
    topicId: report.topic.id,
    outcome: report.evaluation.outcome,
    schemaVersion: String(report.schemaVersion),
  };
  const written = [keys.json, keys.markdown];
  const puts = [
    bucket.put(keys.json, JSON.stringify(report, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: metadata,
    }),
    bucket.put(keys.markdown, buildInterviewMarkdown(report), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: metadata,
    }),
  ];
  if (report.cheatsheet) {
    written.push(keys.cheatsheet);
    puts.push(
      bucket.put(keys.cheatsheet, buildCheatsheetMarkdown(report), {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: metadata,
      }),
    );
  }
  const writes = await Promise.allSettled(puts);
  const failedWrite = writes.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedWrite) {
    await bucket.delete(written).catch(() => undefined);
    throw failedWrite.reason;
  }
  return {
    jsonKey: keys.json,
    markdownKey: keys.markdown,
    cheatsheetKey: report.cheatsheet ? keys.cheatsheet : undefined,
  };
}
