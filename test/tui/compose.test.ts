import { test } from "node:test";
import assert from "node:assert/strict";
import { key } from "../../src/tui/keypress.ts";
import {
  applyCompletion, composeKey, deleteMentionBefore, EMPTY_COMPOSE, insertText, lines, mentionAt, parseMentions, spans,
  submission, submit,
} from "../../src/tui/compose.ts";
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

test("compose_leading_newline_cursor_at_start", () => {
  const base: ComposeState = { ...EMPTY_COMPOSE, text: "\nabc", cursor: 0, history: ["old"] };
  assert.deepEqual(lines(base), { lines: ["", "abc"], row: 0, col: 0 });
  assert.equal(press(base, "ctrl+u").text, "\nabc");
  assert.equal(press(base, "home").cursor, 0);
  assert.equal(press(base, "ctrl+a").cursor, 0);
  const recalled = press(base, "up");
  assert.deepEqual([recalled.text, recalled.historyIndex, recalled.draft], ["old", 0, "\nabc"]);
});

const pick = (s: ComposeState | null): [string, number] | null => (s ? [s.text, s.cursor] : null);

test("compose_parse_mention_positions", () => {
  assert.deepEqual(parseMentions("@a.md x @b/ me@ex.com \\@c"), [
    { start: 0, end: 5, path: "a.md", quoted: false },
    { start: 8, end: 11, path: "b/", quoted: false },
  ]);
  assert.deepEqual(parseMentions('go @"my tasks/a.md" now')[0], { start: 3, end: 19, path: "my tasks/a.md", quoted: true });
  assert.deepEqual(parseMentions("@a.md,"), [{ start: 0, end: 6, path: "a.md,", quoted: false }]);
  assert.equal(parseMentions("x\n@a.md\nmore")[0]?.path, "a.md");
  assert.deepEqual(parseMentions('@"open quo'), [{ start: 0, end: 10, path: "open quo", quoted: true }]);
});

test("compose_mention_at_cursor", () => {
  assert.equal(mentionAt("x @tasks/sm", 11)?.path, "tasks/sm");
  assert.equal(mentionAt("x @tasks/sm", 2), null);
  assert.equal(mentionAt("x @", 3)?.path, "");
  assert.equal(mentionAt("@a.md b", 6), null);
});

test("compose_submission_split", () => {
  assert.equal(submission("@a.md Check the price").typed, "Check the price");
  assert.equal(submission("Check @a.md   the price").typed, "Check the price");
  assert.equal(submission("a  b @x.md  c").typed, "a  b c");
  assert.equal(submission("@a.md @b.md").typed, null);
  assert.equal(submission("mail \\@john and @ 5pm").typed, "mail @john and @ 5pm");
  assert.equal(submission("line1\n@a.md\nline3").typed, "line1\n\nline3");
  assert.equal(submission("one @a.md\ntwo").typed, "one\ntwo");
  assert.deepEqual(submission("@a.md x @b.md").mentions.map((m) => m.path), ["a.md", "b.md"]);
});

test("compose_backspace_deletes_whole_mention", () => {
  const s = { ...EMPTY_COMPOSE, text: "go @tasks/a.md", cursor: 14 };
  assert.deepEqual(pick(deleteMentionBefore(s)), ["go ", 3]);
  assert.equal(deleteMentionBefore({ ...s, cursor: 13 }), null);
  assert.equal(deleteMentionBefore({ ...s, text: "go @", cursor: 4 }), null);
});

test("compose_apply_completion", () => {
  const s = { ...EMPTY_COMPOSE, text: "@tasks/sm x", cursor: 9 };
  assert.deepEqual(pick(applyCompletion(s, "tasks/smoke/", "descend")), ["@tasks/smoke/ x", 13]);
  assert.deepEqual(pick(applyCompletion(s, "tasks/smoke.md", "accept")), ["@tasks/smoke.md x", 16]);
  const end = { ...EMPTY_COMPOSE, text: "@sm", cursor: 3 };
  assert.deepEqual(pick(applyCompletion(end, "smoke.md", "accept")), ["@smoke.md ", 10]);
  assert.deepEqual(pick(applyCompletion(end, "my tasks/", "descend")), ['@"my tasks/"', 11]);
  assert.deepEqual(pick(applyCompletion(end, "my tasks/a.md", "accept")), ['@"my tasks/a.md" ', 17]);
  const quoted = { ...EMPTY_COMPOSE, text: '@"my tasks/"', cursor: 11 };
  assert.deepEqual(pick(applyCompletion(quoted, "my tasks/a.md", "accept")), ['@"my tasks/a.md" ', 17]);
  const eol = { ...EMPTY_COMPOSE, text: "@sm\nnext", cursor: 3 };
  assert.deepEqual(pick(applyCompletion(eol, "smoke.md", "accept")), ["@smoke.md\nnext", 9]);
  const none = { ...EMPTY_COMPOSE, text: "plain", cursor: 5 };
  assert.equal(applyCompletion(none, "a.md", "accept"), none);
});

test("compose_spans_mark_missing", () => {
  const exists = (p: string) => p === "a.md" || p === "../up.md";
  assert.deepEqual(spans("x @a.md @no.md @../up.md @", exists).map((s) => [s.text, s.kind]), [
    ["x ", "text"], ["@a.md", "mention"], [" ", "text"], ["@no.md", "missing"], [" ", "text"],
    ["@../up.md", "mention"], [" @", "text"],
  ]);
  assert.deepEqual(spans("", exists), []);
});
