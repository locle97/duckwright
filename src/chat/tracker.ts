// Follows the runs the chat started through the run manager: which tasks it owns, what they cost,
// how they ended, and when they have all settled.
import type { ManagerLike, PlanId, PlanSnapshot, TaskId, TaskSnapshot, TaskState } from "../runs/manager.ts";

export interface TaskResult { id: TaskId; name: string; state: TaskState; runId: string | null; costUsd: number; historyPath: string | null; answer: string | null }

interface RunRecord { taskId: TaskId; live: number; end: { costUsd: number; historyPath: string | null; answer: string } | null }

const BUSY: TaskState[] = ["running", "paused", "stopping"];

export class RunTracker {
  #manager: ManagerLike;
  #tasks = new Map<TaskId, TaskSnapshot>();
  #plans = new Map<PlanId, PlanSnapshot>();
  #runs = new Map<string, RunRecord>();
  #ownedTasks = new Set<TaskId>();
  #ownedPlans = new Set<PlanId>();
  #waiters = new Set<() => void>();
  #unsubscribe: () => void;

  constructor(manager: ManagerLike) {
    this.#manager = manager;
    for (const t of manager.list()) this.#tasks.set(t.id, t);
    for (const p of manager.plans()) this.#plans.set(p.id, p);
    this.#unsubscribe = manager.subscribe((e) => {
      if (e.type === "task:added" || e.type === "task:updated") this.#tasks.set(e.task.id, e.task);
      else if (e.type === "task:removed") this.#tasks.delete(e.taskId);
      else if (e.type === "plan:added" || e.type === "plan:updated") this.#plans.set(e.plan.id, e.plan);
      else if (e.type === "plan:removed") this.#plans.delete(e.planId);
      else if (e.type === "run") {
        const key = `${e.taskId}:${e.runId}`;
        const rec = this.#runs.get(key) ?? { taskId: e.taskId, live: 0, end: null };
        this.#runs.set(key, rec);
        const ev = e.event;
        // step:end repeats the cost of the decision (or brain:error) before it, so it is not counted.
        if (ev.type === "decision" || ev.type === "brain:error") rec.live += ev.cost;
        else if (ev.type === "run:end") rec.end = { costUsd: ev.outcome.costUsd, historyPath: ev.outcome.historyPath, answer: ev.outcome.answer };
      }
      for (const w of [...this.#waiters]) w();
    });
  }

  own(taskIds: TaskId[]): void {
    for (const id of taskIds) this.#ownedTasks.add(id);
  }

  ownPlan(planId: PlanId): void {
    this.#ownedPlans.add(planId);
    const plan = this.#plans.get(planId) ?? this.#manager.plans().find((p) => p.id === planId);
    if (plan !== undefined) this.own(plan.taskIds);
  }

  owned(): { tasks: TaskId[]; plans: PlanId[] } {
    return { tasks: [...this.#ownedTasks], plans: [...this.#ownedPlans] };
  }

  runCostUsd(): number {
    let sum = 0;
    for (const rec of this.#runs.values()) if (this.#ownedTasks.has(rec.taskId)) sum += rec.end?.costUsd ?? rec.live;
    return sum;
  }

  results(ids: TaskId[]): TaskResult[] {
    const out: TaskResult[] = [];
    for (const id of ids) {
      const t = this.#tasks.get(id);
      if (t === undefined) continue;
      const rec = t.runId === null ? undefined : this.#runs.get(`${id}:${t.runId}`);
      out.push({
        id, name: t.name, state: t.state, runId: t.runId,
        costUsd: rec === undefined ? 0 : rec.end?.costUsd ?? rec.live,
        historyPath: rec?.end?.historyPath ?? null, answer: rec?.end?.answer ?? null,
      });
    }
    return out;
  }

  #busy(ids: TaskId[]): boolean {
    for (const id of ids) {
      const t = this.#tasks.get(id);
      if (t !== undefined && BUSY.includes(t.state)) return true;
      for (const p of this.#plans.values()) if (p.queued.includes(id)) return true;
    }
    return false;
  }

  settled(ids: TaskId[]): Promise<void> {
    if (!this.#busy(ids)) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.#busy(ids)) return;
        this.#waiters.delete(check);
        resolve();
      };
      this.#waiters.add(check);
    });
  }

  close(): void {
    this.#unsubscribe();
    for (const w of [...this.#waiters]) w();
  }
}
