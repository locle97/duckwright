import fs from "node:fs";
import path from "node:path";

import { RUN_USAGE, UsageError, parseExportArgs, parseRunArgs } from "./args.ts";
import type { RunArgs } from "./args.ts";
import { ExportError, exportRun } from "./export.ts";
import { Agent } from "./loop.ts";
import type { AgentOptions } from "./loop.ts";
import { resolvePath } from "./paths.ts";
import { attachPlain, printOutcome } from "./report/plain.ts";
import { RunManager } from "./runs/manager.ts";
import type { ManagerLike } from "./runs/manager.ts";
import { loadPastRuns } from "./runs/past.ts";
import type { PastRun } from "./runs/past.ts";
import { PROMPTS, historyJson, startRun } from "./runs/run.ts";
import type { AgentLike, PromptPaths } from "./runs/run.ts";
import { fixed4 } from "./text.ts";
import type { ThemeName } from "./tui/theme.ts";
import { TaskFileError, loadTaskFile, taskPaths } from "./taskfile.ts";

export { PROMPTS, historyJson };
export type { AgentLike, PromptPaths };

export function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** `quit()` closes the TUI as a confirmed quit does: stop every run, then resolve `done`. */
export interface TuiHandle { done: Promise<void>; restoreTerminal(): void; quit(): void }
export interface TuiModule { startTui(o: { manager: ManagerLike; theme?: ThemeName; notices?: string[] }): TuiHandle }

export interface CliDeps {
  which(name: string): string | null;
  createAgent(opts: AgentOptions): AgentLike;
  prompts: PromptPaths;
  stdout(line: string): void;
  stderr(line: string): void;
  signal: AbortSignal;
  isTTY(): boolean;
  loadTui(): Promise<TuiModule>;
  loadPastRuns(limit: number): { runs: PastRun[]; skipped: number };
}

/** The first executable called `name` on PATH, like shutil.which. */
export function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

const DEFAULT_DEPS: CliDeps = {
  which,
  createAgent: (opts) => new Agent(opts),
  prompts: PROMPTS,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  signal: new AbortController().signal,
  isTTY: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  loadTui: () => import("./tui/index.ts"),
  loadPastRuns: (limit) => loadPastRuns({ runsDir: "runs", limit }),
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function preflight(deps: CliDeps, skill: string, state: string | null): string | null {
  const { system, snapshotFull, snapshotGrep, snapshotHybrid } = deps.prompts;
  for (const p of [system, snapshotFull, snapshotGrep, snapshotHybrid]) {
    if (!isFile(p)) return `system prompt not found: ${p} (is the installation complete?)`;
  }
  if (!isFile(skill)) return `playwright-cli skill not found: ${skill}`;
  if (state && !isFile(state)) return `state file not found: ${state}`;
  if (!deps.which("claude")) return "claude CLI not found on PATH (install Claude Code)";
  if (!deps.which("playwright-cli")) return "playwright-cli not found on PATH (npm i -g @playwright/cli@latest)";
  return null;
}

const statePath = (args: RunArgs) => (args.state ? resolvePath(args.state) : null);

function preflightArgs(deps: CliDeps, args: RunArgs): string | null {
  return preflight(deps, args.skill, statePath(args));
}

function exportSpec(deps: CliDeps, run: string, out: string | null = null, api = false): string {
  const { path: p, warnings } = exportRun(run, out, api);
  for (const w of warnings) deps.stderr(`warning: ${w}`);
  return p;
}

function exportMain(deps: CliDeps, argv: string[]): number {
  const parsed = parseExportArgs(argv);
  if (parsed.kind === "help") {
    deps.stdout(parsed.text.trimEnd());
    return 0;
  }
  if (parsed.kind === "version") return 0;
  try {
    deps.stdout(`Test: ${exportSpec(deps, parsed.args.run, parsed.args.output, parsed.args.api)}`);
    return 0;
  } catch (e) {
    if (!(e instanceof ExportError)) throw e;
    deps.stderr(e.message);
    return e.exitCode;
  }
}

/**
 * Run one task whose preflight has passed; returns the exit code, its history.json
 * and what it cost, including what was spent before a crash or Ctrl-C.
 */
async function runOne(
  deps: CliDeps, args: RunArgs, taskFile: string | null,
): Promise<[code: number, history: string, cost: number]> {
  const handle = startRun(
    { task: args.task!, taskFile, args },
    { ...deps, onWarning: (m) => deps.stderr(`warning: ${m}`) },
  );
  attachPlain(handle.events, deps.stdout);
  const o = await handle.done;
  printOutcome(o, deps.stdout, deps.stderr);
  return [o.exitCode, o.historyPath ?? "-", o.costUsd];
}

/** Preflight every task, then run them in order and print a summary. */
async function runBatch(deps: CliDeps, runs: [string, RunArgs][]): Promise<number> {
  const errors = runs.flatMap(([p, args]) => {
    const err = preflightArgs(deps, args);
    return err ? [`${p}: ${err}`] : [];
  });
  if (errors.length) {
    deps.stderr(errors.join("\n"));
    return 2;
  }
  const rows: [string, string, string, string][] = [];
  let total = 0;
  let interrupted = false;
  for (const [i, [p, args]] of runs.entries()) {
    if (interrupted) {
      rows.push(["skip", p, "-", "-"]);
      continue;
    }
    deps.stdout(`[${i + 1}/${runs.length}] ${p}`);
    const [code, history, cost] = await runOne(deps, args, p);
    total += cost;
    interrupted = code === 130;
    rows.push([code === 0 ? "pass" : interrupted ? "stop" : "fail", p, `$${fixed4(cost)}`, history]);
  }
  const count = (s: string) => rows.filter((r) => r[0] === s).length;
  deps.stdout(
    `Batch: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} not run`
    + `  Cost: $${fixed4(total)}`,
  );
  for (const row of rows) deps.stdout(row.join("  "));
  if (interrupted) return 130;
  return count("pass") === rows.length ? 0 : 1;
}

async function tuiMain(deps: CliDeps, argv: string[], args: RunArgs): Promise<number> {
  if (args.task !== null || args.file !== null) throw usage("give tasks inside the TUI, not with --tui");
  if (!deps.isTTY()) {
    deps.stderr("--tui needs an interactive terminal");
    return 2;
  }
  const err = preflightArgs(deps, args);
  if (err) {
    deps.stderr(err);
    return 2;
  }
  const limit = args.past ?? 20;
  const past = limit === 0 ? { runs: [], skipped: 0 } : deps.loadPastRuns(limit);
  const manager: RunManager = new RunManager({
    argv,
    past: past.runs,
    defaultSkill: deps.prompts.defaultSkill,
    maxParallel: args.maxParallel ?? 3,
    startRun: (s) => startRun(s, {
      prompts: deps.prompts, signal: deps.signal, createAgent: deps.createAgent,
      onWarning: (m) => manager.notify("error", m),
    }),
    preflight: (a) => preflightArgs(deps, a),
  });
  const tui = await deps.loadTui();
  const k = past.skipped;
  const notices = k > 0 ? [`skipped ${k} unreadable run folder${k === 1 ? "" : "s"} in runs/`] : [];
  const handle = tui.startTui({ manager, theme: args.theme ?? "auto", notices });
  // An outside SIGINT aborts the signal (and with it every run): close the TUI too, and exit 130.
  const onAbort = (): void => handle.quit();
  deps.signal.addEventListener("abort", onAbort, { once: true });
  if (deps.signal.aborted) onAbort();
  try {
    await handle.done;
  } finally {
    deps.signal.removeEventListener("abort", onAbort);
    handle.restoreTerminal();
  }
  const { lines, exitCode } = manager.summary();
  for (const line of lines) deps.stdout(line);
  return deps.signal.aborted ? 130 : exitCode;
}

function usageError(deps: CliDeps, e: UsageError): number {
  deps.stderr(e.usage);
  deps.stderr(`${e.prog}: error: ${e.message}`);
  return 2;
}

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...DEFAULT_DEPS, ...overrides };
  try {
    return await dispatch(deps, argv);
  } catch (e) {
    if (e instanceof UsageError) return usageError(deps, e);
    throw e;
  }
}

async function dispatch(deps: CliDeps, argv: string[]): Promise<number> {
  if (argv[0] === "export") return exportMain(deps, argv.slice(1));
  const parsed = parseRunArgs(argv, deps.prompts.defaultSkill);
  if (parsed.kind === "help") {
    deps.stdout(parsed.text.trimEnd());
    return 0;
  }
  if (parsed.kind === "version") {
    deps.stdout(`duckwright ${version()}`);
    return 0;
  }
  const { args } = parsed;
  if (args.tui) return tuiMain(deps, argv, args);
  if (args.maxParallel !== null) throw usage("--max-parallel needs --tui");
  if (args.past !== undefined) throw usage("--past needs --tui");
  if (args.theme !== undefined) throw usage("--theme needs --tui");
  if (args.task !== null && args.file !== null) throw usage("give a task or --file, not both");
  if (args.task === null && args.file === null) throw usage("give a task or --file");
  if (args.file === null) {
    const err = preflightArgs(deps, args);
    if (err) {
      deps.stderr(err);
      return 2;
    }
    return (await runOne(deps, args, null))[0];
  }

  // Load every file before anything runs, so one bad file stops the whole batch.
  const errors: string[] = [];
  const runs: [string, RunArgs][] = [];
  for (const p of taskPaths(args.file)) {
    if (p instanceof TaskFileError) {
      errors.push(p.message);
      continue;
    }
    try {
      const tf = loadTaskFile(p);
      // A fresh parse per file, so one file's settings never become another's defaults.
      // File settings are defaults, so flags given on the command line still win.
      const fileArgs = parseRunArgs(argv, deps.prompts.defaultSkill, tf.settings);
      if (fileArgs.kind === "args") runs.push([p, { ...fileArgs.args, task: tf.task }]);
    } catch (e) {
      if (!(e instanceof TaskFileError)) throw e;
      errors.push(e.message);
    }
  }
  if (errors.length) {
    deps.stderr(errors.join("\n"));
    return 2;
  }
  if (runs.length > 1) return runBatch(deps, runs);
  const [p, fileArgs] = runs[0];
  const err = preflightArgs(deps, fileArgs);
  if (err) {
    deps.stderr(err);
    return 2;
  }
  return (await runOne(deps, fileArgs, p))[0];
}

function usage(message: string): UsageError {
  return new UsageError(message, RUN_USAGE, "duckwright");
}
