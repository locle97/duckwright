// The view state of one run, built from its events: what the TUI and the web UI both draw.
// Pure: no ink, no react, no DOM and no node modules, so the browser bundle can import it.
import type { ControlState, Phase, RunEvent, RunOutcome } from "./events.ts";
import type { NetworkEntry } from "./network.ts";

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
  /** Run-folder-relative path of this step's screenshot, validated; null when absent or malformed. */
  screenshot: string | null;
  screenshotError: string | null;
}

export interface RunView {
  runId: string;
  /** The run's working directory; "" when unknown. */
  workdir: string;
  maxSteps: number;
  startedAt: number;
  steps: StepView[];
  control: ControlState;
  pausedSince: number | null;
  pausedMs: number;
  cost: number;
  brainFailures: number;
  outcome: RunOutcome | null;
  /** "video.webm" when the run recorded one. */
  video: string | null;
  /** Index into `steps`. */
  selected: number;
  expanded: number[];
  follow: boolean;
  /** Replayed from a past run folder rather than observed live. */
  past?: boolean;
}

export type TimelineOp = "move" | "page" | "first" | "last" | "toggle" | "expandAll" | "collapseAll" | "unfollow";

const SHOT = /^screenshots\/step-\d{3,}\.png$/;
const VIDEO = "video.webm";

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** The view of a run that has just started. */
export function newRunView(runId: string, e: Extract<RunEvent, { type: "run:start" }>): RunView {
  return {
    runId, workdir: typeof e.workdir === "string" ? e.workdir : "", video: null, maxSteps: e.maxSteps, startedAt: e.at, steps: [], control: "running",
    pausedSince: null, pausedMs: 0, cost: 0, brainFailures: 0, outcome: null, selected: 0, expanded: [], follow: true,
  };
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

export function reduceRunEvent(r: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case "run:start":
      return r;
    case "step:start": {
      const previousLast = r.steps.length - 1;
      const view: StepView = {
        step: e.step, goal: "", evaluation: "", memory: null, actions: [], runningAction: null,
        phase: null, status: "running", error: null, cost: null, durationMs: null, network: [], networkErrors: [], screenshot: null, screenshotError: null,
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
        screenshot: typeof e.record.screenshot === "string" && SHOT.test(e.record.screenshot) ? e.record.screenshot : null,
        screenshotError: typeof e.record.screenshotError === "string" ? e.record.screenshotError : null,
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
      return { ...closePause(r, e.at), outcome: e.outcome, video: e.outcome.video === VIDEO ? VIDEO : null };
  }
}

export function reduceTimeline(r: RunView, op: TimelineOp, delta: number): RunView {
  const last = r.steps.length - 1;
  if (last < 0) return r;
  switch (op) {
    case "move":
    case "page":
      return { ...r, selected: clamp(r.selected + delta, 0, last), follow: delta < 0 ? false : r.follow };
    case "first":
      return { ...r, selected: 0, follow: false };
    case "unfollow":
      return { ...r, follow: false };
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

/**
 * Folds a past run's recorded events into a read-only view. A malformed event (or no run:start)
 * keeps just the outcome, so a damaged run folder never breaks the screen.
 */
export function foldPast(runId: string, events: RunEvent[]): RunView {
  let view: RunView | undefined;
  try {
    for (const e of events) {
      if (e.type === "run:start") view = newRunView(runId, e);
      else if (view) view = reduceRunEvent(view, e);
    }
  } catch {
    view = undefined;
  }
  if (!view) {
    let outcome: RunOutcome | null = null;
    for (const e of events) if (e.type === "run:end") outcome = e.outcome;
    view = {
      runId, workdir: "", video: outcome?.video === VIDEO ? VIDEO : null, maxSteps: 0, startedAt: 0, steps: [], control: "running", pausedSince: null, pausedMs: 0,
      cost: 0, brainFailures: 0, outcome, selected: 0, expanded: [], follow: false,
    };
  }
  return {
    ...view, past: true, follow: false, selected: Math.max(0, view.steps.length - 1), expanded: [],
    cost: view.outcome?.costUsd ?? view.cost,
  };
}
