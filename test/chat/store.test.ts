import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../../src/chat/store.ts";
import { redactText } from "../../src/redact.ts";
import { tmpDir } from "../helpers.ts";

const mk = () => new ChatStore(tmpDir());

test("create then load round-trips meta", () => {
  const s = mk();
  const c = s.create({ model: "m", ceilingUsd: 5 });
  assert.deepEqual(s.load(c.id)?.meta, c);
  assert.equal(c.sessionId, null);
  assert.equal(c.spentUsd, 0);
  assert.equal(c.title, "New chat");
});

test("append redacts secrets", () => {
  const s = mk();
  const c = s.create({ model: "m", ceilingUsd: 5 });
  const w = s.append(c.id, { kind: "agent", at: 1, text: "token=abc123secret" });
  assert.equal(w.kind === "agent" && w.text, redactText("token=abc123secret"));
  const m = s.load(c.id)?.messages[0];
  assert.deepEqual(m, w);
});

test("list is newest first", () => {
  const s = mk();
  const a = s.create({ model: "m", ceilingUsd: 1 });
  const b = s.create({ model: "m", ceilingUsd: 1 });
  s.saveMeta({ ...a, updatedAt: 100 });
  s.saveMeta({ ...b, updatedAt: 200 });
  assert.deepEqual(s.list().map((c) => c.id), [b.id, a.id]);
});

test("saveUpload never overwrites and strips folders", () => {
  const s = mk();
  const c = s.create({ model: "m", ceilingUsd: 1 });
  const base = `.duckwright/chats/${c.id}/uploads`;
  assert.equal(s.saveUpload(c.id, "../../x.md", Buffer.from("a")), `${base}/x.md`);
  assert.equal(s.saveUpload(c.id, "../../x.md", Buffer.from("b")), `${base}/x-2.md`);
});

test("load of unknown or invalid id is null", () => {
  const s = mk();
  assert.equal(s.load("../etc"), null);
  assert.equal(s.load("nope"), null);
});
