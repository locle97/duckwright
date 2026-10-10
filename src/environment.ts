import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "./paths.ts";
import { LineError, value as parseValue } from "./taskfile.ts";
import { compareCodePoints } from "./text.ts";

export const ENV_DIR = "environments";
export const ENV_MAX_BYTES = 16384;
export const ENV_NONE = "none";

export class EnvError extends Error {
  override name = "EnvError";
}

/** A value is a path if it contains a separator or ends in `.md` (any case). */
export function isEnvPath(value: string): boolean {
  return value.includes("/") || value.includes(path.sep) || /\.md$/i.test(value);
}

export function isEnvName(value: string): boolean {
  return !isEnvPath(value) && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value);
}

export function envLabel(value: string | null): string | null {
  if (value === null) return null;
  return isEnvPath(value) ? path.basename(value).replace(/\.md$/i, "") : value;
}

export function resolveEnv(value: string, cwd = process.cwd()): { name: string; path: string } {
  const name = envLabel(value) as string;
  if (isEnvPath(value)) return { name, path: resolvePath(path.resolve(cwd, value)) };
  if (isEnvName(value)) return { name, path: resolvePath(path.join(cwd, ENV_DIR, value + ".md")) };
  throw new EnvError(`invalid environment: '${value}'`);
}

export interface LoginCheck { url: string; text: string }
export type LoginConfig =
  | { method: "script"; url: string; usernameSelector: string; passwordSelector: string; submitSelector: string;
      usernameEnv: string; passwordEnv: string; check: LoginCheck | null }
  | { method: "agent"; task: string; usernameEnv: string; passwordEnv: string; check: LoginCheck | null };

const LOGIN_KEYS = [
  "method", "username-env", "password-env", "url", "username-selector", "password-selector",
  "submit-selector", "task", "check-url", "check-text",
];
const SCRIPT_ONLY = ["url", "username-selector", "password-selector", "submit-selector"];
const AGENT_ONLY = ["task"];
const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkLoginValue(key: string, v: string): void {
  if (key === "username-env" || key === "password-env") {
    if (!ENV_VAR.test(v)) {
      throw new LineError(
        `login: ${key} must be an environment variable name (letters, digits and _, not starting with a digit), got "${v}"`,
      );
    }
  } else if (key === "url" || key === "check-url") {
    let ok = false;
    try {
      const proto = new URL(v).protocol;
      ok = proto === "http:" || proto === "https:";
    } catch {
      ok = false;
    }
    if (!ok) throw new LineError(`login: ${key} must be an http or https URL, got "${v}"`);
  }
}

/** Parse the lines between the `---` fences; `first` is the 1-based file line of lines[0]. */
function parseLogin(lines: string[], first: number, p: string): LoginConfig | null {
  const bad = (n: number | null, msg: string) =>
    new EnvError(`environment file invalid: ${p}${n === null ? "" : ":" + n}: ${msg}`);
  const vals = new Map<string, string>();
  const at = new Map<string, number>();
  let opened = false;
  for (let i = 0; i < lines.length; i++) {
    const n = first + i;
    const line = lines[i] as string;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      const colon = line.indexOf(":");
      const indented = /^[ \t]/.test(line);
      if (colon === -1) throw new LineError('expected "key: value"');
      const key = line.slice(0, colon).trim();
      if (!key) throw new LineError('expected "key: value"');
      if (!indented) {
        if (key !== "login") throw new LineError(`unknown key "${key}" (only login is allowed)`);
        if (opened) throw new LineError('login: "login" is set twice');
        if (parseValue(line.slice(colon + 1))) {
          throw new LineError('login: must be followed by indented "key: value" lines');
        }
        opened = true;
        continue;
      }
      if (!opened) throw new LineError(`unknown key "${key}" (only login is allowed)`);
      if (!LOGIN_KEYS.includes(key)) throw new LineError(`login: unknown key "${key}"`);
      if (vals.has(key)) throw new LineError(`login: "${key}" is set twice`);
      const v = parseValue(line.slice(colon + 1));
      if (!v) throw new LineError(`login: "${key}" has no value`);
      if (key === "method" && v !== "script" && v !== "agent") {
        throw new LineError(`login: method must be agent or script, got "${v}"`);
      }
      checkLoginValue(key, v);
      vals.set(key, v);
      at.set(key, n);
    } catch (e) {
      if (e instanceof LineError) throw bad(n, e.message);
      throw e;
    }
  }
  if (!opened) return null;
  const method = vals.get("method");
  if (method !== "script" && method !== "agent") throw bad(null, "login: method is required");
  const [other, own] = method === "script" ? [AGENT_ONLY, SCRIPT_ONLY] : [SCRIPT_ONLY, AGENT_ONLY];
  for (const k of other) {
    if (vals.has(k)) throw bad(at.get(k) as number, `login: ${k} is not used by method ${method}`);
  }
  for (const k of ["username-env", "password-env", ...own]) {
    if (!vals.has(k)) throw bad(null, `login: ${k} is required for method ${method}`);
  }
  const cu = vals.get("check-url");
  const ct = vals.get("check-text");
  if ((cu === undefined) !== (ct === undefined)) {
    throw bad(null, "login: check-url and check-text must be set together");
  }
  const check = cu !== undefined && ct !== undefined ? { url: cu, text: ct } : null;
  const usernameEnv = vals.get("username-env") as string;
  const passwordEnv = vals.get("password-env") as string;
  if (method === "agent") return { method, task: vals.get("task") as string, usernameEnv, passwordEnv, check };
  return {
    method, url: vals.get("url") as string, usernameSelector: vals.get("username-selector") as string,
    passwordSelector: vals.get("password-selector") as string, submitSelector: vals.get("submit-selector") as string,
    usernameEnv, passwordEnv, check,
  };
}

export function loadEnvironment(
  value: string,
  cwd = process.cwd(),
): { name: string; path: string; text: string; login: LoginConfig | null } {
  const { name, path: p } = resolveEnv(value, cwd);
  const cannot = (reason: string) => new EnvError(`environment file cannot be read: ${p}: ${reason}`);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EnvError(`environment file not found: ${p}`);
    }
    throw cannot((e as Error).message);
  }
  if (!st.isFile()) throw cannot("not a file");
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(p);
  } catch (e) {
    throw cannot((e as Error).message);
  }
  if (bytes.length > ENV_MAX_BYTES) {
    throw new EnvError(`environment file too large: ${p} is ${bytes.length} bytes (limit ${ENV_MAX_BYTES})`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw cannot("not valid UTF-8");
  }
  const normalised = decoded.replaceAll("\r\n", "\n");
  let login: LoginConfig | null = null;
  let body = normalised;
  const lines = normalised.split("\n");
  if (/^---[ \t]*$/.test(lines[0] as string)) {
    const close = lines.indexOf("---", 1);
    if (close === -1) throw new EnvError(`environment file invalid: ${p}: front matter is not closed with ---`);
    login = parseLogin(lines.slice(1, close), 2, p);
    body = lines.slice(close + 1).join("\n");
  }
  const text = body.trim();
  if (!text) throw new EnvError(`environment file is empty: ${p}`);
  return { name, path: p, text, login };
}

export function listEnvironments(cwd = process.cwd()): string[] {
  const dir = path.join(cwd, ENV_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const f of entries) {
    if (f.startsWith(".") || !f.endsWith(".md")) continue;
    const stem = f.slice(0, -3);
    if (!isEnvName(stem) || stem === ENV_NONE) continue;
    try {
      if (!fs.statSync(path.join(dir, f)).isFile()) continue;
    } catch {
      continue;
    }
    names.push(stem);
  }
  return names.sort(compareCodePoints);
}
