// Holds typed and file tasks and their runs, with no UI: starts runs in numbered browser-session
// slots, forwards their events, and builds the quit summary.
import fs from "node:fs";
import path from "node:path";

import { parseRunArgs } from "../args.ts";
import type { RunArgs } from "../args.ts";
import type { ControlState, RunEvent, RunOutcome, TwofaWait } from "../events.ts";
import type { SnapshotMode } from "../observe.ts";
import { ENV_NONE, envLabel, isEnvName, isEnvPath, listEnvironments, resolveEnv } from "../environment.ts";
import { SPEC_NAME } from "../export.ts";
import { resolvePath } from "../paths.ts";
import { PlanError, isPlanFolder, loadPlan, writeManifest, writePlan } from "../plan.ts";
import type { LoadedPlan, Manifest, PlanDoc, PlanEntry, Skipped } from "../plan.ts";
import { SpecReplays } from "../replay.ts";
import { loadTaskFile, TaskFileError, taskPaths } from "../taskfile.ts";
import type { TaskFile, TaskSettings } from "../taskfile.ts";
import { fixed4, mentionToken } from "../text.ts";
import type { Human } from "../twofa.ts";
import { HumanBridge } from "./humanBridge.ts";
import type { PastRun } from "./past.ts";
import type { RunHandle, RunSpec } from "./run.ts";

export type TaskId = number;
export type PlanId = number;
/** `planning`: the planner is splitting the plan; `ready`: its tasks are in the list; `failed`: planning failed or was cancelled. */
export type PlanState = "planning" | "ready" | "failed";
export type TaskState = "idle" | "running" | "paused" | "passed" | "failed" | "stopping" | "stopped";
export interface Overrides { model?: string; maxSteps?: number; headed?: boolean; snapshot?: SnapshotMode; video?: boolean; screenshot?: boolean; jev?: boolean; env?: string | null }
export interface Effective { model: string; maxSteps: number; headed: boolean; snapshot: SnapshotMode; video: boolean; screenshot: boolean; jev: boolean; env: string | null }
/** The options every task's next run starts from: `base` is the defaults and flags, `overrides` the edits on top. */
export interface Globals { base: Effective; overrides: Overrides; environments: string[] }
export type TaskSource = { kind: "typed" } | { kind: "file"; path: string };
/** One submission of the add box: mentioned paths in order, and the leftover typed task. */
export interface Submission { mentions: string[]; typed: string | null }
export type AddResult =
  | { ok: true; added: TaskId[]; duplicates: string[] }
  | { ok: false; errors: { mention: number; message: string }[] };
export interface TaskSnapshot {
  id: TaskId; text: string; name: string; source: TaskSource; state: TaskState; overrides: Overrides; effective: Effective; inherited: Effective;
  error: string | null; runId: string | null; runCount: number;
  /** Set while the task's active run waits for a 2FA answer. */
  twofa: { kind: TwofaWait } | null;
  /** True when the task is not live and its latest run folder holds `duckwright.spec.ts`. */
  hasSpec: boolean;
  /** Epoch ms the task was created (past runs: the run's start). Never changes. */
  createdAt: number;
  /** Set for tasks that came from a past run folder. */
  past?: { runId: string; events: RunEvent[] };
  /** Set for a task of a plan. */
  planId?: PlanId;
}
/** A plan in the task list: its tasks in run order, and the ones waiting in a plan run. */
export interface PlanSnapshot {
  id: PlanId;
  /** The plan file's name. */
  name: string;
  /** The plan file or planned folder, as given. */
  source: string;
  /** The planned folder, once written or opened. */
  folder: string | null;
  state: PlanState;
  error: string | null;
  /** What planning cost. */
  cost: number;
  /** Epoch ms planning started and ended (null while it runs). */
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  /** The shared setup's text and file, when the plan has one. */
  setup: string | null;
  setupPath: string | null;
  notes: string[];
  skipped: Skipped[];
  taskIds: TaskId[];
  /** Tasks still to start in the running plan run, in order; empty when no plan run is going. */
  queued: TaskId[];
}
/** What the editor opens: a task (its file, or a typed task's text) or a plan's shared setup. */
export type EditTarget = { kind: "task"; id: TaskId } | { kind: "setup"; planId: PlanId };
export type ManagerEvent =
  | { type: "run"; taskId: TaskId; runId: string; event: RunEvent }
  | { type: "task:added"; task: TaskSnapshot }
  | { type: "task:updated"; task: TaskSnapshot }
  | { type: "task:removed"; taskId: TaskId }
  | { type: "toast"; level: "info" | "error"; message: string }
  | { type: "globals:updated"; globals: Globals }
  | { type: "plan:added"; plan: PlanSnapshot }
  | { type: "plan:updated"; plan: PlanSnapshot }
  | { type: "plan:removed"; planId: PlanId };
export type StartResult = { ok: true; runId: string } | { ok: false; reason: string };
export type Result = { ok: true } | { ok: false; error: string };
export type PlanResult = { ok: true; id: PlanId } | { ok: false; error: string };
export type Planner = (o: { planFile: string; model: string; signal: AbortSignal }) => Promise<{ doc: PlanDoc; cost: number }>;

export interface ManagerLike {
  list(): TaskSnapshot[];
  subscribe(fn: (e: ManagerEvent) => void): () => void;
  addTyped(text: string): TaskId;
  add(sub: Submission): AddResult;
  setOverrides(id: TaskId, o: Overrides): void;
  globals(): Globals;
  setGlobals(o: Overrides): void;
  remove(id: TaskId): boolean;
  start(id: TaskId): StartResult;
  pause(id: TaskId): void;
  resume(id: TaskId): void;
  step(id: TaskId): void;
  stop(id: TaskId): void;
  answerTwoFactor(id: TaskId, value: string | null): void;
  activeCount(): number;
  stopAll(): Promise<void>;
  plans(): PlanSnapshot[];
  /** Plan a plan file (the planner writes its tasks), or open a planned folder. */
  plan(source: string): PlanResult;
  /** Plan a plan whose planning failed again. */
  retryPlan(id: PlanId): Result;
  cancelPlan(id: PlanId): void;
  /** Run the plan's tasks in the plan's order, as many at once as the parallel limit allows: all of them, or the failed and stopped ones. */
  runPlan(id: PlanId, which: "all" | "failed"): Result;
  /** Start no more of the plan's tasks, and stop the one running. */
  stopPlan(id: PlanId): void;
  /** Remove the plan and its tasks from the list (the files stay). */
  removePlan(id: PlanId): boolean;
  /** Move a plan's task up (-1) or down (+1) in the plan's order. */
  movePlanTask(id: TaskId, delta: number): void;
  readSource(target: EditTarget): { ok: true; text: string } | { ok: false; error: string };
  saveSource(target: EditTarget, text: string): Result;
  /** Open the task's latest run spec in the Playwright Inspector. */
  replaySpec(id: TaskId): Promise<Result>;
}

export interface ManagerOptions {
  argv: string[];
  defaultSkill: string;
  /** Global config settings, under every task's own file settings. */
  settings?: TaskSettings;
  maxParallel: number;
  startRun(spec: RunSpec, human: Human): RunHandle;
  preflight(args: RunArgs): string | null;
  /** The folder file-task names are relative to. Default: the process's current folder. */
  cwd?: string;
  /** Past runs, oldest first: each becomes a task (with its final state) ahead of any added task. */
  past?: PastRun[];
  /** Clock for task creation times (epoch ms). Default: `Date.now`. */
  now?: () => number;
  /** Splits a plan file into scenarios; without it, only planned folders can be opened. */
  planner?: Planner;
  /** Where planned folders are written. Default: "tasks". */
  plansRoot?: string;
  /** Launches the Playwright Inspector. Default: a real `SpecReplays`. */
  replays?: SpecReplays;
}

export const stillRunning = (name: string) => `${name} is still running; replay its spec when it finishes`;
export const notRunYet = (name: string) => `${name} has not run yet`;
export const noSpec = (runId: string) => `no spec for run ${runId}: only a passed run writes duckwright.spec.ts`;
export const openingToast = (runId: string) => `opening ${runId}/duckwright.spec.ts in the Playwright Inspector`;
export const closedToast = (runId: string, code: number | null, specDir: string) =>
  code === 0 || code === null
    ? `Playwright Inspector closed for ${runId}`
    : `Playwright exited with code ${code} for ${runId}; run "npx playwright test duckwright.spec.ts --debug" in ${specDir} to see why`;

/** `"<first line>"`, cut with … so it holds at most `max` code points. */
export function taskName(text: string, max = 40): string {
  const first = [...(text.split(/\r?\n/)[0] ?? "")];
  const body = first.length > max ? [...first.slice(0, Math.max(0, max - 1)), "…"] : first;
  return `"${body.join("")}"`;
}

function effectiveOf(a: RunArgs): Effective {
  return { model: a.model, maxSteps: a.maxSteps, headed: a.headed, snapshot: a.snapshot, video: a.video, screenshot: a.screenshot, jev: a.jev, env: envLabel(a.env) };
}

interface RunRecord {
  handle: RunHandle;
  slot: number;
  session: string;
  bridge: HumanBridge;
  active: boolean; // until `done` settles
  quitStopped: boolean;
  outcome: RunOutcome | null;
}

interface Task {
  id: TaskId;
  text: string;
  name: string;
  source: TaskSource;
  /** Front matter, minus `session` (the slot always wins). Empty for typed tasks. */
  fileSettings: TaskSettings;
  overrides: Overrides;
  state: TaskState;
  error: string | null;
  runs: RunRecord[];
  /** The run folder this task was loaded from; null for tasks added in this session. */
  past: PastRun | null;
  createdAt: number;
  planId: PlanId | null;
}

interface Plan {
  id: PlanId;
  name: string;
  source: string;
  folder: string | null;
  manifest: Manifest | null;
  /** Each task's manifest entry, for writing the order back. */
  entries: Map<TaskId, PlanEntry>;
  state: PlanState;
  error: string | null;
  cost: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  setup: string | null;
  setupPath: string | null;
  taskIds: TaskId[];
  queue: TaskId[];
  abort: AbortController | null;
}

const CONTROL_TO_STATE: Record<ControlState, TaskState> = {
  running: "running", stepping: "running", paused: "paused", stopping: "stopping",
};
const OUTCOME_TO_STATE: Record<RunOutcome["status"], TaskState> = {
  pass: "passed", fail: "failed", stop: "stopped",
};

export class RunManager implements ManagerLike {
  #o: ManagerOptions;
  #now: () => number;
  #tasks: Task[] = [];
  /** Removed tasks that ran: out of the list, but their runs stay in the quit summary. */
  #retired: Task[] = [];
  #nextId = 1;
  /** Global options: above the flags and front matter, below each task's own overrides. */
  #globals: Overrides = {};
  /** Set by stopAll: no run starts after quitting began. */
  #closing = false;
  #listeners: Array<(e: ManagerEvent) => void> = [];
  /** Tasks waiting for a free run slot, started in order as runs finish. */
  #queued: TaskId[] = [];
  #plans: Plan[] = [];
  #nextPlanId = 1;
  #replays: SpecReplays;

  constructor(o: ManagerOptions) {
    this.#o = o;
    this.#replays = o.replays ?? new SpecReplays();
    this.#now = o.now ?? Date.now;
    for (const p of o.past ?? []) {
      const name = p.source.kind === "file" ? this.#fileName(p.source.path) : taskName(p.text);
      this.#tasks.push({
        id: this.#nextId++, text: p.text, name, source: { ...p.source }, fileSettings: p.fileSettings,
        overrides: {}, state: OUTCOME_TO_STATE[p.outcome.status], error: null, runs: [], past: p, createdAt: p.startedAt,
        planId: null,
      });
    }
  }

  /** Show a message in the UI as a toast. */
  notify(level: "info" | "error", message: string): void {
    this.#emit({ type: "toast", level, message });
  }

  list(): TaskSnapshot[] {
    return this.#tasks.map((t) => this.#snapshot(t));
  }

  subscribe(fn: (e: ManagerEvent) => void): () => void {
    this.#listeners.push(fn);
    return () => {
      const i = this.#listeners.indexOf(fn);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }

  addTyped(text: string): TaskId {
    return this.#addTask({ kind: "typed" }, text, {}, taskName(text));
  }

  /**
   * Add one add-box submission: every mentioned file (folders expanded as -f does), then the
   * typed task. All or nothing: if any mention fails, nothing is added and every error is returned.
   */
  add(sub: Submission): AddResult {
    const errors: { mention: number; message: string }[] = [];
    const files: { path: string; tf: TaskFile }[] = [];
    sub.mentions.forEach((mention, i) => {
      const own = (message: string): string => {
        const rest = message.startsWith(mention) ? message.slice(mention.length) : `: ${message}`;
        return mentionToken(mention) + (rest === ": file not found" ? ": not found (type \\@ for a literal @)" : rest);
      };
      for (const p of taskPaths([mention])) {
        if (p instanceof TaskFileError) {
          errors.push({ mention: i, message: own(p.message) });
          continue;
        }
        try {
          files.push({ path: p, tf: loadTaskFile(p) });
        } catch (e) {
          if (!(e instanceof TaskFileError)) throw e;
          errors.push({ mention: i, message: p === mention ? own(e.message) : e.message });
        }
      }
    });
    if (errors.length > 0) return { ok: false, errors };
    // Past runs are history, separate from tasks: they never block adding the same file again.
    const seen = new Set(this.#tasks.flatMap((t) => (t.source.kind === "file" && !t.past ? [resolvePath(t.source.path)] : [])));
    const added: TaskId[] = [];
    const duplicates: string[] = [];
    for (const { path: p, tf } of files) {
      const name = this.#fileName(p);
      const key = resolvePath(p);
      if (seen.has(key)) {
        duplicates.push(name);
        continue;
      }
      seen.add(key);
      const { session: _ignored, ...settings } = tf.settings;
      added.push(this.#addTask({ kind: "file", path: p }, tf.task, settings, name));
    }
    if (sub.typed !== null) added.push(this.addTyped(sub.typed));
    return { ok: true, added, duplicates };
  }

  setOverrides(id: TaskId, o: Overrides): void {
    const task = this.#find(id);
    if (!task) return;
    task.overrides = { ...o };
    this.#updated(task);
  }

  #cwd(): string {
    return this.#o.cwd ?? process.cwd();
  }

  globals(): Globals {
    const parsed = parseRunArgs(this.#o.argv, this.#o.defaultSkill, this.#o.settings);
    if (parsed.kind !== "args") throw new Error("argv does not describe a run");
    return { base: effectiveOf(parsed.args), overrides: { ...this.#globals }, environments: listEnvironments(this.#cwd()) };
  }

  /** Replace the global options; every task's effective settings follow. */
  setGlobals(o: Overrides): void {
    this.#globals = { ...o };
    this.#emit({ type: "globals:updated", globals: this.globals() });
    for (const t of this.#tasks) this.#updated(t);
  }

  remove(id: TaskId): boolean {
    const task = this.#find(id);
    if (!task || this.#activeRun(task)) return false;
    const plan = this.#planOf(task);
    if (plan) {
      plan.taskIds = plan.taskIds.filter((x) => x !== id);
      plan.queue = plan.queue.filter((x) => x !== id);
      plan.entries.delete(id);
      this.#saveManifest(plan);
      this.#planUpdated(plan);
    }
    this.#tasks = this.#tasks.filter((t) => t !== task);
    if (task.runs.length > 0) this.#retired.push(task);
    this.#emit({ type: "task:removed", taskId: id });
    return true;
  }

  effectiveArgs(id: TaskId): RunArgs {
    const task = this.#find(id);
    if (!task) throw new Error(`no task ${id}`);
    return this.#argsFor(task);
  }

  start(id: TaskId): StartResult {
    const task = this.#find(id);
    if (!task) return { ok: false, reason: "no such task" };
    if (this.#closing) return { ok: false, reason: "quitting" };
    if (this.#activeRun(task)) return { ok: false, reason: "already running" };
    const n = this.activeCount();
    if (n >= this.#o.maxParallel) return { ok: false, reason: `${n} runs active (limit ${this.#o.maxParallel})` };
    const args = this.#argsFor(task);
    const problem = this.#o.preflight(args);
    if (problem !== null) {
      task.error = problem;
      this.#updated(task);
      this.#emit({ type: "toast", level: "error", message: problem });
      return { ok: false, reason: problem };
    }
    task.error = null;
    const slot = this.#freeSlot();
    const session = `${args.session}-${slot}`;
    const bridge = new HumanBridge(() => this.#updated(task));
    let handle: RunHandle;
    try {
      const taskFile = task.source.kind === "file" ? task.source.path : null;
      handle = this.#o.startRun({ task: task.text, taskFile, args: { ...args, session } }, bridge);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.error = message;
      this.#updated(task);
      this.#emit({ type: "toast", level: "error", message });
      return { ok: false, reason: message };
    }
    const run: RunRecord = { handle, slot, session, bridge, active: true, quitStopped: false, outcome: null };
    task.runs.push(run);
    task.state = CONTROL_TO_STATE[handle.control.state];
    let started = false;
    handle.events.subscribe((event) => {
      this.#emit({ type: "run", taskId: task.id, runId: handle.id, event });
      if (event.type === "run:start") {
        started = true;
      } else if (event.type === "control") {
        task.state = CONTROL_TO_STATE[event.state];
        this.#updated(task);
      } else if (event.type === "run:end") {
        task.state = OUTCOME_TO_STATE[event.outcome.status];
        this.#updated(task);
      }
    });
    void handle.done.then((outcome) => {
      run.outcome = outcome;
      run.active = false;
      this.#startQueued();
      this.#advancePlans();
      // A run that failed before run:start has no run view to show why: put it on the task.
      if (!started && outcome.error !== null) task.error = outcome.error;
      // Once per settle, so the snapshot carries the final hasSpec.
      this.#updated(task);
      if (outcome.error?.startsWith("playwright error:")) {
        this.#emit({
          type: "toast", level: "error",
          message: `${outcome.error} (if a browser is left open: playwright-cli -s=${run.session} close)`,
        });
      }
    });
    this.#updated(task);
    return { ok: true, runId: handle.id };
  }

  /**
   * Start these tasks in order: as many as the parallel limit allows now, the rest as earlier
   * runs finish. A task that is removed, already running or fails to start is skipped.
   */
  startQueued(ids: TaskId[]): void {
    this.#queued.push(...ids);
    this.#startQueued();
  }

  #startQueued(): void {
    while (this.#queued.length > 0 && !this.#closing && this.activeCount() < this.#o.maxParallel) {
      this.start(this.#queued.shift()!);
    }
  }

  pause(id: TaskId): void {
    this.#activeRunOf(id)?.handle.control.pause();
  }

  resume(id: TaskId): void {
    this.#activeRunOf(id)?.handle.control.resume();
  }

  step(id: TaskId): void {
    this.#activeRunOf(id)?.handle.control.step();
  }

  answerTwoFactor(id: TaskId, value: string | null): void {
    this.#activeRunOf(id)?.bridge.answer(value);
  }

  stop(id: TaskId): void {
    this.#activeRunOf(id)?.handle.control.stop();
  }

  activeCount(): number {
    let n = 0;
    for (const t of this.#tasks) for (const r of t.runs) if (r.active) n++;
    return n;
  }

  async stopAll(): Promise<void> {
    this.#closing = true;
    for (const p of this.#plans) {
      p.queue = [];
      p.abort?.abort();
    }
    // No run can start now; still, wait until none is active (each one once, should `done` reject).
    const waited = new Set<RunRecord>();
    for (;;) {
      const active = this.#tasks.flatMap((t) => t.runs).filter((r) => r.active && !waited.has(r));
      if (active.length === 0) return;
      for (const r of active) {
        waited.add(r);
        r.quitStopped = true;
        r.handle.control.stop();
      }
      await Promise.all(active.map((r) => r.handle.done.then(() => undefined, () => undefined)));
      // `done` handlers registered in start() run before ours, so every outcome is recorded here.
    }
  }

  plans(): PlanSnapshot[] {
    return this.#plans.map((p) => this.#planSnapshot(p));
  }

  plan(source: string): PlanResult {
    const src = source.trim();
    if (src === "") return { ok: false, error: "give a plan file or a planned folder" };
    if (this.#closing) return { ok: false, error: "quitting" };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src);
    } catch {
      return { ok: false, error: `${src}: not found` };
    }
    const now = this.#now();
    const plan: Plan = {
      id: this.#nextPlanId, name: path.basename(path.resolve(src)), source: src, folder: null, manifest: null, entries: new Map(),
      state: "planning", error: null, cost: 0, startedAt: now, endedAt: null, createdAt: now,
      setup: null, setupPath: null, taskIds: [], queue: [], abort: null,
    };
    if (stat.isDirectory()) {
      if (!isPlanFolder(src)) return { ok: false, error: `${src}: not a planned folder (no plan.json)` };
      const key = resolvePath(src);
      if (this.#plans.some((p) => p.folder !== null && resolvePath(p.folder) === key)) return { ok: false, error: `${src}: already open` };
      let loaded: LoadedPlan;
      try {
        loaded = loadPlan(src);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      this.#nextPlanId++;
      this.#plans.push(plan);
      this.#emit({ type: "plan:added", plan: this.#planSnapshot(plan) });
      this.#fill(plan, loaded);
      return { ok: true, id: plan.id };
    }
    if (!this.#o.planner) return { ok: false, error: "planning is not available here" };
    this.#nextPlanId++;
    this.#plans.push(plan);
    this.#emit({ type: "plan:added", plan: this.#planSnapshot(plan) });
    this.#startPlanning(plan);
    return { ok: true, id: plan.id };
  }

  retryPlan(id: PlanId): Result {
    const plan = this.#findPlan(id);
    if (!plan || plan.state !== "failed") return { ok: false, error: "nothing to retry" };
    if (this.#closing) return { ok: false, error: "quitting" };
    if (!this.#o.planner) return { ok: false, error: "planning is not available here" };
    this.#startPlanning(plan);
    return { ok: true };
  }

  cancelPlan(id: PlanId): void {
    this.#findPlan(id)?.abort?.abort();
  }

  runPlan(id: PlanId, which: "all" | "failed"): Result {
    const plan = this.#findPlan(id);
    if (!plan || plan.state !== "ready") return { ok: false, error: "the plan has no tasks yet" };
    if (this.#closing) return { ok: false, error: "quitting" };
    if (this.#planBusy(plan)) return { ok: false, error: "the plan is already running" };
    const ids = plan.taskIds.filter((x) => {
      const t = this.#find(x);
      return t !== undefined && (which === "all" || t.state === "failed" || t.state === "stopped");
    });
    if (ids.length === 0) return { ok: false, error: which === "all" ? "the plan has no tasks" : "no failed tasks to run again" };
    plan.queue = ids;
    this.#planUpdated(plan);
    this.#advancePlans();
    return { ok: true };
  }

  stopPlan(id: PlanId): void {
    const plan = this.#findPlan(id);
    if (!plan) return;
    plan.queue = [];
    this.#planUpdated(plan);
    for (const x of plan.taskIds) this.stop(x);
  }

  removePlan(id: PlanId): boolean {
    const plan = this.#findPlan(id);
    if (!plan || plan.state === "planning" || this.#planBusy(plan)) return false;
    for (const x of [...plan.taskIds]) {
      const task = this.#find(x);
      if (!task) continue;
      // Not through remove(): the manifest keeps every task, so the folder opens whole again.
      this.#tasks = this.#tasks.filter((t) => t !== task);
      if (task.runs.length > 0) this.#retired.push(task);
      this.#emit({ type: "task:removed", taskId: x });
    }
    this.#plans = this.#plans.filter((p) => p !== plan);
    this.#emit({ type: "plan:removed", planId: id });
    return true;
  }

  movePlanTask(id: TaskId, delta: number): void {
    const task = this.#find(id);
    const plan = task ? this.#planOf(task) : undefined;
    if (!plan) return;
    const i = plan.taskIds.indexOf(id);
    const j = Math.max(0, Math.min(plan.taskIds.length - 1, i + delta));
    if (i === -1 || i === j) return;
    const ids = [...plan.taskIds];
    ids.splice(i, 1);
    ids.splice(j, 0, id);
    plan.taskIds = ids;
    this.#saveManifest(plan);
    this.#planUpdated(plan);
  }

  readSource(target: EditTarget): { ok: true; text: string } | { ok: false; error: string } {
    if (target.kind === "setup") {
      const plan = this.#findPlan(target.planId);
      if (!plan?.setupPath) return { ok: false, error: "this plan has no shared setup" };
      return readText(plan.setupPath);
    }
    const task = this.#find(target.id);
    if (!task) return { ok: false, error: "no such task" };
    if (task.past) return { ok: false, error: "a past run cannot be edited" };
    return task.source.kind === "file" ? readText(task.source.path) : { ok: true, text: task.text };
  }

  saveSource(target: EditTarget, text: string): Result {
    if (target.kind === "setup") return this.#saveSetup(target.planId, text);
    const task = this.#find(target.id);
    if (!task) return { ok: false, error: "no such task" };
    if (task.past) return { ok: false, error: "a past run cannot be edited" };
    if (this.#activeRun(task)) return { ok: false, error: "the task is running" };
    if (task.source.kind === "typed") {
      const typed = text.trim();
      if (typed === "") return { ok: false, error: "the task is empty" };
      task.text = typed;
      task.name = taskName(typed);
      this.#updated(task);
      return { ok: true };
    }
    const file = task.source.path;
    const before = readText(file);
    try {
      fs.writeFileSync(file, text);
      const tf = loadTaskFile(file);
      const { session: _ignored, ...settings } = tf.settings;
      task.text = tf.task;
      task.fileSettings = settings;
      task.error = null;
    } catch (e) {
      // Put the file back as it was, so a bad edit never sticks.
      if (before.ok) {
        try {
          fs.writeFileSync(file, before.text);
        } catch {
          // reported below with the edit's own error
        }
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.#updated(task);
    return { ok: true };
  }

  async replaySpec(id: TaskId): Promise<Result> {
    const task = this.#find(id);
    if (!task) return { ok: false, error: "no such task" };
    if (task.state === "running" || task.state === "paused" || task.state === "stopping") {
      return { ok: false, error: stillRunning(task.name) };
    }
    const spec = this.#specOf(task);
    if (!spec) return { ok: false, error: notRunYet(task.name) };
    if (!fs.existsSync(spec.path)) return { ok: false, error: noSpec(spec.runId) };
    const specDir = path.dirname(spec.path);
    const r = await this.#replays.launch(spec.runId, spec.path, (code) => {
      this.notify("info", closedToast(spec.runId, code, specDir));
    });
    if (!r.ok) return r;
    this.notify("info", openingToast(spec.runId));
    return { ok: true };
  }

  summary(): { lines: string[]; exitCode: number } {
    const rows: Array<{ name: string; outcome: RunOutcome }> = [];
    let total = 0;
    let quit = false;
    // Removed tasks' runs count too; ids follow the order the tasks were added.
    const tasks = [...this.#retired, ...this.#tasks].sort((a, b) => a.id - b.id);
    for (const t of tasks) {
      let latest: RunOutcome | null = null;
      for (const r of t.runs) {
        if (r.quitStopped) quit = true;
        if (!r.outcome) continue;
        total += r.outcome.costUsd;
        latest = r.outcome;
      }
      if (latest) rows.push({ name: t.name, outcome: latest });
    }
    if (rows.length === 0 && !quit) return { lines: [], exitCode: 0 };
    const count = (s: RunOutcome["status"]) => rows.filter((r) => r.outcome.status === s).length;
    const w = Math.max(0, ...rows.map((r) => r.name.length));
    const lines = [
      `Batch: ${count("pass")} passed, ${count("fail")} failed, ${count("stop")} stopped  Cost: $${fixed4(total)}`,
      ...rows.map((r) =>
        `${r.outcome.status}  ${r.name.padEnd(w)}  $${fixed4(r.outcome.costUsd)}  ${r.outcome.historyPath ?? "-"}`),
    ];
    const exitCode = quit ? 130 : rows.every((r) => r.outcome.status === "pass") ? 0 : 1;
    return { lines, exitCode };
  }

  #saveSetup(id: PlanId, text: string): Result {
    const plan = this.#findPlan(id);
    if (!plan?.setupPath) return { ok: false, error: "this plan has no shared setup" };
    if (text.trim() === "") return { ok: false, error: "the setup is empty" };
    if (this.#planBusy(plan)) return { ok: false, error: "the plan is running" };
    try {
      fs.writeFileSync(plan.setupPath, text);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    plan.setup = text.trim();
    // Every task of the plan puts the setup first, so read each one again.
    for (const x of plan.taskIds) {
      const task = this.#find(x);
      if (!task || task.source.kind !== "file") continue;
      try {
        task.text = loadTaskFile(task.source.path).task;
        task.error = null;
      } catch (e) {
        task.error = e instanceof Error ? e.message : String(e);
      }
      this.#updated(task);
    }
    this.#planUpdated(plan);
    return { ok: true };
  }

  #startPlanning(plan: Plan): void {
    const planner = this.#o.planner!;
    const abort = new AbortController();
    Object.assign(plan, { state: "planning", error: null, startedAt: this.#now(), endedAt: null, abort });
    this.#planUpdated(plan);
    const g = this.globals();
    const model = g.overrides.model ?? g.base.model;
    let env: string | null;
    if (this.#globals.env !== undefined) env = this.#globals.env === ENV_NONE ? null : this.#globals.env;
    else {
      const parsed = parseRunArgs(this.#o.argv, this.#o.defaultSkill, this.#o.settings);
      if (parsed.kind !== "args") throw new Error("argv does not describe a run");
      env = parsed.args.env;
    }
    if (env !== null && isEnvPath(env)) env = resolveEnv(env, this.#cwd()).path;
    // Called at once (a throw becomes a rejection), so a cancel right after still reaches the planner.
    void new Promise<{ doc: PlanDoc; cost: number }>((resolve) => resolve(planner({ planFile: plan.source, model, signal: abort.signal })))
      .then(({ doc, cost }) => {
        plan.cost += cost;
        if (abort.signal.aborted) throw new PlanError("cancelled");
        this.#fill(plan, writePlan(doc, plan.source, this.#o.plansRoot ?? "tasks", env));
      })
      .catch((e: unknown) => {
        if (e instanceof PlanError) plan.cost += e.cost;
        plan.state = "failed";
        plan.error = abort.signal.aborted ? "cancelled" : e instanceof Error ? e.message : String(e);
        this.#emit({ type: "toast", level: "error", message: `${plan.name}: ${plan.error}` });
      })
      .finally(() => {
        plan.abort = null;
        plan.endedAt = this.#now();
        this.#planUpdated(plan);
      });
  }

  /** Add a loaded plan's tasks under it; a task file that no longer loads is skipped and reported. */
  #fill(plan: Plan, loaded: LoadedPlan): void {
    const m = loaded.manifest;
    Object.assign(plan, {
      folder: loaded.folder, manifest: m, name: m.name, setupPath: loaded.setupPath, state: "ready", error: null,
      endedAt: plan.endedAt ?? this.#now(),
    });
    if (loaded.setupPath !== null) {
      const r = readText(loaded.setupPath);
      plan.setup = r.ok ? r.text.trim() : null;
    }
    for (const entry of loaded.tasks) {
      let tf;
      try {
        tf = loadTaskFile(entry.path);
      } catch (e) {
        this.#emit({ type: "toast", level: "error", message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const { session: _ignored, ...settings } = tf.settings;
      const id = this.#addTask({ kind: "file", path: entry.path }, tf.task, settings, `${entry.id}: ${entry.title}`, plan.id);
      plan.taskIds.push(id);
      plan.entries.set(id, { file: entry.file, id: entry.id, title: entry.title });
    }
    this.#planUpdated(plan);
  }

  /** Start the queued tasks of each running plan, in order, while parallel slots are free. */
  #advancePlans(): void {
    for (const plan of this.#plans) {
      if (plan.queue.length === 0) continue;
      while (plan.queue.length > 0) {
        if (this.#closing) {
          plan.queue = [];
          break;
        }
        if (this.activeCount() >= this.#o.maxParallel) break;
        const id = plan.queue.shift()!;
        const task = this.#find(id);
        if (!task || this.#activeRun(task)) continue;
        // A task that cannot start (the manager already said why) ends the plan run.
        if (!this.start(id).ok) plan.queue = [];
      }
      this.#planUpdated(plan);
    }
  }

  #planBusy(plan: Plan): boolean {
    return plan.queue.length > 0 || plan.taskIds.some((x) => this.#activeRunOf(x) !== undefined);
  }

  /** Write the plan's order back to plan.json; a failed write is reported, and the list keeps the new order. */
  #saveManifest(plan: Plan): void {
    if (plan.folder === null || plan.manifest === null) return;
    const tasks = plan.taskIds.flatMap((x) => plan.entries.get(x) ?? []);
    plan.manifest = { ...plan.manifest, tasks };
    try {
      writeManifest(plan.folder, plan.manifest);
    } catch (e) {
      this.#emit({ type: "toast", level: "error", message: `could not save the plan order: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  #planSnapshot(p: Plan): PlanSnapshot {
    return {
      id: p.id, name: p.name, source: p.source, folder: p.folder, state: p.state, error: p.error, cost: p.cost,
      startedAt: p.startedAt, endedAt: p.endedAt, createdAt: p.createdAt, setup: p.setup, setupPath: p.setupPath,
      notes: [...(p.manifest?.notes ?? [])], skipped: (p.manifest?.skipped ?? []).map((x) => ({ ...x })),
      taskIds: [...p.taskIds], queued: [...p.queue],
    };
  }

  #planUpdated(p: Plan): void {
    this.#emit({ type: "plan:updated", plan: this.#planSnapshot(p) });
  }

  #findPlan(id: PlanId): Plan | undefined {
    return this.#plans.find((p) => p.id === id);
  }

  #planOf(task: Task): Plan | undefined {
    return task.planId === null ? undefined : this.#findPlan(task.planId);
  }

  #argsFor(task: Task, own = true): RunArgs {
    const parsed = parseRunArgs(this.#o.argv, this.#o.defaultSkill, { ...this.#o.settings, ...task.fileSettings });
    if (parsed.kind !== "args") throw new Error("argv does not describe a run");
    const args = { ...parsed.args };
    for (const o of own ? [this.#globals, task.overrides] : [this.#globals]) {
      if (o.model !== undefined) args.model = o.model;
      if (o.maxSteps !== undefined) args.maxSteps = o.maxSteps;
      if (o.headed !== undefined) args.headed = o.headed;
      if (o.snapshot !== undefined) args.snapshot = o.snapshot;
      if (o.video !== undefined) args.video = o.video;
      if (o.screenshot !== undefined) args.screenshot = o.screenshot;
      if (o.jev !== undefined) args.jev = o.jev;
      if (o.env !== undefined) args.env = o.env === ENV_NONE ? null : o.env;
    }
    if (args.env !== null && (isEnvName(args.env) || isEnvPath(args.env))) args.env = resolveEnv(args.env, this.#cwd()).path;
    return args;
  }

  /** The folder of the task's latest run (the session's, else the past one) and its spec path. */
  #specOf(task: Task): { runId: string; path: string } | null {
    const latest = task.runs[task.runs.length - 1];
    let workdir: string | undefined;
    if (latest) workdir = latest.active ? undefined : latest.handle.workdir;
    else workdir = task.past?.workdir;
    if (!workdir) return null;
    return {
      runId: path.basename(workdir),
      path: path.resolve(this.#cwd(), workdir, SPEC_NAME),
    };
  }

  #snapshot(task: Task): TaskSnapshot {
    const a = this.#argsFor(task);
    const latest = task.runs[task.runs.length - 1];
    const snap: TaskSnapshot = {
      id: task.id, text: task.text, name: task.name, source: { ...task.source }, state: task.state,
      overrides: { ...task.overrides },
      effective: effectiveOf(a),
      inherited: effectiveOf(this.#argsFor(task, false)),
      error: task.error, runId: latest ? latest.handle.id : (task.past?.id ?? null), runCount: task.runs.length,
      createdAt: task.createdAt,
      twofa: this.#activeRun(task)?.bridge.pending ?? null,
      hasSpec: this.#hasSpec(task),
    };
    // runId is the latest session run's id after a re-run (else the folder id), like the snapshot's runId; the UI only replays at mount.
    if (task.past) snap.past = { runId: snap.runId ?? task.past.id, events: task.past.events };
    if (task.planId !== null) snap.planId = task.planId;
    return snap;
  }

  #hasSpec(task: Task): boolean {
    if (task.state === "running" || task.state === "paused" || task.state === "stopping") return false;
    try {
      const spec = this.#specOf(task);
      return spec !== null && fs.existsSync(spec.path);
    } catch {
      return false;
    }
  }

  #addTask(source: TaskSource, text: string, fileSettings: TaskSettings, name: string, planId: PlanId | null = null): TaskId {
    const task: Task = {
      id: this.#nextId++, text, name, source, fileSettings, overrides: {}, state: "idle", error: null, runs: [], past: null,
      createdAt: this.#now(), planId,
    };
    this.#tasks.push(task);
    this.#emit({ type: "task:added", task: this.#snapshot(task) });
    return task.id;
  }

  /** A file task's name: its path relative to the current folder. */
  #fileName(p: string): string {
    return path.relative(resolvePath(this.#cwd()), resolvePath(p)) || p;
  }

  #find(id: TaskId): Task | undefined {
    return this.#tasks.find((t) => t.id === id);
  }

  #activeRun(task: Task): RunRecord | undefined {
    const latest = task.runs[task.runs.length - 1];
    return latest?.active ? latest : undefined;
  }

  #activeRunOf(id: TaskId): RunRecord | undefined {
    const task = this.#find(id);
    return task ? this.#activeRun(task) : undefined;
  }

  #freeSlot(): number {
    const used = new Set<number>();
    for (const t of this.#tasks) for (const r of t.runs) if (r.active) used.add(r.slot);
    let slot = 1;
    while (used.has(slot)) slot++;
    return slot;
  }

  #updated(task: Task): void {
    this.#emit({ type: "task:updated", task: this.#snapshot(task) });
  }

  #emit(e: ManagerEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch {
        // a throwing listener must not break the manager
      }
    }
  }
}

function readText(p: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: fs.readFileSync(p, "utf8") };
  } catch (e) {
    return { ok: false, error: `${p}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : (e as Error).message}` };
  }
}
