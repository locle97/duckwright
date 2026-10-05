import { test } from "node:test";
import assert from "node:assert/strict";
import { key } from "../../src/tui/keypress.ts";
import { composeKey, EMPTY_COMPOSE, insertText, lines, submit } from "../../src/tui/compose.ts";
import type { ComposeState } from "../../src/tui/compose.ts";

function press(s: ComposeState, ...specs: string[]): ComposeState {
  return specs.reduce((acc, spec) => composeKey(acc, key(spec)), s);
}

function typed(text: string, s: ComposeState = EMPTY_COMPOSE): ComposeState {
  return insertText(s, text);
}

test("key_parses_specs", () => {
  assert.deepEqual(key("a"), { input: "a", name: null, ctrl: false, meta: false, shift: false });
  assert.deepEqual(key("ctrl+c"), { input: "c", name: null, ctrl: true, meta: false, shift: false });
  assert.deepEqual(key("alt+return"), { input: "", name: "return", ctrl: false, meta: true, shift: false });
  assert.deepEqual(key("shift+tab"), { input: "", name: "tab", ctrl: false, meta: false, shift: true });
  assert.deepEqual(key("up"), { input: "", name: "up", ctrl: false, meta: false, shift: false });
  assert.equal(key("space").input, " ");
  assert.equal(key("pageUp").name, "pageUp");
});

test("compose_typing_and_cursor_moves", () => {
  let s = press(EMPTY_COMPOSE, "h", "i");
  assert.deepEqual([s.text, s.cursor], ["hi", 2]);
  s = press(s, "left", "x");
  assert.deepEqual([s.text, s.cursor], ["hxi", 2]);
  s = press(s, "backspace");
  assert.deepEqual([s.text, s.cursor], ["hi", 1]);
  s = press(s, "delete");
  assert.deepEqual([s.text, s.cursor], ["h", 1]);
  s = press(s, "delete", "right");
  assert.deepEqual([s.text, s.cursor], ["h", 1]);
  s = press(s, "home");
  assert.equal(s.cursor, 0);
  s = press(s, "backspace", "left");
  assert.deepEqual([s.text, s.cursor], ["h", 0]);
  s = press(s, "end");
  assert.equal(s.cursor, 1);
  s = press(s, "ctrl+a");
  assert.equal(s.cursor, 0);
  s = press(s, "ctrl+e");
  assert.equal(s.cursor, 1);
  s = press(s, "ctrl+c", "return", "escape", "tab");
  assert.deepEqual([s.text, s.cursor], ["h", 1]);
});

test("compose_word_ops", () => {
  const s = typed("foo bar  baz");
  assert.equal(press(s, "ctrl+w").text, "foo bar  ");
  assert.equal(press(s, "ctrl+w", "ctrl+w").text, "foo ");
  assert.equal(press(s, "ctrl+u").text, "");
  const moved = press(s, "alt+left");
  assert.equal(moved.cursor, 9);
  assert.equal(press(moved, "alt+left").cursor, 4);
  assert.equal(press(moved, "alt+left", "alt+left").cursor, 0);
  assert.equal(press(moved, "alt+left", "alt+left", "alt+right").cursor, 3);
  assert.equal(press(moved, "alt+right").cursor, 12);
  const mid = press(typed("foo bar"), "left", "left", "ctrl+w");
  assert.deepEqual([mid.text, mid.cursor], ["foo ar", 4]);
});

test("compose_alt_return_newline_and_lines", () => {
  let s = press(typed("ab"), "alt+return");
  s = typed("cd", s);
  assert.equal(s.text, "ab\ncd");
  assert.deepEqual(lines(s), { lines: ["ab", "cd"], row: 1, col: 2 });
  s = press(s, "home");
  assert.deepEqual([s.cursor, lines(s).row, lines(s).col], [3, 1, 0]);
  s = press(s, "ctrl+u");
  assert.equal(s.text, "ab\ncd");
  s = press(s, "end", "ctrl+u");
  assert.equal(s.text, "ab\n");
  assert.deepEqual(lines(EMPTY_COMPOSE), { lines: [""], row: 0, col: 0 });
});

test("compose_paste_keeps_newlines", () => {
  const s = insertText(typed("x"), "a\nb\nc");
  assert.equal(s.text, "xa\nb\nc");
  assert.equal(s.cursor, 6);
  assert.deepEqual(lines(s).lines, ["xa", "b", "c"]);
});

test("compose_submit_trims", () => {
  const r = submit(typed("  hello world \n"));
  assert.equal(r.task, "hello world");
  assert.deepEqual(r.state, { text: "", cursor: 0, history: ["hello world"], historyIndex: null, draft: "" });
});

test("compose_submit_ignores_whitespace", () => {
  const s = typed("   \n  ");
  const r = submit(s);
  assert.equal(r.task, null);
  assert.equal(r.state, s);
});

test("compose_long_multiline_task_kept_whole", () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const r = submit(insertText(EMPTY_COMPOSE, body));
  assert.equal(r.task, body);
  assert.equal(r.task?.split("\n").length, 20);
});

test("compose_history_with_kept_draft", () => {
  let s = EMPTY_COMPOSE;
  s = submit(typed("a", s)).state;
  s = submit(typed("b", s)).state;
  s = typed("dr", s);
  s = press(s, "up");
  assert.equal(s.text, "b");
  assert.equal(s.cursor, 1);
  s = press(s, "up");
  assert.equal(s.text, "a");
  s = press(s, "up");
  assert.equal(s.text, "a");
  s = press(s, "down");
  assert.equal(s.text, "b");
  s = press(s, "down");
  assert.equal(s.text, "dr");
  assert.equal(s.historyIndex, null);
  assert.equal(press(s, "down").text, "dr");
  assert.equal(press(EMPTY_COMPOSE, "up").text, "");
});

test("compose_up_moves_line_when_not_first", () => {
  let s = submit(typed("old")).state;
  s = typed("abcd\nef\nghijk", s);
  s = press(s, "up");
  assert.deepEqual([s.historyIndex, lines(s).row, lines(s).col], [null, 1, 2]);
  s = press(s, "up");
  assert.deepEqual([s.historyIndex, lines(s).row, lines(s).col], [null, 0, 2]);
  s = press(s, "down", "down");
  assert.deepEqual([lines(s).row, lines(s).col], [2, 2]);
  s = press(s, "up", "up");
  assert.equal(s.historyIndex, null);
  s = press(s, "up");
  assert.equal(s.text, "old");
});
