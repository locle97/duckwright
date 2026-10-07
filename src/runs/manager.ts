// Holds typed and file tasks and their runs, with no UI: starts runs in numbered browser-session
// slots, forwards their events, and builds the quit summary.
import path from "node:path";

import { parseRunArgs } from "../args.ts";
import type { RunArgs } from "../args.ts";
import type { ControlState, RunEvent, RunOutcome, TwofaWait } from "../events.ts";
import type { SnapshotMode } from "../observe.ts";
import { resolvePath } from "../paths.ts";
import { loadTaskFile, TaskFileError, taskPaths } from "../taskfile.ts";
import type { TaskFile, TaskSettings } from "../taskfile.ts";
import { fixed4, mentionToken } from "../text.ts";
import type { Human } from "../twofa.ts";
import { HumanBridge } from "./humanBridge.ts";
import type { PastRun } from "./past.ts";
import type { RunHandle, RunSpec } from "./run.ts";

export type TaskId = number;
export type TaskState = "idle" | "running" | "paused" | "passed" | "failed" | "stopping" | "stopped";
export interface Overrides { model?: string; maxSteps?: number; headed?: boolean; export?: boolean; snapshot?: SnapshotMode }
export interface Effective { model: string; maxSteps: number; headed: boolean; export: boolean; snapshot: SnapshotMode }
/** The options every task's next run starts from: `base` is the defaults and flags, `overrides` the edits on top. */
export interface Globals { base: Effective; overrides: Overrides }
export type TaskSource = { kind: "typed" } | { kind: "file"; path: string };
/** One submission of the add box: mentioned paths in order, and the leftover typed task. */
export interface Submission { mentions: string[]; typed: string | null }
export type AddResult =
  | { ok: true; added: TaskId[]; duplicates: string[] }
  | { ok: false; errors: { mention: number; message: string }[] };
export interface TaskSnapshot {
  id: TaskId; text: string; name: string; source: TaskSource; state: TaskState; overrides: Overrides; effective: Effective;
  error: string | null; runId: string | null; runCount: number;
  /** Set while the task's active run waits for a 2FA answer. */
  twofa: { kind: TwofaWait } | null;
  /** Epoch ms the task was created (past runs: the run's start). Never changes. */
  createdAt: number;
  /** Set for tasks that came from a past run folder. */
  past?: { runId: string; events: RunEvent[] };
}
export type ManagerEvent =
  | { type: "run"; taskId: TaskId; runId: string; event: RunEvent }
  | { type: "task:added"; task: TaskSnapshot }
  | { type: "task:updated"; task: TaskSnapshot }
  | { type: "task:removed"; taskId: TaskId }
  | { type: "toast"; level: "info" | "error"; message: string }
  | { type: "globals:updated"; globals: Globals };
export type StartResult = { ok: true; runId: string } | { ok: false; reason: string };

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
}

export interface ManagerOptions {
  argv: string[];
  defaultSkill: string;
  maxParallel: number;
  startRun(spec: RunSpec, human: Human): RunHandle;
  preflight(args: RunArgs): string | null;
  /** The folder file-task names are relative to. Default: the process's current folder. */
  cwd?: string;
  /** Past runs, oldest first: each becomes a task (with its final state) ahead of any added task. */
  past?: PastRun[];
  /** Clock for task creation times (epoch ms). Default: `Date.now`. */
  now?: () => number;
}

/** `"<first line>"`, cut with … so it holds at most `max` code points. */
export function taskName(text: string, max = 40): string {
  const first = [...(text.split(/\r?\n/)[0] ?? "")];
  const body = first.length > max ? [...first.slice(0, Math.max(0, max - 1)), "…"] : first;
  return `"${body.join("")}"`;
}

function effectiveOf(a: RunArgs): Effective {
  return { model: a.model, maxSteps: a.maxSteps, headed: a.headed, export: a.export, snapshot: a.snapshot };
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

  constructor(o: ManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    for (const p of o.past ?? []) {
      const name = p.source.kind === "file" ? this.#fileName(p.source.path) : taskName(p.text);
      this.#tasks.push({
        id: this.#nextId++, text: p.text, name, source: { ...p.source }, fileSettings: p.fileSettings,
        overrides: {}, state: OUTCOME_TO_STATE[p.outcome.status], error: null, runs: [], past: p, createdAt: p.startedAt,
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
    const seen = new Set(this.#tasks.flatMap((t) => (t.source.kind === "file" ? [resolvePath(t.source.path)] : [])));
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

  globals(): Globals {
    const parsed = parseRunArgs(this.#o.argv, this.#o.defaultSkill);
    if (parsed.kind !== "args") throw new Error("argv does not describe a run");
    return { base: effectiveOf(parsed.args), overrides: { ...this.#globals } };
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
      // A run that failed before run:start has no run view to show why: put it on the task.
      if (!started && outcome.error !== null) {
        task.error = outcome.error;
        this.#updated(task);
      }
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

  #argsFor(task: Task): RunArgs {
    const parsed = parseRunArgs(this.#o.argv, this.#o.defaultSkill, task.fileSettings);
    if (parsed.kind !== "args") throw new Error("argv does not describe a run");
    const args = { ...parsed.args };
    for (const o of [this.#globals, task.overrides]) {
      if (o.model !== undefined) args.model = o.model;
      if (o.maxSteps !== undefined) args.maxSteps = o.maxSteps;
      if (o.headed !== undefined) args.headed = o.headed;
      if (o.export !== undefined) args.export = o.export;
      if (o.snapshot !== undefined) args.snapshot = o.snapshot;
    }
    return args;
  }

  #snapshot(task: Task): TaskSnapshot {
    const a = this.#argsFor(task);
    const latest = task.runs[task.runs.length - 1];
    const snap: TaskSnapshot = {
      id: task.id, text: task.text, name: task.name, source: { ...task.source }, state: task.state,
      overrides: { ...task.overrides },
      effective: effectiveOf(a),
      error: task.error, runId: latest ? latest.handle.id : (task.past?.id ?? null), runCount: task.runs.length,
      createdAt: task.createdAt,
      twofa: this.#activeRun(task)?.bridge.pending ?? null,
    };
    // runId is the latest session run's id after a re-run (else the folder id), like the snapshot's runId; the UI only replays at mount.
    if (task.past) snap.past = { runId: snap.runId ?? task.past.id, events: task.past.events };
    return snap;
  }

  #addTask(source: TaskSource, text: string, fileSettings: TaskSettings, name: string): TaskId {
    const task: Task = {
      id: this.#nextId++, text, name, source, fileSettings, overrides: {}, state: "idle", error: null, runs: [], past: null, createdAt: this.#now(),
    };
    this.#tasks.push(task);
    this.#emit({ type: "task:added", task: this.#snapshot(task) });
    return task.id;
  }

  /** A file task's name: its path relative to the current folder. */
  #fileName(p: string): string {
    return path.relative(resolvePath(this.#o.cwd ?? process.cwd()), resolvePath(p)) || p;
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
