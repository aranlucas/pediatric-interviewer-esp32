import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** @typedef {{ path: string, source: string }} ConfigFile */

const toolDirectory = import.meta.dirname;

const defaultConfigPath = path.resolve(
  toolDirectory,
  "../../firmware/angry_cat_pediatric_interviewer/interviewer_config.h",
);

/**
 * @param {string} source
 * @param {string} name
 */
function stringConstant(source, name) {
  const assignment = source.match(
    new RegExp(
      `(?:constexpr\\s+char|const\\s+char)\\s+${name}\\[\\]\\s*=\\s*((?:"(?:\\\\.|[^"\\\\])*"\\s*)+);`,
    ),
  );

  if (!assignment) {
    return null;
  }

  return [...assignment[1].matchAll(/"((?:\\\\.|[^"\\\\])*)"/g)]
    .map((match) => z.string().parse(JSON.parse(`"${match[1]}"`)))
    .join("");
}

/**
 * @param {string} source
 * @param {string} name
 */
function alias(source, name) {
  return source.match(new RegExp(`^#define\\s+${name}\\s+(\\w+)`, "m"))?.[1] ?? null;
}

/**
 * @param {string} source
 * @param {string} configPath
 */
function includes(source, configPath) {
  return [...source.matchAll(/^#include\s+"([^"]+)"/gm)].map((match) =>
    path.resolve(path.dirname(configPath), match[1]),
  );
}

/**
 * @param {string} configPath
 * @param {Set<string>} visited
 * @returns {Promise<ConfigFile[]>}
 */
async function readConfigTree(configPath, visited = new Set()) {
  if (visited.has(configPath)) {
    return [];
  }

  visited.add(configPath);
  const source = await readFile(configPath, "utf8");
  const files = [{ path: configPath, source }];

  for (const includedPath of includes(source, configPath)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- depth-first include order and the shared visited set determine configuration precedence
    files.push(...(await readConfigTree(includedPath, visited)));
  }

  return files;
}

/**
 * @param {ConfigFile[]} files
 * @param {string} name
 * @param {Set<string>} visited
 * @returns {string}
 */
function resolveConstant(files, name, visited = new Set()) {
  if (visited.has(name)) {
    throw new Error(`Circular interviewer configuration alias: ${name}`);
  }

  visited.add(name);

  for (const file of files) {
    const value = stringConstant(file.source, name);

    if (value !== null) {
      return value;
    }
  }

  for (const file of files) {
    const target = alias(file.source, name);

    if (target) {
      return resolveConstant(files, target, visited);
    }
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
