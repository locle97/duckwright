// The global config: flat `key: value` lines in the user's duckwright.conf, read once at startup.
// Built-in defaults < config < task-file settings < flags on the command line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePath } from "./paths.ts";
import { KEYS, TaskFileError, parseSettings } from "./taskfile.ts";
import type { Kind, TaskSettings } from "./taskfile.ts";
import type { ThemeName } from "./tui/theme.ts";

export const CONFIG_NAME = "duckwright.conf";

/**
 * The user's config folder: %APPDATA%\\duckwright on Windows, otherwise
 * $XDG_CONFIG_HOME/duckwright, falling back to ~/.config/duckwright.
 */
export function configDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "duckwright");
  }
  return path.posix.join(env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config"), "duckwright");
}

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
 * `state`, `env`) are resolved from the folder holding the file. Errors name the file and line.
 */
export function loadConfig(dir: string = configDir()): GlobalConfig {
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

/** What `duckwright init` writes: every key commented out at its built-in default. */
export const DEFAULT_CONFIG = `# Global defaults for every run, read at startup from ~/.config/duckwright/duckwright.conf (Windows: %APPDATA%\\duckwright\\duckwright.conf).
# Order: built-in defaults < this file < a task file's front matter < command-line flags.
# Same keys as a task file's front matter, plus the TUI and web options at the end.
# Relative paths (skill, state, env) are resolved from the folder holding this file.
# allow-file-access is not allowed here; pass it on the command line.

# model: sonnet
# max-steps: 25
# headed: false
# skill: ../prompts/playwright-cli.md
# session: duckwright
# state: auth.json
# network: true
# video: false
# screenshot: false
# twofa-timeout: 300
# snapshot: hybrid
# jev: false
# jev-threshold: 0.8
# env: staging

# max-parallel: 3
# past: 20
# theme: auto
`;

/** Write the default config to `dir` unless it is already there; returns the file and whether it was created. */
export function initConfig(dir: string = configDir()): { file: string; created: boolean } {
  const file = path.join(dir, CONFIG_NAME);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, DEFAULT_CONFIG, { flag: "wx" });
    return { file, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { file, created: false };
    throw e;
  }
}
