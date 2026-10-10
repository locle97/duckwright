import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { RunControl } from "../../src/control.ts";
import { RunEvents } from "../../src/events.ts";
import type { RunOutcome } from "../../src/events.ts";
import { MANIFEST, PlanError, loadPlan } from "../../src/plan.ts";
import type { PlanDoc } from "../../src/plan.ts";
import { RunManager } from "../../src/runs/manager.ts";
import type { ManagerEvent, ManagerOptions, Planner } from "../../src/runs/manager.ts";
import type { RunHandle, RunSpec } from "../../src/runs/run.ts";
import { tmpDir } from "../helpers.ts";

const DOC: PlanDoc = {
  setup: "Log in as qa.",
  notes: ["Start the server"],
  tasks: [
    { id: "S1", title: "First", preconditions: [], steps: ["Do one"], expected: ["One done"] },
    { id: "S2", title: "Second", preconditions: [], steps: ["Do two"], expected: [] },
    { id: "S3", title: "Third", preconditions: [], steps: ["Do three"], expected: [] },
  ],
  skipped: [{ id: "S4", title: "Shell", reason: "needs a shell" }],
};

function outcome(status: "pass" | "fail" | "stop"): RunOutcome {
  return {
    status, exitCode: status === "pass" ? 0 : status === "fail" ? 1 : 130, success: status === "pass",
    answer: "", steps: 1, costUsd: 0, historyPath: null, export: { kind: "off" }, warnings: [], error: null,
  };
}

interface Fake { spec: RunSpec; finish(o: RunOutcome): void }

function setup(over: Partial<ManagerOptions> = {}) {
  const dir = tmpDir();
  const planFile = path.join(dir, "qa-plan.md");
  fs.writeFileSync(planFile, "# QA plan\n");
  const fakes: Fake[] = [];
  const events: ManagerEvent[] = [];
  const calls: Parameters<Planner>[0][] = [];
  let answer: (signal: AbortSignal) => Promise<{ doc: PlanDoc; cost: number }> = async () => ({ doc: DOC, cost: 0.25 });
  const mgr = new RunManager({
    argv: ["--model", "opus"], defaultSkill: "skill.md", maxParallel: 2, preflight: () => null, plansRoot: path.join(dir, "tasks"),
    planner: (o) => {
      calls.push(o);
      return answer(o.signal);
    },
    startRun(spec) {
      const ev = new RunEvents();
      const control = new RunControl(new AbortController(), ev);
      let resolve!: (o: RunOutcome) => void;
      const done = new Promise<RunOutcome>((r) => { resolve = r; });
      const handle: RunHandle = { id: `run-${fakes.length + 1}`, workdir: "/tmp/x", events: ev, control, done };
      fakes.push({ spec, finish(o) { ev.emit({ type: "run:end", outcome: o }); resolve(o); } });
      return handle;
    },
    ...over,
  });
  mgr.subscribe((e) => events.push(e));
  return { mgr, fakes, events, calls, dir, planFile, setAnswer: (f: typeof answer) => { answer = f; } };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

test("plan_a_file_writes_tasks_and_adds_them_under_the_plan", async () => {
  const { mgr, calls, dir, planFile, events } = setup();
  const r = mgr.plan(planFile);
  assert.ok(r.ok);
  assert.equal(mgr.plans()[0]!.state, "planning");
  assert.equal(events[0]!.type, "plan:added");
  await settle();
  assert.equal(calls[0]!.model, "opus", "the planner uses the run model");
  const p = mgr.plans()[0]!;
  assert.equal(p.state, "ready");
  assert.equal(p.name, "qa-plan.md");
  assert.equal(p.folder, path.join(dir, "tasks", "qa-plan"));
  assert.equal(p.cost, 0.25);
  assert.equal(p.setup, "Log in as qa.");
  assert.deepEqual(p.notes, ["Start the server"]);
  assert.deepEqual(p.skipped, DOC.skipped);
  const tasks = mgr.list();
  assert.deepEqual(tasks.map((t) => t.name), ["S1: First", "S2: Second", "S3: Third"]);
  assert.deepEqual(p.taskIds, tasks.map((t) => t.id));
  assert.ok(tasks.every((t) => t.planId === p.id && t.state === "idle"));
  assert.ok(tasks[0]!.text.startsWith("Setup (do this first, then the task below):\nLog in as qa."));
});

test("planning_failure_and_cancel_and_retry", async () => {
  const { mgr, planFile, setAnswer, events } = setup();
  setAnswer(async () => { throw new PlanError("claude error: overloaded", 0.1); });
  const r = mgr.plan(planFile);
  assert.ok(r.ok);
  await settle();
  let p = mgr.plans()[0]!;
  assert.equal(p.state, "failed");
  assert.equal(p.error, "claude error: overloaded");
  assert.equal(p.cost, 0.1);
  assert.ok(events.some((e) => e.type === "toast" && e.message === "qa-plan.md: claude error: overloaded"));
  // Cancel while planning: the planner's signal is aborted and the plan is failed as cancelled.
  setAnswer((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("interrupted")))));
  assert.deepEqual(mgr.retryPlan(p.id), { ok: true });
  assert.equal(mgr.plans()[0]!.state, "planning");
  mgr.cancelPlan(p.id);
  await settle();
  p = mgr.plans()[0]!;
  assert.equal(p.error, "cancelled");
  setAnswer(async () => ({ doc: DOC, cost: 0 }));
  mgr.retryPlan(p.id);
  await settle();
  assert.equal(mgr.plans()[0]!.state, "ready");
  assert.equal(mgr.list().length, 3);
});

test("plan_errors_for_bad_sources", () => {
  const { mgr, dir } = setup();
  assert.deepEqual(mgr.plan("  "), { ok: false, error: "give a plan file or a planned folder" });
  assert.deepEqual(mgr.plan(path.join(dir, "nope.md")), { ok: false, error: `${path.join(dir, "nope.md")}: not found` });
  assert.deepEqual(mgr.plan(dir), { ok: false, error: `${dir}: not a planned folder (no plan.json)` });
  const { mgr: noPlanner, planFile } = setup({ planner: undefined });
  assert.deepEqual(noPlanner.plan(planFile), { ok: false, error: "planning is not available here" });
});

test("open_a_planned_folder_without_the_planner", async () => {
  const first = setup();
  first.mgr.plan(first.planFile);
  await settle();
  const folder = first.mgr.plans()[0]!.folder!;
  const { mgr, calls } = setup();
  const r = mgr.plan(folder);
  assert.ok(r.ok);
  assert.equal(calls.length, 0);
  assert.equal(mgr.plans()[0]!.state, "ready");
  assert.deepEqual(mgr.list().map((t) => t.name), ["S1: First", "S2: Second", "S3: Third"]);
  assert.deepEqual(mgr.plan(folder), { ok: false, error: `${folder}: already open` });
});

test("run_plan_fills_free_slots_in_order", async () => {
  const { mgr, fakes, planFile } = setup();
  mgr.plan(planFile);
  await settle();
  const p = mgr.plans()[0]!;
  const [a, b, c] = p.taskIds;
  mgr.movePlanTask(c!, -2);
  assert.deepEqual(mgr.plans()[0]!.taskIds, [c, a, b]);
  assert.deepEqual(mgr.runPlan(p.id, "all"), { ok: true });
  assert.equal(fakes.length, 2, "fills both free slots, in the plan's order");
  assert.ok(fakes[0]!.spec.task.includes("Do three"));
  assert.ok(fakes[1]!.spec.task.includes("Do one"));
  assert.deepEqual(mgr.plans()[0]!.queued, [b]);
  assert.deepEqual(mgr.runPlan(p.id, "all"), { ok: false, error: "the plan is already running" });
  fakes[0]!.finish(outcome("fail"));
  await settle();
  assert.equal(fakes.length, 3, "a freed slot starts the next queued task");
  assert.ok(fakes[2]!.spec.task.includes("Do two"));
  fakes[1]!.finish(outcome("pass"));
  fakes[2]!.finish(outcome("pass"));
  await settle();
  assert.deepEqual(mgr.plans()[0]!.queued, []);
  // Run again only the failed one.
  assert.deepEqual(mgr.runPlan(p.id, "failed"), { ok: true });
  assert.equal(fakes.length, 4);
  assert.ok(fakes[3]!.spec.task.includes("Do three"));
  fakes[3]!.finish(outcome("pass"));
  await settle();
  assert.deepEqual(mgr.runPlan(p.id, "failed"), { ok: false, error: "no failed tasks to run again" });
});

test("stop_plan_clears_the_queue_and_stops_the_running_tasks", async () => {
  const { mgr, fakes, planFile } = setup();
  mgr.plan(planFile);
  await settle();
  const p = mgr.plans()[0]!;
  mgr.runPlan(p.id, "all");
  mgr.stopPlan(p.id);
  assert.deepEqual(mgr.plans()[0]!.queued, []);
  assert.equal(fakes.length, 2, "the two free slots are filled");
  fakes[0]!.finish(outcome("stop"));
  fakes[1]!.finish(outcome("stop"));
  await settle();
  assert.equal(fakes.length, 2, "nothing else starts");
});

test("a_task_that_cannot_start_ends_the_plan_run", async () => {
  const { mgr, fakes, planFile } = setup({ preflight: () => "claude CLI not found on PATH" });
  mgr.plan(planFile);
  await settle();
  const p = mgr.plans()[0]!;
  mgr.runPlan(p.id, "all");
  assert.equal(fakes.length, 0);
  assert.deepEqual(mgr.plans()[0]!.queued, []);
});

test("reorder_and_remove_are_saved_to_the_manifest", async () => {
  const { mgr, planFile } = setup();
  mgr.plan(planFile);
  await settle();
  const p = mgr.plans()[0]!;
  const [a, b, c] = p.taskIds;
  mgr.movePlanTask(a!, 1);
  mgr.movePlanTask(a!, 5);
  assert.deepEqual(mgr.plans()[0]!.taskIds, [b, c, a]);
  assert.ok(mgr.remove(c!));
  assert.deepEqual(loadPlan(p.folder!).tasks.map((t) => t.id), ["S2", "S1"]);
  // Removing the plan leaves the folder and its manifest as they were.
  assert.ok(mgr.removePlan(p.id));
  assert.deepEqual(mgr.plans(), []);
  assert.deepEqual(mgr.list(), []);
  assert.ok(fs.existsSync(path.join(p.folder!, MANIFEST)));
});

test("edit_a_task_file_and_the_shared_setup", async () => {
  const { mgr, planFile } = setup();
  mgr.plan(planFile);
  await settle();
  const p = mgr.plans()[0]!;
  const id = p.taskIds[0]!;
  const src = mgr.readSource({ kind: "task", id });
  assert.ok(src.ok && src.text.includes("setup: shared/setup.md"));
  const text = src.ok ? src.text.replace("Do one", "Do one, slowly") : "";
  assert.deepEqual(mgr.saveSource({ kind: "task", id }, text), { ok: true });
  assert.ok(mgr.list()[0]!.text.includes("Do one, slowly"));
  // A bad edit is refused and the file is put back.
  const bad = mgr.saveSource({ kind: "task", id }, "---\nnope: 1\n---\nx");
  assert.ok(!bad.ok && bad.error.includes('unknown setting "nope"'));
  assert.equal(fs.readFileSync(mgr.list()[0]!.source.kind === "file" ? (mgr.list()[0]!.source as { path: string }).path : "", "utf8"), text);
  // The setup: every task of the plan picks it up.
  const setupSrc = mgr.readSource({ kind: "setup", planId: p.id });
  assert.deepEqual(setupSrc, { ok: true, text: "Log in as qa.\n" });
  assert.deepEqual(mgr.saveSource({ kind: "setup", planId: p.id }, "Log in as admin.\n"), { ok: true });
  assert.equal(mgr.plans()[0]!.setup, "Log in as admin.");
  assert.ok(mgr.list().every((t) => t.text.includes("Log in as admin.")));
  assert.deepEqual(mgr.saveSource({ kind: "setup", planId: p.id }, " "), { ok: false, error: "the setup is empty" });
});

test("edit_a_typed_task", () => {
  const { mgr } = setup();
  const id = mgr.addTyped("Open a");
  assert.deepEqual(mgr.readSource({ kind: "task", id }), { ok: true, text: "Open a" });
  assert.deepEqual(mgr.saveSource({ kind: "task", id }, " Open b \n"), { ok: true });
  assert.equal(mgr.list()[0]!.text, "Open b");
  assert.equal(mgr.list()[0]!.name, '"Open b"');
  assert.deepEqual(mgr.saveSource({ kind: "task", id }, ""), { ok: false, error: "the task is empty" });
});

test("stop_all_cancels_planning", async () => {
  const { mgr, planFile, setAnswer } = setup();
  setAnswer((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("interrupted")))));
  mgr.plan(planFile);
  await mgr.stopAll();
  await settle();
  assert.equal(mgr.plans()[0]!.error, "cancelled");
  assert.deepEqual(mgr.plan(planFile), { ok: false, error: "quitting" });
});

test("plan_writes_env_from_global_override_else_argv", async () => {
  const { mgr, dir } = setup({ argv: ["--model", "opus", "--env", "cfg"] });
  const envLines = async (name: string): Promise<string[]> => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, "# QA plan\n");
    const r = mgr.plan(f);
    assert.ok(r.ok);
    await settle();
    const plan = mgr.plans().find((p) => p.id === r.id)!;
    return plan.taskIds.map((id) => {
      const t = mgr.list().find((x) => x.id === id)!;
      const m = /^env:.*$/m.exec(fs.readFileSync((t.source as { path: string }).path, "utf8"));
      return m ? m[0] : "";
    });
  };
  assert.deepEqual(await envLines("a.md"), ["env: cfg", "env: cfg", "env: cfg"]);
  mgr.setGlobals({ env: "qa" });
  assert.deepEqual(await envLines("b.md"), ["env: qa", "env: qa", "env: qa"]);
  mgr.setGlobals({ env: null });
  assert.deepEqual(await envLines("c.md"), ["", "", ""]);
});
