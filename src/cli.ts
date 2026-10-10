import fs from "node:fs";
import path from "node:path";

import { RUN_USAGE, UsageError, parseExportArgs, parseRunArgs } from "./args.ts";
import type { RunArgs } from "./args.ts";
import { initConfig, loadConfig, runSettings } from "./config.ts";
import type { GlobalConfig } from "./config.ts";
import { EnvError, loadEnvironment } from "./environment.ts";
import { ExportError, exportRun } from "./export.ts";
import { Agent } from "./loop.ts";
import type { AgentOptions } from "./loop.ts";
import { resolvePath } from "./paths.ts";
import { PlanError, isPlanFolder, runPlanner, writePlan } from "./plan.ts";
import { attachPlain, printOutcome } from "./report/plain.ts";
import { createTtyHuman } from "./report/ttyHuman.ts";
import { RunManager } from "./runs/manager.ts";
import type { ManagerLike, Planner } from "./runs/manager.ts";
import { loadPastRuns } from "./runs/past.ts";
import type { PastRun } from "./runs/past.ts";
import { PROMPTS, historyJson, startRun } from "./runs/run.ts";
import type { AgentLike, PromptPaths } from "./runs/run.ts";
import { secretProblem } from "./twofa.ts";
import type { Human } from "./twofa.ts";
import { fixed4 } from "./text.ts";
import { which } from "./which.ts";
import type { ThemeName } from "./tui/theme.ts";
import type { StartWebOptions, WebHandle } from "./web/index.ts";
import { TaskFileError, loadTaskFile, taskPaths } from "./taskfile.ts";

export { PROMPTS, historyJson, which };
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

export interface WebModule { startWeb(o: StartWebOptions): Promise<WebHandle> }

export interface CliDeps {
  which(name: string): string | null;
  createAgent(opts: AgentOptions): AgentLike;
  prompts: PromptPaths;
  stdout(line: string): void;
  stderr(line: string): void;
  signal: AbortSignal;
  isTTY(): boolean;
  loadTui(): Promise<TuiModule>;
  loadWeb(): Promise<WebModule>;
  loadPastRuns(limit: number): { runs: PastRun[]; skipped: number };
  /** Plan mode's planner; by default `claude -p` with the planner prompt. */
  planner?: Planner;
  /** The global config (duckwright.conf in the user config folder); throws TaskFileError when it is invalid. */
  loadConfig(): GlobalConfig;
  /** Writes the default config unless it exists; used by `duckwright init`. */
  initConfig(): { file: string; created: boolean };
  /** Where the TOTP secret is read from. */
  env: Record<string, string | undefined>;
  /** The person to ask for a 2FA code in print mode, named by `label`. Only used when `isTTY()` is true. */
  human(label: string): Human | null;
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
  loadWeb: () => import("./web/index.ts"),
  loadPastRuns: (limit) => loadPastRuns({ runsDir: "runs", limit }),
  loadConfig: () => loadConfig(),
  initConfig: () => initConfig(),
  env: process.env,
  human: (label) => createTtyHuman({ label }),
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function plannerOf(deps: CliDeps): Planner {
  return deps.planner ?? ((o) => runPlanner({ ...o, promptFile: deps.prompts.planner }));
}

/** Why a --plan argument cannot be planned or opened, or null. */
function planProblem(deps: CliDeps, plan: string): string | null {
  let dir: boolean;
  try {
    dir = fs.statSync(plan).isDirectory();
  } catch {
    return `${plan}: not found`;
  }
  if (dir) return isPlanFolder(plan) ? null : `${plan}: not a planned folder (no plan.json)`;
  if (deps.planner === undefined && !isFile(deps.prompts.planner)) return `planner prompt not found: ${deps.prompts.planner} (is the installation complete?)`;
  return null;
}

/** -p with --plan: plan the file, write the tasks, say where they are; nothing runs. */
async function planMain(deps: CliDeps, args: RunArgs): Promise<number> {
  const plan = args.plan!;
  const problem = planProblem(deps, plan);
  if (problem) {
    deps.stderr(problem);
    return 2;
  }
  if (isPlanFolder(plan)) {
    deps.stderr(`${plan}: already planned; run it with duckwright -p -f ${plan}, or open it in the TUI with duckwright plan ${plan}`);
    return 2;
  }
  if (!deps.which("claude")) {
    deps.stderr("claude CLI not found on PATH (install Claude Code)");
    return 2;
  }
  deps.stdout(`Planning ${plan}…`);
  let r: Awaited<ReturnType<Planner>>;
  try {
    r = await plannerOf(deps)({ planFile: plan, model: args.model, signal: deps.signal });
  } catch (e) {
    if (deps.signal.aborted) return 130;
    deps.stderr(`plan error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const loaded = writePlan(r.doc, plan, "tasks", args.env);
  deps.stdout(`Plan: ${loaded.tasks.length} task${loaded.tasks.length === 1 ? "" : "s"} in ${loaded.folder}${path.sep}  Cost: $${fixed4(r.cost)}`);
  if (loaded.setupPath !== null) deps.stdout(`Shared setup: ${loaded.setupPath}`);
  for (const t of loaded.tasks) deps.stdout(`  ${t.path}`);
  for (const n of r.doc.notes) deps.stdout(`Before you run: ${n}`);
  for (const x of r.doc.skipped) deps.stdout(`Skipped ${x.id} ${x.title}: ${x.reason}`);
  deps.stdout(`Review them in the TUI with: duckwright plan ${loaded.folder}`);
  deps.stdout(`Or run them all with: duckwright -p -f ${loaded.folder}${path.sep}`);
  return 0;
}

function preflight(deps: CliDeps, skill: string, state: string | null, env: string | null = null): string | null {
  const { system, snapshotFull, snapshotGrep, snapshotHybrid } = deps.prompts;
  for (const p of [system, snapshotFull, snapshotGrep, snapshotHybrid]) {
    if (!isFile(p)) return `system prompt not found: ${p} (is the installation complete?)`;
  }
  if (!isFile(skill)) return `playwright-cli skill not found: ${skill}`;
  if (state && !isFile(state)) return `state file not found: ${state}`;
  if (env) {
    try {
      loadEnvironment(env);
    } catch (e) {
      if (e instanceof EnvError) return e.message;
      throw e;
    }
  }
  if (!deps.which("claude")) return "claude CLI not found on PATH (install Claude Code)";
  if (!deps.which("playwright-cli")) return "playwright-cli not found on PATH (npm i -g @playwright/cli@latest)";
  return null;
}

const statePath = (args: RunArgs) => (args.state ? resolvePath(args.state) : null);

function preflightArgs(deps: CliDeps, args: RunArgs): string | null {
  const err = preflight(deps, args.skill, statePath(args), args.env);
  if (err) return err;
  if (args.jev && !deps.env.TYPESAFE_API_KEY?.trim()) return "TYPESAFE_API_KEY is not set (needed by --jev)";
  return null;
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
  deps: CliDeps, args: RunArgs, taskFile: string | null, label: string,
): Promise<[code: number, history: string, cost: number]> {
  const handle = startRun(
    { task: args.task!, taskFile, args },
    {
      ...deps,
      humanFor: () => (deps.isTTY() ? deps.human(label) : null),
      env: deps.env,
      onWarning: (m) => deps.stderr(`warning: ${m}`),
      debugConsole: args.debug ? deps.stderr : undefined,
    },
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
    const [code, history, cost] = await runOne(deps, args, p, `[${i + 1}/${runs.length}] ${p}`);
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

/** A running frontend: `done` settles once the user quit it, `quit()` stops every run and ends it, `cleanup()` puts the screen back. */
interface Frontend { done: Promise<void>; quit(): void; cleanup(): void }
/** The frontend could not start (the port is taken, the UI is not built): one line on stderr, exit 2. */
class StartError extends Error {}

/** Shared by the TUI and web modes: build the manager, add what was given, open a frontend, run until it closes. */
async function interactiveMain(
  deps: CliDeps, argv: string[], args: RunArgs, config: GlobalConfig, open: (manager: RunManager, notices: string[]) => Promise<Frontend>,
): Promise<number> {
  const err = preflightArgs(deps, args) ?? (args.plan !== null ? planProblem(deps, args.plan) : null);
  if (err) {
    deps.stderr(err);
    return 2;
  }
  const limit = args.past ?? config.past ?? 20;
  const past = limit === 0 ? { runs: [], skipped: 0 } : deps.loadPastRuns(limit);
  const manager: RunManager = new RunManager({
    argv,
    past: past.runs,
    defaultSkill: deps.prompts.defaultSkill,
    maxParallel: args.maxParallel ?? config.maxParallel ?? 3,
    settings: runSettings(config),
    startRun: (s, human) => startRun(s, {
      prompts: deps.prompts, signal: deps.signal, createAgent: deps.createAgent, env: deps.env,
      humanFor: () => human,
      onWarning: (m) => manager.notify("error", m),
    }),
    preflight: (a) => preflightArgs(deps, a),
    planner: plannerOf(deps),
  });
  // Load every file before the frontend opens, so a bad one is reported on the plain terminal.
  const given = args.task !== null || args.file !== null ? manager.add({ mentions: args.file ?? [], typed: args.task }) : null;
  if (given !== null && !given.ok) {
    deps.stderr(given.errors.map((e) => e.message).join("\n"));
    return 2;
  }
  const k = past.skipped;
  const notices = k > 0 ? [`skipped ${k} unreadable run folder${k === 1 ? "" : "s"} in runs/`] : [];
  let front: Frontend;
  try {
    front = await open(manager, notices);
  } catch (e) {
    if (!(e instanceof StartError)) throw e;
    deps.stderr(e.message);
    return 2;
  }
  // Started once the frontend is up, so it sees every run from its first event.
  if (given?.ok) manager.startQueued(given.added);
  if (args.plan !== null) {
    const planned = manager.plan(args.plan);
    if (!planned.ok) manager.notify("error", planned.error);
  }
  // An outside SIGINT aborts the signal (and with it every run): close the frontend too, and exit 130.
  const onAbort = (): void => front.quit();
  deps.signal.addEventListener("abort", onAbort, { once: true });
  if (deps.signal.aborted) onAbort();
  try {
    await front.done;
  } finally {
    deps.signal.removeEventListener("abort", onAbort);
    front.cleanup();
  }
  const { lines, exitCode } = manager.summary();
  for (const line of lines) deps.stdout(line);
  return deps.signal.aborted ? 130 : exitCode;
}

function tuiMain(deps: CliDeps, argv: string[], args: RunArgs, config: GlobalConfig): Promise<number> {
  return interactiveMain(deps, argv, args, config, async (manager, notices) => {
    const tui = await deps.loadTui();
    const handle = tui.startTui({ manager, theme: args.theme ?? config.theme ?? "auto", notices });
    return { done: handle.done, quit: handle.quit, cleanup: handle.restoreTerminal };
  });
}

function webMain(deps: CliDeps, argv: string[], args: RunArgs, config: GlobalConfig): Promise<number> {
  return interactiveMain(deps, argv, args, config, async (manager, notices) => {
    const web = await deps.loadWeb();
    let handle: WebHandle;
    try {
      handle = await web.startWeb({
        manager, port: args.port ?? undefined, maxParallel: args.maxParallel ?? config.maxParallel ?? 3, notices,
        theme: args.theme ?? config.theme ?? "auto",
      });
    } catch (e) {
      throw new StartError(e instanceof Error ? e.message : String(e));
    }
    deps.stdout(`duckwright web: ${handle.url}`);
    return { done: handle.done, quit: handle.quit, cleanup: () => {} };
  });
}

/** `duckwright init`: write the default config unless one exists. */
function initMain(deps: CliDeps, rest: string[]): number {
  if (rest.length) throw usage("init takes no arguments");
  try {
    const { file, created } = deps.initConfig();
    deps.stdout(created ? `Wrote default config: ${file}` : `Config already exists: ${file}`);
    return 0;
  } catch (e) {
    deps.stderr(`init: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
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
  if (argv[0] === "init") return initMain(deps, argv.slice(1));
  // `duckwright plan PLAN ...` is `duckwright --plan PLAN ...`.
  if (argv[0] === "plan") {
    if (argv.length < 2 || argv[1]!.startsWith("-")) throw usage("plan: give a plan file or a planned folder");
    argv = ["--plan", ...argv.slice(1)];
  }
  let config: GlobalConfig;
  try {
    config = deps.loadConfig();
  } catch (e) {
    if (!(e instanceof TaskFileError)) throw e;
    deps.stderr(e.message);
    return 2;
  }
  const defaults = runSettings(config);
  const parsed = parseRunArgs(argv, deps.prompts.defaultSkill, defaults);
  if (parsed.kind === "help") {
    deps.stdout(parsed.text.trimEnd());
    return 0;
  }
  if (parsed.kind === "version") {
    deps.stdout(`duckwright ${version()}`);
    return 0;
  }
  const badSecret = secretProblem(deps.env);
  if (badSecret !== null) {
    deps.stderr(badSecret);
    return 2;
  }
  const { args } = parsed;
  if (args.web) {
    if (args.print) throw usage("--web cannot be used with -p");
    return webMain(deps, argv, args, config);
  }
  if (args.port !== null) throw usage("--port applies to --web");
  if (!args.print && deps.isTTY()) return tuiMain(deps, argv, args, config);
  // With no terminal, print mode is the fallback, and the TUI-only options have nothing to apply to.
  if (args.print) {
    if (args.maxParallel !== null) throw usage("--max-parallel applies to the TUI, not with -p");
    if (args.past !== undefined) throw usage("--past applies to the TUI, not with -p");
    if (args.theme !== undefined) throw usage("--theme applies to the TUI, not with -p");
  }
  if (args.plan !== null) {
    if (args.task !== null || args.file !== null) throw usage("--plan only writes task files with -p: give no task or --file");
    return planMain(deps, args);
  }
  if (args.task !== null && args.file !== null) throw usage("give a task or --file, not both");
  if (args.task === null && args.file === null) {
    throw usage(args.print ? "give a task or --file" : "no terminal for the TUI: give a task or --file to run in print mode");
  }
  if (args.file === null) {
    const err = preflightArgs(deps, args);
    if (err) {
      deps.stderr(err);
      return 2;
    }
    return (await runOne(deps, args, null, "duckwright"))[0];
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
      // File settings are defaults over the config, so flags given on the command line still win.
      const fileArgs = parseRunArgs(argv, deps.prompts.defaultSkill, { ...defaults, ...tf.settings });
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
  return (await runOne(deps, fileArgs, p, p))[0];
}

function usage(message: string): UsageError {
  return new UsageError(message, RUN_USAGE, "duckwright");
}
