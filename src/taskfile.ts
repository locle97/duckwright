import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENV_NONE, isEnvName, isEnvPath } from "./environment.ts";
import { SNAPSHOT_MODES } from "./observe.ts";
import type { SnapshotMode } from "./observe.ts";
import { resolvePath } from "./paths.ts";
import { compareCodePoints } from "./text.ts";
import { THEME_NAMES } from "./tui/theme.ts";
import { MAX_TWOFA_TIMEOUT_SEC } from "./twofa.ts";

export type TaskSettings = Partial<{
  maxSteps: number;
  model: string;
  headed: boolean;
  skill: string;
  session: string;
  state: string;
  network: boolean;
  video: boolean;
  screenshot: boolean;
  twofaTimeout: number;
  snapshot: SnapshotMode;
  /** "none", an environment name, or an absolute resolved path to an environment file. */
  env: string;
  /** A shared setup file whose text is put before the task; resolved by loadTaskFile, never a run setting. */
  setup: string;
}>;

export type Kind = "int" | "count" | "str" | "bool" | "path" | "snapshot" | "theme" | "env";

// Front-matter key -> (setting, kind). allow-file-access is deliberately absent:
// a shared task file must not be able to grant the browser unrestricted file access.
export const KEYS: Readonly<Record<string, readonly [keyof TaskSettings, Kind]>> = {
  "max-steps": ["maxSteps", "int"],
  model: ["model", "str"],
  headed: ["headed", "bool"],
  skill: ["skill", "path"],
  session: ["session", "str"],
  state: ["state", "path"],
  network: ["network", "bool"],
  video: ["video", "bool"],
  screenshot: ["screenshot", "bool"],
  "twofa-timeout": ["twofaTimeout", "int"],
  snapshot: ["snapshot", "snapshot"],
  env: ["env", "env"],
  setup: ["setup", "path"],
};
const FENCE = "---";
const COMMENT = /\s#/;

export class TaskFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFileError";
  }
}

export interface TaskFile {
  /** The text the agent gets: the setup file's text first when `setup:` names one, then the body. */
  task: string;
  /** Run settings from the front matter (never `setup`). */
  settings: TaskSettings;
  baseDir: string;
  /** The resolved `setup:` file, or null. */
  setup: string | null;
}

/** The task text with a shared setup put first, so every task of a plan starts the same way. */
export function withSetup(setup: string, body: string): string {
  return `Setup (do this first, then the task below):\n${setup}\n\nTask:\n${body}`;
}

function readUtf8(p: string, label: string): string {
  try {
    // fatal: invalid UTF-8 is an error, as in Python; a leading BOM is dropped.
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new TaskFileError(`${label}: file not found`);
    throw new TaskFileError(`${label}: cannot read: ${(e as Error).message}`);
  }
}

/** A problem on one front-matter line; becomes a TaskFileError with its location. */
class LineError extends Error {}

/** `raw` is the text after the colon, unstripped: only whitespace then `#` starts a comment. */
function value(raw: string): string {
  const v = raw.trim();
  if (v[0] === "'" || v[0] === '"') {
    const end = v.indexOf(v[0], 1);
    const rest = end !== -1 ? v.slice(end + 1).trim() : "";
    if (end === -1 || (rest && !rest.startsWith("#"))) throw new LineError("bad quoted value");
    return v.slice(1, end);
  }
  const m = COMMENT.exec(raw);
  return (m ? raw.slice(0, m.index) : raw).trim();
}

function expandUser(v: string): string {
  if (!v.startsWith("~")) return v;
  const slash = v.indexOf("/");
  const name = v.slice(1, slash === -1 ? undefined : slash);
  if (name && name !== os.userInfo().username) throw new LineError(`cannot expand ~${name}`);
  return os.homedir() + (slash === -1 ? "" : v.slice(slash));
}

function convert(key: string, kind: Kind, v: string, baseDir: string): string | number | boolean {
  if (kind === "int") {
    const n = /^[0-9]+$/.test(v) ? Number(v) : 0;
    if (!(n >= 1 && n <= Number.MAX_SAFE_INTEGER)) {
      throw new LineError(`${key} must be a whole number of at least 1, got "${v}"`);
    }
    if (key === "twofa-timeout" && n > MAX_TWOFA_TIMEOUT_SEC) {
      throw new LineError(`${key} must be a whole number of at most ${MAX_TWOFA_TIMEOUT_SEC}, got "${v}"`);
    }
    return n;
  }
  if (kind === "count") {
    if (!/^[0-9]+$/.test(v) || !Number.isSafeInteger(Number(v))) {
      throw new LineError(`${key} must be a whole number of at least 0, got "${v}"`);
    }
    return Number(v);
  }
  if (kind === "theme") {
    if (!(THEME_NAMES as readonly string[]).includes(v)) {
      throw new LineError(`${key} must be ${THEME_NAMES.join(", ")}, got "${v}"`);
    }
    return v;
  }
  if (kind === "bool") {
    if (v !== "true" && v !== "false") throw new LineError(`${key} must be true or false, got "${v}"`);
    return v === "true";
  }
  if (kind === "snapshot") {
    if (!(SNAPSHOT_MODES as readonly string[]).includes(v)) {
      throw new LineError(`${key} must be full, grep or hybrid, got "${v}"`);
    }
    return v;
  }
  if (kind === "env") {
    if (v === ENV_NONE) return ENV_NONE;
    if (isEnvName(v)) return v;
    if (!isEnvPath(v)) {
      throw new LineError(`env must be an environment name (letters, digits, ".", "_", "-") or a path, got "${v}"`);
    }
    try {
      if (v.includes("\0")) throw new LineError("embedded null byte");
      return resolvePath(path.resolve(baseDir, expandUser(v)));
    } catch (e) {
      throw new LineError(`env is not a usable path: ${(e as Error).message}`);
    }
  }
  if (kind === "path") {
    try {
      if (v.includes("\0")) throw new LineError("embedded null byte");
      return resolvePath(path.resolve(baseDir, expandUser(v)));
    } catch (e) {
      throw new LineError(`${key} is not a usable path: ${(e as Error).message}`);
    }
  }
  return v;
}

/**
 * Validate one value for a front-matter key outside a file (the TUI settings form).
 * Throws TaskFileError with the front-matter message, minus the file and line prefix.
 */
export function settingValue(
  key: "max-steps" | "model" | "headed" | "snapshot" | "video" | "screenshot", raw: string,
): string | number | boolean {
  try {
    if (!raw) throw new LineError(`"${key}" has no value`);
    return convert(key, KEYS[key][1], raw, "");
  } catch (e) {
    if (e instanceof LineError) throw new TaskFileError(e.message);
    throw e;
  }
}

/** Parse flat `key: value` lines against the `keys` table into settings; `where` names the file in errors. */
export function parseSettings(
  lines: [number, string][], baseDir: string, where: string,
  keys: Readonly<Record<string, readonly [string, Kind]>> = KEYS,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [n, line] of lines) {
    try {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) continue;
      const colon = line.indexOf(":");
      const key = colon === -1 ? line.trim() : line.slice(0, colon).trim();
      if (colon === -1 || !key) throw new LineError('expected "key: value"');
      if (key === "allow-file-access") throw new LineError("allow-file-access must be passed on the command line");
      if (!Object.hasOwn(keys, key)) throw new LineError(`unknown setting "${key}"`);
      const [dest, kind] = keys[key];
      if (dest in settings) throw new LineError(`"${key}" is set twice`);
      const v = value(line.slice(colon + 1));
      if (!v) throw new LineError(`"${key}" has no value`);
      settings[dest] = convert(key, kind, v, baseDir);
    } catch (e) {
      if (e instanceof LineError) throw new TaskFileError(`${where}:${n}: ${e.message}`);
      throw e;
    }
  }
  return settings;
}

/**
 * Read a task file: optional `---` front matter of flat settings, then the task text.
 * Errors name `p` as given, so pass the user's string to keep it as typed.
 */
export function loadTaskFile(p: string): TaskFile {
  const text = readUtf8(p, p);
  const baseDir = resolvePath(path.dirname(path.resolve(p)));
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let settings: TaskSettings = {};
  let body = lines;
  if (lines[0].trimEnd() === FENCE) {
    const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === FENCE);
    if (close === -1) throw new TaskFileError(`${p}: front matter is not closed with ---`);
    settings = parseSettings(
      lines.slice(1, close).map((l, i): [number, string] => [i + 2, l]), baseDir, p,
    ) as TaskSettings;
    body = lines.slice(close + 1);
  }
  const task = body.join("\n").trim();
  if (!task) throw new TaskFileError(`${p}: no task text`);
  const { setup, ...rest } = settings;
  if (setup === undefined) return { task, settings: rest, baseDir, setup: null };
  const shared = readUtf8(setup, `${p}: setup ${setup}`).replaceAll("\r\n", "\n").trim();
  if (!shared) throw new TaskFileError(`${p}: setup ${setup} is empty`);
  return { task: withSetup(shared, task), settings: rest, baseDir, setup };
}

export const TASK_SUFFIXES = [".md", ".txt"];

function is(check: (s: fs.Stats) => boolean, p: string): boolean {
  try {
    return check(fs.statSync(p));
  } catch {
    // too long a name, no permission: leave it for loadTaskFile to report
    return false;
  }
}

/** The root-level, non-hidden .md/.txt files of folder `arg`, sorted, named under `arg` as typed. */
function taskFilesIn(arg: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(arg).sort(compareCodePoints);
  } catch (e) {
    throw new TaskFileError(`${arg}: cannot read: ${(e as Error).message}`);
  }
  const names = entries.filter((n) =>
    !n.startsWith(".") && TASK_SUFFIXES.includes(path.extname(n).toLowerCase())
    && is((s) => s.isFile(), path.join(arg, n)));
  if (!names.length) throw new TaskFileError(`${arg}: no task files (.md or .txt)`);
  const prefix = arg.endsWith("/") || arg.endsWith(path.sep) ? arg : arg + path.sep;
  return names.map((n) => prefix + n);
}

/**
 * Each folder in `paths` replaced by its task files, or by its error, in command-line order.
 * A file reached twice is kept once. Other paths, missing ones included, are kept as typed
 * for loadTaskFile to report.
 */
export function taskPaths(paths: string[]): (string | TaskFileError)[] {
  const out: (string | TaskFileError)[] = [];
  const seen = new Set<string>();
  for (const arg of paths) {
    let found: string[];
    try {
      found = is((s) => s.isDirectory(), arg) ? taskFilesIn(arg) : [arg];
    } catch (e) {
      if (!(e instanceof TaskFileError)) throw e;
      out.push(e);
      continue;
    }
    for (const p of found) {
      const key = resolvePath(p);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

/** Like taskPaths, but throws the first folder error. */
export function expandTaskPaths(paths: string[]): string[] {
  const out = taskPaths(paths);
  for (const p of out) if (p instanceof TaskFileError) throw p;
  return out as string[];
}
