// One run's lifecycle, with no UI: make the run folder, drive the agent, write history.json,
// export, and report progress through events and a final outcome.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RunArgs } from "../args.ts";
import { Brain } from "../brain.ts";
import { RunControl } from "../control.ts";
import { RunEvents } from "../events.ts";
import type { ExportOutcome, RunOutcome } from "../events.ts";
import { EnvError, loadEnvironment } from "../environment.ts";
import { HybridBrain, JevAuthError, JevClient, fetchTransport } from "../jev.ts";
import type { JevTransport } from "../jev.ts";
import { DebugLog, debugRunner, debugTransport } from "../debuglog.ts";
import { ExportError, exportRun } from "../export.ts";
import type { HistoryData } from "../export.ts";
import type { Evidence } from "../evidence.ts";
import type { AgentOptions, RunResult } from "../loop.ts";
import { pageDir } from "../observe.ts";
import { resolvePath } from "../paths.ts";
import { AbortedError, runProcess } from "../proc.ts";
import type { Runner } from "../proc.ts";
import type { StepRecord } from "../prompt.ts";
import { PlaywrightCLI, PlaywrightError } from "../pw.ts";
import { makeRunDir } from "../rundir.ts";
import { SECRET_ENV, createTwoFactor } from "../twofa.ts";
import type { Human } from "../twofa.ts";
import { jsonlSink } from "./sink.ts";

export interface PromptPaths {
  system: string;
  defaultSkill: string;
  // How the agent reads the page: pasted into the prompt, or grepped from the saved file.
  snapshotFull: string;
  snapshotGrep: string;
  snapshotHybrid: string;
  /** Plan mode's planner. */
  planner: string;
}

// ../../prompts from both src/runs/ (tests) and dist/runs/ (installed).
const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));
export const PROMPTS: PromptPaths = {
  system: path.join(PROMPTS_DIR, "system.md"),
  defaultSkill: path.join(PROMPTS_DIR, "playwright-cli.md"),
  snapshotFull: path.join(PROMPTS_DIR, "snapshot-full.md"),
  snapshotGrep: path.join(PROMPTS_DIR, "snapshot-grep.md"),
  snapshotHybrid: path.join(PROMPTS_DIR, "snapshot-hybrid.md"),
  planner: path.join(PROMPTS_DIR, "planner.md"),
};

export interface AgentLike {
  costUsd: number;
  evidence?: Evidence;
  run(): Promise<RunResult>;
}

export interface RunSpec {
  task: string;
  taskFile: string | null;
  args: RunArgs;
  exportTest?: boolean;
  consoleErrors?: boolean;
}

export interface RunDeps {
  prompts: PromptPaths;
  signal: AbortSignal;
  createAgent(opts: AgentOptions): AgentLike;
  runsDir?: string; // default "runs"
  onWarning?: (message: string) => void;
  /** Who can be asked for a 2FA code in this run; null (the default) when nobody is attached. */
  humanFor?: (ctx: { signal: AbortSignal; events: RunEvents }) => Human | null;
  /** Where the TOTP secret is read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where debug-log blocks are also sent (print mode passes stderr). The file is written regardless. */
  debugConsole?: (text: string) => void;
  /** The inner Claude runner (default `runProcess`); a test seam. */
  runner?: Runner;
  /** The inner Jev transport (default `fetchTransport`); a test seam. */
  jevTransport?: JevTransport;
}

export interface RunHandle {
  id: string;
  workdir: string;
  events: RunEvents;
  control: RunControl;
  done: Promise<RunOutcome>;
}

/** Relative POSIX path when `abs` is inside `cwd`, else the absolute path. */
export function statePathForHistory(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join("/");
}

export function historyJson(
  task: string, success: boolean, answer: string, steps: number, costUsd: number,
  history: StepRecord[], taskFile: string | null = null, video: string | null = null,
  env: { name: string; path: string } | null = null,
  state: { path: string; source: "file" | "login" } | null = null,
): HistoryData {
  const jevSteps = history.filter((r) => r.decision.source === "jev").length;
  return {
    task,
    task_file: taskFile,
    ...(env !== null ? { env } : {}),
    ...(state !== null ? { state } : {}),
    success,
    answer,
    steps,
    cost_usd: costUsd,
    jev_steps: jevSteps,
    claude_steps: history.length - jevSteps,
    ...(video !== null ? { video } : {}),
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
      cost_usd: r.costUsd ?? 0,
      source: r.decision.source ?? "claude",
      jev: r.decision.jev ?? null,
      ...(r.screenshot ? { screenshot: r.screenshot } : {}),
      ...(r.screenshotError ? { screenshot_error: r.screenshotError } : {}),
      ...(r.network ? { network: r.network } : {}),
      ...(r.networkErrors?.length ? { network_errors: [...r.networkErrors] } : {}),
      ...(r.consoleErrors?.length ? { console_errors: [...r.consoleErrors] } : {}),
      ...(r.requestOrigins?.some((o) => o !== null) ? { request_origins: [...r.requestOrigins] } : {}),
    })),
  };
}

function writeHistory(file: string, data: HistoryData): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const errorText = (e: unknown) => (e instanceof Error ? `error: ${e.name}: ${e.message}` : `error: ${String(e)}`);

function failure(
  message: string, code: 1 | 130, steps: number, costUsd: number, historyPath: string | null,
  warnings: string[] = [], video: string | null = null,
): RunOutcome {
  return {
    status: code === 130 ? "stop" : "fail", exitCode: code, success: false,
    answer: message, steps, costUsd, historyPath, export: { kind: "off" }, warnings, ...(video !== null ? { video } : {}), error: message,
  };
}

export function startRun(spec: RunSpec, deps: RunDeps): RunHandle {
  const events = new RunEvents();
  const runAbort = new AbortController();
  const control = new RunControl(runAbort, events);

  let workdir: string;
  try {
    workdir = makeRunDir(deps.runsDir ?? "runs", spec.taskFile);
  } catch (e) {
    const outcome = failure(errorText(e), 1, 0, 0, null);
    const done = Promise.resolve().then(() => {
      events.emit({ type: "run:end", outcome });
      return outcome;
    });
    return { id: "", workdir: "", events, control, done };
  }

  const signal = AbortSignal.any([deps.signal, runAbort.signal]);
  events.subscribe(jsonlSink(path.join(workdir, "events.jsonl"), (m) => deps.onWarning?.(m)));
  const done = execute(spec, deps, workdir, events, control, signal);
  return { id: path.basename(workdir), workdir, events, control, done };
}

/**
 * The brain for one run folder: Claude, or Jev in front of Claude. Shared by `execute` and the
 * login agent. Prompts are scrubbed by the Agent itself, so no scrubber is needed here.
 */
export function makeBrain(
  args: RunArgs, deps: RunDeps, workdir: string, signal: AbortSignal, log: DebugLog | null,
): AgentOptions["brain"] {
  const apiKey = ((deps.env ?? process.env).TYPESAFE_API_KEY ?? "").trim();
  const claude = new Brain({
    systemFiles: [
      deps.prompts.system,
      { full: deps.prompts.snapshotFull, grep: deps.prompts.snapshotGrep, hybrid: deps.prompts.snapshotHybrid }[args.snapshot],
      args.skill,
    ],
    model: args.model,
    snapshotDir: args.snapshot === "full" ? null : pageDir(workdir),
    signal,
    runner: log ? debugRunner(deps.runner ?? runProcess, log) : deps.runner,
  });
  if (!args.jev) return claude;
  return new HybridBrain({
    jev: new JevClient({
      apiKey, signal,
      transport: log ? debugTransport(deps.jevTransport ?? fetchTransport, log) : deps.jevTransport,
    }),
    claude, minConfidence: args.jevThreshold,
    ...(log ? { onRoute: (r) => log.route(r) } : {}),
  });
}

async function execute(
  spec: RunSpec, deps: RunDeps, workdir: string, events: RunEvents, control: RunControl, signal: AbortSignal,
): Promise<RunOutcome> {
  const { task, taskFile, args } = spec;
  const historyPath = path.join(workdir, "history.json");
  const collected: StepRecord[] = [];
  let agent: AgentLike | null = null;
  let outcome: RunOutcome;
  let envRecord: { name: string; path: string } | null = null;
  let stateRecord: { path: string; source: "file" | "login" } | null = null;
  // Let the caller subscribe before anything is emitted.
  await Promise.resolve();
  try {
    const env = args.env ? loadEnvironment(args.env) : null;
    if (env) envRecord = { name: env.name, path: env.path };
    const statePath = args.state ? resolvePath(args.state) : null;
    if (statePath) stateRecord = { path: statePathForHistory(statePath, resolvePath(process.cwd())), source: "file" };
    events.subscribe((e) => { if (e.type === "step:end") collected.push(e.record); });
    const twofa = createTwoFactor({
      secret: (deps.env ?? process.env)[SECRET_ENV] ?? null,
      human: deps.humanFor?.({ signal, events }) ?? null,
      timeoutSec: args.twofaTimeout,
      signal, events,
    });
    const apiKey = ((deps.env ?? process.env).TYPESAFE_API_KEY ?? "").trim();
    let log: DebugLog | null = null;
    if (args.debug) {
      log = new DebugLog({
        runId: path.basename(workdir), file: path.join(workdir, "debug.log"), console: deps.debugConsole,
        secrets: apiKey !== "" ? [apiKey] : [], scrub: (t) => twofa.scrubber.scrub(t), onWarning: deps.onWarning,
      });
      log.attach(events);
    }
    const brain = makeBrain(args, deps, workdir, signal, log);
    const pw = new PlaywrightCLI({ session: args.session, allowFileAccess: args.allowFileAccess, signal });
    agent = deps.createAgent({
      task, pw, brain, workdir,
      maxSteps: args.maxSteps, headed: args.headed, state: statePath,
      snapshotMode: args.snapshot, network: args.network, consoleErrors: spec.consoleErrors ?? false, video: args.video, screenshot: args.screenshot,
      signal, events, control, twofa, environment: env?.text ?? null,
    });
    events.emit({
      type: "run:start", task, maxSteps: args.maxSteps, model: args.model, snapshot: args.snapshot,
      headed: args.headed, session: args.session, workdir,
    });
    outcome = await finish(await agent.run());
  } catch (e) {
    const cost = agent?.costUsd ?? 0;
    let message: string;
    let code: 1 | 130 = 1;
    // Ctrl-C reaches the child too, so its failure can arrive before the abort does.
    if (e instanceof AbortedError || signal.aborted) {
      message = "interrupted";
      code = 130;
    } else if (e instanceof PlaywrightError) {
      message = `playwright error: ${e.message}`;
    } else if (e instanceof EnvError) {
      message = e.message;
    } else if (e instanceof JevAuthError) {
      message = "jev error: invalid TYPESAFE_API_KEY";
    } else {
      message = errorText(e);
    }
    const ev = agent?.evidence ?? { video: null, warnings: [] };
    let written: string | null = historyPath;
    try {
      writeHistory(historyPath, historyJson(task, false, message, collected.length, cost, collected, taskFile, ev.video, envRecord, stateRecord));
    } catch {
      written = null;
    }
    outcome = failure(message, code, collected.length, cost, written, [...ev.warnings], ev.video);
  }
  events.emit({ type: "run:end", outcome });
  return outcome;

  // Write history.json and export; an export crash that is not an ExportError fails the run.
  async function finish(result: RunResult): Promise<RunOutcome> {
    const ev = agent?.evidence ?? { video: null, warnings: [] };
    writeHistory(historyPath, historyJson(
      task, result.success, result.answer, result.steps, result.costUsd, result.history, taskFile, ev.video, envRecord, stateRecord,
    ));
    const warnings: string[] = [];
    let exported: ExportOutcome = { kind: "off" };
    let error: string | null = null;
    if (spec.exportTest === false) {
      exported = { kind: "off" };
    } else if (!result.success) {
      exported = { kind: "skipped" };
    } else {
      try {
        const r = exportRun(workdir);
        warnings.push(...r.warnings);
        exported = { kind: "written", path: r.path };
      } catch (e) {
        // The run itself succeeded; a failed export does not change that.
        if (e instanceof ExportError) exported = { kind: "failed", message: e.message };
        else error = errorText(e);
      }
    }
    warnings.push(...ev.warnings);
    const ok = result.success && error === null;
    return {
      status: ok ? "pass" : "fail", exitCode: ok ? 0 : 1, success: ok,
      answer: error ?? result.answer, steps: result.steps, costUsd: result.costUsd,
      historyPath, export: exported, warnings, ...(ev.video !== null ? { video: ev.video } : {}),
      ...(args.jev ? { jevSteps: result.history.filter((r) => r.decision.source === "jev").length } : {}),
      error,
    };
  }
}
