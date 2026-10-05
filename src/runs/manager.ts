// Holds typed tasks and their runs, with no UI: starts runs in numbered browser-session slots,
// forwards their events, and builds the quit summary.
import { parseRunArgs } from "../args.ts";
import type { RunArgs } from "../args.ts";
import type { ControlState, RunEvent, RunOutcome } from "../events.ts";
import type { SnapshotMode } from "../observe.ts";
import { fixed4 } from "../text.ts";
import type { RunHandle, RunSpec } from "./run.ts";

export type TaskId = number;
export type TaskState = "idle" | "running" | "paused" | "passed" | "failed" | "stopping" | "stopped";
export interface Overrides { model?: string; maxSteps?: number; headed?: boolean; export?: boolean; snapshot?: SnapshotMode }
export interface Effective { model: string; maxSteps: number; headed: boolean; export: boolean; snapshot: SnapshotMode }
export interface TaskSnapshot {
  id: TaskId; text: string; name: string; state: TaskState; overrides: Overrides; effective: Effective;
  error: string | null; runId: string | null; runCount: number;
}
export type ManagerEvent =
  | { type: "run"; taskId: TaskId; runId: string; event: RunEvent }
  | { type: "task:added"; task: TaskSnapshot }
  | { type: "task:updated"; task: TaskSnapshot }
  | { type: "task:removed"; taskId: TaskId }
  | { type: "toast"; level: "info" | "error"; message: string };
export type StartResult = { ok: true; runId: string } | { ok: false; reason: string };

export interface ManagerLike {
  list(): TaskSnapshot[];
  subscribe(fn: (e: ManagerEvent) => void): () => void;
  addTyped(text: string): TaskId;
  setOverrides(id: TaskId, o: Overrides): void;
  remove(id: TaskId): boolean;
  start(id: TaskId): StartResult;
  pause(id: TaskId): void;
  resume(id: TaskId): void;
  step(id: TaskId): void;
  stop(id: TaskId): void;
  activeCount(): number;
  stopAll(): Promise<void>;
}

export interface ManagerOptions {
  argv: string[];
  defaultSkill: string;
  maxParallel: number;
  startRun(spec: RunSpec): RunHandle;
  preflight(args: RunArgs): string | null;
}

/** `"<first line>"`, cut with … so it holds at most `max` code points. */
export function taskName(text: string, max = 40): string {
  const first = [...(text.split(/\r?\n/)[0] ?? "")];
  const body = first.length > max ? [...first.slice(0, Math.max(0, max - 1)), "…"] : first;
  return `"${body.join("")}"`;
}

interface RunRecord {
  handle: RunHandle;
  slot: number;
  session: string;
  active: boolean; // until `done` settles
  quitStopped: boolean;
  outcome: RunOutcome | null;
}

interface Task {
  id: TaskId;
  text: string;
  overrides: Overrides;
  state: TaskState;
  error: string | null;
  runs: RunRecord[];
}

const CONTROL_TO_STATE: Record<ControlState, TaskState> = {
  running: "running", stepping: "running", paused: "paused", stopping: "stopping",
};
const OUTCOME_TO_STATE: Record<RunOutcome["status"], TaskState> = {
  pass: "passed", fail: "failed", stop: "stopped",
};

export class RunManager implements ManagerLike {
  #o: ManagerOptions;
  #tasks: Task[] = [];
  #nextId = 1;
  #listeners: Array<(e: ManagerEvent) => void> = [];

  constructor(o: ManagerOptions) {
    this.#o = o;
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
    const task: Task = { id: this.#nextId++, text, overrides: {}, state: "idle", error: null, runs: [] };
    this.#tasks.push(task);
    this.#emit({ type: "task:added", task: this.#snapshot(task) });
    return task.id;
  }

  setOverrides(id: TaskId, o: Overrides): void {
    const task = this.#find(id);
    if (!task) return;
    task.overrides = { ...o };
    this.#updated(task);
  }

  remove(id: TaskId): boolean {
    const task = this.#find(id);
    if (!task || this.#activeRun(task)) return false;
    this.#tasks = this.#tasks.filter((t) => t !== task);
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
    let handle: RunHandle;
    try {
      handle = this.#o.startRun({ task: task.text, taskFile: null, args: { ...args, session } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.error = message;
      this.#updated(task);
      this.#emit({ type: "toast", level: "error", message });
      return { ok: false, reason: message };
    }
    const run: RunRecord = { handle, slot, session, active: true, quitStopped: false, outcome: null };
    task.runs.push(run);
    task.state = CONTROL_TO_STATE[handle.control.state];
    handle.events.subscribe((event) => {
      this.#emit({ type: "run", taskId: task.id, runId: handle.id, event });
      if (event.type === "control") {
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

  stop(id: TaskId): void {
    this.#activeRunOf(id)?.handle.control.stop();
  }

  activeCount(): number {
    let n = 0;
    for (const t of this.#tasks) for (const r of t.runs) if (r.active) n++;
    return n;
  }

  async stopAll(): Promise<void> {
    const active = this.#tasks.flatMap((t) => t.runs).filter((r) => r.active);
    for (const r of active) {
      r.quitStopped = true;
      r.handle.control.stop();
    }
    await Promise.all(active.map((r) => r.handle.done.then(() => undefined, () => undefined)));
    // `done` handlers registered in start() run before ours, so every outcome is recorded here.
  }

  summary(): { lines: string[]; exitCode: number } {
    const rows: Array<{ name: string; outcome: RunOutcome }> = [];
    let total = 0;
    let quit = false;
    for (const t of this.#tasks) {
      let latest: RunOutcome | null = null;
      for (const r of t.runs) {
        if (r.quitStopped) quit = true;
        if (!r.outcome) continue;
        total += r.outcome.costUsd;
        latest = r.outcome;
      }
      if (latest) rows.push({ name: taskName(t.text), outcome: latest });
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
    const parsed = parseRunArgs(this.#o.argv, this.#o.defaultSkill, {});
    if (parsed.kind !== "args") throw new Error("argv does not describe a run");
    const args = { ...parsed.args };
    const o = task.overrides;
    if (o.model !== undefined) args.model = o.model;
    if (o.maxSteps !== undefined) args.maxSteps = o.maxSteps;
    if (o.headed !== undefined) args.headed = o.headed;
    if (o.export !== undefined) args.export = o.export;
    if (o.snapshot !== undefined) args.snapshot = o.snapshot;
    return args;
  }

  #snapshot(task: Task): TaskSnapshot {
    const a = this.#argsFor(task);
    const latest = task.runs[task.runs.length - 1];
    return {
      id: task.id, text: task.text, name: taskName(task.text), state: task.state,
      overrides: { ...task.overrides },
      effective: { model: a.model, maxSteps: a.maxSteps, headed: a.headed, export: a.export, snapshot: a.snapshot },
      error: task.error, runId: latest ? latest.handle.id : null, runCount: task.runs.length,
    };
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
