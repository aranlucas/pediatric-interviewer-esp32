import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.resolve(
  toolDirectory,
  "../../firmware/angry_cat_pediatric_interviewer/interviewer_config.h",
);

function stringConstant(source, name) {
  const assignment = source.match(
    new RegExp(
      `(?:constexpr\\s+char|const\\s+char)\\s+${name}\\[\\]\\s*=\\s*((?:"(?:\\\\.|[^"\\\\])*"\\s*)+);`,
    ),
  );
  if (!assignment) return null;
  return [...assignment[1].matchAll(/"((?:\\\\.|[^"\\\\])*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`))
    .join("");
}

function alias(source, name) {
  return source.match(new RegExp(`^#define\\s+${name}\\s+(\\w+)`, "m"))?.[1] ?? null;
}

function includes(source, configPath) {
  return [...source.matchAll(/^#include\s+"([^"]+)"/gm)].map((match) =>
    path.resolve(path.dirname(configPath), match[1]),
  );
}

async function readConfigTree(configPath, visited = new Set()) {
  if (visited.has(configPath)) return [];
  visited.add(configPath);
  const source = await readFile(configPath, "utf8");
  const files = [{ path: configPath, source }];
  for (const includedPath of includes(source, configPath)) {
    files.push(...(await readConfigTree(includedPath, visited)));
  }
  return files;
}

function resolveConstant(files, name) {
  for (const file of files) {
    const value = stringConstant(file.source, name);
    if (value !== null) return value;
  }
  for (const file of files) {
    const target = alias(file.source, name);
    if (target) return resolveConstant(files, target);
  }
  throw new Error(`Could not read ${name} from the interviewer configuration`);
}

export async function interviewerSettings() {
  if (process.env.INTERVIEWER_WS_URL && process.env.DEVICE_TOKEN) {
    return {
      baseUrl: process.env.INTERVIEWER_WS_URL,
      token: process.env.DEVICE_TOKEN,
    };
  }
  if (process.env.INTERVIEWER_WS_URL || process.env.DEVICE_TOKEN) {
    throw new Error("Set both INTERVIEWER_WS_URL and DEVICE_TOKEN, or neither");
  }

  const configPath = process.env.INTERVIEWER_CONFIG_PATH ?? defaultConfigPath;
  const files = await readConfigTree(configPath);
  return {
    baseUrl: resolveConstant(files, "kPediatricInterviewerWebSocketUrl"),
    token: resolveConstant(files, "kPediatricInterviewerDeviceToken"),
  };
}
