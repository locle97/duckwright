import assert from "node:assert/strict";
import { test } from "node:test";

import type { CandidateIndex } from "../../src/tui/candidates.ts";
import { handleApi, parseOverrides, snapshotOf } from "../../src/web/api.ts";
import type { ApiContext, ApiResponse } from "../../src/web/api.ts";
import { FakeManager, planSnapshot, snapshot } from "../tui/fake-manager.ts";

const LOGGED = [{ taskId: 1, runId: "r1", events: [] }];

const INDEX: CandidateIndex = {
  items: [
    { path: "tasks/login.md", folder: false, count: 0 },
    { path: "tasks/", folder: true, count: 1 },
  ],
  truncated: false,
};

function setup(): { m: FakeManager; ctx: ApiContext; quits: number[] } {
  const m = new FakeManager([snapshot(1, "one"), snapshot(2, "two")]);
  m.plansValue = [planSnapshot(1, [1])];
  const quits: number[] = [];
  const ctx: ApiContext = {
    manager: m, maxParallel: 3, notices: ["note"], theme: "dark", quit: () => void quits.push(1), candidates: () => INDEX,
    runs: () => LOGGED,
  };
  return { m, ctx, quits };
}

const call = (ctx: ApiContext, method: string, url: string, body?: unknown): Promise<ApiResponse> => {
  const u = new URL(url, "http://x");
  return handleApi(ctx, { method, path: u.pathname, query: u.searchParams, body });
};
const ok = { ok: true };

test("GET /api/state returns the snapshot", async () => {
  const { ctx } = setup();
  const r = await call(ctx, "GET", "/api/state");
  assert.equal(r.status, 200);
  const s = r.body as ReturnType<typeof snapshotOf>;
  assert.equal(s.tasks.length, 2);
  assert.equal(s.plans.length, 1);
  assert.equal(s.maxParallel, 3);
  assert.deepEqual(s.notices, ["note"]);
  assert.equal(s.theme, "dark");
  assert.equal(s.activeCount, 0);
  assert.deepEqual(s.runs, LOGGED);
  assert.ok(s.globals.base);
});

test("POST /api/tasks adds a typed task and mentions", async () => {
  const { m, ctx } = setup();
  const r = await call(ctx, "POST", "/api/tasks", { mentions: ["tasks/a.md"], typed: "  do it  " });
  assert.equal(r.status, 200);
  assert.deepEqual(m.log, ["add:tasks/a.md|do it"]);
});

test("POST /api/tasks returns the add errors with 400", async () => {
  const { m, ctx } = setup();
  m.addResult = { ok: false, errors: [{ mention: 0, message: "@x: not found" }] };
  const r = await call(ctx, "POST", "/api/tasks", { mentions: ["x"], typed: null });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "@x: not found", errors: [{ mention: 0, message: "@x: not found" }] });
});

test("POST /api/tasks rejects an empty submission and bad shapes", async () => {
  const { m, ctx } = setup();
  assert.equal((await call(ctx, "POST", "/api/tasks", { mentions: [], typed: "   " })).status, 400);
  assert.equal((await call(ctx, "POST", "/api/tasks", { mentions: "x" })).status, 400);
  assert.equal((await call(ctx, "POST", "/api/tasks", undefined)).status, 400);
  assert.deepEqual(m.log, []);
});

test("start maps ok and refusals", async () => {
  const { m, ctx } = setup();
  assert.deepEqual((await call(ctx, "POST", "/api/tasks/1/start")).body, { ok: true, runId: "r1" });
  m.startResult = { ok: false, reason: "3 runs active (limit 3)" };
  const r = await call(ctx, "POST", "/api/tasks/2/start");
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { ok: false, error: "3 runs active (limit 3)" });
  assert.equal((await call(ctx, "POST", "/api/tasks/99/start")).status, 404);
});

test("pause, resume, step and stop call the manager", async () => {
  const { m, ctx } = setup();
  for (const verb of ["pause", "resume", "step", "stop"]) {
    assert.deepEqual((await call(ctx, "POST", `/api/tasks/1/${verb}`)).body, ok);
  }
  assert.deepEqual(m.log, ["pause:1", "resume:1", "step:1", "stop:1"]);
  assert.equal((await call(ctx, "POST", "/api/tasks/9/pause")).status, 404);
});

test("DELETE /api/tasks/:id removes, 409 when refused, 404 when unknown", async () => {
  const { m, ctx } = setup();
  assert.equal((await call(ctx, "DELETE", "/api/tasks/1")).status, 200);
  assert.equal((await call(ctx, "DELETE", "/api/tasks/9")).status, 404);
  m.remove = () => false;
  assert.equal((await call(ctx, "DELETE", "/api/tasks/2")).status, 409);
});

test("overrides and globals are validated then saved", async () => {
  const { m, ctx } = setup();
  const good = { model: "opus", maxSteps: 9, headed: true, snapshot: "grep" };
  assert.equal((await call(ctx, "PUT", "/api/tasks/1/overrides", good)).status, 200);
  assert.deepEqual(m.overrides, [{ id: 1, o: good }]);
  assert.equal((await call(ctx, "PUT", "/api/globals", { model: "haiku" })).status, 200);
  assert.deepEqual(m.globalsSaved, [{ model: "haiku" }]);
  assert.equal((await call(ctx, "PUT", "/api/globals", { maxSteps: 0 })).status, 400);
  assert.equal((await call(ctx, "PUT", "/api/globals", { snapshot: "nope" })).status, 400);
  assert.equal((await call(ctx, "PUT", "/api/tasks/1/overrides", [])).status, 400);
  assert.equal((await call(ctx, "PUT", "/api/tasks/9/overrides", {})).status, 404);
});

test("parseOverrides keeps only known, valid fields", () => {
  assert.deepEqual(parseOverrides({ model: " m ", extra: 1 }), { model: "m" });
  assert.equal(typeof parseOverrides({ model: "" }), "string");
  assert.equal(typeof parseOverrides({ headed: "yes" }), "string");
  assert.equal(typeof parseOverrides({ maxSteps: 1.5 }), "string");
  assert.equal(typeof parseOverrides(null), "string");
});

test("twofa answers and cancels", async () => {
  const { m, ctx } = setup();
  assert.equal((await call(ctx, "POST", "/api/tasks/1/twofa", { value: "123456" })).status, 200);
  assert.equal((await call(ctx, "POST", "/api/tasks/1/twofa", { value: null })).status, 200);
  assert.deepEqual(m.twofaAnswers, [{ id: 1, value: "123456" }, { id: 1, value: null }]);
  assert.equal((await call(ctx, "POST", "/api/tasks/1/twofa", { value: 5 })).status, 400);
});

test("plans: create, controls, remove, move", async () => {
  const { m, ctx } = setup();
  assert.deepEqual((await call(ctx, "POST", "/api/plans", { source: "qa.md" })).body, { ok: true, id: 1 });
  m.planResult = { ok: false, error: "qa.md: not found" };
  assert.equal((await call(ctx, "POST", "/api/plans", { source: "qa.md" })).status, 400);
  assert.equal((await call(ctx, "POST", "/api/plans", {})).status, 400);
  for (const verb of ["retry", "cancel", "stop"]) {
    assert.equal((await call(ctx, "POST", `/api/plans/1/${verb}`)).status, 200);
  }
  assert.equal((await call(ctx, "POST", "/api/plans/1/run", { which: "failed" })).status, 200);
  assert.equal((await call(ctx, "POST", "/api/plans/1/run", {})).status, 200);
  assert.equal((await call(ctx, "POST", "/api/plans/1/run", { which: "x" })).status, 400);
  assert.equal((await call(ctx, "DELETE", "/api/plans/1")).status, 200);
  assert.equal((await call(ctx, "POST", "/api/plans/7/stop")).status, 404);
  assert.equal((await call(ctx, "POST", "/api/tasks/1/move", { delta: -1 })).status, 200);
  assert.equal((await call(ctx, "POST", "/api/tasks/1/move", { delta: 1.5 })).status, 400);
  assert.deepEqual(m.log, [
    "plan:qa.md", "plan:qa.md", "retryPlan:1", "cancelPlan:1", "stopPlan:1", "runPlan:1:failed", "runPlan:1:all",
    "removePlan:1", "movePlanTask:1:-1",
  ]);
});

test("source reads and saves a task and a plan setup", async () => {
  const { m, ctx } = setup();
  const g = await call(ctx, "GET", "/api/source?kind=task&id=1");
  assert.deepEqual(g.body, { ok: true, text: "the source" });
  assert.deepEqual((await call(ctx, "GET", "/api/source?kind=setup&planId=1")).body, { ok: true, text: "the source" });
  assert.equal((await call(ctx, "GET", "/api/source?kind=nope")).status, 400);
  const s = await call(ctx, "PUT", "/api/source", { target: { kind: "task", id: 1 }, text: "new" });
  assert.equal(s.status, 200);
  assert.ok(m.log.includes("saveSource:1:new"));
  m.saveResult = { ok: false, error: "the task is empty" };
  const bad = await call(ctx, "PUT", "/api/source", { target: { kind: "setup", planId: 1 }, text: "" });
  assert.deepEqual([bad.status, bad.body], [400, { ok: false, error: "the task is empty" }]);
  assert.equal((await call(ctx, "PUT", "/api/source", { target: { kind: "task", id: 1 }, text: 5 })).status, 400);
});

test("candidates are ranked and capped", async () => {
  const { ctx } = setup();
  const r = await call(ctx, "GET", "/api/candidates?q=login");
  const b = r.body as { ok: boolean; items: { path: string }[]; truncated: boolean };
  assert.equal(b.ok, true);
  assert.equal(b.items[0]!.path, "tasks/login.md");
  assert.equal(b.truncated, false);
});

test("quit calls the context's quit", async () => {
  const { ctx, quits } = setup();
  assert.equal((await call(ctx, "POST", "/api/quit")).status, 200);
  assert.equal(quits.length, 1);
});

test("unknown routes are 404 and wrong methods 405", async () => {
  const { ctx } = setup();
  assert.equal((await call(ctx, "GET", "/api/nope")).status, 404);
  assert.equal((await call(ctx, "GET", "/api/tasks")).status, 405);
  assert.equal((await call(ctx, "POST", "/api/state")).status, 405);
});

test("a throwing manager becomes a generic 500", async () => {
  const { m, ctx } = setup();
  m.pause = () => { throw new Error("secret detail"); };
  const r = await call(ctx, "POST", "/api/tasks/1/pause");
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: "internal error" }]);
});

test("POST /api/tasks/:id/replay launches the spec replay and ignores the body", async () => {
  const { m, ctx } = setup();
  const r = await call(ctx, "POST", "/api/tasks/1/replay");
  assert.deepEqual([r.status, r.body], [200, ok]);
  assert.ok(m.log.includes("replaySpec:1"));
  const r2 = await call(ctx, "POST", "/api/tasks/1/replay", { path: "/etc" });
  assert.deepEqual([r2.status, r2.body], [200, ok]);
  assert.equal(m.log.filter((l) => l === "replaySpec:1").length, 2);
});

test("POST /api/tasks/:id/replay is 404 for an unknown task", async () => {
  const { m, ctx } = setup();
  const r = await call(ctx, "POST", "/api/tasks/99/replay");
  assert.deepEqual([r.status, r.body], [404, { ok: false, error: "no such task" }]);
  assert.ok(!m.log.includes("replaySpec:99"));
});

test("POST /api/tasks/:id/replay maps a failed result to 409", async () => {
  const { m, ctx } = setup();
  m.replayResult = { ok: false, error: "x" };
  let r = await call(ctx, "POST", "/api/tasks/1/replay");
  assert.deepEqual([r.status, r.body], [409, { ok: false, error: "x" }]);
  const live = '"one" is still running; replay its spec when it finishes';
  m.replayResult = { ok: false, error: live };
  r = await call(ctx, "POST", "/api/tasks/1/replay");
  assert.deepEqual([r.status, r.body], [409, { ok: false, error: live }]);
});

test("GET /api/tasks/:id/replay is 405", async () => {
  const { ctx } = setup();
  const r = await call(ctx, "GET", "/api/tasks/1/replay");
  assert.deepEqual([r.status, r.body], [405, { ok: false, error: "method not allowed" }]);
});

test("a throwing replaySpec becomes a generic 500", async () => {
  const { m, ctx } = setup();
  m.replaySpec = () => { throw new Error("secret detail"); };
  const r = await call(ctx, "POST", "/api/tasks/1/replay");
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: "internal error" }]);
});

test("parse_overrides_evidence", async () => {
  assert.deepEqual(parseOverrides({ video: true, screenshot: false }), { video: true, screenshot: false });
  assert.equal(parseOverrides({ video: "yes" }), "video must be true or false");
  assert.equal(parseOverrides({ screenshot: 1 }), "screenshot must be true or false");
  const { ctx } = setup();
  const r = await call(ctx, "PUT", "/api/globals", { video: 1 });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "video must be true or false" });
});

test("parseOverrides jev", async () => {
  assert.deepEqual(parseOverrides({ jev: true }), { jev: true });
  assert.equal(parseOverrides({ jev: "yes" }), "jev must be true or false");
  const { ctx } = setup();
  const r = await call(ctx, "PUT", "/api/globals", { jev: 1 });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: "jev must be true or false" });
});

test("GET /api/state carries inherited.jev", async () => {
  const { ctx } = setup();
  const s = (await call(ctx, "GET", "/api/state")).body as { tasks: { inherited: { jev: boolean } }[] };
  assert.equal(typeof s.tasks[0].inherited.jev, "boolean");
});
