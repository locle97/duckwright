import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { NoteSink, checkNoteArgs, looksLikeSecret, readNotes } from "../../src/explore/notes.ts";
import { tmpDir } from "../helpers.ts";

const HOST = "shop.example";

test("checkNoteArgs accepts each kind and an on-host url", () => {
  for (const kind of ["business", "page", "quirk", "off-limits", "account", "flow"]) {
    assert.equal(checkNoteArgs([kind, "text"], HOST), null, kind);
  }
  assert.equal(checkNoteArgs(["page", "Cart", "https://shop.example/cart?x=1"], HOST), null);
});

test("checkNoteArgs rejects bad shapes", () => {
  assert.match(checkNoteArgs(["nope", "x"], HOST) ?? "", /^error: .*kind/);
  assert.match(checkNoteArgs(["quirk"], HOST) ?? "", /^error:/);
  assert.match(checkNoteArgs(["quirk", "  "], HOST) ?? "", /^error:/);
  assert.match(checkNoteArgs(["quirk", "x".repeat(401)], HOST) ?? "", /400/);
  assert.match(checkNoteArgs(["page", "x", "https://other.example/"], HOST) ?? "", /host/);
  assert.match(checkNoteArgs(["page", "x", "ftp://shop.example/"], HOST) ?? "", /url/);
});

test("looksLikeSecret flags credentials, not credential sources", () => {
  assert.equal(looksLikeSecret("password: hunter2"), true);
  assert.equal(looksLikeSecret("api_key=abcd1234"), true);
  assert.equal(looksLikeSecret("Authorization: Bearer abc.def.ghi"), true);
  assert.equal(looksLikeSecret("token abcDEF1234567890abcDEF1234567890xyz"), true);
  assert.equal(looksLikeSecret("test user qa@shop.example; password comes from DUCKWRIGHT_QA_PASSWORD"), false);
  assert.equal(looksLikeSecret("Search is slow on the /products page"), false);
});

test("text starting with a dash is a valid note, not a flag", () => {
  assert.equal(checkNoteArgs(["quirk", "--submit is just text here"], HOST), null);
});

test("NoteSink appends only valid notes and readNotes is tolerant", () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, HOST);
  sink.step = 3;
  assert.equal(sink.add(["business", "A mug shop"]), "ok");
  assert.match(sink.add(["account", "password: hunter2"]), /^error:.*secret/);
  assert.equal(sink.add(["page", "Cart page", "https://shop.example/cart#x"]), "ok");
  const raw = fs.readFileSync(path.join(dir, "notes.jsonl"), "utf8");
  assert.ok(!raw.includes("hunter2"));
  fs.appendFileSync(path.join(dir, "notes.jsonl"), "not json\n");
  assert.deepEqual(readNotes(dir), [
    { step: 3, kind: "business", text: "A mug shop", url: null },
    { step: 3, kind: "page", text: "Cart page", url: "https://shop.example/cart" },
  ]);
  assert.deepEqual(readNotes(tmpDir()), []);
});
