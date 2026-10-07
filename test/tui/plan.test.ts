import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { cleanup, render } from "ink-testing-library";
import { createElement as h } from "react";

import type { PlanSnapshot, TaskSnapshot, TaskState } from "../../src/runs/manager.ts";
import { App } from "../../src/tui/app.ts";
import { EMPTY_COMPOSE, insertText } from "../../src/tui/compose.ts";
import { firstLine } from "../../src/tui/editor.ts";
import { keymap } from "../../src/tui/keys.ts";
import type { Command } from "../../src/tui/keys.ts";
import { key } from "../../src/tui/keypress.ts";
import { initialState, planTally, reduce, selectedPlan, selectedTask, visibleRows } from "../../src/tui/state.ts";
import type { UiAction, ViewState } from "../../src/tui/state.ts";
import { FakeManager, planSnapshot, snapshot } from "./fake-manager.ts";

afterEach(() => cleanup());

const ui = (action: UiAction): Command => ({ kind: "ui", action });
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SGR = /\x1b\[[0-9;]*m/g;

/** A typed task made at `createdAt`, and plan 1 (made at 10) holding tasks 2, 3, 4 in that order. */
function world(states: TaskState[] = ["idle", "idle", "idle"], plan: Partial<PlanSnapshot> = {}): { tasks: TaskSnapshot[]; plans: PlanSnapshot[] } {
  const tasks = [
    snapshot(1, "Standalone old", { createdAt: 5 }),
    ...states.map((state, i) => snapshot(i + 2, `Scenario ${i + 1}`, {
      name: `S${i + 1}: Scenario ${i + 1}`, planId: 1, createdAt: 11, state, source: { kind: "file", path: `tasks/qa-plan/0${i + 1}.md` },
      runId: state === "idle" ? null : `r${i + 2}`, runCount: state === "idle" ? 0 : 1,
    })),
    snapshot(9, "Standalone new", { createdAt: 20 }),
  ];
  return { tasks, plans: [planSnapshot(1, [2, 3, 4], { createdAt: 10, ...plan })] };
}
function mk(states?: TaskState[], plan?: Partial<PlanSnapshot>): ViewState {
  const w = world(states, plan);
  return initialState(0, w.tasks, [], null, w.plans);
}
const labels = (s: ViewState): string[] => visibleRows(s).map((r) => (r.kind === "plan" ? `plan ${r.plan.id}` : `task ${s.tasks[r.index]!.id}`));
const press = (s: ViewState, spec: string): Command[] => keymap(key(spec), s, 0);
const play = (s: ViewState, cmds: Command[]): ViewState => cmds.reduce((acc, c) => (c.kind === "ui" ? reduce(acc, c.action) : acc), s);
const onPlan = (s: ViewState): ViewState => reduce(s, { type: "selectPlan", id: 1 });
const onTask = (s: ViewState, id: number): ViewState => reduce(s, { type: "selectTask", id });

test("rows_put_plan_tasks_under_their_plan_in_plan_order", () => {
  const s = mk();
  assert.deepEqual(labels(s), ["task 9", "plan 1", "task 2", "task 3", "task 4", "task 1"]);
  // The plan's order wins over creation order.
  const moved = reduce(s, { type: "manager", event: { type: "plan:updated", plan: { ...s.plans[0]!, taskIds: [4, 2, 3] } } });
  assert.deepEqual(labels(moved), ["task 9", "plan 1", "task 4", "task 2", "task 3", "task 1"]);
});

test("selection_moves_over_plan_headers", () => {
  let s = mk();
  assert.equal(selectedTask(s)?.id, 9);
  s = reduce(s, { type: "select", delta: 1 });
  assert.equal(selectedTask(s), null);
  assert.equal(selectedPlan(s)?.id, 1);
  s = reduce(s, { type: "select", delta: 1 });
  assert.equal(selectedTask(s)?.id, 2);
  s = reduce(s, { type: "selectEdge", edge: "last" });
  assert.equal(selectedTask(s)?.id, 1);
});

test("collapse_hides_plan_tasks_and_moves_the_selection_to_the_header", () => {
  let s = onTask(mk(), 3);
  s = play(s, press(s, "c"));
  assert.deepEqual(labels(s), ["task 9", "plan 1", "task 1"]);
  assert.equal(selectedPlan(s)?.id, 1);
  s = play(s, press(s, "c"));
  assert.deepEqual(labels(s), ["task 9", "plan 1", "task 2", "task 3", "task 4", "task 1"]);
  // Selecting a task of a folded plan unfolds it.
  s = reduce(reduce(s, { type: "collapse", id: 1 }), { type: "selectTask", id: 4 });
  assert.equal(selectedTask(s)?.id, 4);
  assert.ok(labels(s).includes("task 4"));
});

test("filter_keeps_a_plan_with_matching_tasks", () => {
  let s = reduce(mk(), { type: "openFilter" });
  s = reduce(s, { type: "filterEdit", query: "scenario 2" });
  assert.deepEqual(labels(s), ["plan 1", "task 3"]);
  s = reduce(s, { type: "filterEdit", query: "qa-plan" });
  assert.deepEqual(labels(s), ["plan 1"]);
});

test("removing_a_selected_plan_task_selects_the_next_row", () => {
  let s = onTask(mk(), 3);
  s = reduce(s, { type: "manager", event: { type: "task:removed", taskId: 3 } });
  assert.equal(selectedTask(s)?.id, 4);
  s = onPlan(s);
  s = reduce(s, { type: "manager", event: { type: "plan:removed", planId: 1 } });
  assert.equal(selectedTask(s)?.id, 2, "its tasks stay until their own removals arrive");
});

test("plan_tally_counts_states_and_queue", () => {
  const s = mk(["passed", "failed", "idle"], { queued: [4] });
  assert.deepEqual(planTally(s, s.plans[0]!), { total: 3, passed: 1, failed: 1, live: 0, running: true, cost: 0 });
});

test("plan_header_keys", () => {
  const s = onPlan(mk());
  assert.deepEqual(press(s, "space"), [{ kind: "plan", call: "runAll", id: 1 }]);
  assert.deepEqual(press(s, "d"), [ui({ type: "confirm", value: { kind: "removePlan", planId: 1 } })]);
  assert.deepEqual(press(s, "return"), [ui({ type: "focus", target: "detail" })]);
  assert.deepEqual(press(s, "e"), [{ kind: "openEdit", target: { kind: "setup", planId: 1 }, title: "tasks/qa-plan/shared/setup.md" }]);
  assert.deepEqual(press(s, "F"), [], "nothing failed yet");
  const failed = onPlan(mk(["passed", "failed", "idle"]));
  assert.deepEqual(press(failed, "F"), [{ kind: "plan", call: "runFailed", id: 1 }]);
  const running = onPlan(mk(["passed", "running", "idle"], { queued: [4] }));
  assert.deepEqual(press(running, "space"), []);
  assert.deepEqual(press(running, "s"), [{ kind: "plan", call: "stop", id: 1 }]);
  assert.deepEqual(press(running, "d"), []);
  const planning = onPlan(mk([], { state: "planning", taskIds: [] }));
  assert.deepEqual(press(planning, "s"), [{ kind: "plan", call: "cancel", id: 1 }]);
  assert.deepEqual(press(planning, "space"), []);
  const failedPlan = onPlan(mk([], { state: "failed", error: "boom", taskIds: [] }));
  assert.deepEqual(press(failedPlan, "space"), [{ kind: "plan", call: "retry", id: 1 }]);
});

test("plan_task_keys_move_edit_and_rerun_failed", () => {
  const s = onTask(mk(["idle", "failed", "idle"]), 3);
  assert.deepEqual(press(s, "J"), [{ kind: "move", id: 3, delta: 1 }]);
  assert.deepEqual(press(s, "K"), [{ kind: "move", id: 3, delta: -1 }]);
  assert.deepEqual(press(s, "e"), [{ kind: "openEdit", target: { kind: "task", id: 3 }, title: "tasks/qa-plan/02.md" }]);
  assert.deepEqual(press(s, "F"), [{ kind: "plan", call: "runFailed", id: 1 }]);
  assert.deepEqual(press(s, "space"), [{ kind: "manager", call: "start", id: 3 }], "space still runs just this task");
  // No moving while the plan runs, and no J/K for a task outside a plan.
  assert.deepEqual(press(onTask(mk(["running", "idle", "idle"]), 3), "J"), []);
  assert.deepEqual(press(onTask(mk(), 9), "J"), []);
});

test("P_opens_the_plan_box_and_enter_plans_one_file", () => {
  let s = play(mk(), press(mk(), "P"));
  assert.equal(s.mode, "compose");
  assert.equal(s.composeFor, "plan");
  s = reduce(s, { type: "compose", next: insertText(EMPTY_COMPOSE, "@docs/qa-plan.md") });
  assert.deepEqual(press(s, "return"), [ui({ type: "completion", value: null }), { kind: "planSubmission", path: "docs/qa-plan.md" }]);
  const typed = reduce(s, { type: "compose", next: insertText(EMPTY_COMPOSE, "docs/qa plan.md") });
  assert.deepEqual(press(typed, "return")[1], { kind: "planSubmission", path: "docs/qa plan.md" });
  const two = reduce(s, { type: "compose", next: insertText(EMPTY_COMPOSE, "@a.md @b.md") });
  assert.deepEqual(press(two, "return"), [ui({ type: "addFailed", errors: ["give one plan file or planned folder"], cursor: 11 })]);
  // a opens the box for a task again.
  const back = play(reduce(s, { type: "escape" }), press(reduce(s, { type: "escape" }), "a"));
  assert.equal(back.composeFor, "task");
});

test("editor_keys", () => {
  const opened = reduce(mk(), {
    type: "edit", value: { target: { kind: "task", id: 1 }, title: "t", original: "ab", compose: { ...insertText(EMPTY_COMPOSE, "ab"), cursor: 2 }, error: null },
  });
  assert.equal(opened.mode, "edit");
  assert.deepEqual(press(opened, "escape"), [ui({ type: "edit", value: null })], "nothing changed: close at once");
  const typed = play(opened, press(opened, "return"));
  assert.equal(typed.edit?.compose.text, "ab\n");
  assert.deepEqual(press(typed, "ctrl+s"), [{ kind: "saveEdit" }]);
  const asking = play(typed, press(typed, "escape"));
  assert.equal(asking.mode, "confirm");
  assert.deepEqual(asking.confirm, { kind: "discard" });
  assert.equal(play(asking, press(asking, "n")).mode, "edit", "no goes back to the editor");
  const gone = play(asking, press(asking, "y"));
  assert.equal(gone.edit, null);
  assert.equal(gone.mode, "list");
  // A refused save keeps the editor open with the reason.
  const refused = reduce(typed, { type: "editFailed", error: "bad front matter" });
  assert.equal(refused.edit?.error, "bad front matter");
  assert.equal(play(refused, press(refused, "x")).edit?.error, null, "typing clears it");
});

test("editor_scrolls_to_the_cursor", () => {
  assert.equal(firstLine(0, 100, 10), 0);
  assert.equal(firstLine(50, 100, 10), 41);
  assert.equal(firstLine(99, 100, 10), 90);
  assert.equal(firstLine(3, 5, 10), 0);
});

function mount(m: FakeManager) {
  const r = render(h(App, { manager: m, size: { columns: 100, rows: 24 }, tickMs: 10, onQuit: () => {}, onForceExit: () => {} }));
  return {
    frame: () => (r.lastFrame() ?? "").replace(SGR, ""),
    async type(...inputs: string[]) {
      for (const input of inputs) {
        r.stdin.write(input);
        await settle();
      }
    },
  };
}

test("app_shows_a_plan_group_and_its_detail", async () => {
  const w = world(["passed", "failed", "idle"], { notes: ["Start the fixture server"], skipped: [{ id: "S9", title: "Exit codes", reason: "needs a shell" }] });
  const m = new FakeManager(w.tasks);
  m.plansValue = w.plans;
  const t = mount(m);
  await settle();
  let f = t.frame();
  assert.match(f, /▾ qa-plan\.md +1\/3 ✗1/);
  assert.match(f, /  ✓ S1: Scenario 1/);
  assert.match(f, /  ✗ S2: Scenario 2/);
  await t.type("j");
  f = t.frame();
  assert.match(f, /Shared setup, done first in every task/);
  assert.match(f, /Log in as qa\./);
  assert.match(f, /Before you run \(the agent can't do these\)/);
  assert.match(f, /- Start the fixture server/);
  assert.match(f, /1\. ✓ S1: Scenario 1/);
  assert.match(f, /S9 Exit codes: needs a shell/);
  assert.match(f, /space run plan/);
  await t.type(" ");
  assert.deepEqual(m.log.slice(-1), ["runPlan:1:all"]);
  await t.type("j");
  assert.match(t.frame(), /plan: qa-plan\.md, task 1 of 3/);
});

test("app_plan_box_plans_and_selects_the_plan", async () => {
  const m = new FakeManager();
  m.planResult = { ok: false, error: "nope.md: not found" };
  const t = mount(m);
  await settle();
  await t.type("P");
  assert.match(t.frame(), /plan › @ a plan file to break into tasks/);
  await t.type("nope.md", "\r");
  assert.deepEqual(m.log, ["plan:nope.md"]);
  assert.match(t.frame(), /nope\.md: not found/);
  m.planResult = { ok: true, id: 1 };
  m.plansValue = [planSnapshot(1, [], { state: "planning" })];
  m.emit({ type: "plan:added", plan: m.plansValue[0]! });
  await t.type("\r");
  const f = t.frame();
  assert.match(f, /planning/);
  assert.match(f, /Claude is splitting the plan/);
  assert.match(f, /› Describe a task/, "the box takes tasks again");
});

test("app_edit_a_task_and_save", async () => {
  const m = new FakeManager([snapshot(1, "Open a")]);
  m.sourceText = "Open a";
  const t = mount(m);
  await settle();
  await t.type("e");
  assert.match(t.frame(), /edit "Open a"/);
  assert.match(t.frame(), /1 Open a/);
  await t.type("\x1b[F", " now", "\x13");
  assert.deepEqual(m.log, ["readSource:1", "saveSource:1:Open a now"]);
  assert.doesNotMatch(t.frame(), /edit "Open a"/);
  // A refused save shows why and keeps the editor.
  m.saveResult = { ok: false, error: "the task is empty" };
  await t.type("e", "\x13");
  assert.match(t.frame(), /! the task is empty/);
});

test("a_new_plan_takes_the_selection_from_the_top_row_only", () => {
  const empty = initialState(0);
  const added = reduce(empty, { type: "manager", event: { type: "plan:added", plan: planSnapshot(5, [], { createdAt: 50 }) } });
  assert.equal(selectedPlan(added)?.id, 5);
  const moved = reduce(mk(), { type: "selectTask", id: 1 });
  const kept = reduce(moved, { type: "manager", event: { type: "plan:added", plan: planSnapshot(5, [], { createdAt: 50 }) } });
  assert.equal(selectedTask(kept)?.id, 1);
});
