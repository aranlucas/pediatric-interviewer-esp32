import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeLine } from "../src/lib";
import {
  DEVICE_GPIO_HEADER_PIN,
  DEVICE_GPIO_PIN,
  parseClientToolResult,
} from "../src/device-tools";
import { airQualityCategory, getCurrentWeather, weatherCondition } from "../src/weather-tools";
import { NOVA_3_QUERY_MODEL, requestedTranscriptionModel } from "../src/voice-config";
import { isRepeatRequest, PEDIATRIC_TOPICS, requestedTopic } from "../src/interview-content";
import {
  buildInterviewMarkdown,
  evaluateInterview,
  interviewEvaluationSchema,
  PRACTICE_SCORE_RUBRIC,
  reportObjectKeys,
  storeInterviewReport,
  type StoredInterviewReport,
} from "../src/interview-report";
import {
  GEMINI_LIVE_MODEL,
  geminiLiveConfig,
  geminiTextTurn,
  TURN_DISPOSITION_TOOL,
} from "../src/gemini-live-protocol";
import { openingPresentationForDisplay, questionForDisplay } from "../src/interview-display";
import { parseInterviewerDeviceMessage } from "../src/interviewer-protocol";
import { resamplePcm16 } from "../src/pcm-audio";

const seattle = { name: "Seattle", latitude: 47.6062, longitude: -122.3321 };

afterEach(() => vi.restoreAllMocks());

describe("Angry Cat server-side tools", () => {
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

  it("accepts only a correlated, bounded client-tool result envelope", () => {
    expect(DEVICE_GPIO_PIN).toBe(21);
    expect(DEVICE_GPIO_HEADER_PIN).toBe(6);
    expect(
      parseClientToolResult(
        JSON.stringify({
          type: "client_tool_result",
          id: "call-1",
          tool: "set_gpio",
          ok: true,
          result: { pin: 21, state: "on", level: 1 },
        }),
      ),
    ).toMatchObject({ id: "call-1", tool: "set_gpio", ok: true });
    expect(parseClientToolResult("not-json")).toBeNull();
    expect(
      parseClientToolResult(
        JSON.stringify({ type: "client_tool_result", tool: "set_gpio", ok: true }),
      ),
    ).toBeNull();
  });

  it("reads the C++ model query used by createTranscriber", () => {
    expect(
      requestedTranscriptionModel("wss://example.com/agents/angry-cat/esp32?model=nova-3"),
    ).toBe(NOVA_3_QUERY_MODEL);
    expect(requestedTranscriptionModel(null)).toBeNull();
  });

  it("maps weather codes into voice-friendly conditions", () => {
    expect(weatherCondition(2)).toBe("Partly cloudy");
    expect(weatherCondition(61)).toBe("Rain");
  });

  it("maps US AQI into the standard category", () => {
    expect(airQualityCategory(48)).toBe("Good");
    expect(airQualityCategory(75)).toBe("Moderate");
    expect(airQualityCategory(175)).toBe("Unhealthy");
  });

  it("fetches and shapes current weather inside the Worker", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        current: {
          time: "2026-08-12T09:30",
          temperature_2m: 63,
          apparent_temperature: 63,
          relative_humidity_2m: 68,
          weather_code: 2,
          wind_speed_10m: 4,
          wind_gusts_10m: 9,
          is_day: 1,
        },
        daily: {
          temperature_2m_max: [74],
          temperature_2m_min: [57],
          precipitation_probability_max: [10],
          uv_index_max: [5],
          sunset: ["2026-08-12T20:22"],
        },
      }),
    );

    await expect(getCurrentWeather(seattle)).resolves.toMatchObject({
      source: "Open-Meteo live server tool",
      location: "Seattle",
      condition: "Partly cloudy",
      temperatureF: 63,
      highF: 74,
      lowF: 57,
    });
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.hostname).toBe("api.open-meteo.com");
    expect(calledUrl.searchParams.get("latitude")).toBe("47.6062");
  });

  it("rejects an incomplete upstream result instead of inventing values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ current: {} }));
    await expect(getCurrentWeather(seattle)).rejects.toThrow("daily weather");
  });

  it("surfaces an upstream HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(getCurrentWeather(seattle)).rejects.toThrow("HTTP 503");
  });

  it("normalizes and bounds model output for the LCD", () => {
    const line = sanitizeLine(
      "“Fine.  The clouds are doing their best, which is apparently not much today, so take a jacket anyway.”",
    );
    expect(line).not.toMatch(/[\r\n“”"]/);
    expect(line.length).toBeLessThanOrEqual(88);
  });

  it("uses a deterministic empty-line response", () => {
    expect(sanitizeLine("\n\t")).toBe("Even the clouds have nothing useful to say.");
  });
});

describe("Pediatric oral-board interviewer", () => {
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
                  enum: ["advance_skillset", "probe_current_answer", "provide_case_information"],
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
    expect(instruction).toContain("Generate a new clinical vignette");
    expect(instruction).toContain("Temperament and cooperation potential");
    expect(instruction).toContain("ask what they would ask the parent, patient, or caregiver");
    expect(instruction).toContain(
      "do not announce the omission, suggest content, or turn the probe into a checklist",
    );
    expect(instruction).toContain(
      "give a brief internally consistent finding and let them continue",
    );
    expect(instruction).toContain(
      "A shallow but complete answer gets one neutral opportunity to elaborate",
    );
    expect(instruction).toContain(
      "ask exactly one focused question with one primary decision target",
    );
    expect(instruction).toContain(
      "reassesses risk, adapts the plan, and explains what would change",
    );
    expect(instruction).toContain("Acknowledgements are optional");
    expect(instruction).toContain(
      "Clarification and case-information turns remain within the current exchange",
    );
    expect(instruction).toContain("Treat unrelated speech as ambient audio");
    expect(instruction).toContain("Never speak disclaimers");
    expect(instruction).toContain(
      "Never name, announce, restate, paraphrase, or introduce the selected topic",
    );
    expect(instruction).toContain("Start the opening vignette with patient information");
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

  it("parses only a known topic-selection command", () => {
    expect(requestedTopic("Start topic: pulp_therapy")?.label).toBe("Pulp Therapy");
    expect(requestedTopic("Start topic: made_up")).toBeNull();
    expect(requestedTopic("Tell me about pulp therapy")).toBeNull();
  });

  it("recognizes repeat requests without treating ordinary answers as repeats", () => {
    expect(isRepeatRequest("Could you repeat the question? ")).toBe(true);
    expect(isRepeatRequest("Please say that again.")).toBe(true);
    expect(isRepeatRequest("I would repeat the radiograph in six months.")).toBe(false);
    expect(isRepeatRequest("I would assess airway and oxygen saturation.")).toBe(false);
  });

  it("requires a six-exchange Oral Boards-compatible evaluation", () => {
    const evaluation = sampleReport().evaluation;
    expect(interviewEvaluationSchema.parse(evaluation).exchanges).toHaveLength(6);
    expect(() =>
      interviewEvaluationSchema.parse({
        ...evaluation,
        exchanges: evaluation.exchanges.slice(0, 5),
      }),
    ).toThrow();
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
