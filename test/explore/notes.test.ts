import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { NoteSink, checkNoteArgs, looksLikeSecret, readNotes, readRejected } from "../../src/explore/notes.ts";
import { readLedger } from "../../src/explore/writes.ts";
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

test("rejected adds are counted in a file that survives a crash", () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, HOST);
  assert.equal(sink.add(["quirk", "fine"]), "ok");
  assert.match(sink.add(["quirk", "password: hunter2"]), /^error:/);
  assert.match(sink.add(["nope", "x"]), /^error:/);
  assert.equal(readRejected(dir), 2);
  assert.deepEqual(readNotes(dir).map((n) => n.text), ["fine"]);
  assert.ok(!fs.readFileSync(path.join(dir, "notes.jsonl"), "utf8").includes("hunter2"));
  assert.equal(readRejected(tmpDir()), 0);
});

const M = "DW-261011-a3f9-";

test("created and removed notes need the flag's marker", () => {
  assert.match(checkNoteArgs(["created", `${M}Pasta`], HOST) ?? "", /only available with --allow-writes/);
  assert.match(checkNoteArgs(["removed", `${M}Pasta`], HOST) ?? "", /only available with --allow-writes/);
  assert.equal(checkNoteArgs(["created", `${M}Pasta`, "https://shop.example/r/1"], HOST, M), null);
  assert.match(checkNoteArgs(["created", "Pasta"], HOST, M) ?? "", new RegExp(`must start with the run marker ${M}`));
  assert.match(checkNoteArgs(["created", "DW-261011-ffff-Pasta"], HOST, M) ?? "", /must start with the run marker/);
});

test("function notes are accepted in every explore run", () => {
  assert.equal(checkNoteArgs(["function", "Create recipe", "https://shop.example/r/create"], HOST), null);
  assert.equal(checkNoteArgs(["function", "Create recipe"], HOST, M), null);
  assert.match(checkNoteArgs(["function", "password: hunter2"], HOST) ?? "", /secret/);
});

test("the sink writes the ledger for created and removed, and rejects an unmatched removed", () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, HOST, M);
  sink.step = 4;
  assert.equal(sink.add(["created", `${M}Pasta`, "https://shop.example/r/1#x"]), "ok");
  assert.match(sink.add(["removed", `${M}Soup`]), /does not match an item created in this run/);
  assert.equal(sink.add(["removed", `${M.toLowerCase()}pasta`]), "ok");
  assert.deepEqual(readLedger(dir), [{ name: `${M}Pasta`, url: "https://shop.example/r/1", removed: true }]);
  const kinds = readNotes(dir).map((n) => n.kind);
  assert.deepEqual(kinds, ["created", "removed"]);
  const raw = fs.readFileSync(path.join(dir, "notes.jsonl"), "utf8");
  assert.ok(raw.includes('{"rejected":1}'));
});

test("without a marker the sink refuses created notes and writes no ledger", () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, HOST);
  assert.match(sink.add(["created", `${M}Pasta`]), /only available with --allow-writes/);
  assert.equal(fs.existsSync(path.join(dir, "created.jsonl")), false);
});
