#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WebSocket from "ws";

import { interviewerSettings } from "./interviewer-settings.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sampleRate = 24_000;
const pcmFrameBytes = 960;
const frameDurationMs = 20;
// The opening (vignette, readiness question, first clinical question) is many
// seconds of speech. Anything materially below this means audio never played.
const MINIMUM_OPENING_AUDIO_BYTES = 240_000; // ~5 s at 24 kHz mono 16-bit
// Silent opening turns Gemini emits before it will speak the vignette.
const MAX_SILENT_OPENING_TURNS = 2;

/** Throws with machine-readable context so a failure explains itself. */
function assert(condition, message, context) {
  if (condition) return;
  throw new Error(`${message} :: ${JSON.stringify(context)}`);
}

const defaultAnswers = [
  [
    "I would begin with a structured history, pain assessment, medical review, developmental assessment, and focused examination.",
    "I would identify urgent safety concerns, form a differential diagnosis, and explain what additional records or imaging are necessary.",
  ],
  [
    "I would prioritize disease control and the least restrictive approach that can safely accomplish the necessary treatment.",
    "I would discuss reasonable alternatives, risks, expected benefits, and informed consent with the parent or guardian.",
  ],
  [
    "My treatment choice would account for age, dentition, prognosis, cooperation, medical factors, and the family's ability to follow the plan.",
    "I would defend the preferred option while describing when a different treatment or specialist referral would be appropriate.",
  ],
  [
    "I would communicate in developmentally appropriate language, use teach back, and document the decision making and consent discussion.",
    "I would adapt the appointment and monitoring plan to the child's individual needs without compromising safety.",
  ],
  [
    "I would anticipate complications, define the warning signs that require urgent reassessment, and provide clear postoperative instructions.",
    "Follow up would be timed to reassess symptoms, healing, function, behavior, and whether the treatment objectives were achieved.",
  ],
  [
    "Before concluding, I would confirm that the diagnosis and plan remain consistent with every finding revealed during the case.",
    "I would coordinate referrals when needed, document the outcome, and give the family a specific safety net and recall plan.",
  ],
];

function usage() {
  console.log(`Usage: npm run simulate:interview -- [options]

Options:
  --topic <id>       Topic id sent to the examiner (default: behavior_guidance)
  --turns <0-6>      Number of candidate answers to simulate; 0 tests readiness only (default: 6)
  --pause-ms <ms>    Thinking pause between answer halves (default: 2000)
  --commit-delay-ms <ms>  Silence after an answer before explicit commit (default: 500)
  --cafe-noise-percent <0-40>  Mix synthesized background chatter into input
  --voice <name>     macOS system voice used by say (default: Samantha)
  --rate <wpm>       Speech rate passed to say (default: 175)
  --timeout-ms <ms>  Whole-session timeout (default: 600000)
  --max-follow-ups <n>  Probes answered per question before failing (default: 4)
  --help             Show this help

The script reads INTERVIEWER_WS_URL and DEVICE_TOKEN when both are set.
Otherwise it reads the firmware interviewer_config.h without printing secrets.`);
}

function parseArguments(argv) {
  const options = {
    topic: "behavior_guidance",
    turns: 6,
    pauseMs: 2_000,
    commitDelayMs: 500,
    cafeNoisePercent: 0,
    voice: "Samantha",
    rate: 175,
    timeoutMs: 600_000,
    // The worker forces the exchange to advance after four probes; a fifth
    // means that enforcement is broken and the exam would never reach six.
    maxFollowUps: 4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    if (argument === "--topic") options.topic = value;
    else if (argument === "--turns") options.turns = Number(value);
    else if (argument === "--pause-ms") options.pauseMs = Number(value);
    else if (argument === "--commit-delay-ms") options.commitDelayMs = Number(value);
    else if (argument === "--max-follow-ups") options.maxFollowUps = Number(value);
    else if (argument === "--cafe-noise-percent") options.cafeNoisePercent = Number(value);
    else if (argument === "--voice") options.voice = value;
    else if (argument === "--rate") options.rate = Number(value);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.turns) || options.turns < 0 || options.turns > 6) {
    throw new Error("--turns must be an integer from 0 through 6");
  }
  if (!Number.isFinite(options.pauseMs) || options.pauseMs < 0) {
    throw new Error("--pause-ms must be zero or greater");
  }
  if (!Number.isFinite(options.commitDelayMs) || options.commitDelayMs < 0) {
    throw new Error("--commit-delay-ms must be zero or greater");
  }
  if (
    !Number.isFinite(options.cafeNoisePercent) ||
    options.cafeNoisePercent < 0 ||
    options.cafeNoisePercent > 40
  ) {
    throw new Error("--cafe-noise-percent must be between 0 and 40");
  }
  if (!Number.isFinite(options.rate) || options.rate < 80 || options.rate > 450) {
    throw new Error("--rate must be between 80 and 450 words per minute");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 30_000) {
    throw new Error("--timeout-ms must be at least 30000");
  }
  return options;
}

function sessionUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `/agents/pediatric-interviewer/esp32-${crypto.randomBytes(4).toString("hex")}`;
  return url.toString();
}

function wavPcm(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    if (chunk === "data") return buffer.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length & 1);
  }
  throw new Error("Generated WAV file has no PCM data chunk");
}

async function synthesizeAnswers(options, temporaryDirectory) {
  const answers = [];
  for (let answerIndex = 0; answerIndex < options.turns; answerIndex += 1) {
    const parts = [];
    for (let partIndex = 0; partIndex < 2; partIndex += 1) {
      const base = path.join(temporaryDirectory, `answer-${answerIndex + 1}-${partIndex + 1}`);
      const aiff = `${base}.aiff`;
      const wav = `${base}.wav`;
      await execFileAsync("say", [
        "-v",
        options.voice,
        "-r",
        String(options.rate),
        "-o",
        aiff,
        defaultAnswers[answerIndex][partIndex],
      ]);
      await execFileAsync("afconvert", [
        "-f",
        "WAVE",
        "-d",
        `LEI16@${sampleRate}`,
        "-c",
        "1",
        aiff,
        wav,
      ]);
      parts.push(wavPcm(fs.readFileSync(wav)));
    }
    answers.push(parts);
  }
  return answers;
}

// Elaborations for examiner probes. They are deliberately generic: the point
// is to keep the exam moving and exercise the follow-up path, not to model a
// strong candidate. Reused in order, then the last one repeats.
const followUpAnswers = [
  "To be specific, I would commit to that plan for this child, and I would explain the risks, benefits, and alternatives to the parent before starting, and confirm consent.",
  "For safety I would review the medical history and contraindications first, monitor throughout, and I would review the patient afterward and escalate if the situation changed.",
];

async function synthesizeFollowUps(options, temporaryDirectory) {
  const parts = [];
  for (const [index, line] of followUpAnswers.entries()) {
    const base = path.join(temporaryDirectory, `follow-up-${index + 1}`);
    const aiff = `${base}.aiff`;
    const wav = `${base}.wav`;
    await execFileAsync("say", [
      "-v",
      options.voice,
      "-r",
      String(options.rate),
      "-o",
      aiff,
      line,
    ]);
    await execFileAsync("afconvert", [
      "-f",
      "WAVE",
      "-d",
      `LEI16@${sampleRate}`,
      "-c",
      "1",
      aiff,
      wav,
    ]);
    parts.push(wavPcm(fs.readFileSync(wav)));
  }
  return parts;
}

async function synthesizeReadiness(options, temporaryDirectory) {
  const aiff = path.join(temporaryDirectory, "readiness.aiff");
  const wav = path.join(temporaryDirectory, "readiness.wav");
  await execFileAsync("say", [
    "-v",
    options.voice,
    "-r",
    String(options.rate),
    "-o",
    aiff,
    "Yes, I am ready to begin.",
  ]);
  await execFileAsync("afconvert", [
    "-f",
    "WAVE",
    "-d",
    `LEI16@${sampleRate}`,
    "-c",
    "1",
    aiff,
    wav,
  ]);
  return wavPcm(fs.readFileSync(wav));
}

async function synthesizeCafeNoise(options, temporaryDirectory) {
  if (options.cafeNoisePercent === 0) return null;
  const aiff = path.join(temporaryDirectory, "cafe-chatter.aiff");
  const wav = path.join(temporaryDirectory, "cafe-chatter.wav");
  await execFileAsync("say", [
    "-v",
    "Alex",
    "-r",
    "205",
    "-o",
    aiff,
    "Could we get two coffees please? Yes, the table by the window is open. I will bring the cups and a glass of water.",
  ]);
  await execFileAsync("afconvert", [
    "-f",
    "WAVE",
    "-d",
    `LEI16@${sampleRate}`,
    "-c",
    "1",
    aiff,
    wav,
  ]);
  return wavPcm(fs.readFileSync(wav));
}

function mixBackground(pcm, background, percent, backgroundOffset) {
  if (!background || percent <= 0) return { pcm, backgroundOffset };
  const mixed = Buffer.allocUnsafe(pcm.length);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const speech = pcm.readInt16LE(offset);
    const noiseOffset = backgroundOffset % background.length;
    const alignedNoiseOffset = noiseOffset - (noiseOffset % 2);
    const noise = background.readInt16LE(alignedNoiseOffset);
    const value = Math.max(-32_768, Math.min(32_767, speech + Math.round((noise * percent) / 100)));
    mixed.writeInt16LE(value, offset);
    backgroundOffset = (backgroundOffset + 2) % background.length;
  }
  return { pcm: mixed, backgroundOffset };
}

function silence(durationMs) {
  return Buffer.alloc(Math.ceil(durationMs / frameDurationMs) * pcmFrameBytes);
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function simulate(options, answers, followUps, readiness, settings, cafeNoise) {
  const startedAt = Date.now();
  const log = (event, details = {}) => {
    console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, event, ...details }));
  };
  const socket = new WebSocket(sessionUrl(settings.baseUrl), {
    headers: { "X-Device-Token": settings.token },
  });
  let questionNumber = 0;
  let phase = "idle";
  let answersStarted = 0;
  // Probes the examiner asked on the question currently open, and across the
  // whole run. The examiner prompt caps probes at two per skillset.
  let followUpsOnCurrentQuestion = 0;
  const followUpsPerQuestion = [];
  let candidateStreaming = false;
  let stopCandidateAudio = false;
  let finished = false;
  let backgroundOffset = 0;
  let commitsSent = 0;
  let prematureStops = 0;
  let report = null;
  const candidateTranscripts = [];
  const readinessTranscripts = [];
  const turnCompletions = [];
  let readinessSent = false;
  let firstQuestionReceived = false;
  let readinessOnlyComplete = false;
  let readinessCompletionTarget = 0;
  const openingTurns = [];
  let firstQuestionTurn = null;
  let outputAudioFrames = 0;
  let outputAudioBytes = 0;
  let maximumOutputFrameBytes = 0;
  let oddOutputFrames = 0;
  let turnOutputAudioBytes = 0;
  let turnOutputAudioPeak = 0;
  let turnOutputNonzeroSamples = 0;
  let resolveRun;
  let rejectRun;
  const run = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    const summary = {
      ...result,
      commitsSent,
      prematureStops,
      followUps: {
        total: followUpsPerQuestion.reduce((sum, count) => sum + count, followUpsOnCurrentQuestion),
        perQuestion: [...followUpsPerQuestion, followUpsOnCurrentQuestion].slice(1),
      },
      candidateTranscripts,
      readinessTranscripts,
      openingTurns,
      firstQuestionTurn,
      turnCompletions,
      report,
      outputAudio: {
        frames: outputAudioFrames,
        bytes: outputAudioBytes,
        maximumFrameBytes: maximumOutputFrameBytes,
        oddFrames: oddOutputFrames,
      },
    };
    log("simulation_complete", summary);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "end_call" }));
      socket.close();
    }
    resolveRun(summary);
  };

  const sendPcm = async (pcm) => {
    for (let offset = 0; offset < pcm.length; offset += pcmFrameBytes) {
      if (stopCandidateAudio || socket.readyState !== WebSocket.OPEN) return;
      const frame = pcm.subarray(offset, Math.min(offset + pcmFrameBytes, pcm.length));
      const mixed = mixBackground(frame, cafeNoise, options.cafeNoisePercent, backgroundOffset);
      backgroundOffset = mixed.backgroundOffset;
      socket.send(mixed.pcm);
      await wait(frameDurationMs);
    }
  };

  const sendAnswer = async (answerIndex) => {
    candidateStreaming = true;
    stopCandidateAudio = false;
    log("candidate_answer_started", {
      answer: answerIndex + 1,
      questionNumber,
      pauseMs: options.pauseMs,
    });
    await sendPcm(answers[answerIndex][0]);
    log("candidate_thinking_pause_started", { answer: answerIndex + 1 });
    await sendPcm(silence(options.pauseMs));
    if (!stopCandidateAudio) await sendPcm(answers[answerIndex][1]);
    if (!stopCandidateAudio) {
      log("candidate_answer_finished", { answer: answerIndex + 1 });
      await sendPcm(silence(options.commitDelayMs));
    }
    if (!stopCandidateAudio && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "commit_turn" }));
      commitsSent += 1;
      log("candidate_turn_committed", { answer: answerIndex + 1 });
    }
    candidateStreaming = false;
  };

  /** Answers an examiner probe: one utterance, then commit. */
  const sendFollowUp = async () => {
    candidateStreaming = true;
    stopCandidateAudio = false;
    const index = Math.min(followUpsOnCurrentQuestion, followUps.length - 1);
    followUpsOnCurrentQuestion += 1;
    log("candidate_follow_up_started", {
      question: questionNumber,
      followUp: followUpsOnCurrentQuestion,
    });
    await sendPcm(followUps[index]);
    if (!stopCandidateAudio) await sendPcm(silence(options.commitDelayMs));
    if (!stopCandidateAudio && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "commit_turn" }));
      commitsSent += 1;
      log("candidate_follow_up_committed", {
        question: questionNumber,
        followUp: followUpsOnCurrentQuestion,
      });
    }
    candidateStreaming = false;
  };

  const sendReadiness = async () => {
    candidateStreaming = true;
    stopCandidateAudio = false;
    readinessSent = true;
    log("candidate_readiness_started");
    await sendPcm(readiness);
    if (!stopCandidateAudio) await sendPcm(silence(options.commitDelayMs));
    if (!stopCandidateAudio && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "commit_turn" }));
      log("candidate_readiness_committed");
    }
    candidateStreaming = false;
  };

  const maybeStartAnswer = () => {
    if (finished || candidateStreaming || phase !== "interviewing") return;
    // The examiner probed instead of advancing: the question number has not
    // moved even though this answer is already in. Answer the probe, otherwise
    // both sides wait for each other until the run times out.
    if (answersStarted > 0 && questionNumber === answersStarted) {
      assert(
        followUpsOnCurrentQuestion < options.maxFollowUps,
        "Examiner exceeded the follow-up cap on one question; the prompt allows four probes per skillset",
        {
          question: questionNumber,
          followUps: followUpsOnCurrentQuestion,
          maxFollowUps: options.maxFollowUps,
        },
      );
      void sendFollowUp().catch(rejectRun);
      return;
    }
    if (questionNumber !== answersStarted + 1) return;
    if (answersStarted >= options.turns) {
      finish({ answersSimulated: answersStarted, stoppedBeforeQuestion: questionNumber });
      return;
    }
    const answerIndex = answersStarted;
    answersStarted += 1;
    // The previous question closed; start counting probes again.
    followUpsPerQuestion.push(followUpsOnCurrentQuestion);
    followUpsOnCurrentQuestion = 0;
    void sendAnswer(answerIndex).catch(rejectRun);
  };

  const handleListening = () => {
    if (!readinessSent) {
      void sendReadiness().catch(rejectRun);
      return;
    }
    if (!firstQuestionReceived) return;
    if (options.turns === 0) {
      readinessOnlyComplete = true;
      readinessCompletionTarget = turnCompletions.length + 1;
      return;
    }
    maybeStartAnswer();
  };

  const deadline = setTimeout(() => {
    log("simulation_timeout", { phase, questionNumber, answersStarted });
    socket.close();
    rejectRun(new Error(`Simulation timed out after ${options.timeoutMs} ms`));
  }, options.timeoutMs);

  socket.on("open", () => {
    log("websocket_open");
    socket.send(JSON.stringify({ type: "hello", protocol_version: 1 }));
    socket.send(
      JSON.stringify({
        type: "start_call",
        preferred_format: "pcm16",
        topic_id: options.topic,
      }),
    );
  });
  socket.on("message", (data, binary) => {
    if (binary) {
      outputAudioFrames += 1;
      outputAudioBytes += data.length;
      turnOutputAudioBytes += data.length;
      maximumOutputFrameBytes = Math.max(maximumOutputFrameBytes, data.length);
      if (data.length % 2 !== 0) oddOutputFrames += 1;
      for (let offset = 0; offset + 1 < data.length; offset += 2) {
        const sample = data.readInt16LE(offset);
        if (sample !== 0) turnOutputNonzeroSamples += 1;
        turnOutputAudioPeak = Math.max(turnOutputAudioPeak, Math.abs(sample));
      }
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.type === "status") {
      log("status", { status: message.status, questionNumber });
      if (candidateStreaming && (message.status === "thinking" || message.status === "speaking")) {
        stopCandidateAudio = true;
        prematureStops += 1;
        log("candidate_microphone_stopped", {
          answer: answersStarted,
          reason: message.status,
        });
      }
      if (message.status === "listening") handleListening();
      if (message.status === "complete") {
        finish({ answersSimulated: answersStarted, phase: "complete" });
      }
    } else if (message.type === "interview_state") {
      phase = message.phase;
      questionNumber = message.questionNumber;
      log("interview_state", {
        phase,
        questionNumber,
        domain: message.domain,
        question: message.question,
      });
    } else if (message.type === "transcript" && message.role === "user") {
      if (/^yes\b/i.test(message.text.trim())) {
        readinessTranscripts.push(message.text);
        log("candidate_readiness_transcript", { text: message.text });
      } else {
        candidateTranscripts.push(message.text);
        log("candidate_transcript", { text: message.text });
      }
    } else if (message.type === "transcript_end" && message.role === "assistant") {
      const audio = {
        bytes: turnOutputAudioBytes,
        peak: turnOutputAudioPeak,
        nonzeroSamples: turnOutputNonzeroSamples,
      };
      if (!readinessSent) {
        openingTurns.push({ text: message.text, audio });
      } else if (!firstQuestionReceived) {
        firstQuestionReceived = true;
        firstQuestionTurn = { text: message.text, audio };
      }
      log("examiner_transcript", {
        text: message.text,
        audioBytes: turnOutputAudioBytes,
        audioPeak: turnOutputAudioPeak,
        nonzeroSamples: turnOutputNonzeroSamples,
      });
      turnOutputAudioBytes = 0;
      turnOutputAudioPeak = 0;
      turnOutputNonzeroSamples = 0;
    } else if (message.type === "turn_complete") {
      turnCompletions.push({
        answerCount: message.answerCount,
        questionNumber: message.questionNumber,
      });
      log("turn_complete", {
        answerCount: message.answerCount,
        questionNumber: message.questionNumber,
      });
      if (readinessOnlyComplete && turnCompletions.length >= readinessCompletionTarget) {
        finish({ answersSimulated: 0, stoppedBeforeQuestion: questionNumber });
      }
    } else if (message.type === "interview_report") {
      report = {
        reportId: message.reportId,
        outcome: message.outcome,
        reviewPath: message.reviewPath,
      };
      log("interview_report", {
        reportId: message.reportId,
        outcome: message.outcome,
        reviewPath: message.reviewPath,
      });
    } else if (message.type === "error") {
      log("server_error", { message: message.message });
      rejectRun(new Error(message.message));
    }
  });
  socket.on("error", (error) => rejectRun(error));
  socket.on("close", (code, reason) => {
    log("websocket_closed", { code, reason: reason.toString() });
    if (!finished) rejectRun(new Error(`WebSocket closed before completion (${code})`));
  });

  return run;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pediatric-interview-simulator-"),
  );
  try {
    console.log(
      JSON.stringify({
        event: "preparing_simulation",
        topic: options.topic,
        turns: options.turns,
        pauseMs: options.pauseMs,
        voice: options.voice,
      }),
    );
    const [answers, followUps, readiness, settings, cafeNoise] = await Promise.all([
      synthesizeAnswers(options, temporaryDirectory),
      synthesizeFollowUps(options, temporaryDirectory),
      synthesizeReadiness(options, temporaryDirectory),
      interviewerSettings(),
      synthesizeCafeNoise(options, temporaryDirectory),
    ]);
    const result = await simulate(options, answers, followUps, readiness, settings, cafeNoise);
    const openingSummary = result.openingTurns.map((turn, index) => ({
      index,
      audioBytes: turn.audio.bytes,
      audioPeak: turn.audio.peak,
      text: turn.text.slice(0, 90),
    }));
    console.log(
      JSON.stringify({
        event: "opening_summary",
        turns: openingSummary,
        firstQuestionAudioBytes: result.firstQuestionTurn?.audio.bytes ?? 0,
        sessionAudio: result.outputAudio,
        turnCompletions: result.turnCompletions.length,
      }),
    );

    // Gemini answers the first opening prompt with a transcript and no audio;
    // the worker re-prompts it to speak the same text. That silent turn is an
    // expected artifact, so assert on what the candidate actually hears.
    const audibleTurns = result.openingTurns.filter((turn) => turn.audio.bytes > 0);
    const silentTurns = result.openingTurns.length - audibleTurns.length;
    assert(
      audibleTurns.length === 2,
      "Opening must be exactly two audible turns: the case, then the readiness question. " +
        "More than two means one Gemini response advanced the handshake more than once.",
      { audible: audibleTurns.length, silent: silentTurns, turns: openingSummary },
    );
    assert(
      silentTurns <= MAX_SILENT_OPENING_TURNS,
      "Gemini needed more silent retries than expected to speak the opening. " +
        "Above this the candidate waits noticeably before hearing the vignette.",
      { silent: silentTurns, allowed: MAX_SILENT_OPENING_TURNS, turns: openingSummary },
    );

    const [caseTurn, readinessTurn] = audibleTurns;

    assert(/here is your case/i.test(caseTurn.text), 'Opening turn 1 did not say "Here is your case."', {
      text: caseTurn.text.slice(0, 200),
    });
    assert(!caseTurn.text.includes("?"), "Case presentation asked a question before readiness", {
      tail: caseTurn.text.slice(-200),
    });
    assert(
      /^are you ready to begin\?$/i.test(readinessTurn.text.trim()),
      'Opening turn 2 was not exactly "Are you ready to begin?"',
      { text: readinessTurn.text.slice(0, 200) },
    );

    // Gemini reports a turn complete before that turn's audio has finished
    // streaming, so PCM consistently lands in a later bucket than the
    // transcript it belongs to. Per-turn byte counts are therefore not a valid
    // audibility signal; assert the opening was audible in aggregate instead.
    const openingAudioBytes =
      result.openingTurns.reduce((total, turn) => total + turn.audio.bytes, 0) +
      (result.firstQuestionTurn?.audio.bytes ?? 0);
    const openingAudioPeak = Math.max(
      0,
      ...result.openingTurns.map((turn) => turn.audio.peak),
      result.firstQuestionTurn?.audio.peak ?? 0,
    );
    assert(
      openingAudioBytes >= MINIMUM_OPENING_AUDIO_BYTES,
      `Opening delivered less than ${(MINIMUM_OPENING_AUDIO_BYTES / (sampleRate * 2)).toFixed(1)}s ` +
        "of PCM. The vignette was probably never spoken aloud.",
      {
        openingAudioBytes,
        minimum: MINIMUM_OPENING_AUDIO_BYTES,
        approxSeconds: +(openingAudioBytes / (sampleRate * 2)).toFixed(2),
        perTurn: openingSummary.map(({ index, audioBytes }) => ({ index, audioBytes })),
      },
    );
    assert(openingAudioPeak > 0, "Opening PCM was entirely silent", {
      openingAudioPeak,
      openingAudioBytes,
    });

    assert(
      result.readinessTranscripts.some((text) => /^yes\b/i.test(text.trim())),
      "Readiness confirmation was not transcribed",
      { readinessTranscripts: result.readinessTranscripts },
    );
    assert(
      Boolean(result.firstQuestionTurn?.text.includes("?")),
      "Readiness confirmation did not produce the first clinical question",
      { firstQuestionTurn: result.firstQuestionTurn?.text.slice(0, 200) ?? null },
    );
    assert(
      result.turnCompletions.length >= 3,
      "Expected at least three turn completions across the opening handshake",
      { turnCompletions: result.turnCompletions },
    );
    assert(
      result.turnCompletions.every(({ answerCount }) => answerCount === 0),
      "Opening or readiness was incorrectly counted as a clinical answer",
      { turnCompletions: result.turnCompletions },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "simulation_failed", message: error.message }));
  process.exitCode = 1;
});
