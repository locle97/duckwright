import assert from "node:assert/strict";
import { test } from "node:test";

import { codePointLength, sliceCodePoints, splitLines } from "../src/text.ts";

test("splitLines matches Python separators", () => {
  assert.deepEqual(
    splitLines("a\nb\r\nc\rd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l"),
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"],
  );
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n\n"), ["", ""]);
  assert.deepEqual(splitLines("a\r\n\r\nb"), ["a", "", "b"]);
});

test("sliceCodePoints never splits a surrogate pair", () => {
  assert.equal(sliceCodePoints("ab😀c", 3), "ab😀");
  assert.equal(sliceCodePoints("ab", 10), "ab");
  assert.equal(codePointLength("ab😀c"), 4);
  assert.equal(codePointLength(""), 0);
});
