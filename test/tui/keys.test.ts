import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskSnapshot, TaskState } from "../../src/runs/manager.ts";
import { insertText } from "../../src/tui/compose.ts";
import { openForm, formKey } from "../../src/tui/form.ts";
import { helpBindings, hints, keymap } from "../../src/tui/keys.ts";
import type { Command } from "../../src/tui/keys.ts";
import { key } from "../../src/tui/keypress.ts";
import { initialState, reduce } from "../../src/tui/state.ts";
import type { UiAction, ViewState } from "../../src/tui/state.ts";

function task(id: number, state: TaskState = "idle"): TaskSnapshot {
  const live = state === "running" || state === "paused" || state === "stopping";
  return {
    id, text: `task ${id}`, name: `"task ${id}"`, state, overrides: {},
    effective: { model: "m", maxSteps: 10, headed: false, export: false, snapshot: "hybrid" },
    error: null, runId: live || state === "passed" ? `r${id}` : null, runCount: live ? 1 : 0,
  };
}

const ui = (action: UiAction): Command => ({ kind: "ui", action });
const mk = (...states: TaskState[]): ViewState => initialState(0, states.map((st, i) => task(i + 1, st)));
const press = (s: ViewState, spec: string, active = 0): Command[] => keymap(key(spec), s, active);
/** Apply the ui commands of a press to the state. */
function play(s: ViewState, cmds: Command[]): ViewState {
  return cmds.reduce((acc, c) => (c.kind === "ui" ? reduce(acc, c.action) : acc), s);
}
/** A detail screen on a task whose run has started, so the timeline exists. */
function detailOf(state: TaskState): ViewState {
  const s = mk(state);
  const event = { type: "run:start", at: 0, task: "t", maxSteps: 10, model: "m", snapshot: "hybrid", headed: false, session: "s", workdir: "/w" };
  const withRun = reduce(s, { type: "manager", event: { type: "run", taskId: 1, runId: "r1", event } as never });
  return reduce(withRun, { type: "focus", target: "detail" });
}
const footer = (s: ViewState): string => hints(s).map((h) => `${h.key} ${h.label}`).join(" · ");

test("keys_list_bindings", () => {
  const s = mk("running", "paused", "idle");
  assert.deepEqual(press(s, "j"), [ui({ type: "select", delta: 1 })]);
  assert.deepEqual(press(s, "down"), [ui({ type: "select", delta: 1 })]);
  assert.deepEqual(press(s, "k"), [ui({ type: "select", delta: -1 })]);
  assert.deepEqual(press(s, "up"), [ui({ type: "select", delta: -1 })]);
  assert.deepEqual(press(s, "pageDown"), [ui({ type: "select", delta: 10 })]);
  assert.deepEqual(press(s, "pageUp"), [ui({ type: "select", delta: -10 })]);
  assert.deepEqual(press(s, "g"), [ui({ type: "selectEdge", edge: "first" })]);
  assert.deepEqual(press(s, "G"), [ui({ type: "selectEdge", edge: "last" })]);
  assert.deepEqual(press(s, "tab"), [ui({ type: "toggleFocus" })]);
  assert.deepEqual(press(s, "?"), [ui({ type: "help", open: true })]);
  assert.deepEqual(press(s, "a"), [ui({ type: "focus", target: "compose" })]);
  assert.deepEqual(press(s, "p"), [{ kind: "manager", call: "pause", id: 1 }]);
  assert.deepEqual(press(s, "s"), [{ kind: "manager", call: "stop", id: 1 }]);
  const paused = reduce(s, { type: "select", delta: 1 });
  assert.deepEqual(press(paused, "r"), [{ kind: "manager", call: "resume", id: 2 }]);
  assert.deepEqual(press(paused, "n"), [{ kind: "manager", call: "step", id: 2 }]);
  assert.deepEqual(press(paused, "."), [{ kind: "manager", call: "step", id: 2 }]);
  assert.deepEqual(press(paused, "s"), [{ kind: "manager", call: "stop", id: 2 }]);
  const idle = reduce(paused, { type: "select", delta: 1 });
  const form = press(idle, "o");
  assert.equal(form.length, 1);
  assert.equal(form[0]?.kind, "ui");
  assert.deepEqual(press(idle, "d"), [ui({ type: "confirm", value: { kind: "remove", taskId: 3 } })]);
  // o and d are refused while a run is live.
  assert.deepEqual(press(s, "o"), []);
  assert.deepEqual(press(s, "d"), []);
});

test("keys_detail_bindings", () => {
  const s = detailOf("running");
  assert.deepEqual(press(s, "j"), [ui({ type: "timeline", op: "move", delta: 1 })]);
  assert.deepEqual(press(s, "up"), [ui({ type: "timeline", op: "move", delta: -1 })]);
  assert.deepEqual(press(s, "pageDown"), [ui({ type: "timeline", op: "page", delta: 10 })]);
  assert.deepEqual(press(s, "return"), [ui({ type: "timeline", op: "toggle" })]);
  assert.deepEqual(press(s, "space"), [ui({ type: "timeline", op: "toggle" })]);
  assert.deepEqual(press(s, "e"), [ui({ type: "timeline", op: "expandAll" })]);
  assert.deepEqual(press(s, "c"), [ui({ type: "timeline", op: "collapseAll" })]);
  assert.deepEqual(press(s, "G"), [ui({ type: "timeline", op: "last" })]);
  assert.deepEqual(press(s, "end"), [ui({ type: "timeline", op: "last" })]);
  assert.deepEqual(press(s, "p"), [{ kind: "manager", call: "pause", id: 1 }]);
  assert.deepEqual(press(s, "escape"), [ui({ type: "escape" })]);
});

test("keys_noop_without_live_run", () => {
  for (const state of ["idle", "passed", "failed", "stopped"] as const) {
    const s = mk(state);
    for (const spec of ["p", "r", "n", ".", "s"]) assert.deepEqual(press(s, spec), [], `${spec} on ${state}`);
  }
  // A stopping task accepts no control keys either, and p needs running, r/n need paused.
  const stopping = mk("stopping");
  for (const spec of ["p", "r", "n", "s", "o", "d"]) assert.deepEqual(press(stopping, spec), [], `${spec} on stopping`);
  assert.deepEqual(press(mk("paused"), "p"), []);
  assert.deepEqual(press(mk("running"), "r"), []);
  assert.deepEqual(press(mk("running"), "n"), []);
  // Every task-directed key on an empty list does nothing.
  const empty = initialState(0);
  for (const spec of ["return", "o", "d", "p", "r", "n", ".", "s", "j", "k", "up", "down", "pageUp", "pageDown", "g", "G", "tab"]) {
    assert.deepEqual(press(empty, spec), [], `${spec} on empty list`);
  }
  const emptyDetail = reduce(empty, { type: "focus", target: "detail" });
  for (const spec of ["return", "space", "e", "c", "G", "end", "j", "p", "s"]) {
    assert.deepEqual(press(emptyDetail, spec), [], `${spec} on empty detail`);
  }
});

test("keys_return_starts_or_focuses", () => {
  for (const state of ["idle", "passed", "failed", "stopped"] as const) {
    assert.deepEqual(press(mk(state), "return"), [{ kind: "manager", call: "start", id: 1 }], state);
  }
  for (const state of ["running", "paused", "stopping"] as const) {
    assert.deepEqual(press(mk(state), "return"), [ui({ type: "focus", target: "detail" })], state);
  }
});

test("keys_compose_submit_and_escape", () => {
  let s = reduce(mk("idle"), { type: "focus", target: "compose" });
  assert.equal(s.mode, "compose");
  // Empty text: return does nothing.
  assert.deepEqual(press(s, "return"), []);
  s = reduce(s, { type: "compose", next: insertText(s.compose, "  buy milk ") });
  const cmds = press(s, "return");
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0]?.kind, "ui");
  assert.deepEqual(cmds[1], { kind: "addTask", text: "buy milk" });
  const after = play(s, cmds);
  assert.equal(after.compose.text, "");
  assert.deepEqual(after.compose.history, ["buy milk"]);
  // alt+return inserts a newline instead of submitting.
  const nl = press(s, "alt+return");
  assert.equal(nl.length, 1);
  assert.equal(play(s, nl).compose.text, "  buy milk \n");
  // Typing goes through the compose editor, escape leaves.
  const typed = play(s, press(s, "x"));
  assert.equal(typed.compose.text, "  buy milk x");
  assert.deepEqual(press(s, "escape"), [ui({ type: "escape" })]);
  assert.equal(play(s, press(s, "escape")).mode, "list");
  // Letters that are bindings elsewhere are plain text here.
  assert.equal(play(s, press(s, "q")).compose.text, "  buy milk q");
});

test("keys_form_save_blocked_when_invalid", () => {
  const t = task(1);
  const base = reduce(initialState(0, [t]), { type: "form", next: openForm(1, t.effective, {}) });
  assert.equal(base.mode, "form");
  const saved = press(base, "return");
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], { kind: "saveOverrides", id: 1, overrides: {} });
  assert.deepEqual(saved[1], ui({ type: "form", next: null }));
  assert.equal(play(base, saved).mode, "list");
  assert.deepEqual(press(base, "escape"), [ui({ type: "form", next: null })]);
  // Make max steps invalid: focus it and append a letter.
  const bad = reduce(base, { type: "form", next: formKey(formKey(base.form!, key("down")), key("x")) });
  assert.deepEqual(press(bad, "return"), []);
  assert.deepEqual(press(bad, "escape"), [ui({ type: "form", next: null })]);
});

test("keys_quit_with_and_without_runs", () => {
  const s = mk("idle");
  assert.deepEqual(press(s, "q", 0), [{ kind: "quit" }]);
  assert.deepEqual(press(s, "q", 2), [ui({ type: "confirm", value: { kind: "quit", count: 2 } })]);
  const confirm = reduce(s, { type: "confirm", value: { kind: "quit", count: 2 } });
  assert.equal(confirm.mode, "confirm");
  assert.deepEqual(press(confirm, "y", 2), [{ kind: "stopAllAndQuit" }]);
  assert.deepEqual(press(confirm, "return", 2), [{ kind: "stopAllAndQuit" }]);
  assert.deepEqual(press(confirm, "n", 2), [ui({ type: "confirm", value: null })]);
  assert.deepEqual(press(confirm, "escape", 2), [ui({ type: "confirm", value: null })]);
  assert.deepEqual(press(confirm, "x", 2), []);
  const remove = reduce(s, { type: "confirm", value: { kind: "remove", taskId: 1 } });
  assert.deepEqual(press(remove, "y"), [ui({ type: "confirm", value: null }), { kind: "manager", call: "remove", id: 1 }]);
  assert.deepEqual(press(remove, "n"), [ui({ type: "confirm", value: null })]);
});

test("keys_help_closes", () => {
  const s = reduce(mk("idle"), { type: "help", open: true });
  assert.deepEqual(press(s, "escape"), [ui({ type: "help", open: false })]);
  assert.deepEqual(press(s, "?"), [ui({ type: "help", open: false })]);
  assert.deepEqual(press(s, "x"), []);
});

test("keys_ctrlc_sequence", () => {
  let s = mk("running");
  const c1 = press(s, "ctrl+c", 1);
  assert.deepEqual(c1[0], ui({ type: "confirm", value: { kind: "quit", count: 1 } }));
  assert.deepEqual(c1[c1.length - 1], ui({ type: "ctrlC" }));
  s = play(s, c1);
  assert.equal(s.mode, "confirm");
  assert.equal(s.ctrlC, 1);
  const c2 = press(s, "ctrl+c", 1);
  assert.ok(c2.some((c) => c.kind === "stopAllAndQuit"));
  s = play(s, c2);
  assert.equal(s.ctrlC, 2);
  assert.deepEqual(press(s, "ctrl+c", 1), [{ kind: "forceExit" }]);
  // With no active runs the first press quits at once.
  const idle = press(mk("idle"), "ctrl+c", 0);
  assert.equal(idle[0]?.kind, "quit");
  // Works from compose too.
  const compose = reduce(mk("idle"), { type: "focus", target: "compose" });
  assert.deepEqual(press(compose, "ctrl+c", 2)[0], ui({ type: "confirm", value: { kind: "quit", count: 2 } }));
});

test("hints_per_mode_and_state", () => {
  assert.equal(footer(mk("running")), "⏎ open · a add · p pause · s stop · tab focus · ? help");
  assert.equal(footer(mk("paused")), "⏎ open · a add · r resume · n step · s stop · tab focus · ? help");
  assert.equal(footer(mk("idle")), "⏎ run · a add · o options · d remove · ? help");
  assert.equal(footer(mk("stopping")), "⏎ open · a add · tab focus · ? help");
  assert.equal(footer(initialState(0)), "a add · ? help");
  assert.equal(footer(reduce(mk("idle"), { type: "focus", target: "compose" })), "⏎ add · alt+⏎ newline · ↑↓ history · esc back");
  const t = task(1);
  assert.equal(footer(reduce(initialState(0, [t]), { type: "form", next: openForm(1, t.effective, {}) })), "⏎ save · ctrl+r reset · esc cancel");
  assert.equal(footer(reduce(mk("idle"), { type: "confirm", value: { kind: "remove", taskId: 1 } })), "y yes · n no");
  assert.equal(footer(reduce(mk("idle"), { type: "help", open: true })), "esc close");
  const detail = footer(detailOf("running"));
  assert.match(detail, /^↑↓ move · ⏎ expand · /);
  assert.match(detail, /p pause/);
});

test("help_lists_mode_bindings", () => {
  const list = helpBindings(mk("idle")).map((h) => `${h.key} ${h.label}`);
  for (const want of ["⏎ run", "a add", "o options", "d remove", "p pause", "r resume", "n step", "s stop", "tab focus", "q quit"]) {
    assert.ok(list.some((l) => l.startsWith(want)), `list help has ${want}: ${list.join("|")}`);
  }
  const detail = helpBindings(reduce(mk("idle"), { type: "focus", target: "detail" })).map((h) => `${h.key} ${h.label}`);
  assert.ok(detail.some((l) => l.includes("expand all")));
  assert.ok(detail.some((l) => l.includes("collapse all")));
  assert.ok(!detail.some((l) => l.startsWith("⏎ run")));
});
