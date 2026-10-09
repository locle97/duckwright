// A scripted ManagerLike for the Ink app tests: records every call and lets a test emit events.
import type { Decision } from "../../src/brain.ts";
import type { RunEvent, RunOutcome } from "../../src/events.ts";
import { taskName } from "../../src/runs/manager.ts";
import type {
  AddResult, EditTarget, Globals, ManagerEvent, ManagerLike, Overrides, PlanId, PlanResult, PlanSnapshot, Result, StartResult,
  Submission, TaskId, TaskSnapshot,
} from "../../src/runs/manager.ts";

export function snapshot(id: TaskId, text: string, over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id, text, name: taskName(text), source: { kind: "typed" }, state: "idle", overrides: {},
    effective: { model: "sonnet", maxSteps: 25, headed: false, snapshot: "hybrid", video: false, screenshot: false, jev: false, env: null },
    inherited: { model: "sonnet", maxSteps: 25, headed: false, snapshot: "hybrid", video: false, screenshot: false, jev: false, env: null },
    error: null, runId: null, runCount: 0, createdAt: 0,
    twofa: null, hasSpec: false, ...over,
  };
}

export function planSnapshot(id: PlanId, taskIds: TaskId[], over: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    id, name: "qa-plan.md", source: "qa-plan.md", folder: "tasks/qa-plan", state: "ready", error: null, cost: 0.12,
    startedAt: 0, endedAt: 1000, createdAt: 0, setup: "Log in as qa.", setupPath: "tasks/qa-plan/shared/setup.md",
    notes: [], skipped: [], taskIds, queued: [], ...over,
  };
}

export class FakeManager implements ManagerLike {
  tasks: TaskSnapshot[];
  plansValue: PlanSnapshot[] = [];
  /** What plan() returns. */
  planResult: PlanResult = { ok: true, id: 1 };
  /** What readSource() and saveSource() return. */
  sourceText = "the source";
  saveResult: Result = { ok: true };
  /** Every call, in order, as "method" or "method:arg". */
  log: string[] = [];
  overrides: Array<{ id: TaskId; o: Overrides }> = [];
  active = 0;
  /** What replaySpec() returns. */
  replayResult: Result = { ok: true };
  startResult: StartResult = { ok: true, runId: "r1" };
  stopAllResult: Promise<void> = Promise.resolve();
  /** What add() returns; by default it adds the typed task and reports it. */
  addResult: AddResult | null = null;
  /** What globals() returns; setGlobals replaces its overrides. */
  globalsValue: Globals = { base: snapshot(0, "").effective, overrides: {}, environments: [] };
  /** Every setGlobals argument, in order. */
  globalsSaved: Overrides[] = [];
  /** Every answerTwoFactor call, in order (null = cancel). */
  twofaAnswers: Array<{ id: TaskId; value: string | null }> = [];
  #listeners: Array<(e: ManagerEvent) => void> = [];
  #nextId: number;

  constructor(tasks: TaskSnapshot[] = []) {
    this.tasks = tasks;
    this.#nextId = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  }

  answerTwoFactor(id: TaskId, value: string | null): void {
    this.log.push(`answerTwoFactor:${id}`);
    this.twofaAnswers.push({ id, value });
  }

  list(): TaskSnapshot[] {
    return [...this.tasks];
  }

  subscribe(fn: (e: ManagerEvent) => void): () => void {
    this.#listeners.push(fn);
    return () => {
      this.#listeners = this.#listeners.filter((x) => x !== fn);
    };
  }

  emit(e: ManagerEvent): void {
    for (const fn of [...this.#listeners]) fn(e);
  }

  addTyped(text: string): TaskId {
    this.log.push(`addTyped:${text}`);
    const task = snapshot(this.#nextId++, text);
    this.tasks.push(task);
    this.emit({ type: "task:added", task });
    return task.id;
  }

  add(sub: Submission): AddResult {
    this.log.push(`add:${sub.mentions.join(",")}|${sub.typed ?? ""}`);
    if (this.addResult !== null) return this.addResult;
    const added: TaskId[] = [];
    if (sub.typed !== null) {
      const task = snapshot(this.#nextId++, sub.typed);
      this.tasks.push(task);
      this.emit({ type: "task:added", task });
      added.push(task.id);
    }
    return { ok: true, added, duplicates: [] };
  }

  setOverrides(id: TaskId, o: Overrides): void {
    this.log.push(`setOverrides:${id}`);
    this.overrides.push({ id, o });
  }

  globals(): Globals {
    return { base: { ...this.globalsValue.base }, overrides: { ...this.globalsValue.overrides }, environments: [...this.globalsValue.environments] };
  }

  setGlobals(o: Overrides): void {
    this.log.push("setGlobals");
    this.globalsSaved.push(o);
    this.globalsValue = { ...this.globalsValue, overrides: { ...o } };
    this.emit({ type: "globals:updated", globals: this.globals() });
  }

  remove(id: TaskId): boolean {
    this.log.push(`remove:${id}`);
    return true;
  }

  start(id: TaskId): StartResult {
    this.log.push(`start:${id}`);
    return this.startResult;
  }

  pause(id: TaskId): void {
    this.log.push(`pause:${id}`);
  }

  resume(id: TaskId): void {
    this.log.push(`resume:${id}`);
  }

  step(id: TaskId): void {
    this.log.push(`step:${id}`);
  }

  stop(id: TaskId): void {
    this.log.push(`stop:${id}`);
  }

  async replaySpec(id: TaskId): Promise<Result> {
    this.log.push(`replaySpec:${id}`);
    return this.replayResult;
  }

  activeCount(): number {
    return this.active;
  }

  stopAll(): Promise<void> {
    this.log.push("stopAll");
    return this.stopAllResult;
  }

  plans(): PlanSnapshot[] {
    return [...this.plansValue];
  }

  plan(source: string): PlanResult {
    this.log.push(`plan:${source}`);
    return this.planResult;
  }

  retryPlan(id: PlanId): Result {
    this.log.push(`retryPlan:${id}`);
    return { ok: true };
  }

  cancelPlan(id: PlanId): void {
    this.log.push(`cancelPlan:${id}`);
  }

  runPlan(id: PlanId, which: "all" | "failed"): Result {
    this.log.push(`runPlan:${id}:${which}`);
    return { ok: true };
  }

  stopPlan(id: PlanId): void {
    this.log.push(`stopPlan:${id}`);
  }

  removePlan(id: PlanId): boolean {
    this.log.push(`removePlan:${id}`);
    return true;
  }

  movePlanTask(id: TaskId, delta: number): void {
    this.log.push(`movePlanTask:${id}:${delta}`);
  }

  readSource(target: EditTarget): { ok: true; text: string } | { ok: false; error: string } {
    this.log.push(`readSource:${target.kind === "task" ? target.id : `setup${target.planId}`}`);
    return { ok: true, text: this.sourceText };
  }

  saveSource(target: EditTarget, text: string): Result {
    this.log.push(`saveSource:${target.kind === "task" ? target.id : `setup${target.planId}`}:${text}`);
    return this.saveResult;
  }

  /** Replace a task's snapshot and emit `task:updated`. */
  update(id: TaskId, over: Partial<TaskSnapshot>): void {
    const i = this.tasks.findIndex((t) => t.id === id);
    this.tasks[i] = { ...this.tasks[i], ...over };
    this.emit({ type: "task:updated", task: this.tasks[i] });
  }

  run(taskId: TaskId, runId: string, events: RunEvent[]): void {
    for (const event of events) this.emit({ type: "run", taskId, runId, event });
  }
}

export const ev = {
  start: (maxSteps = 25): RunEvent => ({
    type: "run:start", at: Date.now(), task: "t", maxSteps, model: "sonnet", snapshot: "hybrid",
    headed: false, session: "s", workdir: "/w",
  }),
  step: (step: number): RunEvent => ({ type: "step:start", at: Date.now(), step }),
  phase: (step: number, phase: "observing" | "thinking" | "acting"): RunEvent => ({ type: "phase", at: Date.now(), step, phase }),
  decision: (step: number, d: Decision, cost: number): RunEvent => ({ type: "decision", at: Date.now(), step, decision: d, cost }),
  actionStart: (step: number, index: number): RunEvent => ({ type: "action:start", at: Date.now(), step, index }),
  actionResult: (step: number, index: number, result: string): RunEvent =>
    ({ type: "action:result", at: Date.now(), step, index, result, code: null }),
  stepEnd: (step: number, d: Decision, results: string[]): RunEvent => ({
    type: "step:end", at: Date.now(), record: { step, decision: d, results, codes: results.map(() => null) }, cost: 0, durationMs: 4200,
  }),
  control: (state: "running" | "paused" | "stepping" | "stopping"): RunEvent => ({ type: "control", at: Date.now(), state }),
  end: (outcome: RunOutcome): RunEvent => ({ type: "run:end", at: Date.now(), outcome }),
};

export function decision(goal: string, actions: [string, ...string[]][]): Decision {
  return {
    evaluationPreviousGoal: `eval of ${goal}`, memory: `memory of ${goal}`, nextGoal: goal,
    actions: actions.map(([cmd, ...args]) => ({ cmd, args })),
  } as Decision;
}
