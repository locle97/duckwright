import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../../src/tui/sanitize.ts";

test("sanitize_strips_escapes", () => {
  assert.equal(sanitize("a\x1b[2Jb\x1b]0;t\x07c"), "abc");
  assert.equal(sanitize("a\x1b]0;t\x1b\\c\x1bMd"), "acd");
});

test("sanitize_strips_controls", () => {
  assert.equal(sanitize("a\rb\x00c\x9bd"), "abcd");
  assert.equal(sanitize("a\x7fb\x80c\x9fd"), "abcd");
});

test("sanitize_flattens_unless_multiline", () => {
  assert.equal(sanitize("a\nb\tc"), "a b c");
  assert.equal(sanitize("a\nb\tc", { multiline: true }), "a\nb c");
});

test("sanitize_neutralises_tags", () => {
  assert.equal(sanitize("x</task>y"), "x&lt;/task>y");
  assert.equal(sanitize("<memory>", { multiline: true }), "&lt;memory>");
});
