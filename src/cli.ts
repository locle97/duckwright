import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RUN_USAGE, UsageError, parseExportArgs, parseRunArgs } from "./args.ts";
import type { RunArgs } from "./args.ts";
import { Brain } from "./brain.ts";
import { ExportError, exportRun } from "./export.ts";
import type { HistoryData } from "./export.ts";
import { Agent } from "./loop.ts";
import type { AgentOptions, RunResult } from "./loop.ts";
import { pageDir } from "./observe.ts";
import { resolvePath } from "./paths.ts";
import { AbortedError } from "./proc.ts";
import { stepLine } from "./prompt.ts";
import type { StepRecord } from "./prompt.ts";
import { PlaywrightCLI, PlaywrightError } from "./pw.ts";
import { makeRunDir } from "./rundir.ts";
import { TaskFileError, loadTaskFile, taskPaths } from "./taskfile.ts";

export interface PromptPaths {
  system: string;
  defaultSkill: string;
  // How the agent reads the page: pasted into the prompt, or grepped from the saved file.
  snapshotFull: string;
  snapshotGrep: string;
  snapshotHybrid: string;
}

// ../prompts from both src/ (tests) and dist/ (installed).
const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));
export const PROMPTS: PromptPaths = {
  system: path.join(PROMPTS_DIR, "system.md"),
  defaultSkill: path.join(PROMPTS_DIR, "playwright-cli.md"),
  snapshotFull: path.join(PROMPTS_DIR, "snapshot-full.md"),
  snapshotGrep: path.join(PROMPTS_DIR, "snapshot-grep.md"),
  snapshotHybrid: path.join(PROMPTS_DIR, "snapshot-hybrid.md"),
};

export function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface AgentLike {
  costUsd: number;
  run(): Promise<RunResult>;
}

export interface CliDeps {
  which(name: string): string | null;
  createAgent(opts: AgentOptions): AgentLike;
  prompts: PromptPaths;
  stdout(line: string): void;
  stderr(line: string): void;
  signal: AbortSignal;
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

export function historyJson(
  task: string, success: boolean, answer: string, steps: number, costUsd: number,
  history: StepRecord[], taskFile: string | null = null,
): HistoryData {
  return {
    task,
    task_file: taskFile,
    success,
    answer,
    steps,
    cost_usd: costUsd,
    history: history.map((r) => ({
      step: r.step,
      evaluation_previous_goal: r.decision.evaluationPreviousGoal,
      memory: r.decision.memory,
      next_goal: r.decision.nextGoal,
      actions: r.decision.actions.map((a, i) => ({
        cmd: a.cmd,
        args: [...a.args],
        code: i < r.codes.length ? r.codes[i] : null,
      })),
      results: [...r.results],
    })),
  };
}

function writeHistory(file: string, data: HistoryData): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function exportSpec(deps: CliDeps, run: string, out: string | null = null): string {
  const { path: p, warnings } = exportRun(run, out);
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
    deps.stdout(`Test: ${exportSpec(deps, parsed.args.run, parsed.args.output)}`);
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
  const task = args.task!;
  const workdir = makeRunDir("runs", taskFile);
  const historyPath = path.join(workdir, "history.json");
  const collected: StepRecord[] = [];
  const modeMd = { full: deps.prompts.snapshotFull, grep: deps.prompts.snapshotGrep, hybrid: deps.prompts.snapshotHybrid }[args.snapshot];
  const brain = new Brain({
    systemFiles: [deps.prompts.system, modeMd, args.skill],
    model: args.model,
    snapshotDir: args.snapshot === "full" ? null : pageDir(workdir),
    signal: deps.signal,
  });
  const pw = new PlaywrightCLI({ session: args.session, allowFileAccess: args.allowFileAccess, signal: deps.signal });
  const agent = deps.createAgent({
    task, pw, brain, workdir,
    maxSteps: args.maxSteps, headed: args.headed, state: statePath(args),
    onStep: (rec) => {
      collected.push(rec);
      deps.stdout(stepLine(rec));
    },
    snapshotMode: args.snapshot,
    signal: deps.signal,
  });
  const fail = (answer: string, code: number): [number, string, number] => {
    writeHistory(historyPath, historyJson(task, false, answer, collected.length, agent.costUsd, collected, taskFile));
    deps.stderr(answer);
    return [code, historyPath, agent.costUsd];
  };

  let result: RunResult;
  try {
    result = await agent.run();
  } catch (e) {
    if (e instanceof PlaywrightError) return fail(`playwright error: ${e.message}`, 1);
    if (e instanceof AbortedError) return fail("interrupted", 130);
    return fail(e instanceof Error ? `error: ${e.name}: ${e.message}` : `error: ${String(e)}`, 1);
  }

  writeHistory(historyPath, historyJson(
    task, result.success, result.answer, result.steps, result.costUsd, result.history, taskFile,
  ));
  deps.stdout(`Result: ${result.success ? "success" : "failure"}`);
  deps.stdout(`Answer: ${result.answer}`);
  deps.stdout(`Steps: ${result.steps}  Cost: $${result.costUsd.toFixed(4)}`);
  deps.stdout(`History: ${historyPath}`);
  if (args.export) {
    if (!result.success) {
      deps.stdout("Test: not exported (run did not succeed)");
    } else {
      try {
        deps.stdout(`Test: ${exportSpec(deps, workdir)}`);
      } catch (e) {
        // The run itself succeeded; a failed export does not change that.
        if (!(e instanceof ExportError)) throw e;
        deps.stderr(`export failed: ${e.message}`);
      }
    }
  }
  return [result.success ? 0 : 1, historyPath, result.costUsd];
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
    rows.push([code === 0 ? "pass" : interrupted ? "stop" : "fail", p, `$${cost.toFixed(4)}`, history]);
  }
  const count = (s: string) => rows.filter((r) => r[0] === s).length;
  deps.stdout(
    `Batch: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} not run`
    + `  Cost: $${total.toFixed(4)}`,
  );
  for (const row of rows) deps.stdout(row.join("  "));
  if (interrupted) return 130;
  return count("pass") === rows.length ? 0 : 1;
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
