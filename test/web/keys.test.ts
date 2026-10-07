import assert from "node:assert/strict";
import { test } from "node:test";

import { commandFor, shouldIgnore } from "../../web/src/keys.ts";
import { initialState, reduce } from "../../web/src/store.ts";
import type { Action, WebState } from "../../web/src/store.ts";
import type { KeyInfo } from "../../web/src/keys.ts";
import { planSnapshot, snapshot } from "../tui/fake-manager.ts";

function state(tasks = [snapshot(1, "one")], plans = [] as ReturnType<typeof planSnapshot>[], selection: WebState["selection"] = { kind: "task", id: 1 }): WebState {
  const s: Action = {
    type: "stream", now: 0,
    message: { type: "state", tasks, plans, globals: { base: snapshot(0, "").effective, overrides: {} }, activeCount: 0, maxParallel: 3, notices: [], theme: "auto", runs: [] },
  };
  return { ...reduce(initialState(), s), selection };
}

test("a and P open the add dialogs, ? the help, / focuses the filter", () => {
  const s = state();
  assert.deepEqual(commandFor("a", s), { type: "action", action: { type: "dialog", value: { kind: "add", mode: "task" } } });
  assert.deepEqual(commandFor("P", s), { type: "action", action: { type: "dialog", value: { kind: "add", mode: "plan" } } });
  assert.deepEqual(commandFor("?", s), { type: "action", action: { type: "dialog", value: { kind: "help" } } });
  assert.deepEqual(commandFor("/", s), { type: "focusFilter" });
});

test("space starts an idle task, not a live one", () => {
  assert.deepEqual(commandFor(" ", state()), { type: "task", id: 1, verb: "start" });
  assert.equal(commandFor(" ", state([snapshot(1, "one", { state: "running" })])), null);
});

test("space on a ready plan runs it", () => {
  const s = state([snapshot(1, "one", { planId: 1 })], [planSnapshot(1, [1])], { kind: "plan", id: 1 });
  assert.deepEqual(commandFor(" ", s), { type: "runPlan", id: 1 });
});

test("p pauses a running task and resumes a paused one; n steps; s stops", () => {
  const running = state([snapshot(1, "one", { state: "running" })]);
  const paused = state([snapshot(1, "one", { state: "paused" })]);
  assert.deepEqual(commandFor("p", running), { type: "task", id: 1, verb: "pause" });
  assert.deepEqual(commandFor("p", paused), { type: "task", id: 1, verb: "resume" });
  assert.deepEqual(commandFor("n", paused), { type: "task", id: 1, verb: "step" });
  assert.equal(commandFor("n", running), null);
  assert.deepEqual(commandFor("s", running), { type: "task", id: 1, verb: "stop" });
  assert.equal(commandFor("s", state()), null);
});

test("j and k move the selection; arrows too", () => {
  const s = state();
  assert.deepEqual(commandFor("j", s), { type: "action", action: { type: "move", delta: 1 } });
  assert.deepEqual(commandFor("ArrowUp", s), { type: "action", action: { type: "move", delta: -1 } });
});

test("e edits a task that is not running and not a past run", () => {
  assert.deepEqual(commandFor("e", state()), { type: "editTask", id: 1, name: '"one"' });
  assert.equal(commandFor("e", state([snapshot(1, "one", { state: "running" })])), null);
  assert.equal(commandFor("e", state([snapshot(1, "one", { past: { runId: "p", events: [] } })])), null);
});

test("x asks before removing; a running task cannot be removed", () => {
  assert.deepEqual(commandFor("x", state()), {
    type: "action", action: { type: "dialog", value: { kind: "confirm", confirm: { kind: "remove", taskId: 1 } } },
  });
  assert.equal(commandFor("x", state([snapshot(1, "one", { state: "running" })])), null);
});

test("q quits at once when nothing runs, and asks when something does", () => {
  assert.deepEqual(commandFor("q", state()), { type: "quit" });
  assert.deepEqual(commandFor("q", state([snapshot(1, "one", { state: "running" })])), {
    type: "action", action: { type: "dialog", value: { kind: "confirm", confirm: { kind: "quit", count: 1 } } },
  });
});

test("timeline keys", () => {
  const s = state();
  assert.deepEqual(commandFor("Enter", s), { type: "action", action: { type: "timeline", op: "toggle" } });
  assert.deepEqual(commandFor("]", s), { type: "action", action: { type: "timeline", op: "move", delta: 1 } });
  assert.deepEqual(commandFor("E", s), { type: "action", action: { type: "timeline", op: "expandAll" } });
  assert.deepEqual(commandFor("G", s), { type: "action", action: { type: "timeline", op: "last" } });
});

test("unknown keys do nothing", () => {
  assert.equal(commandFor("z", state()), null);
});

test("e on a plan with a setup file edits the setup; x on a ready plan asks to remove it", () => {
  const s = state([snapshot(1, "one", { planId: 1 })], [planSnapshot(1, [1])], { kind: "plan", id: 1 });
  assert.deepEqual(commandFor("e", s), { type: "editSetup", planId: 1, name: "qa-plan.md setup" });
  assert.deepEqual(commandFor("x", s), {
    type: "action", action: { type: "dialog", value: { kind: "confirm", confirm: { kind: "removePlan", planId: 1 } } },
  });
});

test("o opens the task options and O the global ones", () => {
  const s = state();
  assert.deepEqual(commandFor("o", s), { type: "action", action: { type: "dialog", value: { kind: "options", taskId: 1 } } });
  assert.deepEqual(commandFor("O", s), { type: "action", action: { type: "dialog", value: { kind: "options", taskId: null } } });
});

test("[ moves the timeline back and C collapses all", () => {
  const s = state();
  assert.deepEqual(commandFor("[", s), { type: "action", action: { type: "timeline", op: "move", delta: -1 } });
  assert.deepEqual(commandFor("C", s), { type: "action", action: { type: "timeline", op: "collapseAll" } });
});

const press = (over: Partial<KeyInfo> = {}): KeyInfo => ({
  key: "a", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, inEditable: false, inInteractive: false, ...over,
});

test("shouldIgnore lets a plain key on the page through", () => {
  assert.equal(shouldIgnore(press(), state()), false);
});

test("shouldIgnore steps aside for modifiers, handled events and text fields", () => {
  assert.equal(shouldIgnore(press({ ctrlKey: true }), state()), true);
  assert.equal(shouldIgnore(press({ metaKey: true }), state()), true);
  assert.equal(shouldIgnore(press({ altKey: true }), state()), true);
  assert.equal(shouldIgnore(press({ defaultPrevented: true }), state()), true);
  assert.equal(shouldIgnore(press({ inEditable: true }), state()), true);
});

test("shouldIgnore steps aside while a dialog or a 2FA prompt is up", () => {
  assert.equal(shouldIgnore(press(), { ...state(), dialog: { kind: "help" } }), true);
  const t = snapshot(1, "one", { twofa: { kind: "code" } as never });
  assert.equal(shouldIgnore(press(), state([t])), true);
});

test("shouldIgnore is on for the ended, expired and not-yet-loaded screens", () => {
  assert.equal(shouldIgnore(press(), { ...state(), ended: true }), true);
  assert.equal(shouldIgnore(press(), { ...state(), expired: true }), true);
  assert.equal(shouldIgnore(press(), { ...state(), loaded: false }), true);
});

test("shouldIgnore leaves Enter and Space to a focused button or link, but not other keys", () => {
  assert.equal(shouldIgnore(press({ key: "Enter", inInteractive: true }), state()), true);
  assert.equal(shouldIgnore(press({ key: " ", inInteractive: true }), state()), true);
  assert.equal(shouldIgnore(press({ key: "a", inInteractive: true }), state()), false);
  assert.equal(shouldIgnore(press({ key: "Enter" }), state()), false);
});
