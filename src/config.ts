// The global config: flat `key: value` lines in config/duckwright.conf, read once at startup.
// Built-in defaults < config < task-file settings < flags on the command line.
import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "./paths.ts";
import { KEYS, TaskFileError, parseSettings } from "./taskfile.ts";
import type { Kind, TaskSettings } from "./taskfile.ts";
import type { ThemeName } from "./tui/theme.ts";

export const CONFIG_DIR = "config";
export const CONFIG_NAME = "duckwright.conf";

/** Run settings every task starts from, plus the TUI and web options. */
export type GlobalConfig = TaskSettings & Partial<{
  maxParallel: number;
  past: number;
  theme: ThemeName;
}>;

// The task-file keys, minus `setup` (it belongs to one task), plus the TUI and web options.
// allow-file-access stays command-line only, as in task files.
const { setup: _setup, ...RUN_KEYS } = KEYS;
const CONFIG_KEYS: Readonly<Record<string, readonly [string, Kind]>> = {
  ...RUN_KEYS,
  "max-parallel": ["maxParallel", "int"],
  past: ["past", "count"],
  theme: ["theme", "theme"],
};

/**
 * Read `<dir>/duckwright.conf`; no file means no config. Relative paths in it (`skill`,
 * `state`) are resolved from the folder holding the file. Errors name the file and line.
 */
export function loadConfig(dir: string = CONFIG_DIR): GlobalConfig {
  const file = path.join(dir, CONFIG_NAME);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new TaskFileError(`${file}: cannot read: ${(e as Error).message}`);
  }
  const lines = text.replaceAll("\r\n", "\n").split("\n").map((l, i): [number, string] => [i + 1, l]);
  const baseDir = resolvePath(path.dirname(path.resolve(file)));
  return parseSettings(lines, baseDir, file, CONFIG_KEYS) as GlobalConfig;
}

/** The run settings of a config: everything but the TUI and web options. */
export function runSettings(config: GlobalConfig): TaskSettings {
  const { maxParallel: _m, past: _p, theme: _t, ...rest } = config;
  return rest;
}
