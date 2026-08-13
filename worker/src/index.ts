import { routeAgentRequest } from "agents";

import { TURN_DISPOSITION_TOOL } from "./gemini-live-protocol";
import { INTERVIEW_QUESTION_COUNT } from "./interview-report";
import {
  DEVICE_SAMPLE_RATE,
  OUTPUT_PCM_FRAME_BYTES,
  PEDIATRIC_TOPICS,
  pediatricInterviewerModels,
} from "./interviewer";

type WorkerEnv = Env & {
  DEVICE_TOKEN: string;
  GEMINI_API_KEY: string;
  INTERVIEW_REPORTS: R2Bucket;
};

const TOKEN_ENCODER = new TextEncoder();
const REPORT_PATH_PREFIX = "/interviewer/reports/";
const REPORT_PATH_PATTERN =
  /^\/interviewer\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(json|md)$/i;

export { PediatricInterviewer } from "./interviewer";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function verifyToken(provided: string | null, expected: string): Promise<boolean> {
  if (!provided || !expected || provided.length > 256) return false;
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", TOKEN_ENCODER.encode(provided)),
    crypto.subtle.digest("SHA-256", TOKEN_ENCODER.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const reportMatch =
      request.method === "GET" && path.startsWith(REPORT_PATH_PREFIX)
        ? REPORT_PATH_PATTERN.exec(path)
        : null;
    if (reportMatch) {
      if (!(await verifyToken(request.headers.get("X-Device-Token"), env.DEVICE_TOKEN))) {
        return json({ error: "unauthorized" }, 401);
      }
      const [, reportId, format] = reportMatch;
      const object = await env.INTERVIEW_REPORTS.get(
        `pediatric-oral-boards/reports/${reportId}.${format}`,
      );
      if (!object) return json({ error: "report_not_found" }, 404);
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="pediatric-oral-boards-${reportId}.${format}"`,
        ETag: object.httpEtag,
      });
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }

    if (request.method === "GET" && (path === "/health" || path === "/interviewer/health")) {
      return json({
        ok: true,
        service: "pediatric-dentistry-interviewer",
        stateful: true,
        streaming: true,
        transport: "persistent-websocket-pcm16",
        endpoint: "/agents/pediatric-interviewer/esp32",
        outputAudioSampleRate: DEVICE_SAMPLE_RATE,
        outputAudioFrameBytes: OUTPUT_PCM_FRAME_BYTES,
        questions: INTERVIEW_QUESTION_COUNT,
        finalStep: "structured-evaluation-to-private-r2",
        tools: [TURN_DISPOSITION_TOOL],
        topics: PEDIATRIC_TOPICS.map(({ id, label, studyMaterial }) => ({
          id,
          label,
          studyMaterial,
        })),
        models: pediatricInterviewerModels,
      });
    }

    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: async (upgradeRequest, lobby) => {
        const supportedDeviceName =
          lobby.name === "esp32" || /^esp32-[0-9a-f]{8}$/.test(lobby.name);
        if (lobby.className !== "PEDIATRIC_INTERVIEWER" || !supportedDeviceName) {
          return new Response("Not found", { status: 404 });
        }
        if (!(await verifyToken(upgradeRequest.headers.get("X-Device-Token"), env.DEVICE_TOKEN))) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
    });
    if (routed) return routed;

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;
