import assert from "node:assert/strict";
import { test } from "node:test";

import { filterKey, matches, visibleIndexes } from "../../src/tui/filter.ts";
import { key } from "../../src/tui/keypress.ts";

test("filter_matches", () => {
  const t = { name: '"Login"', text: "Login page" };
  assert.equal(matches(t, "LOG"), true);
  assert.equal(matches(t, "page"), true);
  assert.equal(matches(t, "xyz"), false);
  assert.equal(matches(t, ""), true);
  const tasks = [{ name: "a", text: "a" }, { name: "b", text: "x" }, { name: "c", text: "abc" }];
  assert.deepEqual(visibleIndexes(tasks, "b"), [1, 2]);
});

test("filter_key_edits", () => {
  assert.equal(filterKey("ab", key("c")), "abc");
  assert.equal(filterKey("ab", key("backspace")), "a");
  assert.equal(filterKey("", key("backspace")), "");
  assert.equal(filterKey("ab", key("ctrl+u")), "");
  for (const k of ["up", "return", "escape", "alt+x"]) assert.equal(filterKey("ab", key(k)), null);
  assert.equal(filterKey("ab", { input: "x\ny", name: null, ctrl: false, meta: false, shift: false }), "abxy");
  assert.equal(filterKey("ab", { input: "\n\x7f", name: null, ctrl: false, meta: false, shift: false }), null);
});
