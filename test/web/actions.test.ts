import assert from "node:assert/strict";
import { test } from "node:test";

import { checked, replaySpec, replayTitle, shown } from "../../web/src/actions.ts";
import type { Action } from "../../web/src/store.ts";
import { snapshot } from "../tui/fake-manager.ts";

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

async function withFetch(status: number, body: unknown, fn: (calls: { url: unknown; init: RequestInit | undefined }[]) => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  const calls: { url: unknown; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  }) as never;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

test("replaySpec posts to the replay route", async () => {
  await withFetch(200, { ok: true }, async (calls) => {
    const seen: Action[] = [];
    await replaySpec((a) => seen.push(a), 7);
    assert.equal(calls[0]?.url, "/api/tasks/7/replay");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(seen, []);
  });
});

test("replaySpec shows a 409 as an error toast", async () => {
  await withFetch(409, { ok: false, error: '"t" has not run yet' }, async () => {
    const seen: Action[] = [];
    await replaySpec((a) => seen.push(a), 7);
    assert.deepEqual(seen, [{ type: "toast", level: "error", message: '"t" has not run yet' }]);
  });
});

test("replaySpec 401 expires the session", async () => {
  await withFetch(401, {}, async () => {
    const seen: Action[] = [];
    await replaySpec((a) => seen.push(a), 7);
    assert.deepEqual(seen.map((a) => a.type), ["expired", "toast"]);
  });
});

test("replayTitle follows the task state and hasSpec", () => {
  const withSpec = "Open duckwright.spec.ts in the Playwright Inspector";
  const noSpec = "No spec yet: only a passed run writes duckwright.spec.ts";
  assert.equal(replayTitle(snapshot(1, "t", { state: "passed", hasSpec: true })), withSpec);
  assert.equal(replayTitle(snapshot(1, "t", { state: "passed", hasSpec: false })), noSpec);
  assert.equal(replayTitle(snapshot(1, "t", { state: "idle", hasSpec: false })), noSpec);
  for (const state of ["running", "paused", "stopping"] as const) {
    assert.equal(replayTitle(snapshot(1, "t", { state })), null);
  }
});
