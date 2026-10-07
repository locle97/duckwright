// Pure view-state reducer: turns manager events and UI actions into the screen state the Ink
// components render. No ink/react here; labels are raw (sanitising happens at render time).
import type { ControlState, Phase, RunEvent, RunOutcome } from "../events.ts";
import type { NetworkEntry } from "../network.ts";
import type { EditTarget, Globals, ManagerEvent, PlanId, PlanSnapshot, TaskId, TaskSnapshot, TaskState } from "../runs/manager.ts";
import { rank } from "./candidates.ts";
import type { Candidate, CandidateIndex } from "./candidates.ts";
import { EMPTY_COMPOSE, mentionAt } from "./compose.ts";
import type { ComposeState } from "./compose.ts";
import { matches, visibleIndexes } from "./filter.ts";
import { FIELD_COUNT } from "./form.ts";
import type { FormState } from "./form.ts";

/** `quitting`: a confirmed quit is stopping the runs; the panes stay and only Ctrl-C acts. */
export type Mode = "list" | "detail" | "options" | "compose" | "form" | "help" | "confirm" | "filter" | "edit" | "quitting";

export interface StepView {
  step: number;
  goal: string;
  evaluation: string;
  /** Only when it changed from the earlier step's memory. */
  memory: string | null;
  actions: { label: string; result: string | null }[];
  runningAction: number | null;
  phase: Phase | null;
  status: "running" | "ok" | "warn" | "brain" | "done";
  error: string | null;
  cost: number | null;
  durationMs: number | null;
  /** Calls captured by this step's actions; empty when capture was off, the step predates it, or the data was malformed. */
  network: NetworkEntry[];
  networkErrors: string[];
}

export interface RunView {
  runId: string;
  maxSteps: number;
  startedAt: number;
  steps: StepView[];
  control: ControlState;
  pausedSince: number | null;
  pausedMs: number;
  cost: number;
  brainFailures: number;
  outcome: RunOutcome | null;
  /** Index into `steps`. */
  selected: number;
  expanded: number[];
  follow: boolean;
  /** Replayed from a past run folder rather than observed live. */
  past?: boolean;
}

export interface Toast { id: number; level: "info" | "error"; message: string; until: number }

/** The editor over the panes: a task file (or typed task) or a plan's shared setup, as text. */
export interface EditState {
  target: EditTarget;
  /** What is being edited, for the editor's title. Raw. */
  title: string;
  /** The text as opened, to tell whether there is anything to save or lose. */
  original: string;
  compose: ComposeState;
  /** Why the last save was refused. */
  error: string | null;
}

/** One sidebar row: a plan's header, or a task (under its plan when `planId` is set). */
export type Row = { kind: "plan"; plan: PlanSnapshot } | { kind: "task"; index: number; planId: PlanId | null };

export type Confirm =
  | { kind: "quit"; count: number } | { kind: "remove"; taskId: number } | { kind: "removePlan"; planId: PlanId }
  | { kind: "discard" };

/** The sidebar's two tabs: the tasks of this session (and plans), and past runs not run again. */
export type Tab = "tasks" | "history";

/** What each tab keeps of its own while the other one is shown. */
export interface TabMemory { selected: TaskId | null; selectedPlan: PlanId | null; filter: string }

export interface ViewState {
  now: number;
  openedAt: number;
  tasks: TaskSnapshot[];
  plans: PlanSnapshot[];
  /** Plans whose task rows are hidden. */
  collapsed: PlanId[];
  /** Keyed by run id. */
  runs: Record<string, RunView>;
  /** Index into `tasks`. */
  selected: number;
  /** Set when a plan's header row is selected rather than a task. */
  selectedPlan: PlanId | null;
  /** The sidebar tab shown. */
  tab: Tab;
  /** The selection and filter of the tab not shown. */
  otherTab: TabMemory;
  focus: "list" | "detail" | "options";
  /** The highlighted row of the options pane while it has the focus. */
  optionsSelected: number;
  mode: Mode;
  /** The kept sidebar filter query; "" = none. */
  filter: string;
  /** The query being edited (non-null only in filter mode). */
  filterDraft: string | null;
  compose: ComposeState;
  /** What the add box submits: a task, or a plan file to plan. */
  composeFor: "task" | "plan";
  edit: EditState | null;
  /** The @ completion list, while open: the folder walk it ranks, and the highlighted row. */
  completion: { index: CandidateIndex; highlight: number } | null;
  /** Why the last add-box submission was refused; cleared when the text changes. */
  addErrors: string[];
  form: FormState | null;
  /** The global options; null until the manager reports them. */
  globals: Globals | null;
  confirm: Confirm | null;
  toasts: Toast[];
  ctrlC: number;
}

export type UiAction =
  | { type: "tick"; now: number } | { type: "manager"; event: ManagerEvent }
  | { type: "select"; delta: number } | { type: "tab" } | { type: "selectEdge"; edge: "first" | "last" }
  | { type: "focus"; target: "list" | "detail" | "options" | "compose" } | { type: "escape" }
  | { type: "optionsMove"; delta: number }
  | { type: "compose"; next: ComposeState } | { type: "form"; next: FormState | null }
  | { type: "help"; open: boolean } | { type: "confirm"; value: ViewState["confirm"] }
  | { type: "timeline"; op: "move" | "page" | "first" | "last" | "toggle" | "expandAll" | "collapseAll"; delta?: number }
  | { type: "toast"; level: "info" | "error"; message: string } | { type: "ctrlC" } | { type: "quitting" }
  | { type: "completion"; value: ViewState["completion"] } | { type: "completionMove"; delta: number }
  | { type: "addFailed"; errors: string[]; cursor: number } | { type: "selectTask"; id: TaskId }
  | { type: "openFilter" } | { type: "filterEdit"; query: string } | { type: "filterKeep" } | { type: "filterClear" }
  | { type: "selectPlan"; id: PlanId } | { type: "collapse"; id: PlanId } | { type: "composeFor"; value: "task" | "plan" }
  | { type: "edit"; value: EditState | null } | { type: "editText"; next: ComposeState } | { type: "editFailed"; error: string };

const TOAST_MS = 4000;

/** Folds a past task's recorded events into a read-only run view; a malformed event keeps just the outcome. */
function replayPast(s: ViewState, task: TaskSnapshot): ViewState {
  const past = task.past;
  if (!past) return s;
  let next: ViewState | null = null;
  try {
    let cur = s;
    for (const event of past.events) {
      cur = reduceManager(cur, { type: "run", taskId: task.id, runId: past.runId, event });
    }
    next = cur;
  } catch {
    next = null;
  }
  let view = next?.runs[past.runId];
  if (!next || !view) {
    let outcome: RunOutcome | null = null;
    for (const e of past.events) if (e.type === "run:end") outcome = e.outcome;
    view = {
      runId: past.runId, maxSteps: 0, startedAt: 0, steps: [], control: "running", pausedSince: null, pausedMs: 0,
      cost: 0, brainFailures: 0, outcome, selected: 0, expanded: [], follow: false,
    };
    next = s;
  }
  const done: RunView = {
    ...view, past: true, follow: false, selected: Math.max(0, view.steps.length - 1), expanded: [],
    cost: view.outcome?.costUsd ?? view.cost,
  };
  return { ...next, runs: { ...next.runs, [past.runId]: done } };
}

export function initialState(
  now: number, tasks: TaskSnapshot[] = [], notices: string[] = [], globals: Globals | null = null, plans: PlanSnapshot[] = [],
): ViewState {
  let s: ViewState = {
    now, openedAt: now, tasks, plans, collapsed: [], runs: {}, selected: 0, selectedPlan: null,
    tab: "tasks", otherTab: { selected: null, selectedPlan: null, filter: "" }, focus: "list", optionsSelected: 0,
    mode: "list", filter: "", filterDraft: null, compose: EMPTY_COMPOSE, composeFor: "task", edit: null, completion: null, addErrors: [],
    form: null, globals, confirm: null, toasts: [], ctrlC: 0,
  };
  for (const t of tasks) s = replayPast(s, t);
  for (const n of notices) s = addToast(s, "info", n);
  // Opened with nothing but past runs: show them rather than an empty Tasks tab.
  if (visibleRows(s).length === 0 && tasks.some(isHistory)) s = { ...s, tab: "history" };
  return selectRow(s, visibleRows(s)[0]);
}

/** Whether the open form edits the global options (rather than one task's). */
export function editingGlobals(s: ViewState): boolean {
  return s.mode === "form" && s.form !== null && s.form.taskId === null;
}

/** The query the sidebar filters by right now: the draft while editing, else the kept one. */
export function activeQuery(s: ViewState): string {
  return s.filterDraft ?? s.filter;
}

/** A past run that has not been run again in this session: it lives on the History tab. */
export function isHistory(t: TaskSnapshot): boolean {
  return t.past !== undefined && t.runCount === 0;
}

/** The tab a task is listed under. */
export function tabOf(t: TaskSnapshot): Tab {
  return isHistory(t) ? "history" : "tasks";
}

/** Shows the other tab: the shown one's selection and filter are kept for when it comes back. */
function switchTab(s: ViewState, tab: Tab): ViewState {
  if (tab === s.tab) return s;
  // By id: indexes into `tasks` shift as tasks come and go.
  const keep: TabMemory = { selected: s.tasks[s.selected]?.id ?? null, selectedPlan: s.selectedPlan, filter: s.filter };
  const { selected: id, selectedPlan, filter } = s.otherTab;
  const next = { ...s, tab, otherTab: keep, selectedPlan, filter, filterDraft: null, selected: s.tasks.findIndex((t) => t.id === id) };
  // A tab not shown before (or whose task went away) starts on its first row.
  return next.selected === -1 && selectedPlan === null ? selectRow(next, visibleRows(next)[0]) : snap({ ...next, selected: Math.max(0, next.selected) });
}

/**
 * The sidebar rows of the shown tab in display order: tasks and plans newest first; under each plan its tasks in the
 * plan's order, unless it is collapsed. With a filter, a plan shows when its name or one of its tasks matches.
 */
export function visibleRows(s: ViewState): Row[] {
  const query = activeQuery(s);
  const shown = new Set(visibleIndexes(s.tasks, query));
  const planIds = new Set(s.plans.map((p) => p.id));
  const indexOf = new Map(s.tasks.map((t, i) => [t.id, i]));
  type Entry = { createdAt: number; id: number; rows: Row[] };
  const entries: Entry[] = [];
  s.tasks.forEach((t, i) => {
    if (tabOf(t) !== s.tab) return;
    if (t.planId !== undefined && planIds.has(t.planId)) return;
    if (shown.has(i)) entries.push({ createdAt: t.createdAt, id: t.id, rows: [{ kind: "task", index: i, planId: null }] });
  });
  for (const plan of s.tab === "tasks" ? s.plans : []) {
    const tasks = plan.taskIds.flatMap((id) => {
      const i = indexOf.get(id);
      return i !== undefined && shown.has(i) ? [i] : [];
    });
    if (query !== "" && tasks.length === 0 && !matches({ name: plan.name, text: plan.source }, query)) continue;
    const open = !s.collapsed.includes(plan.id);
    entries.push({
      createdAt: plan.createdAt, id: plan.id,
      rows: [{ kind: "plan", plan }, ...(open ? tasks.map((index): Row => ({ kind: "task", index, planId: plan.id })) : [])],
    });
  }
  entries.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return entries.flatMap((e) => e.rows);
}

/** Indexes into `tasks` that the sidebar shows, in display order. */
export function visibleTasks(s: ViewState): number[] {
  return visibleRows(s).flatMap((r) => (r.kind === "task" ? [r.index] : []));
}

const sameRow = (a: Row, b: Row): boolean =>
  a.kind === "plan" ? b.kind === "plan" && a.plan.id === b.plan.id : b.kind === "task" && a.index === b.index;

/** Where the selection is in `rows`, or -1 when its row is not shown. */
export function selectedRowIndex(s: ViewState, rows: Row[] = visibleRows(s)): number {
  return rows.findIndex((r) => (s.selectedPlan !== null
    ? r.kind === "plan" && r.plan.id === s.selectedPlan
    : r.kind === "task" && r.index === s.selected));
}

function selectRow(s: ViewState, r: Row | undefined): ViewState {
  if (r === undefined) return { ...s, selectedPlan: null, selected: 0 };
  return r.kind === "plan" ? { ...s, selectedPlan: r.plan.id } : { ...s, selectedPlan: null, selected: r.index };
}

/** A hidden selection moves to the first visible row; unchanged when none is visible. */
function snap(s: ViewState): ViewState {
  const rows = visibleRows(s);
  return rows.length === 0 || selectedRowIndex(s, rows) !== -1 ? s : selectRow(s, rows[0]);
}

/**
 * After rows went away (a task or plan removed), keep the selection on its row if it is still
 * shown, else move to the next row that was below it, else the nearest one above.
 */
function keepSelection(before: ViewState, after: ViewState): ViewState {
  const old = visibleRows(before);
  const pos = selectedRowIndex(before, old);
  const rows = visibleRows(after);
  const key = (r: Row): string => (r.kind === "plan" ? `p${r.plan.id}` : `t${before.tasks[r.index]?.id}`);
  const keyAfter = (r: Row): string => (r.kind === "plan" ? `p${r.plan.id}` : `t${after.tasks[r.index]?.id}`);
  const order = pos === -1 ? old : [old[pos]!, ...old.slice(pos + 1), ...old.slice(0, pos).reverse()];
  for (const r of order) {
    const found = rows.find((x) => keyAfter(x) === key(r));
    if (found) return selectRow(after, found);
  }
  return selectRow(after, rows[0]);
}

export function selectedTask(s: ViewState): TaskSnapshot | null {
  if (s.selectedPlan !== null) return null;
  return visibleTasks(s).includes(s.selected) ? (s.tasks[s.selected] ?? null) : null;
}

/** The plan whose header row is selected, when it is shown. */
export function selectedPlan(s: ViewState): PlanSnapshot | null {
  if (s.selectedPlan === null) return null;
  return visibleRows(s).some((r) => r.kind === "plan" && r.plan.id === s.selectedPlan)
    ? (s.plans.find((p) => p.id === s.selectedPlan) ?? null)
    : null;
}

/** The plan a task belongs to. */
export function planOf(s: ViewState, t: TaskSnapshot | null): PlanSnapshot | null {
  return t?.planId === undefined ? null : (s.plans.find((p) => p.id === t.planId) ?? null);
}

/** How a plan's tasks stand: counts by state, whether a plan run is going, and what its runs cost. */
export function planTally(s: ViewState, p: PlanSnapshot): { total: number; passed: number; failed: number; live: number; running: boolean; cost: number } {
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

/** The completion rows for the mention under the cursor, best first; empty while the list is closed. */
export function completionItems(s: ViewState): Candidate[] {
  if (s.completion === null) return [];
  return rank(s.completion.index, mentionAt(s.compose.text, s.compose.cursor)?.path ?? "");
}

export function selectedRun(s: ViewState): RunView | null {
  const runId = selectedTask(s)?.runId;
  return runId ? (s.runs[runId] ?? null) : null;
}

/** The first task (in the order they were added) whose run waits for a 2FA answer. */
export function pendingTwofa(s: ViewState): TaskSnapshot | null {
  return s.tasks.find((t) => t.twofa !== null) ?? null;
}

/** Identifies one wait, so text typed for one request is never shown for another. */
export function twofaWaitKey(t: TaskSnapshot): string {
  return t.twofa === null ? "" : `${t.id}:${t.twofa.kind}:${t.runCount}`;
}

/** Tasks whose latest run has not ended yet. */
export function liveCount(s: ViewState): number {
  return s.tasks.filter((t) => t.state === "running" || t.state === "paused" || t.state === "stopping").length;
}

export function headerCounts(s: ViewState): { counts: Partial<Record<TaskState, number>>; cost: number; elapsedMs: number } {
  const counts: Partial<Record<TaskState, number>> = {};
  for (const t of s.tasks) {
    if (t.past !== undefined && t.runCount === 0) continue;
    counts[t.state] = (counts[t.state] ?? 0) + 1;
  }
  let cost = 0;
  for (const r of Object.values(s.runs)) if (!r.past) cost += r.cost;
  for (const p of s.plans) cost += p.cost;
  return { counts, cost, elapsedMs: s.now - s.openedAt };
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** The base mode a focus shows when no overlay (compose, help, form, confirm, filter) is open. */
const baseMode = (s: ViewState): Mode => s.focus;

function addToast(s: ViewState, level: "info" | "error", message: string): ViewState {
  const id = s.toasts.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  return { ...s, toasts: [...s.toasts, { id, level, message, until: s.now + TOAST_MS }] };
}

function updateRun(s: ViewState, runId: string, fn: (r: RunView) => RunView): ViewState {
  const r = s.runs[runId];
  return r ? { ...s, runs: { ...s.runs, [runId]: fn(r) } } : s;
}

function updateStep(r: RunView, step: number, fn: (v: StepView) => StepView): RunView {
  const i = r.steps.findIndex((v) => v.step === step);
  const cur = r.steps[i];
  if (!cur) return r;
  return { ...r, steps: r.steps.map((v, j) => (j === i ? fn(cur) : v)) };
}

/** Under follow, selection tracks the last step and the running (last) step is expanded. */
function applyFollow(r: RunView, previousLast: number): RunView {
  if (!r.follow || r.steps.length === 0) return r;
  const last = r.steps.length - 1;
  const expanded = r.expanded.filter((i) => i !== previousLast || i === last);
  if (!expanded.includes(last)) expanded.push(last);
  return { ...r, selected: last, expanded };
}

function closePause(r: RunView, at: number): RunView {
  return r.pausedSince === null ? r : { ...r, pausedMs: r.pausedMs + (at - r.pausedSince), pausedSince: null };
}

function previousMemory(r: RunView): string | null {
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const m = r.steps[i]?.memory;
    if (m !== null && m !== undefined) return m;
  }
  return null;
}

function stepStatus(results: (string | null)[], actions: StepView["actions"]): StepView["status"] {
  const done = actions.some((a, i) => a.label.split(" ")[0] === "done" && (a.result ?? results[i]) === "done");
  if (done) return "done";
  return actions.some((a) => a.result?.startsWith("error:")) ? "warn" : "ok";
}

const isEntry = (v: unknown): v is NetworkEntry => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as NetworkEntry;
  return typeof e.method === "string" && typeof e.url === "string" && typeof e.statusText === "string"
    && (e.status === null || typeof e.status === "number") && (e.durationMs === null || typeof e.durationMs === "number");
};
const entriesOf = (v: unknown): NetworkEntry[] => (Array.isArray(v) ? v.filter(isEntry) : []);
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function reduceRunEvent(r: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case "run:start":
      return r;
    case "step:start": {
      const previousLast = r.steps.length - 1;
      const view: StepView = {
        step: e.step, goal: "", evaluation: "", memory: null, actions: [], runningAction: null,
        phase: null, status: "running", error: null, cost: null, durationMs: null, network: [], networkErrors: [],
      };
      return applyFollow({ ...r, steps: [...r.steps, view] }, previousLast);
    }
    case "phase":
      return updateStep(r, e.step, (v) => ({ ...v, phase: e.phase }));
    case "decision": {
      const prev = previousMemory(r);
      const d = e.decision;
      const memory = d.memory === (prev ?? "") ? null : d.memory;
      const next = updateStep(r, e.step, (v) => ({
        ...v, goal: d.nextGoal, evaluation: d.evaluationPreviousGoal, memory,
        actions: d.actions.map((a) => ({ label: [a.cmd, ...a.args].join(" "), result: null })),
        cost: (v.cost ?? 0) + e.cost,
      }));
      return { ...next, cost: r.cost + e.cost, brainFailures: 0 };
    }
    case "action:start":
      return updateStep(r, e.step, (v) => ({ ...v, runningAction: e.index }));
    case "action:result":
      return updateStep(r, e.step, (v) => ({
        ...v, runningAction: v.runningAction === e.index ? null : v.runningAction,
        actions: v.actions.map((a, i) => (i === e.index ? { ...a, result: e.result } : a)),
      }));
    case "brain:error": {
      const next = updateStep(r, e.step, (v) => ({ ...v, status: "brain", error: e.message, cost: (v.cost ?? 0) + e.cost }));
      return { ...next, cost: r.cost + e.cost, brainFailures: e.failures };
    }
    case "step:end":
      return updateStep(r, e.record.step, (v) => ({
        ...v, durationMs: e.durationMs, runningAction: null, phase: null,
        network: entriesOf(e.record.network), networkErrors: stringsOf(e.record.networkErrors),
        status: v.status === "brain" ? "brain" : stepStatus(e.record.results, v.actions),
      }));
    case "twofa:wait":
    case "twofa:done":
      return r;
    case "control": {
      if (e.state === "paused") {
        return { ...r, control: e.state, pausedSince: r.pausedSince ?? e.at };
      }
      return { ...closePause(r, e.at), control: e.state };
    }
    case "run:end":
      return { ...closePause(r, e.at), outcome: e.outcome };
  }
}

function reduceManager(s: ViewState, e: ManagerEvent): ViewState {
  switch (e.type) {
    case "task:added": {
      const next = { ...s, tasks: [...s.tasks, e.task] };
      // An add from the add box shows the tab it lands on; a plan's tasks arrive while it plans, in the background.
      return e.task.planId === undefined ? switchTab(next, tabOf(e.task)) : next;
    }
    case "task:updated": {
      const next = { ...s, tasks: s.tasks.map((t) => (t.id === e.task.id ? e.task : t)) };
      const before = s.tasks.find((t) => t.id === e.task.id);
      if (before === undefined || tabOf(before) === tabOf(e.task)) return next;
      // A past run run again moves to the Tasks tab; when it was selected, the view goes with it.
      const sel = s.selectedPlan === null && s.tasks[s.selected]?.id === e.task.id;
      if (!sel) return keepSelection(s, next);
      const left = keepSelection(s, next);
      const index = next.tasks.findIndex((t) => t.id === e.task.id);
      const shown = switchTab(left, tabOf(e.task));
      const hidden = !visibleTasks({ ...shown, selected: index, selectedPlan: null }).includes(index);
      return { ...shown, selected: index, selectedPlan: null, ...(hidden ? { filter: "" } : {}) };
    }
    case "task:removed": {
      const selId = s.selectedPlan === null ? s.tasks[s.selected]?.id : undefined;
      const tasks = s.tasks.filter((t) => t.id !== e.taskId);
      // Indexes shift: point the selection at the same task in the new list before keeping it.
      const after = { ...s, tasks, selected: Math.max(0, tasks.findIndex((t) => t.id === selId)) };
      return keepSelection(s, after);
    }
    case "plan:added": {
      // A new plan is the top row; while the selection sits on the top row (or nothing yet), it moves to the plan.
      const atTop = s.tab === "tasks" && selectedRowIndex(s) <= 0;
      const next = { ...s, plans: [...s.plans, e.plan] };
      return atTop ? { ...next, selectedPlan: e.plan.id } : next;
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
      if (e.event.type === "run:start") {
        const view: RunView = {
          runId: e.runId, maxSteps: e.event.maxSteps, startedAt: e.event.at, steps: [], control: "running",
          pausedSince: null, pausedMs: 0, cost: 0, brainFailures: 0, outcome: null, selected: 0, expanded: [], follow: true,
        };
        return { ...s, runs: { ...s.runs, [e.runId]: view } };
      }
      const event = e.event;
      return updateRun(s, e.runId, (r) => reduceRunEvent(r, event));
    }
  }
}

function reduceTimeline(r: RunView, op: Extract<UiAction, { type: "timeline" }>["op"], delta: number): RunView {
  const last = r.steps.length - 1;
  if (last < 0) return r;
  switch (op) {
    case "move":
    case "page":
      return { ...r, selected: clamp(r.selected + delta, 0, last), follow: delta < 0 ? false : r.follow };
    case "first":
      return { ...r, selected: 0, follow: false };
    case "last": {
      const expanded = r.expanded.includes(last) ? r.expanded : [...r.expanded, last];
      return { ...r, selected: last, follow: true, expanded };
    }
    case "toggle":
      return { ...r, expanded: r.expanded.includes(r.selected) ? r.expanded.filter((i) => i !== r.selected) : [...r.expanded, r.selected] };
    case "expandAll":
      return { ...r, expanded: r.steps.map((_, i) => i) };
    case "collapseAll":
      return { ...r, expanded: [] };
  }
}

function apply(s: ViewState, a: UiAction): ViewState {
  switch (a.type) {
    case "tick":
      return { ...s, now: a.now, toasts: s.toasts.filter((t) => t.until > a.now) };
    case "manager":
      return reduceManager(s, a.event);
    case "select": {
      const rows = visibleRows(s);
      if (rows.length === 0) return s;
      const pos = selectedRowIndex(s, rows);
      return selectRow(s, rows[clamp((pos === -1 ? 0 : pos) + a.delta, 0, rows.length - 1)]);
    }
    case "tab":
      return switchTab(s, s.tab === "tasks" ? "history" : "tasks");
    case "selectEdge": {
      const rows = visibleRows(s);
      if (rows.length === 0) return s;
      return selectRow(s, a.edge === "first" ? rows[0] : rows[rows.length - 1]);
    }
    case "selectPlan": {
      if (!s.plans.some((p) => p.id === a.id)) return s;
      s = switchTab(s, "tasks");
      const shown = visibleRows(s).some((r) => r.kind === "plan" && r.plan.id === a.id);
      return { ...s, selectedPlan: a.id, ...(shown ? {} : { filter: "", filterDraft: null }) };
    }
    case "collapse": {
      const collapsed = s.collapsed.includes(a.id) ? s.collapsed.filter((x) => x !== a.id) : [...s.collapsed, a.id];
      const next = { ...s, collapsed };
      // A selected task of a collapsing plan gives the selection to the plan's header.
      const t = selectedTask(s);
      return t?.planId === a.id && collapsed.includes(a.id) ? { ...next, selectedPlan: a.id } : next;
    }
    case "composeFor":
      return { ...s, composeFor: a.value, addErrors: a.value === s.composeFor ? s.addErrors : [] };
    case "edit":
      return a.value ? { ...s, edit: a.value, mode: "edit" } : { ...s, edit: null, mode: baseMode(s), confirm: null };
    case "editText":
      return s.edit ? { ...s, edit: { ...s.edit, compose: a.next, error: null } } : s;
    case "editFailed":
      return s.edit ? { ...s, edit: { ...s.edit, error: a.error }, mode: "edit", confirm: null } : s;
    case "openFilter":
      return { ...s, focus: "list", mode: "filter", filterDraft: s.filter };
    case "filterEdit":
      return snap({ ...s, filterDraft: a.query });
    case "filterKeep":
      return snap({ ...s, filter: s.filterDraft ?? s.filter, filterDraft: null, mode: "list" });
    case "filterClear":
      return snap({ ...s, filter: "", filterDraft: null, mode: "list" });
    case "focus":
      if (a.target === "compose") return { ...s, mode: "compose", composeFor: "task", addErrors: s.composeFor === "task" ? s.addErrors : [] };
      return { ...s, focus: a.target, mode: a.target };
    case "escape":
      if (s.mode === "list" || s.mode === "detail" || s.mode === "options") return { ...s, focus: "list", mode: "list" };
      return {
        ...s, mode: baseMode(s), form: s.mode === "form" ? null : s.form, confirm: s.mode === "confirm" ? null : s.confirm,
        completion: s.mode === "compose" ? null : s.completion,
        composeFor: s.mode === "compose" ? "task" : s.composeFor,
        edit: s.mode === "edit" ? null : s.edit,
      };
    case "compose":
      return { ...s, compose: a.next, addErrors: a.next.text === s.compose.text ? s.addErrors : [] };
    case "completion":
      return { ...s, completion: a.value };
    case "completionMove": {
      if (s.completion === null) return s;
      const last = Math.max(0, completionItems(s).length - 1);
      return { ...s, completion: { ...s.completion, highlight: clamp(s.completion.highlight + a.delta, 0, last) } };
    }
    case "addFailed":
      return { ...s, addErrors: a.errors, compose: { ...s.compose, cursor: a.cursor }, completion: null };
    case "selectTask": {
      const i = s.tasks.findIndex((t) => t.id === a.id);
      if (i === -1) return s;
      s = switchTab(s, tabOf(s.tasks[i]!));
      const hidden = !visibleTasks(s).includes(i);
      const planId = s.tasks[i]!.planId;
      const collapsed = planId === undefined ? s.collapsed : s.collapsed.filter((x) => x !== planId);
      return { ...s, selected: i, selectedPlan: null, collapsed, ...(hidden ? { filter: "", filterDraft: null } : {}) };
    }
    case "form": {
      if (a.next) return { ...s, form: a.next, mode: "form" };
      // Closing the global options keeps the options pane on the field the form was on.
      const optionsSelected = s.form?.taskId === null ? s.form.focus : s.optionsSelected;
      return { ...s, form: null, mode: baseMode(s), optionsSelected };
    }
    case "optionsMove":
      return { ...s, optionsSelected: clamp(s.optionsSelected + a.delta, 0, FIELD_COUNT - 1) };
    case "help":
      return { ...s, mode: a.open ? "help" : baseMode(s) };
    case "confirm":
      if (a.value) return { ...s, confirm: a.value, mode: "confirm" };
      // Saying no to discarding an edit goes back to the editor.
      return { ...s, confirm: null, mode: s.confirm?.kind === "discard" && s.edit !== null ? "edit" : baseMode(s) };
    case "timeline": {
      const runId = selectedTask(s)?.runId;
      if (!runId) return s;
      return updateRun(s, runId, (r) => reduceTimeline(r, a.op, a.delta ?? 0));
    }
    case "toast":
      return addToast(s, a.level, a.message);
    case "ctrlC":
      return { ...s, ctrlC: s.ctrlC + 1 };
    case "quitting":
      return { ...s, mode: "quitting", confirm: null, form: null, edit: null };
  }
}

export function reduce(s: ViewState, a: UiAction): ViewState {
  const next = apply(s, a);
  // Ctrl-C counts consecutive presses; another key resets it. Clock ticks, manager events (a run
  // stopping emits some during the press that confirms the quit) and entering the quitting state do not.
  if (a.type === "ctrlC" || a.type === "tick" || a.type === "manager" || a.type === "quitting") return next;
  return next.ctrlC === 0 ? next : { ...next, ctrlC: 0 };
}
