#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { simulatePlaybackBuffer } from "./audio-buffer-model.mjs";
import { interviewerSettings } from "./interviewer-settings.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(toolDirectory);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function normalized(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function runLiveSimulation(name, arguments_) {
  return new Promise((resolve, reject) => {
    console.log(JSON.stringify({ event: "gate_started", gate: name }));
    const child = spawn(
      process.execPath,
      [path.join(toolDirectory, "simulate-interview.mjs"), ...arguments_],
      { cwd: projectDirectory, stdio: ["ignore", "pipe", "pipe"] },
    );
    let pending = "";
    let stderr = "";
    let summary = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.event === "simulation_complete") summary = message;
        } catch {
          // Useful simulator output is JSON; ignore incomplete diagnostic text.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || !summary) {
        reject(new Error(`${name} simulator failed (${code}): ${stderr.trim() || pending.trim()}`));
        return;
      }
      resolve(summary);
    });
  });
}

async function verifyStoredReport(connection, report) {
  requireCondition(report?.reportId, "full interview did not return a report id");
  const url = new URL(connection.baseUrl);
  url.protocol = "https:";
  url.pathname = `/interviewer/reports/${report.reportId}.json`;
  url.search = "";
  const response = await fetch(url, {
    headers: { "X-Device-Token": connection.token },
  });
  requireCondition(response.ok, `stored report fetch returned ${response.status}`);
  return response.json();
}

async function runGate(name, operation) {
  const startedAt = Date.now();
  try {
    const details = await operation();
    const result = {
      gate: name,
      status: "passed",
      durationMs: Date.now() - startedAt,
      details,
    };
    console.log(JSON.stringify({ event: "gate_complete", ...result }));
    return result;
  } catch (error) {
    const result = {
      gate: name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error.message,
    };
    console.error(JSON.stringify({ event: "gate_complete", ...result }));
    return result;
  }
}

async function main() {
  const connection = await interviewerSettings();
  const gates = [];

  gates.push(
    await runGate("two_second_thinking_pause", async () => {
      const result = await runLiveSimulation("two_second_thinking_pause", [
        "--turns",
        "1",
        "--pause-ms",
        "2000",
        "--timeout-ms",
        "150000",
      ]);
      requireCondition(result.commitsSent >= 1, "expected at least one commit");
      requireCondition(result.prematureStops === 0, "answer stopped before explicit commit");
      requireCondition(result.candidateTranscripts.length >= 1, "expected a candidate transcript");
      const transcript = normalized(result.candidateTranscripts[0]);
      requireCondition(
        transcript.includes("differential diagnosis") && transcript.includes("imaging"),
        "second half of the paused answer was not preserved",
      );
      return { transcriptCharacters: result.candidateTranscripts[0].length };
    }),
  );

  gates.push(
    await runGate("four_second_explicit_commit", async () => {
      const result = await runLiveSimulation("four_second_explicit_commit", [
        "--turns",
        "1",
        "--pause-ms",
        "1000",
        "--commit-delay-ms",
        "4000",
        "--timeout-ms",
        "150000",
      ]);
      requireCondition(result.commitsSent >= 1, "expected at least one commit");
      requireCondition(result.prematureStops === 0, "provider ended the turn before commit");
      requireCondition(result.stoppedBeforeQuestion === 2, "interview did not advance once");
      return { commits: result.commitsSent, advancedToQuestion: 2 };
    }),
  );

  gates.push(
    await runGate("cafe_noise_tap_commit", async () => {
      const result = await runLiveSimulation("cafe_noise_tap_commit", [
        "--turns",
        "1",
        "--pause-ms",
        "2000",
        "--cafe-noise-percent",
        "12",
        "--timeout-ms",
        "150000",
      ]);
      requireCondition(result.commitsSent >= 1, "tap-equivalent commit was not sent");
      requireCondition(result.prematureStops === 0, "noise caused a premature stop");
      requireCondition(result.candidateTranscripts[0]?.length > 60, "no usable noisy transcript");
      requireCondition(result.stoppedBeforeQuestion === 2, "noisy answer did not advance");
      return {
        noisePercent: 12,
        transcriptCharacters: result.candidateTranscripts[0].length,
      };
    }),
  );

  gates.push(
    await runGate("playback_350ms_jitter", async () => {
      const model = simulatePlaybackBuffer({ maximumJitterMs: 350 });
      requireCondition(model.passed, "buffer model underrun or overflow");
      requireCondition(model.maximumArrivalGapMs >= 350, "jitter fixture was not applied");
      return model;
    }),
  );

  gates.push(
    await runGate("six_turn_report_to_r2", async () => {
      const result = await runLiveSimulation("six_turn_report_to_r2", [
        "--turns",
        "6",
        "--pause-ms",
        "2000",
        "--rate",
        "230",
        "--timeout-ms",
        "600000",
      ]);
      requireCondition(result.phase === "complete", "interview did not complete");
      requireCondition(result.answersSimulated === 6, "expected six primary answers");
      requireCondition(result.primaryQuestions.length === 6, "expected six primary questions");
      requireCondition(
        result.primaryQuestions.every(
          (question) => !/(?:thank you|review is being prepared|concludes? (?:our|the))/i.test(question),
        ),
        "completion text was used as a primary question",
      );
      requireCondition(result.commitsSent >= 6, "expected at least six commits");
      requireCondition(result.candidateTranscripts.length >= 6, "expected at least six transcripts");
      requireCondition(result.prematureStops === 0, "a candidate answer stopped prematurely");
      requireCondition(result.outputAudio.oddFrames === 0, "received malformed PCM frame");
      const stored = await verifyStoredReport(connection, result.report);
      requireCondition(
        stored.evaluation?.exchanges?.length === 6,
        "stored report lacks six exchanges",
      );
      return {
        reportId: result.report.reportId,
        transcripts: result.candidateTranscripts.length,
        storedExchanges: stored.evaluation.exchanges.length,
        outputAudioFrames: result.outputAudio.frames,
      };
    }),
  );

  const failed = gates.filter(({ status }) => status === "failed");
  const report = {
    generatedAt: new Date().toISOString(),
    scope: {
      live: "deployed Worker, Gemini Live, Durable Object, transcripts, and R2",
      modeled: "ESP32 playback buffer under ordered WebSocket jitter",
      excluded: "analog microphone, codec, power, and RF hardware",
    },
    status: failed.length === 0 ? "passed" : "failed",
    passed: gates.length - failed.length,
    failed: failed.length,
    gates,
  };
  const reportPath = path.join(projectDirectory, "simulation-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ event: "suite_complete", reportPath, ...report }));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "suite_failed", message: error.message }));
  process.exitCode = 1;
});
