import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunArgs } from "../../src/args.ts";
import { RunControl } from "../../src/control.ts";
import { RunEvents } from "../../src/events.ts";
import type { RunOutcome } from "../../src/events.ts";
import { RunManager, taskName } from "../../src/runs/manager.ts";
import type { ManagerEvent, ManagerOptions } from "../../src/runs/manager.ts";
import type { RunHandle, RunSpec } from "../../src/runs/run.ts";

function outcome(status: "pass" | "fail" | "stop", over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status, exitCode: status === "pass" ? 0 : status === "fail" ? 1 : 130, success: status === "pass",
    answer: "", steps: 1, costUsd: 0, historyPath: null, export: { kind: "off" }, warnings: [], error: null,
    ...over,
  };
}

interface Fake {
  handle: RunHandle;
  spec: RunSpec;
  finish(o: RunOutcome): void;
}

function setup(over: Partial<ManagerOptions> = {}) {
  const fakes: Fake[] = [];
  const events: ManagerEvent[] = [];
  const mgr = new RunManager({
    argv: [], defaultSkill: "skill.md", maxParallel: 2, preflight: () => null,
    startRun(spec) {
      const ev = new RunEvents();
      const control = new RunControl(new AbortController(), ev);
      let resolve!: (o: RunOutcome) => void;
      const done = new Promise<RunOutcome>((r) => { resolve = r; });
      const handle: RunHandle = { id: `run-${fakes.length + 1}`, workdir: "/tmp/x", events: ev, control, done };
      fakes.push({
        handle, spec,
        finish(o) {
          ev.emit({ type: "run:end", outcome: o });
          resolve(o);
        },
      });
      return handle;
    },
    ...over,
  });
  mgr.subscribe((e) => events.push(e));
  return { mgr, fakes, events };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test("manager_add_typed_snapshot", () => {
  const { mgr, events } = setup();
  const a = mgr.addTyped("Check the price\nmore");
  const b = mgr.addTyped("two");
  assert.deepEqual([a, b], [1, 2]);
  const t = mgr.list()[0];
  assert.equal(t.name, '"Check the price"');
  assert.equal(t.state, "idle");
  assert.equal(t.runId, null);
  assert.equal(t.runCount, 0);
  assert.equal(events[0].type, "task:added");
});

test("taskName cuts long first lines with an ellipsis", () => {
  assert.equal(taskName("x".repeat(50)), `"${"x".repeat(39)}…"`);
  assert.equal(taskName("héllo", 3), '"hé…"');
});

test("manager_layering_flags_then_overrides", () => {
  const { mgr } = setup({ argv: ["--model", "opus"] });
  const id = mgr.addTyped("t");
  mgr.setOverrides(id, { maxSteps: 7 });
  const args = mgr.effectiveArgs(id);
  assert.equal(args.model, "opus");
  assert.equal(args.maxSteps, 7);
  const eff = mgr.list()[0].effective;
  assert.equal(eff.model, "opus");
  assert.equal(eff.maxSteps, 7);
});

test("manager_preflight_failure_keeps_idle", () => {
  const { mgr, fakes, events } = setup({ preflight: () => "no browser" });
  const id = mgr.addTyped("t");
  events.length = 0;
  assert.deepEqual(mgr.start(id), { ok: false, reason: "no browser" });
  assert.equal(fakes.length, 0);
  assert.equal(mgr.list()[0].state, "idle");
  assert.equal(mgr.list()[0].error, "no browser");
  assert.ok(events.some((e) => e.type === "task:updated"));
  assert.ok(events.some((e) => e.type === "toast" && e.level === "error" && e.message === "no browser"));
});

test("manager_parallel_limit", () => {
  const { mgr } = setup();
  const ids = [mgr.addTyped("a"), mgr.addTyped("b"), mgr.addTyped("c")];
  assert.equal(mgr.start(ids[0]).ok, true);
  assert.equal(mgr.start(ids[1]).ok, true);
  assert.deepEqual(mgr.start(ids[2]), { ok: false, reason: "2 runs active (limit 2)" });
  assert.equal(mgr.activeCount(), 2);
});

test("manager_second_start_refused", () => {
  const { mgr, fakes } = setup();
  const id = mgr.addTyped("a");
  assert.equal(mgr.start(id).ok, true);
  assert.deepEqual(mgr.start(id), { ok: false, reason: "already running" });
  assert.equal(fakes.length, 1);
});

test("manager_slots_assigned_and_released", async () => {
  const { mgr, fakes, events } = setup();
  const [a, b, c] = [mgr.addTyped("a"), mgr.addTyped("b"), mgr.addTyped("c")];
  mgr.start(a);
  mgr.start(b);
  assert.equal(fakes[0].spec.args.session, "duckwright-1");
  assert.equal(fakes[1].spec.args.session, "duckwright-2");
  assert.equal(fakes[0].spec.task, "a");
  assert.equal(fakes[0].spec.taskFile, null);
  fakes[0].finish(outcome("pass"));
  await tick();
  assert.equal(mgr.start(c).ok, true);
  assert.equal(fakes[2].spec.args.session, "duckwright-1");
  // an error outcome frees the slot too, and toasts a playwright error
  fakes[2].finish(outcome("fail", { error: "playwright error: boom" }));
  await tick();
  assert.ok(events.some((e) => e.type === "toast"
    && e.message === "playwright error: boom (if a browser is left open: playwright-cli -s=duckwright-1 close)"));
  assert.equal(mgr.start(a).ok, true);
  assert.equal(fakes[3].spec.args.session, "duckwright-1");
  assert.equal(mgr.list()[0].runCount, 2);
  assert.equal(mgr.list()[0].runId, "run-4");
});

test("manager_controls_forward_and_noop", () => {
  const { mgr, fakes, events } = setup();
  const id = mgr.addTyped("a");
  mgr.pause(id); // no run yet: no-op
  mgr.start(id);
  const c = fakes[0].handle.control;
  mgr.pause(id);
  assert.equal(c.state, "paused");
  mgr.step(id);
  assert.equal(c.state, "stepping");
  mgr.pause(id);
  mgr.resume(id);
  assert.equal(c.state, "running");
  fakes[0].handle.events.emit({ type: "step:start", step: 1 });
  assert.ok(events.some((e) => e.type === "run" && e.taskId === id && e.runId === "run-1" && e.event.type === "step:start"));
  mgr.stop(id);
  assert.equal(c.state, "stopping");
});

test("manager_controls_noop_after_end", async () => {
  const { mgr, fakes } = setup();
  const id = mgr.addTyped("a");
  mgr.start(id);
  fakes[0].finish(outcome("pass"));
  await tick();
  mgr.pause(id);
  assert.equal(fakes[0].handle.control.state, "running");
});

test("manager_states", async () => {
  const { mgr, fakes } = setup();
  const [a, b] = [mgr.addTyped("a"), mgr.addTyped("b")];
  const state = (id: number) => mgr.list().find((t) => t.id === id)!.state;
  assert.equal(state(a), "idle");
  mgr.start(a);
  assert.equal(state(a), "running");
  mgr.pause(a);
  assert.equal(state(a), "paused");
  mgr.resume(a);
  assert.equal(state(a), "running");
  mgr.stop(a);
  assert.equal(state(a), "stopping");
  fakes[0].finish(outcome("stop"));
  assert.equal(state(a), "stopped");
  mgr.start(b);
  fakes[1].finish(outcome("pass"));
  assert.equal(state(b), "passed");
  await tick();
  mgr.start(a);
  fakes[2].finish(outcome("fail"));
  assert.equal(state(a), "failed");
});

test("manager_remove_refused_while_active", async () => {
  const { mgr, fakes, events } = setup();
  const id = mgr.addTyped("a");
  mgr.start(id);
  assert.equal(mgr.remove(id), false);
  assert.equal(mgr.list().length, 1);
  fakes[0].finish(outcome("pass"));
  await tick();
  assert.equal(mgr.remove(id), true);
  assert.equal(mgr.list().length, 0);
  assert.ok(events.some((e) => e.type === "task:removed" && e.taskId === id));
});

test("manager_stopall_waits", async () => {
  const { mgr, fakes } = setup();
  mgr.start(mgr.addTyped("a"));
  mgr.start(mgr.addTyped("b"));
  let settled = false;
  const p = mgr.stopAll().then(() => { settled = true; });
  assert.equal(fakes[0].handle.control.state, "stopping");
  assert.equal(fakes[1].handle.control.state, "stopping");
  fakes[0].finish(outcome("stop"));
  await tick();
  assert.equal(settled, false);
  fakes[1].finish(outcome("stop"));
  await p;
  assert.equal(settled, true);
  assert.equal(mgr.summary().exitCode, 130);
});

test("manager_stopall_after_some_ended", async () => {
  const { mgr, fakes } = setup();
  mgr.start(mgr.addTyped("a"));
  mgr.start(mgr.addTyped("b"));
  fakes[0].finish(outcome("pass", { costUsd: 0.5 }));
  await tick();
  const p = mgr.stopAll();
  fakes[1].finish(outcome("stop", { costUsd: 0.25 }));
  await p;
  const s = mgr.summary();
  assert.equal(s.exitCode, 130);
  assert.equal(s.lines[0], "Batch: 1 passed, 0 failed, 1 stopped  Cost: $0.7500");
});

test("manager_summary_empty", () => {
  const { mgr } = setup();
  mgr.addTyped("never run");
  assert.deepEqual(mgr.summary(), { lines: [], exitCode: 0 });
});

test("manager_summary_lines", async () => {
  const { mgr, fakes } = setup({ maxParallel: 5 });
  const [a, b, c] = [mgr.addTyped("short"), mgr.addTyped("a longer task name"), mgr.addTyped("mid")];
  mgr.start(a);
  fakes[0].finish(outcome("fail", { costUsd: 0.1 }));
  await tick();
  mgr.start(a); // re-run: latest is the pass, total keeps the earlier cost
  mgr.start(b);
  mgr.start(c);
  fakes[1].finish(outcome("pass", { costUsd: 0.2, historyPath: "runs/r2/history.json" }));
  fakes[2].finish(outcome("fail", { costUsd: 0.3 }));
  fakes[3].finish(outcome("stop", { costUsd: 0.4 }));
  await tick();
  const s = mgr.summary();
  assert.deepEqual(s.lines, [
    "Batch: 1 passed, 1 failed, 1 stopped  Cost: $1.0000",
    `pass  ${'"short"'.padEnd(20)}  $0.2000  runs/r2/history.json`,
    `fail  ${'"a longer task name"'.padEnd(20)}  $0.3000  -`,
    `stop  ${'"mid"'.padEnd(20)}  $0.4000  -`,
  ]);
  assert.equal(s.exitCode, 1);
});
