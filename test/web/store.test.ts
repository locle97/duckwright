import assert from "node:assert/strict";
import { test } from "node:test";

import type { Decision } from "../../src/brain.ts";
import type { RunEvent, RunOutcome } from "../../src/events.ts";
import type { ManagerEvent } from "../../src/runs/manager.ts";
import { clean } from "../../web/src/clean.ts";
import {
  initialState, liveCount, pendingTwofa, planTally, reduce, selectedRun, selectedTask, totalCost, visibleRows,
} from "../../web/src/store.ts";
import type { Action, StreamMessage, WebState } from "../../web/src/store.ts";
import { planSnapshot, snapshot } from "../tui/fake-manager.ts";

const OUTCOME: RunOutcome = {
  status: "pass", exitCode: 0, success: true, answer: "ok", steps: 1, costUsd: 0.5, historyPath: null,
  export: { kind: "off" }, warnings: [], error: null,
};
const dec = (goal: string): Decision => ({
  evaluationPreviousGoal: "e", memory: "m", nextGoal: goal, actions: [{ cmd: "goto", args: ["u"] }],
} as Decision);
const runStart = (): RunEvent => ({ type: "run:start", at: 1, task: "t", maxSteps: 5, model: "m", snapshot: "hybrid", headed: false, session: "s", workdir: "/w" });
const stateMsg = (over: Partial<Extract<StreamMessage, { type: "state" }>> = {}): Action => ({
  type: "stream", now: 0,
  message: {
    type: "state", tasks: [], plans: [], globals: { base: snapshot(0, "").effective, overrides: {} }, activeCount: 0,
    maxParallel: 3, notices: [], theme: "auto", runs: [], ...over,
  },
});
const mgr = (message: ManagerEvent): Action => ({ type: "stream", message, now: 0 });
const apply = (s: WebState, ...a: Action[]): WebState => a.reduce(reduce, s);

test("a state message fills the store, selects the newest row and turns notices into toasts", () => {
  const tasks = [snapshot(1, "one", { createdAt: 1 }), snapshot(2, "two", { createdAt: 2 })];
  const s = apply(initialState(100), stateMsg({ tasks, notices: ["skipped 2 run folders"], maxParallel: 5 }));
  assert.equal(s.loaded, true);
  assert.equal(s.maxParallel, 5);
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
  assert.equal(s.toasts[0]!.message, "skipped 2 run folders");
  assert.equal(s.toasts[0]!.until, 4000); // the message's `now` (0) plus 4 s
});

test("logged runs and past runs are folded into run views", () => {
  const past = snapshot(1, "old", { runId: "p1", createdAt: 1, past: { runId: "p1", events: [runStart(), { type: "run:end", at: 2, outcome: OUTCOME }] } });
  const live = snapshot(2, "live", { runId: "r2", state: "running", createdAt: 2 });
  const s = apply(initialState(), stateMsg({
    tasks: [past, live],
    runs: [{ taskId: 2, runId: "r2", events: [runStart(), { type: "step:start", at: 2, step: 1 }] }],
  }));
  assert.equal(s.runs.p1!.past, true);
  assert.equal(s.runs.p1!.outcome?.status, "pass");
  assert.equal(s.runs.r2!.steps.length, 1);
  assert.equal(s.runs.r2!.past, undefined);
});

test("task and run events update the store", () => {
  let s = apply(initialState(), stateMsg({ tasks: [snapshot(1, "one")] }));
  s = apply(s, mgr({ type: "run", taskId: 1, runId: "r1", event: runStart() }));
  s = apply(s, mgr({ type: "run", taskId: 1, runId: "r1", event: { type: "step:start", at: 2, step: 1 } }));
  s = apply(s, mgr({ type: "run", taskId: 1, runId: "r1", event: { type: "decision", at: 3, step: 1, decision: dec("go"), cost: 0.25 } }));
  s = apply(s, mgr({ type: "task:updated", task: snapshot(1, "one", { state: "running", runId: "r1", runCount: 1 }) }));
  assert.equal(selectedTask(s)!.state, "running");
  assert.equal(selectedRun(s)!.steps[0]!.goal, "go");
  assert.equal(totalCost(s), 0.25);
  assert.equal(liveCount(s), 1);
  s = apply(s, mgr({ type: "task:added", task: snapshot(2, "two", { createdAt: 5 }) }));
  assert.equal(s.tasks.length, 2);
  s = apply(s, mgr({ type: "task:removed", taskId: 1 }));
  assert.deepEqual(s.tasks.map((t) => t.id), [2]);
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
});

test("plans nest their tasks, collapse, and the filter narrows rows", () => {
  const tasks = [
    snapshot(1, "alpha", { createdAt: 1, planId: 1 }), snapshot(2, "beta", { createdAt: 1, planId: 1 }),
    snapshot(3, "gamma", { createdAt: 2 }),
  ];
  let s = apply(initialState(), stateMsg({ tasks, plans: [planSnapshot(1, [1, 2], { createdAt: 3 })] }));
  assert.deepEqual(visibleRows(s).map((r) => (r.kind === "plan" ? `plan${r.plan.id}` : `task${r.task.id}`)), ["plan1", "task1", "task2", "task3"]);
  s = apply(s, { type: "collapse", id: 1 });
  assert.deepEqual(visibleRows(s).map((r) => (r.kind === "plan" ? `plan${r.plan.id}` : `task${r.task.id}`)), ["plan1", "task3"]);
  s = apply(s, { type: "collapse", id: 1 }, { type: "filter", value: "BET" });
  assert.deepEqual(visibleRows(s).map((r) => (r.kind === "plan" ? `plan${r.plan.id}` : `task${r.task.id}`)), ["plan1", "task2"]);
});

test("move steps through the visible rows and clamps at the ends", () => {
  const tasks = [snapshot(1, "a", { createdAt: 1 }), snapshot(2, "b", { createdAt: 2 })];
  let s = apply(initialState(), stateMsg({ tasks }));
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
  s = apply(s, { type: "move", delta: 1 });
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
  s = apply(s, { type: "move", delta: 5 });
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
  s = apply(s, { type: "move", delta: -9 });
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
});

test("a removed selection moves to a neighbour; a hidden one snaps to the first row", () => {
  const tasks = [snapshot(1, "a", { createdAt: 1 }), snapshot(2, "b", { createdAt: 2 }), snapshot(3, "c", { createdAt: 3 })];
  let s = apply(initialState(), stateMsg({ tasks }), { type: "select", selection: { kind: "task", id: 2 } });
  s = apply(s, mgr({ type: "task:removed", taskId: 2 }));
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
  s = apply(s, { type: "filter", value: "c" });
  assert.deepEqual(s.selection, { kind: "task", id: 3 });
});

test("timeline actions apply to the selected run", () => {
  let s = apply(initialState(), stateMsg({ tasks: [snapshot(1, "one", { runId: "r1", runCount: 1 })] }));
  s = apply(s, mgr({ type: "run", taskId: 1, runId: "r1", event: runStart() }));
  s = apply(s, mgr({ type: "run", taskId: 1, runId: "r1", event: { type: "step:start", at: 2, step: 1 } }));
  s = apply(s, { type: "timeline", op: "collapseAll" }, { type: "timeline", op: "toggle" });
  assert.deepEqual(selectedRun(s)!.expanded, [0]);
});

test("a 2FA wait is found, and keyed by task, kind and run count", () => {
  const s = apply(initialState(), stateMsg({ tasks: [snapshot(1, "a"), snapshot(2, "b", { twofa: { kind: "totp" } })] }));
  assert.equal(pendingTwofa(s)!.id, 2);
});

test("plan tally counts states and a running plan", () => {
  const tasks = [
    snapshot(1, "a", { planId: 1, state: "passed" }), snapshot(2, "b", { planId: 1, state: "failed" }),
    snapshot(3, "c", { planId: 1, state: "running" }), snapshot(4, "d", { planId: 1, state: "idle" }),
  ];
  const plan = planSnapshot(1, [1, 2, 3, 4]);
  const s = apply(initialState(), stateMsg({ tasks, plans: [plan] }));
  assert.deepEqual(planTally(s, plan), { total: 4, passed: 1, failed: 1, live: 1, running: true, cost: 0 });
});

test("toasts expire on tick; errors from actions can be added", () => {
  let s = apply(initialState(0), { type: "toast", level: "error", message: "bad" });
  assert.equal(s.toasts.length, 1);
  s = apply(s, { type: "tick", now: 3999 });
  assert.equal(s.toasts.length, 1);
  s = apply(s, { type: "tick", now: 4000 });
  assert.equal(s.toasts.length, 0);
});

test("dialogs open and close, and the editor tracks text and errors", () => {
  let s = apply(initialState(), { type: "dialog", value: { kind: "edit", draft: { target: { kind: "task", id: 1 }, title: "t", original: "a", text: "a", error: null } } });
  s = apply(s, { type: "editText", text: "ab" }, { type: "editFailed", error: "empty" });
  assert.equal(s.dialog?.kind === "edit" && s.dialog.draft.text, "ab");
  assert.equal(s.dialog?.kind === "edit" && s.dialog.draft.error, "empty");
  s = apply(s, { type: "dialog", value: null });
  assert.equal(s.dialog, null);
});

test("connection and ended flags", () => {
  let s = apply(initialState(), { type: "connection", connected: true });
  assert.equal(s.connected, true);
  s = apply(s, { type: "connection", connected: false }, { type: "ended" });
  assert.deepEqual([s.connected, s.ended], [false, true]);
  s = apply(initialState(), { type: "connection", connected: true }, { type: "expired" });
  assert.deepEqual([s.expired, s.connected], [true, false]);
});

test("clean strips escapes and control characters", () => {
  assert.equal(clean("a\x1b[31mred\x1b[0m\x07b"), "aredb");
  assert.equal(clean("one\ntwo"), "one two");
  assert.equal(clean("one\ntwo", { multiline: true }), "one\ntwo");
  assert.equal(clean("tab\there"), "tab here");
});

const hist = (id: number, createdAt = id) =>
  snapshot(id, `h${id}`, { createdAt, runId: `p${id}`, past: { runId: `p${id}`, events: [runStart(), { type: "run:end", at: 2, outcome: OUTCOME }] } });
const ids = (s: WebState): number[] => visibleRows(s).map((r) => (r.kind === "task" ? r.task.id : -r.plan.id));

test("tabs split tasks and history; plans only show on Tasks", () => {
  let s = apply(initialState(), stateMsg({ tasks: [hist(1), hist(2), snapshot(3, "t", { createdAt: 3 })], plans: [planSnapshot(1, [3])] }));
  assert.equal(s.tab, "tasks");
  assert.ok(!ids(s).includes(1) && !ids(s).includes(2));
  assert.ok(ids(s).includes(-1));
  s = apply(s, { type: "tab" });
  assert.equal(s.tab, "history");
  assert.deepEqual(ids(s), [2, 1]);
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
  s = apply(s, { type: "tab" });
  assert.equal(s.tab, "tasks");
});

test("each tab keeps its own selection and filter", () => {
  let s = apply(initialState(), stateMsg({ tasks: [hist(1), hist(2), snapshot(3, "t3", { createdAt: 3 }), snapshot(4, "t4", { createdAt: 4 })] }));
  s = apply(s, { type: "move", delta: 1 }, { type: "filter", value: "t3" });
  assert.deepEqual(s.selection, { kind: "task", id: 3 });
  s = apply(s, { type: "tab" });
  assert.equal(s.filter, "");
  s = apply(s, { type: "move", delta: 1 }, { type: "tab" });
  assert.equal(s.filter, "t3");
  assert.deepEqual(s.selection, { kind: "task", id: 3 });
  s = apply(s, { type: "tab" });
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
});

test("opens on History when there are only past runs", () => {
  assert.equal(apply(initialState(), stateMsg({ tasks: [hist(1)] })).tab, "history");
  assert.equal(apply(initialState(), stateMsg()).tab, "tasks");
});

test("running a past task again moves it to Tasks and the view follows", () => {
  let s = apply(initialState(), stateMsg({ tasks: [hist(1), hist(2), snapshot(3, "t", { createdAt: 3 })] }), { type: "tab" });
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
  s = apply(s, mgr({ type: "task:updated", task: { ...s.tasks[1]!, state: "running", runCount: 1 } }));
  assert.equal(s.tab, "tasks");
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
  assert.deepEqual(ids(s), [3, 2]);
  s = apply(s, { type: "tab" });
  assert.deepEqual(ids(s), [1]);
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
});

test("a past task run again while another is selected leaves the view alone", () => {
  let s = apply(initialState(), stateMsg({ tasks: [hist(1), hist(2)] }));
  s = apply(s, mgr({ type: "task:updated", task: { ...s.tasks[0]!, state: "running", runCount: 1 } }));
  assert.equal(s.tab, "history");
  assert.deepEqual(s.selection, { kind: "task", id: 2 });
});

test("an added task shows its tab; selecting a past task shows History; a plan's tasks keep the tab", () => {
  let s = apply(initialState(), stateMsg({ tasks: [hist(1)] }));
  assert.equal(s.tab, "history");
  s = apply(s, mgr({ type: "task:added", task: snapshot(2, "new", { createdAt: 5 }) }));
  assert.equal(s.tab, "tasks");
  assert.deepEqual(ids(s), [2]);
  s = apply(s, { type: "select", selection: { kind: "task", id: 1 } });
  assert.equal(s.tab, "history");
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
  s = apply(s, mgr({ type: "task:added", task: snapshot(3, "planned", { createdAt: 6, planId: 7 }) }));
  assert.equal(s.tab, "history");
});

test("a new plan does not steal the selection on the History tab", () => {
  let s = apply(initialState(), stateMsg({ tasks: [hist(1)] }));
  s = apply(s, mgr({ type: "plan:added", plan: planSnapshot(1, []) }));
  assert.deepEqual(s.selection, { kind: "task", id: 1 });
});

test("image_dialog_action", () => {
  const value = { kind: "image" as const, src: "/api/runs/x/screenshots/step-001.png", title: "Screenshot: step 1" };
  const s = reduce(initialState(), { type: "dialog", value });
  assert.deepEqual(s.dialog, value);
  assert.equal(reduce(s, { type: "dialog", value: null }).dialog, null);
});
