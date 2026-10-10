import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "./paths.ts";
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

export function loadEnvironment(
  value: string,
  cwd = process.cwd(),
): { name: string; path: string; text: string } {
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
  const text = decoded.replaceAll("\r\n", "\n").trim();
  if (!text) throw new EnvError(`environment file is empty: ${p}`);
  return { name, path: p, text };
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
