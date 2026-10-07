// The browser's state: what the server sent, the run views folded from run events, and the
// screen's own state (selection, filter, dialogs, toasts). Plain TypeScript: no DOM, no React,
// so it is tested with node --test.
import type { RunEvent } from "../../src/events.ts";
import type { EditTarget, Globals, ManagerEvent, PlanId, PlanSnapshot, TaskId, TaskSnapshot } from "../../src/runs/manager.ts";
import { foldPast, newRunView, reduceRunEvent, reduceTimeline } from "../../src/runviews.ts";
import type { RunView, TimelineOp } from "../../src/runviews.ts";
import type { WebSnapshot } from "../../src/web/api.ts";

export type StreamMessage = ({ type: "state" } & WebSnapshot) | ManagerEvent;
export type Selection = { kind: "task"; id: TaskId } | { kind: "plan"; id: PlanId } | null;
export type Confirm =
  | { kind: "quit"; count: number } | { kind: "remove"; taskId: TaskId } | { kind: "removePlan"; planId: PlanId };
export interface EditDraft { target: EditTarget; title: string; original: string; text: string; error: string | null }
export type Dialog =
  | { kind: "add"; mode: "task" | "plan" }
  | { kind: "edit"; draft: EditDraft }
  | { kind: "options"; taskId: TaskId | null }
  | { kind: "confirm"; confirm: Confirm }
  | { kind: "help" };
export interface Toast { id: number; level: "info" | "error"; message: string; until: number }
export type Row = { kind: "plan"; plan: PlanSnapshot } | { kind: "task"; task: TaskSnapshot; planId: PlanId | null };

export interface WebState {
  /** The first snapshot has arrived. */
  loaded: boolean;
  connected: boolean;
  /** The server was told to quit: the page has nothing left to talk to. */
  ended: boolean;
  /** The token no longer works (the server answered 401). */
  expired: boolean;
  now: number;
  tasks: TaskSnapshot[];
  plans: PlanSnapshot[];
  globals: Globals | null;
  maxParallel: number;
  theme: "auto" | "dark" | "light";
  /** Keyed by run id. */
  runs: Record<string, RunView>;
  selection: Selection;
  /** Plans whose task rows are hidden. */
  collapsed: PlanId[];
  filter: string;
  dialog: Dialog | null;
  toasts: Toast[];
}

export type Action =
  | { type: "stream"; message: StreamMessage; now: number }
  | { type: "connection"; connected: boolean }
  | { type: "ended" }
  | { type: "expired" }
  | { type: "tick"; now: number }
  | { type: "select"; selection: Selection }
  | { type: "move"; delta: number }
  | { type: "collapse"; id: PlanId }
  | { type: "filter"; value: string }
  | { type: "dialog"; value: Dialog | null }
  | { type: "editText"; text: string }
  | { type: "editFailed"; error: string }
  | { type: "toast"; level: "info" | "error"; message: string }
  | { type: "timeline"; op: TimelineOp; delta?: number };

const TOAST_MS = 4000;

export function initialState(now = 0): WebState {
  return {
    loaded: false, connected: false, ended: false, expired: false, now, tasks: [], plans: [], globals: null, maxParallel: 3, theme: "auto",
    runs: {}, selection: null, collapsed: [], filter: "", dialog: null, toasts: [],
  };
}

const matches = (t: { name: string; text: string }, q: string): boolean => {
  if (q === "") return true;
  const x = q.toLowerCase();
  return t.name.toLowerCase().includes(x) || t.text.toLowerCase().includes(x);
};

/** The sidebar rows: tasks and plans newest first; a plan's tasks under it in the plan's order unless collapsed. */
export function visibleRows(s: WebState): Row[] {
  const planIds = new Set(s.plans.map((p) => p.id));
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  type Entry = { createdAt: number; id: number; rows: Row[] };
  const entries: Entry[] = [];
  for (const t of s.tasks) {
    if (t.planId !== undefined && planIds.has(t.planId)) continue;
    if (matches(t, s.filter)) entries.push({ createdAt: t.createdAt, id: t.id, rows: [{ kind: "task", task: t, planId: null }] });
  }
  for (const p of s.plans) {
    const tasks = p.taskIds.flatMap((id) => {
      const t = byId.get(id);
      return t && matches(t, s.filter) ? [t] : [];
    });
    if (s.filter !== "" && tasks.length === 0 && !matches({ name: p.name, text: p.source }, s.filter)) continue;
    const open = !s.collapsed.includes(p.id);
    entries.push({
      createdAt: p.createdAt, id: p.id,
      rows: [{ kind: "plan", plan: p }, ...(open ? tasks.map((task): Row => ({ kind: "task", task, planId: p.id })) : [])],
    });
  }
  entries.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return entries.flatMap((e) => e.rows);
}

const rowKey = (r: Row): string => (r.kind === "plan" ? `p${r.plan.id}` : `t${r.task.id}`);
const selKey = (sel: Selection): string | null => (sel === null ? null : sel.kind === "plan" ? `p${sel.id}` : `t${sel.id}`);
const toSelection = (r: Row | undefined): Selection =>
  r === undefined ? null : r.kind === "plan" ? { kind: "plan", id: r.plan.id } : { kind: "task", id: r.task.id };

/** Keeps the selection on a shown row: unchanged when it still is, else the first row (or none). */
function snap(s: WebState): WebState {
  const rows = visibleRows(s);
  const key = selKey(s.selection);
  if (key !== null && rows.some((r) => rowKey(r) === key)) return s;
  return { ...s, selection: toSelection(rows[0]) };
}

/** After rows went away: stay on the selected row if shown, else the next one below it, else the nearest above. */
function keepSelection(before: WebState, after: WebState): WebState {
  const old = visibleRows(before);
  const key = selKey(before.selection);
  const pos = old.findIndex((r) => rowKey(r) === key);
  const rows = visibleRows(after);
  const order = pos === -1 ? old : [old[pos]!, ...old.slice(pos + 1), ...old.slice(0, pos).reverse()];
  for (const r of order) {
    const found = rows.find((x) => rowKey(x) === rowKey(r));
    if (found) return { ...after, selection: toSelection(found) };
  }
  return { ...after, selection: toSelection(rows[0]) };
}

export function selectedTask(s: WebState): TaskSnapshot | null {
  return s.selection?.kind === "task" ? (s.tasks.find((t) => t.id === s.selection!.id) ?? null) : null;
}
export function selectedPlan(s: WebState): PlanSnapshot | null {
  return s.selection?.kind === "plan" ? (s.plans.find((p) => p.id === s.selection!.id) ?? null) : null;
}
export function selectedRun(s: WebState): RunView | null {
  const runId = selectedTask(s)?.runId;
  return runId ? (s.runs[runId] ?? null) : null;
}
/** The first task (in the order they were added) whose run waits for a 2FA answer. */
export const pendingTwofa = (s: WebState): TaskSnapshot | null => s.tasks.find((t) => t.twofa !== null) ?? null;
/** Identifies one wait, so text typed for one request is never shown for another. */
export const twofaWaitKey = (t: TaskSnapshot): string => (t.twofa === null ? "" : `${t.id}:${t.twofa.kind}:${t.runCount}`);
export const liveCount = (s: WebState): number =>
  s.tasks.filter((t) => t.state === "running" || t.state === "paused" || t.state === "stopping").length;
export function totalCost(s: WebState): number {
  let cost = 0;
  for (const r of Object.values(s.runs)) if (!r.past) cost += r.cost;
  for (const p of s.plans) cost += p.cost;
  return cost;
}

export function planTally(s: WebState, p: PlanSnapshot): { total: number; passed: number; failed: number; live: number; running: boolean; cost: number } {
  let passed = 0;
  let failed = 0;
  let live = 0;
  let cost = 0;
  for (const id of p.taskIds) {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) continue;
    if (t.state === "passed") passed++;
    else if (t.state === "failed" || t.state === "stopped") failed++;
    else if (t.state === "running" || t.state === "paused" || t.state === "stopping") live++;
    const run = t.runId !== null ? s.runs[t.runId] : undefined;
    if (run && !run.past) cost += run.cost;
  }
  return { total: p.taskIds.length, passed, failed, live, running: p.queued.length > 0 || live > 0, cost };
}

function addToast(s: WebState, level: "info" | "error", message: string, now = s.now): WebState {
  const id = s.toasts.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  return { ...s, toasts: [...s.toasts, { id, level, message, until: now + TOAST_MS }] };
}

function foldLive(runId: string, events: RunEvent[]): RunView | null {
  let view: RunView | null = null;
  for (const e of events) {
    if (e.type === "run:start") view = newRunView(runId, e);
    else if (view) view = reduceRunEvent(view, e);
  }
  return view;
}

function applySnapshot(s: WebState, m: Extract<StreamMessage, { type: "state" }>, now: number): WebState {
  const runs: Record<string, RunView> = {};
  for (const t of m.tasks) if (t.past) runs[t.past.runId] = foldPast(t.past.runId, t.past.events);
  for (const r of m.runs) {
    const view = foldLive(r.runId, r.events);
    if (view) runs[r.runId] = view;
  }
  let next: WebState = {
    ...s, loaded: true, now, tasks: m.tasks, plans: m.plans, globals: m.globals, maxParallel: m.maxParallel, theme: m.theme, runs,
  };
  next = snap(next);
  // Notices are shown once, on the first snapshot only.
  if (!s.loaded) for (const n of m.notices) next = addToast(next, "info", n, now);
  return next;
}

function reduceManager(s: WebState, e: ManagerEvent): WebState {
  switch (e.type) {
    case "task:added":
      return snap({ ...s, tasks: [...s.tasks, e.task] });
    case "task:updated":
      return { ...s, tasks: s.tasks.map((t) => (t.id === e.task.id ? e.task : t)) };
    case "task:removed":
      return keepSelection(s, { ...s, tasks: s.tasks.filter((t) => t.id !== e.taskId) });
    case "plan:added": {
      // A new plan is the top row; while the selection sits on the top row (or nothing yet), it moves to the plan.
      const rows = visibleRows(s);
      const atTop = s.selection === null || rows.length === 0 || rowKey(rows[0]!) === selKey(s.selection);
      const next = { ...s, plans: [...s.plans, e.plan] };
      return atTop ? { ...next, selection: { kind: "plan", id: e.plan.id } } : next;
    }
    case "plan:updated":
      return snap({ ...s, plans: s.plans.map((p) => (p.id === e.plan.id ? e.plan : p)) });
    case "plan:removed":
      return keepSelection(s, { ...s, plans: s.plans.filter((p) => p.id !== e.planId), collapsed: s.collapsed.filter((x) => x !== e.planId) });
    case "toast":
      return addToast(s, e.level, e.message);
    case "globals:updated":
      return { ...s, globals: e.globals };
    case "run": {
      if (e.event.type === "run:start") return { ...s, runs: { ...s.runs, [e.runId]: newRunView(e.runId, e.event) } };
      const event = e.event;
      const r = s.runs[e.runId];
      return r ? { ...s, runs: { ...s.runs, [e.runId]: reduceRunEvent(r, event) } } : s;
    }
  }
}

export function reduce(s: WebState, a: Action): WebState {
  switch (a.type) {
    case "stream":
      return a.message.type === "state" ? applySnapshot(s, a.message, a.now) : reduceManager({ ...s, now: a.now }, a.message);
    case "connection":
      return { ...s, connected: a.connected };
    case "ended":
      return { ...s, ended: true, connected: false };
    case "expired":
      return { ...s, expired: true, connected: false };
    case "tick":
      return { ...s, now: a.now, toasts: s.toasts.filter((t) => t.until > a.now) };
    case "select":
      return { ...s, selection: a.selection };
    case "move": {
      const rows = visibleRows(s);
      if (rows.length === 0) return s;
      const pos = rows.findIndex((r) => rowKey(r) === selKey(s.selection));
      const to = Math.max(0, Math.min(rows.length - 1, (pos === -1 ? 0 : pos) + a.delta));
      return { ...s, selection: toSelection(rows[to]) };
    }
    case "collapse": {
      const collapsed = s.collapsed.includes(a.id) ? s.collapsed.filter((x) => x !== a.id) : [...s.collapsed, a.id];
      return snap({ ...s, collapsed });
    }
    case "filter":
      return snap({ ...s, filter: a.value });
    case "dialog":
      return { ...s, dialog: a.value };
    case "editText":
      return s.dialog?.kind === "edit" ? { ...s, dialog: { kind: "edit", draft: { ...s.dialog.draft, text: a.text, error: null } } } : s;
    case "editFailed":
      return s.dialog?.kind === "edit" ? { ...s, dialog: { kind: "edit", draft: { ...s.dialog.draft, error: a.error } } } : s;
    case "toast":
      return addToast(s, a.level, a.message);
    case "timeline": {
      const runId = selectedTask(s)?.runId;
      const r = runId ? s.runs[runId] : undefined;
      return runId && r ? { ...s, runs: { ...s.runs, [runId]: reduceTimeline(r, a.op, a.delta ?? 0) } } : s;
    }
  }
}
