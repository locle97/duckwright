import assert from "node:assert/strict";
import { test } from "node:test";

import { RunTracker } from "../../src/chat/tracker.ts";
import type { RunOutcome } from "../../src/events.ts";
import { FakeManager, ev, planSnapshot, snapshot } from "../tui/fake-manager.ts";

const outcome = (costUsd: number): RunOutcome => ({
  status: "pass", exitCode: 0, success: true, answer: "ok", steps: 1, costUsd, historyPath: "/h.json",
  export: { written: false } as never, warnings: [], error: null,
});

test("tracker sums costs of owned runs only", () => {
  const m = new FakeManager([snapshot(1, "a"), snapshot(2, "b")]);
  const t = new RunTracker(m);
  t.own([1]);
  m.run(1, "r1", [ev.end(outcome(0.3))]);
  m.run(2, "r2", [ev.end(outcome(0.5))]);
  assert.equal(t.runCostUsd(), 0.3);
  assert.equal(t.results([1])[0].answer, null);
  t.close();
});

test("tracker counts live decision costs until run:end replaces them", () => {
  const m = new FakeManager([snapshot(1, "a")]);
  const t = new RunTracker(m);
  t.own([1]);
  m.run(1, "r1", [ev.decision(1, { evaluationPreviousGoal: "", memory: "", nextGoal: "g", actions: [] } as never, 0.1), ev.stepEnd(1, {} as never, [])]);
  assert.equal(t.runCostUsd(), 0.1);
  m.run(1, "r1", [ev.end(outcome(0.12))]);
  assert.equal(t.runCostUsd(), 0.12);
  t.close();
});

test("settled resolves when owned tasks finish", async () => {
  const m = new FakeManager([snapshot(1, "a", { state: "running", runId: "r1" })]);
  const t = new RunTracker(m);
  t.own([1]);
  let done = false;
  const p = t.settled([1]).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  m.update(1, { state: "passed" });
  await p;
  assert.equal(done, true);
  t.close();
});

test("settled waits for tasks queued in a plan and ownPlan owns the plan's tasks", async () => {
  const m = new FakeManager([snapshot(1, "a"), snapshot(2, "b")]);
  m.plansValue = [planSnapshot(7, [1, 2], { queued: [2] })];
  const t = new RunTracker(m);
  t.ownPlan(7);
  assert.deepEqual(t.owned(), { tasks: [1, 2], plans: [7] });
  let done = false;
  const p = t.settled([2]).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  m.emit({ type: "plan:updated", plan: planSnapshot(7, [1, 2], { queued: [] }) });
  await p;
  t.close();
});
