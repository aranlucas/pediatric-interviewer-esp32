import { afterEach, describe, expect, it, vi } from "vitest";

import { PEDIATRIC_TOPICS } from "../src/interview-content";
import {
  buildCheatsheetMarkdown,
  buildInterviewCheatsheet,
  buildInterviewMarkdown,
  evaluateInterview,
  interviewEvaluationSchema,
  PRACTICE_SCORE_RUBRIC,
  reportObjectKeys,
  storeInterviewReport,
  type StoredInterviewReport,
} from "../src/interview-report";
import { isResponseComplete, shouldEndTurn } from "../src/turn-completion";
import {
  END_INTERVIEW_TOOL,
  GEMINI_LIVE_MODEL,
  geminiLiveConfig,
  geminiOpeningTurn,
  geminiReplayForAudioTurn,
  geminiReadinessTurn,
  geminiTextTurn,
  TURN_DISPOSITION_TOOL,
} from "../src/gemini-live-protocol";
import { openingPresentationForDisplay, questionForDisplay } from "../src/interview-display";
import { parseInterviewerDeviceMessage } from "../src/interviewer-protocol";
import { resamplePcm16 } from "../src/pcm-audio";

afterEach(() => vi.restoreAllMocks());

describe("Interviewer device display", () => {
  it("fits the generated presentation on screen while preserving its question", () => {
    const presentation = openingPresentationForDisplay(
      `A seven-year-old presents after a playground injury. ${"Additional evolving clinical detail. ".repeat(20)}What findings determine your immediate management?`,
    );

    expect(presentation.length).toBeLessThanOrEqual(380);
    expect(presentation).toMatch(/^A seven-year-old presents/);
    expect(presentation).toMatch(/What findings determine your immediate management\?$/);
  });

  it("extracts the final spoken question for the compact device view", () => {
    expect(
      questionForDisplay(
        "Understood. The radiograph shows furcation radiolucency. What treatment do you recommend?",
      ),
    ).toBe("What treatment do you recommend?");
  });
});

describe("Pediatric oral-board interviewer", () => {
  it("separates the case presentation from the readiness question", () => {
    expect(geminiOpeningTurn()).toEqual({
      turns:
        'PRESENT_CASE. Say "Here is your case." Then present the opening vignette in at most 60 spoken words, without asking any question. End the response immediately after the vignette.',
      turnComplete: true,
    });
    expect(geminiReadinessTurn()).toEqual({
      turns: 'ASK_READINESS. Ask exactly, "Are you ready to begin?" Say nothing else.',
      turnComplete: true,
    });
    expect(geminiReplayForAudioTurn("Here is your case. A child presents with pain.")).toEqual({
      turns:
        "REPLAY_FOR_AUDIO. Speak exactly the following text and nothing else: Here is your case. A child presents with pain.",
      turnComplete: true,
    });
  });

  it("marks a typed candidate answer as a complete Gemini client turn", () => {
    expect(geminiTextTurn("I would assess the child first.")).toEqual({
      turns: "I would assess the child first.",
      turnComplete: true,
    });
  });

  it("accepts only typed interviewer device commands", () => {
    expect(
      parseInterviewerDeviceMessage(
        JSON.stringify({ type: "start_call", topic_id: "pulp_therapy" }),
      ),
    ).toEqual({ type: "start_call", topic_id: "pulp_therapy" });
    expect(
      parseInterviewerDeviceMessage(
        JSON.stringify({ type: "candidate_text", text: "  I would reassess the child.  " }),
      ),
    ).toEqual({
      type: "candidate_text",
      text: "I would reassess the child.",
    });
    expect(
      parseInterviewerDeviceMessage(
        JSON.stringify({ type: "candidate_text", text: " ".repeat(20) }),
      ),
    ).toBeNull();
    expect(parseInterviewerDeviceMessage("null")).toBeNull();
    expect(parseInterviewerDeviceMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("resamples PCM when provider and device rates differ", () => {
    const source = new Uint8Array(12);
    const view = new DataView(source.buffer);
    [0, 1_000, 2_000, 3_000, 4_000, 5_000].forEach((sample, index) =>
      view.setInt16(index * 2, sample, true),
    );
    const output = resamplePcm16(source, 24_000, 16_000);
    expect(output.byteLength).toBe(8);
    const samples = Array.from({ length: 4 }, (_, index) =>
      new DataView(output.buffer).getInt16(index * 2, true),
    );
    expect(samples).toEqual([0, 1_500, 3_000, 4_500]);
  });

  it("preserves Gemini's native 24 kHz PCM without resampling", () => {
    const source = new Uint8Array([0, 1, 2, 3, 4, 5]);
    expect(resamplePcm16(source, 24_000, 24_000)).toEqual(source);
  });

  it("configures one Gemini Live session for audio, transcripts, and VAD", () => {
    const config = geminiLiveConfig(PEDIATRIC_TOPICS[0]);
    expect(GEMINI_LIVE_MODEL).toBe("gemini-3.1-flash-live-preview");
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
    });
    expect(config.speechConfig).toMatchObject({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
    });
    expect(config.realtimeInputConfig?.automaticActivityDetection).toMatchObject({
      disabled: true,
    });
    expect(config.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({
            name: TURN_DISPOSITION_TOOL,
            parametersJsonSchema: expect.objectContaining({
              properties: {
                disposition: {
                  type: "string",
                  enum: [
                    "begin_first_question",
                    "advance_skillset",
                    "probe_current_answer",
                    "provide_case_information",
                  ],
                },
              },
              required: ["disposition"],
            }),
          }),
          expect.objectContaining({
            name: END_INTERVIEW_TOOL,
            parametersJsonSchema: expect.objectContaining({
              properties: {
                reason: {
                  type: "string",
                  enum: [
                    "candidate_requested",
                    "candidate_unable_to_continue",
                    "running_out_of_time",
                    "examination_complete",
                  ],
                },
              },
              required: ["reason"],
            }),
          }),
        ],
      },
    ]);
    const instruction = String(config.systemInstruction);
    expect(instruction).toContain("Topic: Behavior Guidance");
    expect(instruction).toContain("Generate a new clinical vignette");
    expect(instruction).toContain("Temperament and cooperation potential");
    expect(instruction).toContain("WHAT AN EXAMINER LISTENS FOR");
    expect(instruction).toContain(
      "never turn a probe into a checklist, a compound question, or a leading question",
    );
    expect(instruction).toContain(
      "give a brief internally consistent finding and let them continue",
    );
    // A thin answer must be probed rather than silently recorded, and probing
    // must terminate: without a forced advance the exchange never reaches the
    // review and the session runs to the Live time limit.
    expect(instruction).toContain("Probe a thin answer instead of accepting it");
    expect(instruction).toContain("First probe: open and neutral");
    expect(instruction).toContain("Later probes: name the missing dimension, never its content");
    expect(instruction).toContain("Never probe the same skillset more than four times");
    expect(instruction).toContain(
      "classify advance_skillset even if the answer is still thin",
    );
    expect(instruction).toContain("no more than four times per skillset");
    expect(instruction).not.toContain(
      "A shallow but complete answer gets one neutral opportunity to elaborate",
    );
    expect(instruction).toContain(
      "ask exactly one focused question with one primary decision target",
    );
    expect(instruction).toContain('On ASK_READINESS, ask exactly, "Are you ready to begin?"');
    expect(instruction).toContain(
      "reassesses risk, adapts the plan, and explains what would change",
    );
    expect(instruction).toContain("Acknowledgements are optional");
    expect(instruction).toContain(
      "Probe, clarification, and case-information turns remain within the current exchange",
    );
    expect(instruction).toContain(
      "If the candidate says they did not hear, missed, or were not given the opening case or question",
    );
    expect(instruction).toContain(
      "A request to hear or repeat the case or question is not unrelated speech",
    );
    expect(instruction).toContain("Treat genuinely unrelated speech as ambient audio");
    expect(instruction).toContain("Never speak disclaimers");
    expect(instruction).toContain(
      "Never name, announce, restate, paraphrase, or introduce the selected topic",
    );
    expect(instruction).toContain('say exactly, "Here is your case."');
    expect(instruction).toContain("Present the generated vignette without asking any question");
    expect(instruction).not.toContain("state the topic, present the generated vignette");
    expect(instruction).not.toContain("medical advice");
    expect(instruction).not.toContain("A healthy four-year-old");
  });

  it("offers the ten requested oral-board study topics", () => {
    expect(PEDIATRIC_TOPICS).toHaveLength(10);
    expect(new Set(PEDIATRIC_TOPICS.map(({ id }) => id)).size).toBe(10);
    expect(PEDIATRIC_TOPICS.map(({ label }) => label)).toEqual([
      "Behavior Guidance",
      "Growth & Development",
      "Oral Facial Injury, Emergency Care & Oral Surgery",
      "Diagnosis, Oral Pathology, Oral Radiology, and Oral Medicine",
      "Prevention & Health Promotion",
      "Dental Caries Diagnosis, Non-Restorative Caries Management and Restorative Treatment",
      "Pulp Therapy",
      "Special Health Care Needs",
      "Advocacy and Education",
      "Elements of Pediatric Dental Practice",
    ]);
    for (const topic of PEDIATRIC_TOPICS) {
      expect(topic.studyMaterial.length).toBeGreaterThan(20);
      expect(topic.caseScope.length).toBeGreaterThan(80);
      expect(topic.competencies).toHaveLength(6);
      expect("starterQuestion" in topic).toBe(false);
    }
  });

  it("grades a full exam, and a short one when the interview ended early", () => {
    const evaluation = sampleReport().evaluation;
    expect(interviewEvaluationSchema.parse(evaluation).exchanges).toHaveLength(6);
    // An interview ended by the end_interview tool is still worth grading on
    // whatever the candidate answered.
    expect(
      interviewEvaluationSchema.parse({
        ...evaluation,
        exchanges: evaluation.exchanges.slice(0, 2),
      }).exchanges,
    ).toHaveLength(2);
    expect(() =>
      interviewEvaluationSchema.parse({ ...evaluation, exchanges: [] }),
    ).toThrow();
    expect(() =>
      interviewEvaluationSchema.parse({
        ...evaluation,
        exchanges: [...evaluation.exchanges, evaluation.exchanges[0]],
      }),
    ).toThrow();
  });

  it("pins the response schema to the number of exchanges actually answered", async () => {
    const report = sampleReport();
    const transcript = report.evaluation.exchanges.slice(0, 3).map(({ question, answer }) => ({
      question,
      answer,
    }));
    const shortEvaluation = {
      ...structuredClone(report.evaluation),
      exchanges: structuredClone(report.evaluation.exchanges).slice(0, 3),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(shortEvaluation) }] } }],
      }),
    );

    const evaluation = await evaluateInterview(
      "test-gemini-key",
      PEDIATRIC_TOPICS.find(({ id }) => id === "pulp_therapy")!,
      transcript,
    );

    expect(evaluation.exchanges).toHaveLength(3);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    // The model must not pad a short interview back up to six invented answers.
    expect(requestBody.generationConfig.responseJsonSchema.properties.exchanges).toMatchObject({
      minItems: 3,
      maxItems: 3,
    });
    expect(requestBody.systemInstruction.parts[0].text).toContain(
      "This interview ended after 3 of 6 planned questions",
    );
  });

  it("requests a structured Gemini review and preserves the recorded transcript", async () => {
    const report = sampleReport();
    const transcript = report.evaluation.exchanges.map(({ question, answer }) => ({
      question,
      answer,
    }));
    const modelEvaluation = structuredClone(report.evaluation);
    modelEvaluation.exchanges[0].question = "Model rewrote the question.";
    modelEvaluation.exchanges[0].answer = "Model rewrote the answer.";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(modelEvaluation) }],
            },
          },
        ],
      }),
    );

    const evaluation = await evaluateInterview(
      "test-gemini-key",
      PEDIATRIC_TOPICS.find(({ id }) => id === "pulp_therapy")!,
      transcript,
    );

    expect(evaluation.exchanges[0]).toMatchObject(transcript[0]);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(String(requestUrl)).toContain("/models/gemini-3.1-flash-lite:generateContent");
    expect(requestInit?.headers).toMatchObject({
      "x-goog-api-key": "test-gemini-key",
    });
    const requestBody = JSON.parse(String(requestInit?.body));
    expect(requestBody.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      maxOutputTokens: 8_192,
    });
    expect(requestBody.generationConfig.responseJsonSchema.properties.exchanges).toMatchObject({
      minItems: 6,
      maxItems: 6,
    });
    const evaluationInput = JSON.parse(requestBody.contents[0].parts[0].text);
    expect(evaluationInput.topic.competencies).toHaveLength(6);
    expect(evaluationInput.topic.blueprintWeight).toBe(8);
  });

  it("sends examiner follow-ups to the evaluator and restores them verbatim", async () => {
    const report = sampleReport();
    const transcript = report.evaluation.exchanges.map(({ question, answer }, index) => ({
      question,
      answer,
      ...(index === 0
        ? {
            followUps: [
              { question: "What would change that plan?", answer: "A change in cooperation." },
            ],
          }
        : {}),
    }));
    // The model never echoes followUps back; the runtime reattaches them.
    const modelEvaluation = structuredClone(report.evaluation);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(modelEvaluation) }] } }],
      }),
    );

    const evaluation = await evaluateInterview(
      "test-gemini-key",
      PEDIATRIC_TOPICS.find(({ id }) => id === "pulp_therapy")!,
      transcript,
    );

    expect(evaluation.exchanges[0].followUps).toEqual(transcript[0].followUps);
    expect(evaluation.exchanges[1].followUps).toBeUndefined();
    const requestBody = JSON.parse(
      String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body),
    );
    const evaluationInput = JSON.parse(requestBody.contents[0].parts[0].text);
    expect(evaluationInput.exchanges[0].followUps).toHaveLength(1);
    // Prompted content must be credited but must not score the same as
    // content the candidate volunteered.
    expect(requestBody.systemInstruction.parts[0].text).toContain(
      "content the candidate produced only after a probe is still demonstrated knowledge",
    );
    expect(requestBody.systemInstruction.parts[0].text).toContain(
      "is normally a 2 rather than a 3",
    );
  });

  it("builds a cheat sheet about answering, grounded in what needed probing", async () => {
    const report = sampleReport();
    report.evaluation.exchanges[0].followUps = [
      { question: "What would change that plan?", answer: "A change in cooperation." },
    ];
    const cheatsheet = sampleCheatsheet();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(cheatsheet) }] } }],
      }),
    );

    const built = await buildInterviewCheatsheet(
      "test-gemini-key",
      PEDIATRIC_TOPICS.find(({ id }) => id === "pulp_therapy")!,
      report.evaluation,
    );

    expect(built).toEqual(cheatsheet);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const input = JSON.parse(requestBody.contents[0].parts[0].text);
    expect(input.probedExchangeCount).toBe(1);
    expect(input.exchanges[0].probesNeeded).toBe(1);
    expect(input.exchanges[0].probeQuestions).toEqual(["What would change that plan?"]);
    // The student sits a different case next time, so the aid must be about
    // structure rather than this vignette's clinical content.
    expect(requestBody.systemInstruction.parts[0].text).toContain(
      "not about this vignette's clinical facts",
    );
  });

  it("renders the cheat sheet as its own document and inside the review", () => {
    const report = { ...sampleReport(), cheatsheet: sampleCheatsheet() };
    const cheatsheet = buildCheatsheetMarkdown(report);
    expect(cheatsheet).toContain("## Cheat sheet: how to answer next time");
    expect(cheatsheet).toContain("### The answer spine");
    expect(cheatsheet).toContain("### Phrases to borrow");
    expect(cheatsheet).toContain("Commit to a position");
    expect(cheatsheet).toContain("Study aid only.");
    // The standalone sheet must not drag the transcript along with it.
    expect(cheatsheet).not.toContain("### Question 1");
    expect(buildInterviewMarkdown(report)).toContain("## Cheat sheet: how to answer next time");
  });

  it("omits the cheat sheet object when generation failed", async () => {
    const withoutCheatsheet = sampleReport();
    const puts: string[] = [];
    const bucket = {
      put: async (key: string) => {
        puts.push(key);
      },
      delete: async () => undefined,
    } as unknown as R2Bucket;

    const stored = await storeInterviewReport(bucket, withoutCheatsheet);

    expect(puts).toEqual([reportObjectKeys(withoutCheatsheet).json, reportObjectKeys(withoutCheatsheet).markdown]);
    expect(stored.cheatsheetKey).toBeUndefined();
  });

  it("renders follow-ups and their grading note in the saved review", () => {
    const report = sampleReport();
    report.evaluation.exchanges[0].followUps = [
      { question: "What would change that plan?", answer: "A change in cooperation." },
    ];
    const markdown = buildInterviewMarkdown(report);
    expect(markdown).toContain("**Examiner follow-up**");
    expect(markdown).toContain("What would change that plan?");
    expect(markdown).toContain("One follow-up was");
    expect(markdown.match(/^### Question /gm)).toHaveLength(6);
  });

  it("renders feedback and spoken model answers in the saved review", () => {
    const markdown = buildInterviewMarkdown(sampleReport());
    expect(markdown).toContain("# Pediatric Oral Boards Practice Report");
    expect(markdown).toContain("## Examiner summary");
    expect(markdown).toContain("**Examiner feedback**");
    expect(markdown).toContain("**Model answer**");
    expect(markdown).toContain("## Practice scoring anchors");
    expect(markdown).toContain(PRACTICE_SCORE_RUBRIC[3]);
    expect(markdown).toContain("not an official result");
    expect(markdown.match(/^### Question /gm)).toHaveLength(6);
  });

  it("stores private JSON and Markdown objects under the report ID", async () => {
    const report = sampleReport();
    const puts: Array<{ key: string; value: string; options: R2PutOptions }> = [];
    const bucket = {
      async put(key: string, value: string, options: R2PutOptions) {
        puts.push({ key, value, options });
        return {} as R2Object;
      },
    } as unknown as R2Bucket;

    await expect(storeInterviewReport(bucket, report)).resolves.toEqual({
      jsonKey: "pediatric-oral-boards/reports/report-123.json",
      markdownKey: "pediatric-oral-boards/reports/report-123.md",
    });
    expect(puts).toHaveLength(2);
    expect(puts.map(({ key }) => key)).toEqual([
      reportObjectKeys(report).json,
      reportObjectKeys(report).markdown,
    ]);
    expect(puts[0].options.customMetadata).toMatchObject({
      reportId: "report-123",
      topicId: "pulp_therapy",
      outcome: "pass",
    });
  });

  it("rolls back both report objects when either R2 write fails", async () => {
    const report = sampleReport();
    const deleted: string[][] = [];
    const bucket = {
      async put(key: string) {
        if (key.endsWith(".md")) throw new Error("R2 unavailable");
        return {} as R2Object;
      },
      async delete(keys: string[]) {
        deleted.push(keys);
      },
    } as unknown as R2Bucket;

    await expect(storeInterviewReport(bucket, report)).rejects.toThrow("R2 unavailable");
    expect(deleted).toEqual([[reportObjectKeys(report).json, reportObjectKeys(report).markdown]]);
  });
});

function sampleReport(): StoredInterviewReport {
  return {
    schemaVersion: 1,
    reportId: "report-123",
    sessionId: "esp32-12345678",
    generatedAt: "2026-08-12T23:00:00.000Z",
    evaluatorModel: "gemini-3.1-flash-lite",
    topic: {
      id: "pulp_therapy",
      label: "Pulp Therapy",
      blueprintWeight: 10,
      blueprintSource:
        "https://www.abpd.org/become-certified/oral-clinical-examination/oce-blueprint",
      studyMaterial: "AAPD Pulp Therapy for Primary and Immature Permanent Teeth",
      objectives: "pulpal diagnosis and treatment choices",
      competencies: [
        {
          skillset: "Pulpal diagnosis",
          cognitiveLevel: "analyze_evaluate",
        },
      ],
    },
    evaluation: {
      outcome: "pass",
      examinerSummary: "The candidate gave a safe and organized response.",
      scoreSummary: [
        {
          skillset: "Pulpal diagnosis",
          skill: "analyze_evaluate",
          score: 3,
          rationale: "Findings were integrated into a defensible diagnosis.",
        },
      ],
      exchanges: Array.from({ length: 6 }, (_, index) => ({
        question: `Question ${index + 1}?`,
        answer: `Candidate answer ${index + 1}.`,
        feedback: "The response was focused; add one relevant contingency.",
        idealResponse: "I would begin with a complete clinical and radiographic assessment.",
        skillset: "Pulpal diagnosis",
        skill: "analyze_evaluate" as const,
        score: 3,
      })),
    },
  };
}

function sampleCheatsheet() {
  return {
    headline: "Commit to a position in your first sentence, then justify it.",
    answerSpine: [
      { move: "Commit", whatToSay: "Name your working diagnosis or chosen action first." },
      { move: "Justify", whatToSay: "Tie it to the findings you were given." },
      { move: "Close", whatToSay: "State follow-up and what would change the plan." },
    ],
    questionPatterns: [
      {
        questionType: "Opening assessment question",
        howToOpen: "State what you would do first and why.",
        mustCover: ["A committed first step", "The reason it comes first"],
        commonPitfall: "You listed options without choosing one.",
      },
    ],
    phrasesToBorrow: [
      { dimension: "Commit to a position", phrase: "My working diagnosis is..." },
      { dimension: "Raise safety unprompted", phrase: "Before I start, I would check..." },
    ],
    drills: [
      "Answer three questions aloud, committing in the first sentence.",
      "Rehearse raising safety before the examiner asks for it.",
    ],
  };
}

describe("Gemini Live turn boundaries", () => {
  it("treats either completion signal as a response completion", () => {
    expect(isResponseComplete({ generationComplete: true })).toBe(true);
    expect(isResponseComplete({ turnComplete: true })).toBe(true);
    expect(isResponseComplete({ generationComplete: false, turnComplete: true })).toBe(true);
    expect(isResponseComplete({})).toBe(false);
    expect(isResponseComplete({ generationComplete: false, turnComplete: false })).toBe(false);
  });

  it("ignores generationComplete during the opening handshake", () => {
    // Gemini emits generationComplete before the turn's audio has finished
    // arriving. Ending the turn there truncated the spoken case presentation
    // and let one response advance the handshake twice.
    expect(shouldEndTurn({ generationComplete: true }, true)).toBe(false);
    expect(shouldEndTurn({ generationComplete: true, turnComplete: true }, true)).toBe(true);
    expect(shouldEndTurn({ turnComplete: true }, true)).toBe(true);
  });

  it("accepts generationComplete once the interview is under way", () => {
    expect(shouldEndTurn({ generationComplete: true }, false)).toBe(true);
    expect(shouldEndTurn({ turnComplete: true }, false)).toBe(true);
  });

  it("never ends a turn without a completion signal", () => {
    expect(shouldEndTurn({}, true)).toBe(false);
    expect(shouldEndTurn({}, false)).toBe(false);
  });

  it("is self-deduplicating only during the opening handshake", () => {
    const pair = [{ generationComplete: true }, { turnComplete: true }];
    // During the handshake the predicate alone ends the turn exactly once, so
    // a stage transition cannot be driven twice by a single response.
    expect(pair.filter((signal) => shouldEndTurn(signal, true))).toHaveLength(1);
    // Afterwards both signals qualify. Deduplication is the caller's job via
    // responseCompletionHandled; anything that re-arms that flag mid-response
    // reintroduces the double-advance this module exists to prevent.
    expect(pair.filter((signal) => shouldEndTurn(signal, false))).toHaveLength(2);
  });
});
