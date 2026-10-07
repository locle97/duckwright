import assert from "node:assert/strict";
import { test } from "node:test";

import { checked, shown } from "../../web/src/actions.ts";
import type { Action } from "../../web/src/store.ts";

const run = (call: Promise<{ ok: boolean; [k: string]: unknown }>, fn: typeof shown) => {
  const seen: Action[] = [];
  return fn((a) => seen.push(a), call as never).then(() => seen);
};

test("a 401 reply marks the session expired", async () => {
  const seen = await run(Promise.resolve({ ok: false, error: "unauthorized", unauthorized: true }), checked);
  assert.deepEqual(seen, [{ type: "expired" }]);
});

test("shown dispatches expired and the error toast for a 401", async () => {
  const seen = await run(Promise.resolve({ ok: false, error: "unauthorized", unauthorized: true }), shown);
  assert.equal(seen[0]?.type, "expired");
  assert.equal(seen[1]?.type, "toast");
});

test("other failures only toast, and success dispatches nothing", async () => {
  assert.deepEqual((await run(Promise.resolve({ ok: false, error: "bad" }), shown)).map((a) => a.type), ["toast"]);
  assert.deepEqual(await run(Promise.resolve({ ok: true }), shown), []);
});
