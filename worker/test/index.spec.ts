import { afterEach, describe, expect, it, vi } from "vitest";

import { PEDIATRIC_TOPICS } from "../src/interview-content";
import {
  buildInterviewTopic,
  DEFAULT_INTERVIEW_DIFFICULTY,
  DEFAULT_INTERVIEW_QUESTION_COUNT,
  resolveInterviewConfiguration,
} from "../src/interview-config";
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
  appendBoundedTranscript,
  isBoundedProviderAudio,
  isValidPcm16Input,
  liveReconnectDelayMs,
  MAX_INPUT_PCM_BYTES,
  MAX_INPUT_PCM_BYTES_PER_SECOND,
  PcmInputRateGuard,
} from "../src/live-session-lifecycle";
import {
  GEMINI_LIVE_MODEL,
  geminiFirstQuestionTurn,
  geminiLiveConfig,
  geminiReconnectTurn,
  geminiTextTurn,
  isValidOpeningCasePresentation,
  turnDispositionToolOutput,
  TURN_DISPOSITION_TOOL,
} from "../src/gemini-live-protocol";
import { openingPresentationForDisplay, questionForDisplay } from "../src/interview-display";
import {
  cloneInterviewExchanges,
  finalizeInterviewReport,
} from "../src/interview-finalization";
import { parseInterviewerDeviceMessage } from "../src/interviewer-protocol";
import {
  decodeOpeningSpeech,
  GEMINI_TTS_MODEL,
  openingSpeechInteraction,
  OPENING_TTS_REQUEST_OPTIONS,
} from "../src/opening-speech";
import {
  GEMINI_OPENING_CASE_MODEL,
  openingCaseInteraction,
  openingCaseJsonSchema,
  OPENING_CASE_REQUEST_OPTIONS,
  parseOpeningCaseResponse,
} from "../src/opening-case";
import { resamplePcm16 } from "../src/pcm-audio";
import {
  CLOUDFLARE_TTS_MODEL,
  CLOUDFLARE_TTS_SAMPLE_RATE,
  synthesizeCloudflareSpeech,
} from "../src/cloudflare-speech";

afterEach(() => vi.restoreAllMocks());

function pcm16Wav(pcm: Uint8Array, sampleRate = 24_000): Uint8Array {
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm).copy(wav, 44);
  return wav;
}

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
  it("requests bounded raw PCM from the Cloudflare Workers AI binding", async () => {
    const run = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from([1, 0, 2, 0]), {
        headers: { "Content-Type": "audio/l16" },
      }),
    );

    await expect(
      synthesizeCloudflareSpeech({ run } as unknown as Ai, "Are you ready to begin?"),
    ).resolves.toEqual({
      pcm: Uint8Array.from([1, 0, 2, 0]),
      sampleRate: CLOUDFLARE_TTS_SAMPLE_RATE,
    });
    expect(run).toHaveBeenCalledWith(
      CLOUDFLARE_TTS_MODEL,
      {
        text: "Are you ready to begin?",
        speaker: "orpheus",
        encoding: "linear16",
        container: "none",
        sample_rate: 24_000,
      },
      expect.objectContaining({
        returnRawResponse: true,
        tags: ["angry-cat", "opening-tts"],
      }),
    );
  });

  it("rejects malformed Cloudflare PCM before device playback", async () => {
    const run = vi.fn().mockResolvedValue(new Response(Uint8Array.from([1, 2, 3])));

    await expect(
      synthesizeCloudflareSpeech({ run } as unknown as Ai, "Synthetic speech"),
    ).rejects.toThrow("invalid PCM16 audio");
  });

  it("builds a non-stored, bounded structured opening-case interaction", () => {
    const interaction = openingCaseInteraction(PEDIATRIC_TOPICS[0], "standard");

    expect(interaction).toMatchObject({
      model: GEMINI_OPENING_CASE_MODEL,
      store: false,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: openingCaseJsonSchema,
      },
      generation_config: {
        thinking_level: "minimal",
        max_output_tokens: 256,
      },
    });
    expect(interaction.input).toContain("Domain: Behavior Guidance");
    expect(OPENING_CASE_REQUEST_OPTIONS).toEqual({ timeout: 20_000, maxRetries: 1 });
  });

  it("turns a semantically valid structured vignette into the runtime-owned case", () => {
    expect(
      parseOpeningCaseResponse(
        JSON.stringify({
          vignette:
            "Here is your case. An anxious four-year-old child presents with intermittent lower molar pain, limited prior dental care, escalating distress in clinic, and a caregiver requesting completion of all necessary treatment today.",
        }),
      ),
    ).toBe(
      "Here is your case. An anxious four-year-old child presents with intermittent lower molar pain, limited prior dental care, escalating distress in clinic, and a caregiver requesting completion of all necessary treatment today.",
    );
  });

  it("rejects schema-valid text that crosses the opening speech boundary", () => {
    expect(() =>
      parseOpeningCaseResponse(
        JSON.stringify({
          vignette:
            "An anxious four-year-old child presents with intermittent lower molar pain and limited prior dental care. What is your initial assessment and management plan for this patient?",
        }),
      ),
    ).toThrow("violated the spoken vignette boundary");
    expect(() =>
      parseOpeningCaseResponse(
        JSON.stringify({
          vignette:
            "An anxious four-year-old child presents with intermittent lower molar pain, limited prior dental care, escalating distress in clinic, and a caregiver requesting treatment. Are you ready to begin.",
        }),
      ),
    ).toThrow("violated the spoken vignette boundary");
  });

  it("starts the first clinical question without a readiness gate", () => {
    expect(geminiFirstQuestionTurn()).toEqual({
      turns:
        "BEGIN_INTERVIEW. The candidate has heard the case. Ask only the first focused clinical question now. Do not repeat the case, add a preamble, ask whether they are ready, or answer the question.",
      turnComplete: true,
    });
  });

  it("requires a case marker and rejects clinical questions at the opening boundary", () => {
    expect(
      isValidOpeningCasePresentation(
        "Here is your case. A four-year-old presents with pain and dental anxiety.",
      ),
    ).toBe(true);
    expect(
      isValidOpeningCasePresentation(
        "Here is your case. A four-year-old presents with pain. Are you ready to begin?",
      ),
    ).toBe(false);
    expect(
      isValidOpeningCasePresentation(
        "Based on what you observe, what are your initial thoughts?",
      ),
    ).toBe(false);
    expect(
      isValidOpeningCasePresentation(
        "Here is your case. A child presents with pain. What is your diagnosis?",
      ),
    ).toBe(false);
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
        JSON.stringify({
          type: "start_call",
          topic_ids: ["pulp_therapy", "behavior_guidance"],
          question_count: 8,
          difficulty: "hard",
        }),
      ),
    ).toEqual({
      type: "start_call",
      topic_ids: ["pulp_therapy", "behavior_guidance"],
      question_count: 8,
      difficulty: "hard",
    });
    expect(
      parseInterviewerDeviceMessage(
        JSON.stringify({ type: "start_call", question_count: 11, difficulty: "expert" }),
      ),
    ).toBeNull();
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
    expect(config.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(config.sessionResumption).toEqual({});
    expect(
      geminiLiveConfig(PEDIATRIC_TOPICS[0], { sessionResumptionHandle: "resume-token" })
        .sessionResumption,
    ).toEqual({ handle: "resume-token" });
    const recoveryInstruction = String(
      geminiLiveConfig(PEDIATRIC_TOPICS[0], {
        recoveryContext: {
          casePresentation: "A four-year-old presents with pain.",
          currentQuestion: "How would you assess cooperation?",
          persistedAnswerCount: 2,
          plannedQuestionCount: 6,
        },
      }).systemInstruction,
    );
    expect(recoveryInstruction).toContain("Do not generate or substitute a new case");
    expect(recoveryInstruction).toContain("A four-year-old presents with pain");
    expect(recoveryInstruction).toContain("persisted 2 of 6 scored exchanges");
    expect(recoveryInstruction).not.toContain("readiness confirmation");
    expect(recoveryInstruction).toContain("<SILENT_RECOVERY_CONTEXT>");
    expect(recoveryInstruction).toContain(
      "Never introduce, quote, paraphrase, or read it aloud",
    );
    expect(recoveryInstruction).toContain(
      "not a request to repeat the case merely because it discusses",
    );
    expect(recoveryInstruction).toContain(
      "Repeat the case only when the candidate explicitly asks",
    );
    expect(recoveryInstruction).toContain(
      "when a RESUME_INTERVIEW command explicitly directs you",
    );
    expect(String(config.systemInstruction)).toContain("Never ask whether the candidate is ready");
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
                    "advance_skillset",
                    "probe_current_answer",
                    "provide_case_information",
                  ],
                },
              },
              required: ["disposition"],
            }),
          }),
        ],
      },
    ]);
    const instruction = String(config.systemInstruction);
    expect(instruction).toContain("Topic: Behavior Guidance");
    expect(instruction).toContain("Temperament and cooperation potential");
    expect(instruction).toContain("WHAT AN EXAMINER LISTENS FOR");
    expect(instruction).toContain(
      "never turn a probe into a checklist, a compound question, or a leading question",
    );
    expect(instruction).toContain("The interview runtime, not you, is the authority");
    expect(instruction).toContain("Never infer progress from the number of conversational turns");
    expect(instruction).toContain('say exactly, "Hold the screen or use End interview to stop."');
    expect(instruction).not.toContain("end_interview");
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
    expect(instruction).not.toContain("Are you ready to begin?");
    expect(instruction).not.toContain("ASK_READINESS");
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
    expect(instruction).toContain("On BEGIN_INTERVIEW, ask only the first focused clinical question");
    expect(instruction).toContain("runtime presents the generated case separately");
    expect(instruction).toContain("runtime generates and presents the clinical vignette outside Gemini Live");
    expect(instruction).not.toContain("Generate a new clinical vignette");
    expect(instruction).not.toContain("state the topic, present the generated vignette");
    expect(instruction).not.toContain("medical advice");
    expect(instruction).not.toContain("A healthy four-year-old");
  });

  it("uses the persisted exchange count to direct every classified turn", () => {
    expect(turnDispositionToolOutput("advance_skillset", 3)).toContain(
      "Ask clinical question 5",
    );
    expect(turnDispositionToolOutput("advance_skillset", 5)).toContain(
      "scored exchange 6 of 6",
    );
    expect(turnDispositionToolOutput("advance_skillset", 5)).toContain("Ask no further question");
    expect(turnDispositionToolOutput("probe_current_answer", 3)).toContain(
      "this turn does not advance it",
    );
    expect(turnDispositionToolOutput("provide_case_information", 3)).toContain(
      "this turn does not advance it",
    );
    expect(turnDispositionToolOutput("advance_skillset", 7, 8)).toContain(
      "scored exchange 8 of 8",
    );
  });

  it("keeps device defaults while accepting configurable combo interviews", () => {
    expect(resolveInterviewConfiguration({ legacyTopicId: "pulp_therapy" })).toEqual({
      topicIds: ["pulp_therapy"],
      questionCount: DEFAULT_INTERVIEW_QUESTION_COUNT,
      difficulty: DEFAULT_INTERVIEW_DIFFICULTY,
    });

    const configuration = resolveInterviewConfiguration({
      topicIds: ["behavior_guidance", "pulp_therapy", "growth_development", "advocacy_education"],
      questionCount: 3,
      difficulty: "hard",
    });
    expect(configuration).toEqual({
      topicIds: ["behavior_guidance", "pulp_therapy", "growth_development", "advocacy_education"],
      questionCount: 4,
      difficulty: "hard",
    });
    const combo = buildInterviewTopic(configuration!.topicIds);
    expect(combo.id).toBe("combo");
    expect(combo.label).toContain("Behavior Guidance + Pulp Therapy");
    expect(combo.caseScope).toContain("one coherent pediatric patient scenario");
    expect(combo.competencies.slice(0, 4).map((item) => item.skillset)).toEqual([
      expect.stringContaining("Behavior Guidance:"),
      expect.stringContaining("Pulp Therapy:"),
      expect.stringContaining("Growth & Development:"),
      expect.stringContaining("Advocacy and Education:"),
    ]);
  });

  it("configures a hard combo case for the requested question target", () => {
    const combo = buildInterviewTopic(["behavior_guidance", "pulp_therapy"]);
    const instruction = String(
      geminiLiveConfig(combo, { questionCount: 8, difficulty: "hard" }).systemInstruction,
    );
    expect(instruction).toContain("Combo: Behavior Guidance + Pulp Therapy");
    expect(instruction).toContain("8-QUESTION PLAN");
    expect(instruction).toContain("Level: hard");
    expect(instruction).toContain("Count exactly 8 substantive candidate answers");
    expect(
      instruction.match(/^\d+\. .+\[(?:remember|understand_apply|analyze_evaluate)\]$/gm),
    ).toHaveLength(8);
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
    // An interview ended explicitly is still worth grading on whatever the candidate answered.
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
        exchanges: Array.from({ length: 11 }, () => evaluation.exchanges[0]),
      }),
    ).toThrow();
  });

  it("accepts descriptive skillset labels longer than 120 characters", () => {
    const evaluation = structuredClone(sampleReport().evaluation);
    const descriptiveSkillset =
      "Assessment and management across clinical findings, caregiver communication, patient safety, informed consent, follow-up, and escalation planning";
    expect(descriptiveSkillset.length).toBeGreaterThan(120);
    evaluation.scoreSummary[1] = {
      ...evaluation.scoreSummary[0],
      skillset: descriptiveSkillset,
    };
    evaluation.exchanges[1].skillset = descriptiveSkillset;

    const parsed = interviewEvaluationSchema.parse(evaluation);

    expect(parsed.scoreSummary[1].skillset).toBe(descriptiveSkillset);
    expect(parsed.exchanges[1].skillset).toBe(descriptiveSkillset);
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
      8,
      "hard",
    );

    expect(evaluation.exchanges).toHaveLength(3);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    // The model must not pad a short interview back up to the configured target.
    expect(requestBody.generationConfig.responseJsonSchema.properties.exchanges).toMatchObject({
      minItems: 3,
      maxItems: 3,
    });
    expect(requestBody.systemInstruction.parts[0].text).toContain(
      "This interview ended after 3 of 8 planned questions",
    );
    expect(requestBody.systemInstruction.parts[0].text).toContain(
      "configured difficulty was hard",
    );
    expect(JSON.parse(requestBody.contents[0].parts[0].text).configuration).toEqual({
      questionCount: 8,
      difficulty: "hard",
    });
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
    expect(String(requestUrl)).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(requestInit?.headers).toMatchObject({
      "x-goog-api-key": "test-gemini-key",
    });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
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

  it("rejects evaluator output that invents or drops transcript exchanges", async () => {
    const report = sampleReport();
    const transcript = report.evaluation.exchanges.map(({ question, answer }) => ({
      question,
      answer,
    }));
    const shortEvaluation = structuredClone(report.evaluation);
    shortEvaluation.exchanges.pop();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(shortEvaluation) }] } }],
      }),
    );

    await expect(
      evaluateInterview(
        "test-gemini-key",
        PEDIATRIC_TOPICS.find(({ id }) => id === "pulp_therapy")!,
        transcript,
      ),
    ).rejects.toThrow("returned 5 exchanges; expected 6");
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

  it("quotes the original case presentation before the scoring anchors", () => {
    const report = sampleReport();
    const markdown = buildInterviewMarkdown(report);
    const caseSection = markdown.indexOf("## Original case presentation");
    const anchorsSection = markdown.indexOf("## Practice scoring anchors");
    expect(caseSection).toBeGreaterThan(-1);
    expect(anchorsSection).toBeGreaterThan(caseSection);
    expect(markdown).toContain(
      "Here is your case. A four-year-old presents with swelling and pain around a treated baby tooth.",
    );
  });

  it("omits the case presentation section for reports without one", () => {
    const markdown = buildInterviewMarkdown({ ...sampleReport(), casePresentation: undefined });
    expect(markdown).not.toContain("## Original case presentation");
    expect(markdown).toContain("## Practice scoring anchors");
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

  it("keeps successful deterministic writes in place for an idempotent retry", async () => {
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
    expect(deleted).toEqual([]);
  });

  it("clones nested exchanges and finalizes one typed report snapshot", async () => {
    const report = sampleReport();
    const topic = buildInterviewTopic(["pulp_therapy"]);
    const transcript = report.evaluation.exchanges.map(({ question, answer, followUps }) => ({
      question,
      answer,
      ...(followUps ? { followUps } : {}),
    }));
    const source = [
      {
        question: "What is your first step?",
        answer: "I would assess the child.",
        followUps: [{ question: "Why?", answer: "To prioritize safety." }],
      },
    ];
    const cloned = cloneInterviewExchanges(source);
    cloned[0].followUps![0].answer = "Changed after snapshot.";
    expect(source[0].followUps[0].answer).toBe("To prioritize safety.");

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(report.evaluation) }] } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(sampleCheatsheet()) }] } }],
        }),
      );
    const stored: Array<{ key: string; value: string }> = [];
    const bucket = {
      put: vi.fn(async (key: string, value: string) => {
        stored.push({ key, value });
      }),
    } as unknown as R2Bucket;
    const retry = async <T>(operation: (attempt: number) => Promise<T>): Promise<T> =>
      operation(1);
    const casePresentation =
      "Here is your case. A four-year-old presents with swelling around a restored molar.";

    const finalized = await finalizeInterviewReport(
      {
        apiKey: "test-gemini-key",
        reportId: "report-snapshot",
        sessionId: "session-snapshot",
        interviewGeneration: "generation-snapshot",
        topicIds: ["pulp_therapy"],
        topic,
        questionCount: 6,
        difficulty: "standard",
        exchanges: transcript,
        casePresentation,
      },
      bucket,
      retry,
    );

    expect(finalized.evaluation.exchanges).toHaveLength(transcript.length);
    expect(finalized.cheatsheet?.headline).toContain("Commit");
    expect(stored.map(({ key }) => key)).toEqual([
      "pediatric-oral-boards/reports/report-snapshot.json",
      "pediatric-oral-boards/reports/report-snapshot.md",
      "pediatric-oral-boards/reports/report-snapshot-cheatsheet.md",
    ]);
    const storedJson = JSON.parse(
      stored.find(({ key }) => key.endsWith(".json"))?.value ?? "{}",
    );
    expect(storedJson.casePresentation).toBe(casePresentation);
    const storedMarkdown = stored.find(({ key }) => key.endsWith(".md"))?.value ?? "";
    expect(storedMarkdown).toContain("## Original case presentation");
    expect(storedMarkdown).toContain(casePresentation);
  });
});

function sampleReport(): StoredInterviewReport {
  return {
    schemaVersion: 3,
    reportId: "report-123",
    sessionId: "esp32-12345678",
    generatedAt: "2026-08-12T23:00:00.000Z",
    evaluatorModel: "gemini-3.5-flash-lite",
    configuration: {
      topicIds: ["pulp_therapy"],
      questionCount: 6,
      difficulty: "standard",
    },
    casePresentation:
      "Here is your case. A four-year-old presents with swelling and pain around a treated baby tooth.",
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

  it("ignores generationComplete during the opening sequence", () => {
    // Gemini emits generationComplete before the turn's audio has finished
    // arriving. Ending the turn there truncated the spoken case presentation
    // and let one response advance the sequence twice.
    expect(shouldEndTurn({ generationComplete: true }, true)).toBe(false);
    expect(shouldEndTurn({ generationComplete: true, turnComplete: true }, true)).toBe(true);
    expect(shouldEndTurn({ turnComplete: true }, true)).toBe(true);
  });

  it("accepts generationComplete once the interview is under way", () => {
    expect(shouldEndTurn({ generationComplete: true }, false)).toBe(false);
    expect(shouldEndTurn({ turnComplete: true }, false)).toBe(true);
  });

  it("never ends a turn without a completion signal", () => {
    expect(shouldEndTurn({}, true)).toBe(false);
    expect(shouldEndTurn({}, false)).toBe(false);
  });

  it("waits through generationComplete and late content for turnComplete", () => {
    const stream = [
      { generationComplete: true },
      { text: "late audio/transcript content" },
      { turnComplete: true },
    ];
    expect(stream.filter((signal) => shouldEndTurn(signal, false))).toHaveLength(1);
    expect(shouldEndTurn(stream[0], true)).toBe(false);
    expect(shouldEndTurn(stream[2], true)).toBe(true);
  });
});

describe("Gemini opening speech fallback", () => {
  it("accepts bounded mono WAV output from the current TTS model", () => {
    const pcm = Uint8Array.from([1, 0, 2, 0]);
    expect(GEMINI_TTS_MODEL).toBe("gemini-3.1-flash-tts-preview");
    expect(
      decodeOpeningSpeech({
        channels: 1,
        data: Buffer.from(pcm16Wav(pcm)).toString("base64"),
        mime_type: "audio/wav",
        sample_rate: 24_000,
      }),
    ).toEqual({ pcm, sampleRate: 24_000 });
  });

  it("accepts bounded raw L16 with or without response metadata", () => {
    const pcm = Uint8Array.from([1, 0, 2, 0]);
    expect(
      decodeOpeningSpeech({
        channels: 1,
        data: Buffer.from(pcm).toString("base64"),
        mime_type: "audio/l16",
        sample_rate: 24_000,
      }),
    ).toEqual({ pcm, sampleRate: 24_000 });
    expect(
      decodeOpeningSpeech({
        channels: 1,
        data: Buffer.from(pcm).toString("base64"),
      }),
    ).toEqual({ pcm, sampleRate: 24_000 });
    expect(
      decodeOpeningSpeech({
        channels: 1,
        data: Buffer.from(pcm).toString("base64"),
        mime_type: "audio/L16;codec=pcm;rate=24000;channels=1;bits=16",
      }),
    ).toEqual({ pcm, sampleRate: 24_000 });
  });

  it("requests private audio through the current Interactions contract", () => {
    expect(openingSpeechInteraction("Here is your case.")).toEqual({
      model: "gemini-3.1-flash-tts-preview",
      input: "Here is your case.",
      store: false,
      response_format: {
        type: "audio",
      },
      generation_config: {
        speech_config: [{ voice: "Charon" }],
      },
    });
    expect(OPENING_TTS_REQUEST_OPTIONS).toEqual({ timeout: 30_000, maxRetries: 1 });
  });

  it("rejects malformed or incompatible TTS output", () => {
    const validData = Buffer.from([1, 0]).toString("base64");
    expect(() => decodeOpeningSpeech(undefined)).toThrow(/no audio data/i);
    expect(() =>
      decodeOpeningSpeech({ data: validData, channels: 2, sample_rate: 24_000 }),
    ).toThrow(/non-mono/i);
    expect(() =>
      decodeOpeningSpeech({ data: validData, mime_type: "audio/mp3", sample_rate: 24_000 }),
    ).toThrow(/unexpected audio format/i);
    expect(() =>
      decodeOpeningSpeech({
        data: Buffer.from([1]).toString("base64"),
        mime_type: "audio/l16",
        sample_rate: 24_000,
      }),
    ).toThrow(/invalid or oversized/i);
  });
});

describe("Gemini Live lifecycle guards", () => {
  it("validates bounded, even-length PCM16 input", () => {
    expect(isValidPcm16Input(new ArrayBuffer(2))).toBe(true);
    expect(isValidPcm16Input(new ArrayBuffer(0))).toBe(false);
    expect(isValidPcm16Input(new ArrayBuffer(3))).toBe(false);
    expect(isValidPcm16Input(new ArrayBuffer(MAX_INPUT_PCM_BYTES))).toBe(true);
    expect(isValidPcm16Input(new ArrayBuffer(MAX_INPUT_PCM_BYTES + 2))).toBe(false);
  });

  it("bounds reconnect delay and gives a deterministic resume prompt", () => {
    expect(liveReconnectDelayMs(1, 350)).toBe(350);
    expect(liveReconnectDelayMs(99, 350)).toBe(1_400);
    const turn = geminiReconnectTurn("Assess the airway", 2, 6).turns;
    expect(turn).toContain("persisted 2 of 6");
    expect(turn).toContain("already heard the persisted case");
    expect(turn).not.toContain("readiness");
    expect(turn).toContain("Speak only the single pending clinical question once");
    expect(turn).toContain(
      "<PENDING_CLINICAL_QUESTION>Assess the airway</PENDING_CLINICAL_QUESTION>",
    );
    expect(turn).toContain("Do not repeat or summarize the case");
  });

  it("allows real-time PCM jitter but rejects a one-second audio flood", () => {
    const guard = new PcmInputRateGuard();
    const frameBytes = 4_800;
    const startedAt = 1_000;
    const acceptedFrames = Math.floor(MAX_INPUT_PCM_BYTES_PER_SECOND / frameBytes);
    for (let index = 0; index < acceptedFrames; index += 1) {
      expect(guard.accept(frameBytes, startedAt + index)).toBe(true);
    }
    expect(guard.accept(frameBytes, startedAt + acceptedFrames)).toBe(false);
    expect(guard.accept(frameBytes, startedAt + 1_001)).toBe(true);
  });

  it("bounds incremental transcripts and provider audio before decoding", () => {
    expect(appendBoundedTranscript("abcd", "efgh", 6)).toBe("abcd e");
    expect(appendBoundedTranscript("Here is", "your case.")).toBe("Here is your case.");
    expect(appendBoundedTranscript("Here is your case", ".")).toBe("Here is your case.");
    expect(appendBoundedTranscript("abcdef", "ignored", 6)).toBe("abcdef");
    expect(isBoundedProviderAudio("AA==")).toBe(true);
    expect(isBoundedProviderAudio("")).toBe(false);
    expect(isBoundedProviderAudio("A".repeat(512 * 1024 + 1))).toBe(false);
  });
});
