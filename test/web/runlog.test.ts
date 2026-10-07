import assert from "node:assert/strict";
import { test } from "node:test";

import type { ManagerEvent } from "../../src/runs/manager.ts";
import { RunLog } from "../../src/web/runlog.ts";
import { FakeManager, ev, snapshot } from "../tui/fake-manager.ts";

class CountingManager extends FakeManager {
  subs = 0;
  override subscribe(fn: (e: ManagerEvent) => void): () => void {
    this.subs++;
    const off = super.subscribe(fn);
    return () => {
      this.subs--;
      off();
    };
  }
}

test("collects each run's events in order, by run id", () => {
  const m = new CountingManager([snapshot(1, "a"), snapshot(2, "b")]);
  const log = new RunLog(m);
  m.run(1, "r1", [ev.start(), ev.step(1)]);
  m.run(2, "r2", [ev.start()]);
  m.run(1, "r1", [ev.step(2)]);
  const entries = log.entries();
  assert.deepEqual(entries.map((e) => [e.taskId, e.runId, e.events.length]), [[1, "r1", 3], [2, "r2", 1]]);
  assert.equal(entries[0]!.events[0]!.type, "run:start");
});

test("entries are copies", () => {
  const m = new CountingManager([snapshot(1, "a")]);
  const log = new RunLog(m);
  m.run(1, "r1", [ev.start()]);
  log.entries()[0]!.events.length = 0;
  assert.equal(log.entries()[0]!.events.length, 1);
});

test("removing a task forgets its runs", () => {
  const m = new CountingManager([snapshot(1, "a"), snapshot(2, "b")]);
  const log = new RunLog(m);
  m.run(1, "r1", [ev.start()]);
  m.run(2, "r2", [ev.start()]);
  m.emit({ type: "task:removed", taskId: 1 });
  assert.deepEqual(log.entries().map((e) => e.runId), ["r2"]);
});

test("close stops listening", () => {
  const m = new CountingManager([snapshot(1, "a")]);
  const log = new RunLog(m);
  assert.equal(m.subs, 1);
  log.close();
  assert.equal(m.subs, 0);
  m.run(1, "r1", [ev.start()]);
  assert.deepEqual(log.entries(), []);
});
