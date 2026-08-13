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
const sampleRate = 16_000;
const pcmFrameBytes = 640;
const frameDurationMs = 20;

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
  --turns <1-6>      Number of candidate answers to simulate (default: 6)
  --pause-ms <ms>    Thinking pause between answer halves (default: 2000)
  --commit-delay-ms <ms>  Silence after an answer before explicit commit (default: 500)
  --cafe-noise-percent <0-40>  Mix synthesized background chatter into input
  --voice <name>     macOS system voice used by say (default: Samantha)
  --rate <wpm>       Speech rate passed to say (default: 175)
  --timeout-ms <ms>  Whole-session timeout (default: 300000)
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
    timeoutMs: 300_000,
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
    else if (argument === "--cafe-noise-percent") options.cafeNoisePercent = Number(value);
    else if (argument === "--voice") options.voice = value;
    else if (argument === "--rate") options.rate = Number(value);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.turns) || options.turns < 1 || options.turns > 6) {
    throw new Error("--turns must be an integer from 1 through 6");
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

async function simulate(options, answers, settings, cafeNoise) {
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
  let candidateStreaming = false;
  let stopCandidateAudio = false;
  let finished = false;
  let backgroundOffset = 0;
  let commitsSent = 0;
  let prematureStops = 0;
  let report = null;
  const candidateTranscripts = [];
  let outputAudioFrames = 0;
  let outputAudioBytes = 0;
  let maximumOutputFrameBytes = 0;
  let oddOutputFrames = 0;
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
      candidateTranscripts,
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

  const maybeStartAnswer = () => {
    if (
      finished ||
      candidateStreaming ||
      phase !== "interviewing" ||
      questionNumber !== answersStarted + 1
    ) {
      return;
    }
    if (answersStarted >= options.turns) {
      finish({ answersSimulated: answersStarted, stoppedBeforeQuestion: questionNumber });
      return;
    }
    const answerIndex = answersStarted;
    answersStarted += 1;
    void sendAnswer(answerIndex).catch(rejectRun);
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
      maximumOutputFrameBytes = Math.max(maximumOutputFrameBytes, data.length);
      if (data.length % 2 !== 0) oddOutputFrames += 1;
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
      if (message.status === "listening") maybeStartAnswer();
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
      });
    } else if (message.type === "transcript" && message.role === "user") {
      candidateTranscripts.push(message.text);
      log("candidate_transcript", { text: message.text });
    } else if (message.type === "transcript_end" && message.role === "assistant") {
      log("examiner_transcript", { text: message.text });
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
    const [answers, settings, cafeNoise] = await Promise.all([
      synthesizeAnswers(options, temporaryDirectory),
      interviewerSettings(),
      synthesizeCafeNoise(options, temporaryDirectory),
    ]);
    await simulate(options, answers, settings, cafeNoise);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "simulation_failed", message: error.message }));
  process.exitCode = 1;
});
