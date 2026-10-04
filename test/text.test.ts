import assert from "node:assert/strict";
import { test } from "node:test";

import { codePointLength, compareCodePoints, fixed4, sliceCodePoints, splitLines } from "../src/text.ts";

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

test("fixed4 rounds exact ties to even like Python", () => {
  assert.equal(fixed4(0.03125), "0.0312");
  assert.equal(fixed4(0.09375), "0.0938");
  assert.equal(fixed4(0.0213), "0.0213");
  assert.equal(fixed4(0.12345), "0.1235"); // not an exact tie in binary
  assert.equal(fixed4(0), "0.0000");
  assert.equal(fixed4(2.5), "2.5000");
});

test("compareCodePoints sorts like Python", () => {
  assert.deepEqual(["Ａ.md", "😀.md", "b.md"].sort(compareCodePoints), ["b.md", "Ａ.md", "😀.md"]);
});
