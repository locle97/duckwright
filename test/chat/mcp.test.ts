import assert from "node:assert/strict";
import { test } from "node:test";

import { handleMcp, MCP_TOOLS, WAIT_CAP_SEC } from "../../src/chat/mcp.ts";
import type { EnvAccounts, JsonRpc, McpHost } from "../../src/chat/mcp.ts";
import { RunTracker } from "../../src/chat/tracker.ts";
import type { Phase } from "../../src/chat/types.ts";
import { FakeManager, planSnapshot, snapshot } from "../tui/fake-manager.ts";

function setup(over: { spent?: number; ceiling?: number; messages?: string[]; tasks?: ReturnType<typeof snapshot>[]; envs?: EnvAccounts[] } = {}) {
  const manager = new FakeManager(over.tasks ?? []);
  const tracker = new RunTracker(manager);
  const queue = [...(over.messages ?? [])];
  const calls: string[] = [];
  const host: McpHost = {
    manager, tracker, spentUsd: () => over.spent ?? 0, ceilingUsd: () => over.ceiling ?? 5,
    takeMessages: () => queue.splice(0), setPhase: (p: Phase) => calls.push(`phase:${p}`), ask: (q) => calls.push(`ask:${q.join("|")}`),
    activity: (t) => calls.push(`activity:${t}`), setPlanFolder: (f) => calls.push(`folder:${f}`),
    environments: () => over.envs ?? [],
  };
  return { manager, tracker, host, calls };
}

const call = (name: string, args: object = {}): JsonRpc => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const body = (r: any) => JSON.parse(r.result.content[0].text);

test("initialize and tools/list", async () => {
  const { host } = setup();
  const init: any = await handleMcp(host, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "duckwright");
  const list: any = await handleMcp(host, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t: any) => t.name), [
    "set_phase", "ask", "check_messages", "budget", "environments", "open_plan", "run_plan", "run_task", "wait",
  ]);
  assert.equal(list.result.tools, MCP_TOOLS);
});

test("run_task refuses over the ceiling", async () => {
  const { host, manager } = setup({ spent: 5, ceiling: 5 });
  const r: any = await handleMcp(host, call("run_task", { file: "a.md" }));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /spend ceiling reached/);
  assert.equal(manager.log.some((l) => l.startsWith("add") || l.startsWith("start")), false);
});

test("every tool result carries pending messages", async () => {
  const { host } = setup({ messages: ["skip checkout"], spent: 1 });
  assert.deepEqual(body(await handleMcp(host, call("budget"))).pending_messages, ["skip checkout"]);
  const second = body(await handleMcp(host, call("budget")));
  assert.deepEqual(second.pending_messages, []);
  assert.equal(second.remaining_usd, 4);
});

test("set_phase validates and ask notes", async () => {
  const { host, calls } = setup();
  assert.equal(body(await handleMcp(host, call("set_phase", { phase: "probe" }))).ok, true);
  const bad: any = await handleMcp(host, call("set_phase", { phase: "nap" }));
  assert.equal(bad.result.isError, true);
  assert.equal(body(await handleMcp(host, call("ask", { questions: ["a?"] }))).note, "end your turn now");
  assert.deepEqual(calls, ["phase:probe", "ask:a?"]);
});

test("wait times out with done false", async () => {
  const { host } = setup({ tasks: [snapshot(1, "a", { state: "running" })] });
  const r = body(await handleMcp(host, call("wait", { task_ids: [1] }), 0.05));
  assert.equal(r.done, false);
  assert.equal(r.results[0].state, "running");
});

test("a timed-out wait leaves no waiter behind", async () => {
  const { host, tracker } = setup({ tasks: [snapshot(1, "a", { state: "running" })] });
  assert.equal(body(await handleMcp(host, call("wait", { task_ids: [1] }), 0.05)).done, false);
  assert.equal(tracker.waiting, 0);
});

test("wait defaults to and is capped at 240 s", async (t) => {
  assert.equal(WAIT_CAP_SEC, 240);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const args of [{ task_ids: [1] }, { task_ids: [1], timeout_sec: 600 }]) {
    const { host, tracker } = setup({ tasks: [snapshot(1, "a", { state: "running" })] });
    let settled = false;
    const p = handleMcp(host, call("wait", args)).then((r) => { settled = true; return r; });
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(239_999);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal(body(await p).done, false);
    assert.equal(tracker.waiting, 0);
  }
});

test("wait returns done true when the task finishes", async () => {
  const { host, manager } = setup({ tasks: [snapshot(1, "a", { state: "running" })] });
  const p = handleMcp(host, call("wait", { task_ids: [1] }), 5);
  manager.update(1, { state: "passed" });
  assert.equal(body(await p).done, true);
});

test("open_plan owns the plan and falls back to the open one; run_plan reports activity", async () => {
  const { host, manager, calls, tracker } = setup();
  manager.plansValue = [planSnapshot(3, [4, 5])];
  manager.planResult = { ok: false, error: "tasks/qa-plan: already open" };
  const r = body(await handleMcp(host, call("open_plan", { folder: "tasks/qa-plan" })));
  assert.deepEqual(r, { plan_id: 3, task_ids: [4, 5], pending_messages: [] });
  assert.deepEqual(tracker.owned().plans, [3]);
  assert.equal(body(await handleMcp(host, call("run_plan", { plan_id: 3 }))).ok, true);
  assert.deepEqual(calls, ["folder:tasks/qa-plan", "activity:Running plan tasks/qa-plan"]);
  assert.ok(manager.log.includes("runPlan:3:all"));
});

test("run_task adds, sets env, starts", async () => {
  const { host, manager, calls } = setup();
  manager.addResult = { ok: true, added: [9], duplicates: [] };
  const r = body(await handleMcp(host, call("run_task", { file: "t.md", env: "staging" })));
  assert.equal(r.task_id, 9);
  assert.equal(r.run_id, "r1");
  assert.deepEqual(manager.log, ["add:t.md|", "setOverrides:9", "start:9"]);
  assert.deepEqual(calls, ["activity:Running t.md"]);
});

test("unknown method is -32601 and notification returns null", async () => {
  const { host } = setup();
  const r: any = await handleMcp(host, { jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(r.error.code, -32601);
  assert.equal(await handleMcp(host, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("ping answers with an empty result", async () => {
  const { host } = setup();
  assert.deepEqual(await handleMcp(host, { jsonrpc: "2.0", id: 7, method: "ping" }), { jsonrpc: "2.0", id: 7, result: {} });
});

test("environments lists each environment's accounts without secrets", async () => {
  const { host } = setup({
    envs: [{ name: "localhost-9091", baseUrl: "http://localhost:9091", accounts: [
      { id: "admin", label: "Admin", role: "admin", username: "changeme@example.com", hasTotp: false },
    ] }],
  });
  const r = body(await handleMcp(host, call("environments")));
  assert.deepEqual(r.environments, [{
    name: "localhost-9091", base_url: "http://localhost:9091",
    accounts: [{ id: "admin", label: "Admin", role: "admin", username: "changeme@example.com", has_totp: false }],
  }]);
  assert.deepEqual(r.pending_messages, []);
  assert.doesNotMatch(JSON.stringify(r), /password/i);
});
