import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SNAPSHOT_MODES } from "./observe.ts";
import type { SnapshotMode } from "./observe.ts";
import { resolvePath } from "./paths.ts";
import { compareCodePoints } from "./text.ts";

export type TaskSettings = Partial<{
  maxSteps: number;
  model: string;
  headed: boolean;
  skill: string;
  session: string;
  state: string;
  export: boolean;
  network: boolean;
  twofaTimeout: number;
  snapshot: SnapshotMode;
}>;

type Kind = "int" | "str" | "bool" | "path" | "snapshot";

// Front-matter key -> (setting, kind). allow-file-access is deliberately absent:
// a shared task file must not be able to grant the browser unrestricted file access.
export const KEYS: Readonly<Record<string, readonly [keyof TaskSettings, Kind]>> = {
  "max-steps": ["maxSteps", "int"],
  model: ["model", "str"],
  headed: ["headed", "bool"],
  skill: ["skill", "path"],
  session: ["session", "str"],
  state: ["state", "path"],
  export: ["export", "bool"],
  network: ["network", "bool"],
  "twofa-timeout": ["twofaTimeout", "int"],
  snapshot: ["snapshot", "snapshot"],
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
  task: string;
  settings: TaskSettings;
  baseDir: string;
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
    return n;
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
  key: "max-steps" | "model" | "headed" | "export" | "snapshot", raw: string,
): string | number | boolean {
  try {
    if (!raw) throw new LineError(`"${key}" has no value`);
    return convert(key, KEYS[key][1], raw, "");
  } catch (e) {
    if (e instanceof LineError) throw new TaskFileError(e.message);
    throw e;
  }
}

function parseSettings(lines: [number, string][], baseDir: string, where: string): TaskSettings {
  const settings: Record<string, unknown> = {};
  for (const [n, line] of lines) {
    try {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) continue;
      const colon = line.indexOf(":");
      const key = colon === -1 ? line.trim() : line.slice(0, colon).trim();
      if (colon === -1 || !key) throw new LineError('expected "key: value"');
      if (key === "allow-file-access") throw new LineError("allow-file-access must be passed on the command line");
      if (!Object.hasOwn(KEYS, key)) throw new LineError(`unknown setting "${key}"`);
      const [dest, kind] = KEYS[key];
      if (dest in settings) throw new LineError(`"${key}" is set twice`);
      const v = value(line.slice(colon + 1));
      if (!v) throw new LineError(`"${key}" has no value`);
      settings[dest] = convert(key, kind, v, baseDir);
    } catch (e) {
      if (e instanceof LineError) throw new TaskFileError(`${where}:${n}: ${e.message}`);
      throw e;
    }
  }
  return settings as TaskSettings;
}

/**
 * Read a task file: optional `---` front matter of flat settings, then the task text.
 * Errors name `p` as given, so pass the user's string to keep it as typed.
 */
export function loadTaskFile(p: string): TaskFile {
  let text: string;
  try {
    // fatal: invalid UTF-8 is an error, as in Python; a leading BOM is dropped.
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new TaskFileError(`${p}: file not found`);
    throw new TaskFileError(`${p}: cannot read: ${(e as Error).message}`);
  }
  const baseDir = resolvePath(path.dirname(path.resolve(p)));
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let settings: TaskSettings = {};
  let body = lines;
  if (lines[0].trimEnd() === FENCE) {
    const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === FENCE);
    if (close === -1) throw new TaskFileError(`${p}: front matter is not closed with ---`);
    settings = parseSettings(
      lines.slice(1, close).map((l, i): [number, string] => [i + 2, l]), baseDir, p,
    );
    body = lines.slice(close + 1);
  }
  const task = body.join("\n").trim();
  if (!task) throw new TaskFileError(`${p}: no task text`);
  return { task, settings, baseDir };
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
