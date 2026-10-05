import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskSnapshot, TaskState } from "../../src/runs/manager.ts";
import type { CandidateIndex } from "../../src/tui/candidates.ts";
import { EMPTY_COMPOSE, insertText } from "../../src/tui/compose.ts";
import { openForm, formKey } from "../../src/tui/form.ts";
import { helpBindings, hintPrefix, hints, keymap, tooSmallKeymap } from "../../src/tui/keys.ts";
import type { Command } from "../../src/tui/keys.ts";
import { key } from "../../src/tui/keypress.ts";
import { editingGlobals, initialState, reduce } from "../../src/tui/state.ts";
import type { UiAction, ViewState } from "../../src/tui/state.ts";

function task(id: number, state: TaskState = "idle"): TaskSnapshot {
  const live = state === "running" || state === "paused" || state === "stopping";
  return {
    id, text: `task ${id}`, name: `"task ${id}"`, source: { kind: "typed" }, state, overrides: {},
    effective: { model: "m", maxSteps: 10, headed: false, export: false, snapshot: "hybrid" },
    error: null, runId: live || state === "passed" ? `r${id}` : null, runCount: live ? 1 : 0, createdAt: 0,
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
  // Newest first: display order is task 3, 2, 1, so start on the bottom row (task 1).
  const s = reduce(mk("running", "paused", "idle"), { type: "selectEdge", edge: "last" });
  assert.deepEqual(press(s, "j"), [ui({ type: "select", delta: 1 })]);
  assert.deepEqual(press(s, "down"), [ui({ type: "select", delta: 1 })]);
  assert.deepEqual(press(s, "k"), [ui({ type: "select", delta: -1 })]);
  assert.deepEqual(press(s, "up"), [ui({ type: "select", delta: -1 })]);
  assert.deepEqual(press(s, "pageDown"), [ui({ type: "select", delta: 10 })]);
  assert.deepEqual(press(s, "pageUp"), [ui({ type: "select", delta: -10 })]);
  assert.deepEqual(press(s, "g"), [ui({ type: "selectEdge", edge: "first" })]);
  assert.deepEqual(press(s, "G"), [ui({ type: "selectEdge", edge: "last" })]);
  assert.deepEqual(press(s, "tab"), [ui({ type: "focus", target: "compose" })]);
  assert.deepEqual(press(s, "?"), [ui({ type: "help", open: true })]);
  assert.deepEqual(press(s, "a"), [ui({ type: "focus", target: "compose" })]);
  assert.deepEqual(press(s, "p"), [{ kind: "manager", call: "pause", id: 1 }]);
  assert.deepEqual(press(s, "s"), [{ kind: "manager", call: "stop", id: 1 }]);
  const paused = reduce(s, { type: "select", delta: -1 });
  assert.deepEqual(press(paused, "r"), [{ kind: "manager", call: "resume", id: 2 }]);
  assert.deepEqual(press(paused, "n"), [{ kind: "manager", call: "step", id: 2 }]);
  assert.deepEqual(press(paused, "."), [{ kind: "manager", call: "step", id: 2 }]);
  assert.deepEqual(press(paused, "s"), [{ kind: "manager", call: "stop", id: 2 }]);
  const idle = reduce(paused, { type: "select", delta: -1 });
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
  for (const spec of ["return", "o", "d", "p", "r", "n", ".", "s", "j", "k", "up", "down", "pageUp", "pageDown", "g", "G"]) {
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
  assert.deepEqual(cmds, [ui({ type: "completion", value: null }), { kind: "addSubmission", mentions: [], typed: "buy milk" }]);
  // The App clears the box once the manager has accepted the submission.
  assert.equal(play(s, cmds).compose.text, "  buy milk ");
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

test("keys_quitting_ignores_all_but_ctrlc", () => {
  let s = reduce(reduce(mk("running", "idle"), { type: "confirm", value: { kind: "quit", count: 1 } }), { type: "quitting" });
  for (const k of ["escape", "n", "y", "return", "q", "a", "j", "s", "d", "?", "tab"]) {
    assert.deepEqual(press(s, k, 1), [], k);
  }
  assert.deepEqual(press(s, "ctrl+c", 1), [ui({ type: "ctrlC" })]);
  s = play(s, press(s, "ctrl+c", 1));
  s = play(s, press(s, "ctrl+c", 1));
  assert.deepEqual(press(s, "ctrl+c", 1), [{ kind: "forceExit" }]);
});

test("keys_too_small_screen", () => {
  const compose = reduce(mk("idle"), { type: "focus", target: "compose" });
  assert.deepEqual(tooSmallKeymap(key("q"), compose, 0), [{ kind: "quit" }]);
  assert.deepEqual(tooSmallKeymap(key("escape"), compose, 0), [{ kind: "quit" }]);
  assert.deepEqual(tooSmallKeymap(key("x"), compose, 0), [], "nothing is typed into the hidden box");
  const ask = tooSmallKeymap(key("q"), mk("running"), 1);
  assert.deepEqual(ask, [ui({ type: "confirm", value: { kind: "quit", count: 1 } })]);
  const confirm = play(mk("running"), ask);
  assert.deepEqual(tooSmallKeymap(key("y"), confirm, 1), [{ kind: "stopAllAndQuit" }]);
  assert.deepEqual(tooSmallKeymap(key("n"), confirm, 1), [ui({ type: "confirm", value: null })]);
  const quitting = reduce(confirm, { type: "quitting" });
  assert.deepEqual(tooSmallKeymap(key("q"), quitting, 1), []);
  assert.deepEqual(tooSmallKeymap(key("ctrl+c"), quitting, 1), [ui({ type: "ctrlC" })]);
});

test("hints_per_mode_and_state", () => {
  assert.equal(footer(mk("running")), "⏎ open · tab add · → details · p pause · s stop · ? help");
  assert.equal(footer(mk("paused")), "⏎ open · tab add · → details · r resume · n step · s stop · ? help");
  assert.equal(footer(mk("idle")), "⏎ run · tab add · o options · d remove · ? help");
  assert.equal(footer(mk("stopping")), "⏎ open · tab add · → details · ? help");
  assert.equal(footer(initialState(0)), "tab add · ? help");
  assert.equal(footer(reduce(mk("idle"), { type: "focus", target: "compose" })), "⏎ add · @ file · alt+⏎ newline · ↑↓ history · tab tasks · esc back");
  const t = task(1);
  assert.equal(footer(reduce(initialState(0, [t]), { type: "form", next: openForm(1, t.effective, {}) })), "⏎ save · ctrl+r reset · esc cancel");
  assert.equal(footer(reduce(mk("idle"), { type: "confirm", value: { kind: "remove", taskId: 1 } })), "y yes · n no");
  assert.equal(footer(reduce(mk("idle"), { type: "help", open: true })), "esc close");
  const detail = footer(detailOf("running"));
  assert.match(detail, /^↑↓ move · ⏎ expand · /);
  assert.match(detail, /p pause/);
  assert.match(detail, /tab tasks/);
});

test("help_lists_mode_bindings", () => {
  const list = helpBindings(mk("idle")).map((h) => `${h.key} ${h.label}`);
  for (const want of ["⏎ run", "a add", "o options", "d remove", "p pause", "r resume", "n step", "s stop", "tab add", "→ details", "q quit"]) {
    assert.ok(list.some((l) => l.startsWith(want)), `list help has ${want}: ${list.join("|")}`);
  }
  const detail = helpBindings(reduce(mk("idle"), { type: "focus", target: "detail" })).map((h) => `${h.key} ${h.label}`);
  assert.ok(detail.some((l) => l.includes("expand all")));
  assert.ok(detail.some((l) => l.includes("collapse all")));
  assert.ok(!detail.some((l) => l.startsWith("⏎ run")));
  assert.ok(detail.some((l) => l.startsWith("tab tasks")));
});

const IDX: CandidateIndex = {
  items: [
    { path: "tasks/", folder: true, count: 2 },
    { path: "tasks/a.md", folder: false, count: 0 },
    { path: "tasks/b.md", folder: false, count: 0 },
  ],
  truncated: false,
};

/** A compose-mode state holding `text`, cursor at the end, with the completion list open when `open`. */
function composing(text: string, open = false): ViewState {
  let s = reduce(mk("idle"), { type: "focus", target: "compose" });
  s = reduce(s, { type: "compose", next: { ...EMPTY_COMPOSE, text, cursor: text.length } });
  return open ? reduce(s, { type: "completion", value: { index: IDX, highlight: 0 } }) : s;
}
const kinds = (cmds: Command[]): string[] => cmds.map((c) => (c.kind === "ui" ? `ui:${c.action.type}` : c.kind));
/** Press keys in order, applying ui commands, and opening the completion on openCompletion. */
function typeKeys(s: ViewState, ...specs: string[]): { s: ViewState; cmds: Command[] } {
  let cmds: Command[] = [];
  for (const spec of specs) {
    cmds = press(s, spec);
    for (const c of cmds) {
      if (c.kind === "ui") s = reduce(s, c.action);
      if (c.kind === "openCompletion") s = reduce(s, { type: "completion", value: { index: IDX, highlight: 0 } });
    }
  }
  return { s, cmds };
}

test("keys_at_opens_completion", () => {
  assert.deepEqual(kinds(press(composing("go "), "@")), ["ui:compose", "openCompletion"]);
  assert.deepEqual(kinds(press(composing("me"), "@")), ["ui:compose"]);
  assert.deepEqual(kinds(press(composing("@a.md"), "x")), ["ui:compose", "openCompletion"]);
  // Moving into a mention does not open the list.
  assert.deepEqual(kinds(press(composing("@a.md "), "left")), ["ui:compose"]);
  assert.deepEqual(kinds(press(composing("@a.md "), "left")), ["ui:compose"]);
  const { s } = typeKeys(composing("@a.md "), "left", "left");
  assert.equal(s.completion, null);
});

test("keys_completion_navigation", () => {
  const open = composing("@tas", true);
  assert.deepEqual(press(open, "down"), [ui({ type: "completionMove", delta: 1 })]);
  let r = typeKeys(open, "tab");
  assert.equal(r.s.compose.text, "@tasks/");
  assert.notEqual(r.s.completion, null);
  r = typeKeys(open, "down", "return");
  assert.equal(r.s.compose.text, "@tasks/a.md ");
  assert.equal(r.s.completion, null);
  assert.ok(!r.cmds.some((c) => c.kind === "addSubmission"));
  r = typeKeys(open, "down", "tab");
  assert.equal(r.s.compose.text, "@tasks/a.md ");
  assert.equal(r.s.completion, null);
});

test("keys_completion_escape_then_escape", () => {
  const first = typeKeys(composing("@ta", true), "escape").s;
  assert.equal(first.completion, null);
  assert.equal(first.mode, "compose");
  assert.equal(first.compose.text, "@ta");
  assert.equal(typeKeys(first, "escape").s.mode, "list");
});

test("keys_completion_closes_when_cursor_leaves", () => {
  assert.equal(typeKeys(composing("@ta", true), "space").s.completion, null);
  assert.equal(typeKeys(composing("x @ta", true), "home").s.completion, null);
  // Editing inside the mention keeps it open and resets the highlight.
  const s = reduce(composing("@ta", true), { type: "completionMove", delta: 1 });
  const after = typeKeys(s, "s").s;
  assert.equal(after.completion?.highlight, 0);
});

test("keys_return_with_no_matches_submits", () => {
  const cmds = press(composing("@zz", true), "return");
  const sub = cmds.find((c) => c.kind === "addSubmission");
  assert.ok(sub && sub.kind === "addSubmission");
  assert.equal(sub.mentions[0]?.path, "zz");
  assert.deepEqual(press(composing("@zz", true), "tab"), []);
});

test("keys_submit_split", () => {
  assert.deepEqual(press(composing("@a.md check it"), "return")[1], {
    kind: "addSubmission", mentions: [{ start: 0, end: 5, path: "a.md", quoted: false }], typed: "check it",
  });
  assert.deepEqual(press(composing("   "), "return"), []);
});

test("keys_backspace_mention_only_when_closed", () => {
  assert.equal(typeKeys(composing("@a.md"), "backspace").s.compose.text, "");
  assert.equal(typeKeys(composing("@a.md", true), "backspace").s.compose.text, "@a.m");
});

test("keys_up_down_history_only_when_closed", () => {
  let s = composing("");
  s = reduce(s, { type: "compose", next: { ...s.compose, history: ["old"] } });
  assert.equal(typeKeys(s, "up").s.compose.text, "old");
  const open = composing("@ta", true);
  assert.deepEqual(press(open, "up"), [ui({ type: "completionMove", delta: -1 })]);
});

test("keys_paste_with_mention_does_not_open_list", () => {
  const r = typeKeys(composing(""), "@a.md check it");
  assert.ok(!r.cmds.some((c) => c.kind === "openCompletion"));
  assert.equal(r.s.completion, null);
  assert.equal(kinds(press(r.s, "return"))[1], "addSubmission");
});

test("keys_compose_hints_with_completion", () => {
  assert.equal(footer(composing("x")), "⏎ add · @ file · alt+⏎ newline · ↑↓ history · tab tasks · esc back");
  assert.equal(footer(composing("@t", true)), "↑↓ move · tab complete · ⏎ accept · esc close");
});

test("keys_completion_closes_when_cursor_jumps_to_another_mention", () => {
  let s = reduce(composing("@ta @ta", true), { type: "compose", next: { ...EMPTY_COMPOSE, text: "@ta @ta", cursor: 3 } });
  s = reduce(s, { type: "completion", value: { index: IDX, highlight: 0 } });
  assert.equal(typeKeys(s, "end").s.completion, null);
});

const inFilter = (s: ViewState, draft: string): ViewState =>
  reduce(reduce(s, { type: "openFilter" }), { type: "filterEdit", query: draft });
const withFilter = (s: ViewState, q: string): ViewState => reduce(inFilter(s, q), { type: "filterKeep" });

test("keys_slash_opens_filter", () => {
  assert.deepEqual(press(mk("idle"), "/"), [ui({ type: "openFilter" })]);
  assert.deepEqual(press(detailOf("running"), "/"), [ui({ type: "openFilter" })]);
});

test("keys_filter_mode", () => {
  const s = inFilter(mk("idle"), "ab");
  assert.deepEqual(press(s, "c"), [ui({ type: "filterEdit", query: "abc" })]);
  assert.deepEqual(press(s, "backspace"), [ui({ type: "filterEdit", query: "a" })]);
  assert.deepEqual(press(s, "ctrl+u"), [ui({ type: "filterEdit", query: "" })]);
  assert.deepEqual(press(s, "return"), [ui({ type: "filterKeep" })]);
  assert.deepEqual(press(s, "escape"), [ui({ type: "filterClear" })]);
  assert.deepEqual(press(s, "up"), []);
  assert.deepEqual(press(s, "ctrl+c"), [{ kind: "quit" }, ui({ type: "ctrlC" })]);
});

test("keys_esc_clears_active_filter", () => {
  const s = withFilter(mk("idle"), "task");
  assert.deepEqual(press(s, "escape"), [ui({ type: "filterClear" })]);
  assert.deepEqual(press(mk("idle"), "escape"), []);
});

test("keys_filter_no_visible_task_noop", () => {
  const s = withFilter(mk("idle", "idle"), "zzz");
  for (const k of ["return", "d", "o", "j"]) assert.deepEqual(press(s, k), [], k);
});

test("keys_filter_hints", () => {
  const f = inFilter(mk("idle"), "ab");
  assert.deepEqual(hints(f), [{ key: "⏎", label: "keep" }, { key: "esc", label: "clear" }]);
  assert.equal(hintPrefix(f), "/ab▌  ");
  const list = withFilter(mk("idle"), "x");
  assert.equal(hintPrefix(list), 'filter "x" · ');
  assert.ok(hints(list).some((h) => h.key === "esc" && h.label === "clear filter"));
  const detail = reduce(withFilter(detailOf("running"), "t"), { type: "focus", target: "detail" });
  assert.equal(hintPrefix(detail), 'filter "t" · ');
  assert.ok(!hints(detail).some((h) => h.label === "clear filter"));
  const none = mk("idle");
  assert.equal(hintPrefix(none), "");
  assert.ok(!hints(none).some((h) => h.key === "/"));
  assert.ok(helpBindings(none).some((h) => h.key === "/" && h.label === "filter"));
});

test("keys_list_tab_opens_add_box", () => {
  const compose = [ui({ type: "focus", target: "compose" })];
  assert.deepEqual(press(mk("idle"), "tab"), compose);
  assert.deepEqual(press(mk(), "tab"), compose);
  assert.deepEqual(press(mk("idle"), "shift+tab"), compose);
});

test("keys_list_right_opens_details", () => {
  const s = reduce(detailOf("passed"), { type: "focus", target: "list" });
  assert.deepEqual(press(s, "right"), [ui({ type: "focus", target: "detail" })]);
  assert.deepEqual(press(mk("idle"), "right"), []);
});

test("keys_compose_tab_to_list_keeps_draft", () => {
  const s = composing("hello");
  assert.deepEqual(press(s, "tab"), [ui({ type: "focus", target: "list" })]);
  const after = play(s, press(s, "tab"));
  assert.equal(after.mode, "list");
  assert.equal(after.focus, "list");
  assert.equal(after.compose.text, "hello");
  for (const spec of ["ctrl+tab", "alt+tab"]) {
    assert.ok(!press(s, spec).some((c) => c.kind === "ui" && c.action.type === "focus"), spec);
  }
});

test("keys_detail_tab_to_list", () => {
  assert.deepEqual(press(detailOf("running"), "tab"), [ui({ type: "focus", target: "list" })]);
  const noRun = reduce(mk("idle"), { type: "focus", target: "detail" });
  assert.deepEqual(press(noRun, "tab"), [ui({ type: "focus", target: "list" })]);
});

test("keys_global_options", () => {
  const globals = { base: task(1).effective, overrides: { model: "opus" } };
  for (const s of [initialState(0, [task(1)], [], globals), initialState(0, [], [], globals), detailOf("running")]) {
    const g = s.globals === null ? reduce(s, { type: "manager", event: { type: "globals:updated", globals } }) : s;
    const cmds = press(g, "O");
    assert.deepEqual(cmds, [ui({ type: "form", next: openForm(null, globals.base, globals.overrides) })]);
    const open = play(g, cmds);
    assert.equal(editingGlobals(open), true);
    assert.deepEqual(press(open, "return"), [
      { kind: "saveGlobals", overrides: { model: "opus" } }, ui({ type: "form", next: null }),
    ]);
    assert.equal(editingGlobals(play(open, press(open, "escape"))), false);
  }
  assert.deepEqual(press(mk("idle"), "O"), [], "no globals yet: nothing to edit");
  assert.ok(helpBindings(mk("idle")).some((h) => h.key === "O" && h.label === "global options"));
  assert.ok(!hints(initialState(0, [task(1)], [], globals)).some((h) => h.key === "O"), "help only, not the footer");
});
