import assert from "node:assert/strict";
import { test } from "node:test";

import type { Decision } from "../../src/brain.ts";
import type { RunEvent, RunOutcome } from "../../src/events.ts";
import type { ManagerEvent, TaskSnapshot, TaskState } from "../../src/runs/manager.ts";
import type { CandidateIndex } from "../../src/tui/candidates.ts";
import { EMPTY_COMPOSE } from "../../src/tui/compose.ts";
import { completionItems, headerCounts, initialState, reduce, selectedRun, selectedTask, visibleTasks } from "../../src/tui/state.ts";
import type { UiAction, ViewState } from "../../src/tui/state.ts";

function task(id: number, state: TaskState = "idle", runId: string | null = null): TaskSnapshot {
  return {
    id, text: `task ${id}`, name: `"task ${id}"`, source: { kind: "typed" }, state, overrides: {},
    effective: { model: "m", maxSteps: 10, headed: false, export: false, snapshot: "hybrid" },
    error: null, runId, runCount: runId ? 1 : 0, createdAt: 0,
  };
}

const OUTCOME: RunOutcome = {
  status: "pass", exitCode: 0, success: true, answer: "ok", steps: 1, costUsd: 0, historyPath: null,
  export: { kind: "off" }, warnings: [], error: null,
};

function dec(goal: string, actions: [string, ...string[]][], memory = "m"): Decision {
  return {
    evaluationPreviousGoal: `eval ${goal}`, memory, nextGoal: goal,
    actions: actions.map(([cmd, ...args]) => ({ cmd, args })),
  } as Decision;
}

const run = (event: RunEvent, runId = "r1", taskId = 1): UiAction => ({ type: "manager", event: { type: "run", taskId, runId, event } as ManagerEvent });
const mgr = (event: ManagerEvent): UiAction => ({ type: "manager", event });
const start = (at = 0): RunEvent => ({ type: "run:start", at, task: "t", maxSteps: 10, model: "m", snapshot: "hybrid", headed: false, session: "s", workdir: "/w" } as RunEvent);
const stepStart = (step: number, at = 0): RunEvent => ({ type: "step:start", at, step });
const phase = (step: number, p: "observing" | "thinking" | "acting"): RunEvent => ({ type: "phase", at: 0, step, phase: p });
const decision = (step: number, d: Decision, cost = 0.01): RunEvent => ({ type: "decision", at: 0, step, decision: d, cost });
const aStart = (step: number, index: number): RunEvent => ({ type: "action:start", at: 0, step, index });
const aResult = (step: number, index: number, result: string): RunEvent => ({ type: "action:result", at: 0, step, index, result, code: null });
const stepEnd = (step: number, d: Decision, results: string[], durationMs = 100): RunEvent =>
  ({ type: "step:end", at: 0, record: { step, decision: d, results, codes: results.map(() => null) }, cost: 0, durationMs });
const control = (state: "running" | "paused" | "stepping" | "stopping", at: number): RunEvent => ({ type: "control", at, state });

function play(s: ViewState, ...actions: UiAction[]): ViewState {
  return actions.reduce(reduce, s);
}

function fullStep(step: number, d: Decision, results: string[]): UiAction[] {
  const out: UiAction[] = [run(stepStart(step)), run(phase(step, "observing")), run(phase(step, "thinking")), run(decision(step, d)), run(phase(step, "acting"))];
  results.forEach((r, i) => { out.push(run(aStart(step, i)), run(aResult(step, i, r))); });
  out.push(run(stepEnd(step, d, results)));
  return out;
}

const base = (): ViewState => play(initialState(1000), mgr({ type: "task:added", task: task(1, "running", "r1") }), run(start(1000)));

test("state_task_events", () => {
  let s = initialState(0);
  assert.equal(selectedTask(s), null);
  assert.equal(selectedRun(s), null);
  s = play(s, mgr({ type: "task:added", task: task(1) }), mgr({ type: "task:added", task: task(2) }));
  assert.deepEqual(s.tasks.map((t) => t.id), [1, 2]);
  s = reduce(s, mgr({ type: "task:updated", task: task(2, "running", "r9") }));
  assert.equal(s.tasks[1]?.state, "running");
  assert.equal(selectedTask(reduce(s, { type: "select", delta: -1 }))?.id, 2, "newest (id 2) is above id 1");
  s = reduce(s, mgr({ type: "task:removed", taskId: 1 }));
  assert.deepEqual(s.tasks.map((t) => t.id), [2]);
  assert.equal(initialState(0, [task(5)]).tasks.length, 1);
});

test("state_selection_clamps_after_remove", () => {
  // Display order is 3, 2, 1; the bottom row is task 1 (index 0).
  let s = play(initialState(0, [task(1), task(2), task(3)]), { type: "selectEdge", edge: "last" });
  assert.equal(s.selected, 0);
  s = reduce(s, mgr({ type: "task:removed", taskId: 3 }));
  assert.equal(selectedTask(s)?.id, 1);
  s = reduce(s, mgr({ type: "task:removed", taskId: 2 }));
  assert.equal(s.selected, 0);
  s = reduce(s, mgr({ type: "task:removed", taskId: 1 }));
  assert.equal(s.selected, 0);
  assert.equal(selectedTask(s), null);
  // removing an earlier task keeps selection in range
  let t = play(initialState(0, [task(1), task(2), task(3)]), { type: "select", delta: 1 });
  assert.equal(selectedTask(t)?.id, 2);
  t = reduce(t, mgr({ type: "task:removed", taskId: 1 }));
  assert.equal(t.selected, 0, "index shifts down; the selected id stays");
  assert.equal(selectedTask(t)?.id, 2);
  t = reduce(t, { type: "select", delta: 5 });
  assert.equal(selectedTask(t)?.id, 2);
  t = reduce(t, { type: "select", delta: -5 });
  assert.equal(selectedTask(t)?.id, 3);
  assert.equal(reduce(initialState(0), mgr({ type: "task:removed", taskId: 9 })).selected, 0);
});

test("state_run_event_flow", () => {
  const d = dec("open page", [["open", "https://x.test"], ["click", "e3"]]);
  let s = base();
  const rv0 = selectedRun(s);
  assert.ok(rv0);
  assert.equal(rv0.runId, "r1");
  assert.equal(rv0.maxSteps, 10);
  assert.equal(rv0.startedAt, 1000);
  assert.equal(rv0.follow, true);
  assert.deepEqual(rv0.expanded, []);
  assert.equal(rv0.control, "running");

  s = play(s, run(stepStart(1)));
  let st = selectedRun(s)!.steps[0]!;
  assert.equal(st.status, "running");
  assert.equal(st.step, 1);
  s = reduce(s, run(phase(1, "thinking")));
  assert.equal(selectedRun(s)!.steps[0]!.phase, "thinking");

  s = play(s, run(decision(1, d, 0.02)), run(phase(1, "acting")), run(aStart(1, 0)));
  st = selectedRun(s)!.steps[0]!;
  assert.equal(st.goal, "open page");
  assert.equal(st.evaluation, "eval open page");
  assert.equal(st.memory, "m");
  assert.deepEqual(st.actions, [{ label: "open https://x.test", result: null }, { label: "click e3", result: null }]);
  assert.equal(st.runningAction, 0);
  assert.equal(st.cost, 0.02);
  assert.equal(selectedRun(s)!.cost, 0.02);

  s = play(s, run(aResult(1, 0, "ok")), run(aStart(1, 1)));
  st = selectedRun(s)!.steps[0]!;
  assert.equal(st.actions[0]!.result, "ok");
  assert.equal(st.runningAction, 1);
  s = play(s, run(aResult(1, 1, "ok")), run(stepEnd(1, d, ["ok", "ok"], 250)));
  st = selectedRun(s)!.steps[0]!;
  assert.equal(st.status, "ok");
  assert.equal(st.durationMs, 250);
  assert.equal(st.runningAction, null);
  assert.equal(st.phase, null);

  s = reduce(s, run({ type: "run:end", at: 5, outcome: OUTCOME }));
  assert.equal(selectedRun(s)!.outcome, OUTCOME);
});

test("state_run_events_for_unknown_run_or_step_ignored", () => {
  let s = play(initialState(0), run(stepStart(1), "nope"));
  assert.deepEqual(s.runs, {});
  s = play(base(), run(phase(7, "acting")), run(aResult(7, 0, "x")));
  assert.equal(selectedRun(s)!.steps.length, 0);
});

test("state_memory_only_when_changed", () => {
  const a = dec("g1", [["click", "e1"]], "same");
  const b = dec("g2", [["click", "e2"]], "same");
  const c = dec("g3", [["click", "e3"]], "new");
  const s = play(base(), ...fullStep(1, a, ["ok"]), ...fullStep(2, b, ["ok"]), ...fullStep(3, c, ["ok"]));
  assert.deepEqual(selectedRun(s)!.steps.map((x) => x.memory), ["same", null, "new"]);
});

test("state_warn_and_done_status", () => {
  const w = dec("g", [["click", "e1"], ["click", "e2"]]);
  const dn = dec("g", [["click", "e1"], ["done", "yay"]]);
  const dnWarn = dec("g", [["done", "x"]]);
  let s = play(base(), ...fullStep(1, w, ["ok", "error: no such ref"]), ...fullStep(2, dn, ["ok", "done"]), ...fullStep(3, dnWarn, ["error: nope"]));
  assert.deepEqual(selectedRun(s)!.steps.map((x) => x.status), ["warn", "done", "warn"]);
  // an ok-looking result that merely mentions error is not a warning
  s = play(s, ...fullStep(4, dec("g", [["eval", "x"]]), ["got error: later"]));
  assert.equal(selectedRun(s)!.steps[3]!.status, "ok");
});

test("state_brain_failures_count_and_reset", () => {
  const d = dec("g", [["click", "e1"]]);
  const err = (step: number, failures: number): UiAction[] => [
    run(stepStart(step)), run(phase(step, "observing")), run(phase(step, "thinking")),
    run({ type: "brain:error", at: 0, step, message: "bad json", cost: 0.5, failures }),
    run({ type: "step:end", at: 0, record: { step, decision: d, results: [], codes: [] }, cost: 0.5, durationMs: 10 }),
  ];
  let s = play(base(), ...err(1, 1));
  let rv = selectedRun(s)!;
  assert.equal(rv.brainFailures, 1);
  assert.equal(rv.steps[0]!.status, "brain");
  assert.equal(rv.steps[0]!.error, "bad json");
  assert.equal(rv.steps[0]!.cost, 0.5);
  assert.equal(rv.cost, 0.5);
  s = play(s, ...err(2, 2));
  assert.equal(selectedRun(s)!.brainFailures, 2);
  s = play(s, ...fullStep(3, d, ["ok"]));
  rv = selectedRun(s)!;
  assert.equal(rv.brainFailures, 0);
  assert.equal(rv.steps[2]!.status, "ok");
  assert.equal(rv.steps[1]!.status, "brain");
  assert.ok(Math.abs(rv.cost - 1.01) < 1e-9);
});

test("state_follow_mode", () => {
  const d = dec("g", [["click", "e1"]]);
  let s = play(base(), ...fullStep(1, d, ["ok"]), run(stepStart(2)));
  let rv = selectedRun(s)!;
  assert.equal(rv.follow, true);
  assert.equal(rv.selected, 1);
  assert.ok(rv.expanded.includes(1));
  s = play(s, run(stepEnd(2, d, ["ok"])), ...fullStep(3, d, ["ok"]));
  rv = selectedRun(s)!;
  assert.equal(rv.selected, 2);
  // moving up leaves follow mode
  s = reduce(s, { type: "timeline", op: "move", delta: -1 });
  rv = selectedRun(s)!;
  assert.equal(rv.follow, false);
  assert.equal(rv.selected, 1);
  s = play(s, run(stepStart(4)));
  rv = selectedRun(s)!;
  assert.equal(rv.selected, 1);
  assert.equal(rv.steps.length, 4);
  // last turns follow back on
  s = reduce(s, { type: "timeline", op: "last" });
  rv = selectedRun(s)!;
  assert.equal(rv.follow, true);
  assert.equal(rv.selected, 3);
  // first, toggle, expandAll, collapseAll
  s = reduce(s, { type: "timeline", op: "first" });
  assert.equal(selectedRun(s)!.selected, 0);
  assert.equal(selectedRun(s)!.follow, false);
  s = reduce(s, { type: "timeline", op: "toggle" });
  assert.ok(selectedRun(s)!.expanded.includes(0));
  s = reduce(s, { type: "timeline", op: "toggle" });
  assert.ok(!selectedRun(s)!.expanded.includes(0));
  s = reduce(s, { type: "timeline", op: "expandAll" });
  assert.deepEqual([...selectedRun(s)!.expanded].sort(), [0, 1, 2, 3]);
  s = reduce(s, { type: "timeline", op: "collapseAll" });
  assert.deepEqual(selectedRun(s)!.expanded, []);
  s = reduce(s, { type: "timeline", op: "page", delta: 99 });
  assert.equal(selectedRun(s)!.selected, 3);
  s = reduce(s, { type: "timeline", op: "move", delta: -99 });
  assert.equal(selectedRun(s)!.selected, 0);
  // no run selected: timeline ops are harmless
  const e = reduce(initialState(0, [task(1)]), { type: "timeline", op: "last" });
  assert.equal(selectedRun(e), null);
});

test("state_pause_timing", () => {
  let s = base();
  s = play(s, run(control("paused", 2000)));
  assert.equal(selectedRun(s)!.control, "paused");
  assert.equal(selectedRun(s)!.pausedSince, 2000);
  s = play(s, run(control("paused", 2500)));
  assert.equal(selectedRun(s)!.pausedSince, 2000);
  s = play(s, run(control("running", 3000)));
  assert.equal(selectedRun(s)!.pausedSince, null);
  assert.equal(selectedRun(s)!.pausedMs, 1000);
  s = play(s, run(control("paused", 5000)), run(control("stepping", 5500)));
  assert.equal(selectedRun(s)!.pausedMs, 1500);
  s = play(s, run(control("paused", 6000)), run({ type: "run:end", at: 7000, outcome: OUTCOME }));
  assert.equal(selectedRun(s)!.pausedMs, 2500);
  assert.equal(selectedRun(s)!.pausedSince, null);
});

test("state_header_counts_and_cost", () => {
  const d = dec("g", [["click", "e1"]]);
  let s = play(
    initialState(1000, [task(1, "running", "r1"), task(2, "running", "r2"), task(3, "passed", "r3"), task(4, "idle")]),
    run(start(), "r1", 1), run(start(), "r2", 2),
    run(stepStart(1), "r1", 1), run(decision(1, d, 0.25), "r1", 1),
    run(stepStart(1), "r2", 2), run(decision(1, d, 0.5), "r2", 2),
    { type: "tick", now: 6000 },
  );
  const h = headerCounts(s);
  assert.deepEqual(h.counts, { running: 2, passed: 1, idle: 1 });
  assert.equal(h.cost, 0.75);
  assert.equal(h.elapsedMs, 5000);
  s = initialState(0);
  assert.deepEqual(headerCounts(s), { counts: {}, cost: 0, elapsedMs: 0 });
});

test("state_toast_expiry", () => {
  let s = play(initialState(1000), { type: "tick", now: 2000 }, mgr({ type: "toast", level: "info", message: "hi" }));
  assert.equal(s.toasts.length, 1);
  assert.equal(s.toasts[0]!.until, 6000);
  s = reduce(s, { type: "toast", level: "error", message: "bad" });
  assert.equal(s.toasts.length, 2);
  assert.notEqual(s.toasts[0]!.id, s.toasts[1]!.id);
  s = reduce(s, { type: "tick", now: 5999 });
  assert.equal(s.toasts.length, 2);
  s = reduce(s, { type: "tick", now: 6000 });
  assert.equal(s.toasts.length, 0);
  assert.equal(s.now, 6000);
});

test("state_escape_restores_previous_focus", () => {
  const typed = { ...EMPTY_COMPOSE, text: "hello", cursor: 5 };
  let s = initialState(0, [task(1)]);
  assert.equal(s.mode, "list");
  s = reduce(s, { type: "toggleFocus" });
  assert.equal(s.focus, "detail");
  assert.equal(s.mode, "detail");
  s = reduce(s, { type: "focus", target: "compose" });
  assert.equal(s.mode, "compose");
  s = reduce(s, { type: "compose", next: typed });
  s = reduce(s, { type: "escape" });
  assert.equal(s.mode, "detail");
  assert.equal(s.focus, "detail");
  assert.equal(s.compose.text, "hello");
  // from list
  s = play(s, { type: "focus", target: "list" }, { type: "focus", target: "compose" }, { type: "escape" });
  assert.equal(s.mode, "list");
  assert.equal(s.compose.text, "hello");
  // help, form, confirm return to the previous mode
  s = play(s, { type: "focus", target: "detail" }, { type: "help", open: true });
  assert.equal(s.mode, "help");
  s = reduce(s, { type: "escape" });
  assert.equal(s.mode, "detail");
  const form = { taskId: 1, fields: [], focus: 0 };
  s = reduce(s, { type: "form", next: form });
  assert.equal(s.mode, "form");
  assert.equal(s.form, form);
  s = reduce(s, { type: "escape" });
  assert.equal(s.mode, "detail");
  assert.equal(s.form, null);
  s = reduce(s, { type: "confirm", value: { kind: "quit", count: 2 } });
  assert.equal(s.mode, "confirm");
  s = reduce(s, { type: "escape" });
  assert.equal(s.mode, "detail");
  assert.equal(s.confirm, null);
  s = play(s, { type: "confirm", value: { kind: "remove", taskId: 1 } }, { type: "confirm", value: null });
  assert.equal(s.mode, "detail");
  s = play(s, { type: "form", next: form }, { type: "form", next: null }, { type: "help", open: true }, { type: "help", open: false });
  assert.equal(s.mode, "detail");
  assert.equal(s.form, null);
});

test("state_ctrlc_counter_resets", () => {
  let s = initialState(0);
  s = play(s, { type: "ctrlC" }, { type: "ctrlC" });
  assert.equal(s.ctrlC, 2);
  s = reduce(s, { type: "tick", now: 10 });
  assert.equal(s.ctrlC, 2);
  s = reduce(s, { type: "select", delta: 1 });
  assert.equal(s.ctrlC, 0);
  s = play(s, { type: "ctrlC" }, mgr({ type: "toast", level: "info", message: "x" }));
  assert.equal(s.ctrlC, 1, "a manager event is not a key and keeps the count");
  s = reduce(s, { type: "toast", level: "error", message: "refused" });
  assert.equal(s.ctrlC, 0, "a key-driven ui action resets it");
});

test("state_ctrlc_survives_manager_events", () => {
  let s = initialState(0, [task(1, "running", "r1")]);
  s = reduce(s, { type: "ctrlC" });
  s = play(s, mgr({ type: "task:updated", task: task(1, "stopping", "r1") }), run({ type: "control", at: 0, state: "stopping" }));
  s = reduce(s, { type: "ctrlC" });
  s = play(s, mgr({ type: "task:updated", task: task(1, "stopping", "r1") }), { type: "quitting" });
  assert.equal(s.ctrlC, 2, "manager events and entering the quitting state keep the count");
});

test("state_quitting_closes_confirm", () => {
  let s = initialState(0, [task(1, "running", "r1")]);
  s = reduce(s, { type: "focus", target: "detail" });
  s = reduce(s, { type: "confirm", value: { kind: "quit", count: 1 } });
  s = reduce(s, { type: "quitting" });
  assert.equal(s.mode, "quitting");
  assert.equal(s.confirm, null);
  assert.equal(s.focus, "detail", "the panes stay as they were");
});

const CIDX: CandidateIndex = {
  items: [{ path: "a.md", folder: false, count: 0 }, { path: "tasks/", folder: true, count: 1 }, { path: "tasks/b.md", folder: false, count: 0 }],
  truncated: false,
};
const withText = (s: ViewState, text: string, cursor = text.length): ViewState =>
  reduce(s, { type: "compose", next: { ...s.compose, text, cursor } });

test("state_add_failed_sets_errors_and_cursor", () => {
  let s = withText(reduce(initialState(0), { type: "focus", target: "compose" }), "@a.md @nope.md x");
  s = reduce(s, { type: "completion", value: { index: CIDX, highlight: 0 } });
  s = reduce(s, { type: "addFailed", errors: ["@nope.md: not found"], cursor: 6 });
  assert.deepEqual(s.addErrors, ["@nope.md: not found"]);
  assert.equal(s.compose.cursor, 6);
  assert.equal(s.compose.text, "@a.md @nope.md x");
  assert.equal(s.completion, null);
});

test("state_compose_edit_clears_errors", () => {
  let s = reduce(withText(initialState(0), "@x"), { type: "addFailed", errors: ["e"], cursor: 0 });
  s = withText(s, "@x", 2); // cursor move only: errors stay
  assert.deepEqual(s.addErrors, ["e"]);
  s = withText(s, "@xy");
  assert.deepEqual(s.addErrors, []);
});

test("state_completion_move_clamps", () => {
  let s = withText(initialState(0), "@");
  s = reduce(s, { type: "completion", value: { index: CIDX, highlight: 0 } });
  s = reduce(s, { type: "completionMove", delta: -1 });
  assert.equal(s.completion?.highlight, 0);
  s = reduce(s, { type: "completionMove", delta: 10 });
  assert.equal(s.completion?.highlight, 2);
});

test("state_select_task_by_id", () => {
  const s = initialState(0, [task(4), task(7), task(9)]);
  assert.equal(reduce(s, { type: "selectTask", id: 9 }).selected, 2);
  assert.equal(reduce(s, { type: "selectTask", id: 5 }).selected, 2, "unknown id: unchanged (newest is selected)");
});

test("state_completion_items_rank_query", () => {
  let s = withText(initialState(0), "go @tas");
  assert.deepEqual(completionItems(s), []);
  s = reduce(s, { type: "completion", value: { index: CIDX, highlight: 0 } });
  assert.deepEqual(completionItems(s).map((c) => c.path), ["tasks/", "tasks/b.md"]);
  assert.equal(completionItems(withText(s, "go @")).length, 3);
});

test("state_escape_from_compose_closes_completion", () => {
  let s = withText(reduce(initialState(0), { type: "focus", target: "compose" }), "@");
  s = reduce(s, { type: "completion", value: { index: CIDX, highlight: 0 } });
  s = reduce(s, { type: "escape" });
  assert.equal(s.completion, null);
  assert.equal(s.mode, "list");
});

function pastTask(id: number, runId: string, events: RunEvent[], state: TaskState = "passed", runCount = 0): TaskSnapshot {
  return { ...task(id, state, runId), runCount, past: { runId, events } };
}
const PAST_OUTCOME: RunOutcome = { ...OUTCOME, steps: 2, costUsd: 0.25 };
const runEnd = (outcome: RunOutcome): RunEvent => ({ type: "run:end", at: 0, outcome });

test("state_replays_past_runs", () => {
  const d1 = dec("g1", [["click", "1"]]);
  const d2 = dec("g2", [["done"]]);
  const events: RunEvent[] = [
    { ...start(0), maxSteps: 5 } as RunEvent,
    stepStart(1), decision(1, d1), aResult(1, 0, "ok"), stepEnd(1, d1, ["ok"]),
    stepStart(2), decision(2, d2), aResult(2, 0, "done"), stepEnd(2, d2, ["done"]),
    runEnd(PAST_OUTCOME),
  ];
  const s = initialState(0, [pastTask(1, "20261001-100000-a", events)]);
  const v = s.runs["20261001-100000-a"];
  assert.equal(v?.steps.length, 2);
  assert.equal(v?.past, true);
  assert.equal(v?.follow, false);
  assert.equal(v?.selected, 1);
  assert.deepEqual(v?.expanded, []);
  assert.equal(v?.cost, 0.25);
  assert.deepEqual(v?.outcome, PAST_OUTCOME);
  assert.equal(selectedRun(s), v);
});

test("state_replay_crash_keeps_outcome", () => {
  const events: RunEvent[] = [
    start(0), stepStart(1), decision(1, null as never), runEnd(PAST_OUTCOME),
  ];
  const v = initialState(0, [pastTask(1, "rp", events)]).runs["rp"];
  assert.deepEqual(v?.steps, []);
  assert.deepEqual(v?.outcome, PAST_OUTCOME);
  assert.equal(v?.past, true);
  assert.equal(v?.cost, 0.25);
});

test("state_header_skips_past", () => {
  const events: RunEvent[] = [start(0), runEnd(PAST_OUTCOME)];
  const past = pastTask(1, "rp", events);
  let s = initialState(0, [past]);
  s = play(s, mgr({ type: "task:added", task: task(2, "running", "r2") }), run(start(0), "r2", 2), run(stepStart(1), "r2", 2),
    run(decision(1, dec("g", [["click", "1"]]), 0.1), "r2", 2));
  const h = headerCounts(s);
  assert.deepEqual(h.counts, { running: 1 });
  assert.equal(h.cost, 0.1);
  const rerun = initialState(0, [pastTask(1, "rp", events, "failed", 1)]);
  assert.deepEqual(headerCounts(rerun).counts, { failed: 1 });
});

test("state_notices_become_toasts", () => {
  const s = initialState(0, [], ["skipped 2 unreadable run folders in runs/"]);
  assert.equal(s.toasts.length, 1);
  assert.equal(s.toasts[0]?.level, "info");
  assert.equal(s.toasts[0]?.message, "skipped 2 unreadable run folders in runs/");
});

const many = (n: number): ViewState => initialState(0, Array.from({ length: n }, (_, i) => task(i + 1)));
const tn = (s: ViewState): string | undefined => selectedTask(s)?.text;

test("state_filter_open_edit_keep_clear", async () => {
  let s = initialState(0, [task(1), task(2)]);
  assert.equal(s.filter, "");
  assert.equal(s.filterDraft, null);
  s = reduce(s, { type: "openFilter" });
  assert.equal(s.mode, "filter");
  assert.equal(s.focus, "list");
  assert.equal(s.filterDraft, "");
  s = reduce(s, { type: "filterEdit", query: "2" });
  assert.equal(s.filterDraft, "2");
  assert.deepEqual(visibleTasks(s), [1]);
  s = reduce(s, { type: "filterKeep" });
  assert.equal(s.filter, "2");
  assert.equal(s.filterDraft, null);
  assert.equal(s.mode, "list");
  s = reduce(reduce(s, { type: "openFilter" }), { type: "filterEdit", query: "" });
  assert.equal(s.filterDraft, "");
  s = reduce(s, { type: "filterKeep" });
  assert.equal(s.filter, "");
  s = reduce(reduce(s, { type: "openFilter" }), { type: "filterEdit", query: "1" });
  s = reduce(s, { type: "filterClear" });
  assert.equal(s.filter, "");
  assert.equal(s.filterDraft, null);
  assert.equal(s.mode, "list");
});

test("state_filter_selection", () => {
  let s = many(12);
  s = reduce(s, { type: "filterEdit", query: "task 1" });
  assert.equal(tn(s), "task 12", "the newest task stays selected while it is visible");
  s = reduce(s, { type: "filterEdit", query: "2" });
  assert.equal(tn(s), "task 12");
  s = reduce(s, { type: "select", delta: 1 });
  assert.equal(tn(s), "task 2");
  s = reduce(s, { type: "select", delta: 1 });
  assert.equal(tn(s), "task 2");
  s = reduce(s, { type: "selectEdge", edge: "first" });
  assert.equal(tn(s), "task 12");
  s = reduce(s, { type: "selectEdge", edge: "last" });
  assert.equal(tn(s), "task 2");
  s = reduce(s, { type: "filterEdit", query: "zzz" });
  assert.equal(selectedTask(s), null);
  assert.equal(selectedRun(s), null);
});

test("state_select_task_clears_hidden_filter", () => {
  let s = many(3);
  s = reduce(reduce(s, { type: "filterEdit", query: "1" }), { type: "filterKeep" });
  assert.equal(s.filter, "1");
  s = reduce(s, { type: "selectTask", id: 1 });
  assert.equal(s.filter, "1");
  s = reduce(s, { type: "selectTask", id: 2 });
  assert.equal(s.filter, "");
  assert.equal(tn(s), "task 2");
});

const at = (id: number, createdAt: number): TaskSnapshot => ({ ...task(id), createdAt });
const ids = (s: ViewState): number[] => visibleTasks(s).map((i) => s.tasks[i]!.id);

test("state_sidebar_newest_first", () => {
  let s = initialState(0);
  s = play(s, mgr({ type: "task:added", task: at(1, 1) }), mgr({ type: "task:added", task: at(2, 2) }), mgr({ type: "task:added", task: at(3, 3) }));
  assert.deepEqual(ids(s), [3, 2, 1]);
  assert.deepEqual(ids(initialState(0, [at(1, 5), at(2, 4)])), [1, 2]);
});

test("state_initial_selects_newest", () => {
  assert.equal(selectedTask(initialState(0, [at(1, 1), at(2, 3), at(3, 2)]))?.id, 2);
});

test("state_add_keeps_selection", () => {
  let s = initialState(0, [at(1, 1), at(2, 2)]);
  s = reduce(s, { type: "selectTask", id: 2 });
  s = reduce(s, mgr({ type: "task:added", task: at(3, 3) }));
  assert.equal(selectedTask(s)?.id, 2);
  assert.equal(s.tasks[visibleTasks(s)[0]!]?.id, 3);
});

test("state_update_keeps_selection_and_order", () => {
  let s = initialState(0, [at(1, 1), at(2, 2), at(3, 3)]);
  s = reduce(s, { type: "selectTask", id: 2 });
  const before = ids(s);
  s = reduce(s, mgr({ type: "task:updated", task: { ...at(2, 2), state: "running", runId: "r2", runCount: 1 } }));
  assert.equal(selectedTask(s)?.id, 2);
  assert.deepEqual(ids(s), before);
});

test("state_remove_keeps_selected_id", () => {
  let s = initialState(0, [at(1, 1), at(2, 2), at(3, 3)]);
  s = reduce(s, { type: "selectTask", id: 1 });
  s = reduce(s, mgr({ type: "task:removed", taskId: 3 }));
  assert.equal(selectedTask(s)?.id, 1);
});

test("state_remove_selected_picks_neighbour", () => {
  const fresh = (): ViewState => initialState(0, [at(1, 1), at(2, 2), at(3, 3)]);
  let s = reduce(fresh(), { type: "selectTask", id: 2 });
  s = reduce(s, mgr({ type: "task:removed", taskId: 2 }));
  assert.equal(selectedTask(s)?.id, 1, "the row below");
  s = reduce(fresh(), { type: "selectTask", id: 1 });
  s = reduce(s, mgr({ type: "task:removed", taskId: 1 }));
  assert.equal(selectedTask(s)?.id, 2, "no row below: the row above");
});

test("state_remove_only_visible_falls_back_to_zero", () => {
  const a = { ...task(1), text: "apple", name: '"apple"' };
  const b = { ...task(2), text: "pear", name: '"pear"' };
  let s = initialState(0, [a, b]);
  s = reduce(reduce(s, { type: "openFilter" }), { type: "filterEdit", query: "apple" });
  s = reduce(s, { type: "filterKeep" });
  assert.equal(selectedTask(s)?.id, 1);
  s = reduce(s, mgr({ type: "task:removed", taskId: 1 }));
  assert.equal(s.selected, 0);
  assert.equal(selectedTask(s), null);
});

test("state_filter_keeps_newest_first", () => {
  let s = initialState(0, [at(1, 1), at(2, 4), at(3, 2), at(4, 3)]);
  s = { ...s, tasks: s.tasks.map((t) => (t.id === 1 || t.id === 3 ? { ...t, text: `x${t.id}`, name: `"x${t.id}"` } : t)) };
  assert.deepEqual(ids(reduce(s, { type: "filterEdit", query: "task" })), [2, 4]);
  assert.deepEqual(ids(reduce(s, { type: "filterEdit", query: "x" })), [3, 1]);
});

test("state_focus_list_keeps_compose_text", () => {
  let s = reduce(initialState(0), { type: "focus", target: "compose" });
  s = withText(s, "hello");
  s = reduce(s, { type: "focus", target: "list" });
  assert.equal(s.mode, "list");
  assert.equal(s.focus, "list");
  assert.equal(s.compose.text, "hello");
});
