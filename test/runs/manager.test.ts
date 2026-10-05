import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { RunArgs } from "../../src/args.ts";
import { RunControl } from "../../src/control.ts";
import { RunEvents } from "../../src/events.ts";
import type { RunOutcome } from "../../src/events.ts";
import { RunManager, taskName } from "../../src/runs/manager.ts";
import type { ManagerEvent, ManagerOptions } from "../../src/runs/manager.ts";
import type { PastRun } from "../../src/runs/past.ts";
import type { RunHandle, RunSpec } from "../../src/runs/run.ts";
import { resolvePath } from "../../src/paths.ts";
import { tmpDir } from "../helpers.ts";

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

test("manager_globals_layering", () => {
  const { mgr, events } = setup({ argv: ["--model", "opus", "--max-steps", "9"] });
  const a = mgr.addTyped("a");
  const b = mgr.addTyped("b");
  mgr.setOverrides(b, { model: "haiku" });
  assert.deepEqual(mgr.globals(), {
    base: { model: "opus", maxSteps: 9, headed: false, export: false, snapshot: "hybrid" }, overrides: {},
  });
  events.length = 0;
  mgr.setGlobals({ model: "sonnet", headed: true });
  assert.deepEqual(mgr.globals().overrides, { model: "sonnet", headed: true });
  assert.equal(mgr.globals().base.model, "opus", "the base stays the flags");
  assert.equal(mgr.effectiveArgs(a).model, "sonnet", "globals beat the flags");
  assert.equal(mgr.effectiveArgs(a).maxSteps, 9);
  assert.equal(mgr.effectiveArgs(a).headed, true);
  assert.equal(mgr.effectiveArgs(b).model, "haiku", "a task's own options beat the globals");
  assert.equal(mgr.list()[0].effective.model, "sonnet");
  assert.deepEqual(events.map((e) => e.type), ["globals:updated", "task:updated", "task:updated"]);
  const g = events[0];
  assert.ok(g.type === "globals:updated" && g.globals.overrides.model === "sonnet");
});

test("manager_globals_beat_front_matter", () => {
  const dir = tree({ "f.md": "---\nmodel: opus\n---\nThe body" });
  const { mgr } = setup({ cwd: dir });
  mgr.add({ mentions: [`${dir}/f.md`], typed: null });
  mgr.setGlobals({ model: "haiku" });
  assert.equal(mgr.list()[0].effective.model, "haiku");
  mgr.setGlobals({});
  assert.equal(mgr.list()[0].effective.model, "opus");
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

test("manager_start_refused_while_quitting", async () => {
  const { mgr, fakes } = setup();
  const [a, b] = [mgr.addTyped("a"), mgr.addTyped("b")];
  mgr.start(a);
  let settled = false;
  const p = mgr.stopAll().then(() => { settled = true; });
  assert.deepEqual(mgr.start(b), { ok: false, reason: "quitting" });
  assert.equal(fakes.length, 1, "no run is launched once quitting began");
  assert.equal(mgr.list()[1].state, "idle");
  fakes[0].finish(outcome("stop"));
  await p;
  assert.equal(settled, true);
  assert.equal(mgr.activeCount(), 0);
  assert.deepEqual(mgr.start(b), { ok: false, reason: "quitting" }, "still refused after stopAll settles");
});

test("manager_summary_keeps_removed_tasks_runs", async () => {
  const { mgr, fakes } = setup();
  const [a, b, c] = [mgr.addTyped("broken"), mgr.addTyped("fine"), mgr.addTyped("never run")];
  mgr.start(a);
  fakes[0].finish(outcome("fail", { costUsd: 0.1 }));
  await tick();
  assert.equal(mgr.remove(a), true);
  assert.equal(mgr.remove(c), true);
  mgr.start(b);
  fakes[1].finish(outcome("pass", { costUsd: 0.2 }));
  await tick();
  const s = mgr.summary();
  assert.deepEqual(s.lines, [
    "Batch: 1 passed, 1 failed, 0 stopped  Cost: $0.3000",
    `fail  ${'"broken"'.padEnd(8)}  $0.1000  -`,
    `pass  ${'"fine"'.padEnd(8)}  $0.2000  -`,
  ]);
  assert.equal(s.exitCode, 1);
  assert.deepEqual(mgr.list().map((t) => t.text), ["fine"], "a removed task stays out of the list");
});

test("manager_error_before_run_start_reaches_task", async () => {
  const fails: Array<(o: RunOutcome) => void> = [];
  const { mgr, events } = setup({
    startRun() {
      const ev = new RunEvents();
      const control = new RunControl(new AbortController(), ev);
      const done = new Promise<RunOutcome>((resolve) => {
        fails.push((o) => {
          ev.emit({ type: "run:end", outcome: o });
          resolve(o);
        });
      });
      return { id: "", workdir: "", events: ev, control, done };
    },
  });
  const id = mgr.addTyped("a");
  mgr.start(id);
  events.length = 0;
  fails[0](outcome("fail", { error: "error: Error: EACCES: runs", steps: 0 }));
  await tick();
  const t = mgr.list()[0];
  assert.equal(t.state, "failed");
  assert.equal(t.error, "error: Error: EACCES: runs");
  const last = events.filter((e) => e.type === "task:updated").pop();
  assert.ok(last && last.type === "task:updated" && last.task.error === "error: Error: EACCES: runs");
});

test("manager_error_after_run_start_stays_in_run", async () => {
  const { mgr, fakes } = setup();
  const id = mgr.addTyped("a");
  mgr.start(id);
  fakes[0].handle.events.emit({
    type: "run:start", task: "a", maxSteps: 1, model: "m", snapshot: "hybrid", headed: false, session: "s", workdir: "/w",
  });
  fakes[0].finish(outcome("fail", { error: "error: Error: boom" }));
  await tick();
  assert.equal(mgr.list()[0].error, null, "the run view shows it");
});

/** Write `files` (relative path -> content) under a fresh temp dir; folders end with "/". */
function tree(files: Record<string, string>): string {
  const dir = tmpDir();
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (rel.endsWith("/")) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
  return dir;
}

test("manager_add_typed_only", () => {
  const { mgr } = setup();
  assert.deepEqual(mgr.add({ mentions: [], typed: "x" }), { ok: true, added: [1], duplicates: [] });
  const t = mgr.list()[0];
  assert.deepEqual(t.source, { kind: "typed" });
  assert.equal(t.name, '"x"');
});

test("manager_add_file_and_folder_in_order", () => {
  const dir = tree({ "a.md": "---\nmodel: opus\n---\nDo A", "smoke/b.md": "Do B", "smoke/c.txt": "Do C" });
  const { mgr } = setup({ cwd: dir });
  const r = mgr.add({ mentions: [`${dir}/a.md`, `${dir}/smoke`], typed: "check it" });
  assert.equal(r.ok, true);
  const list = mgr.list();
  assert.deepEqual(list.map((t) => t.name), ["a.md", "smoke/b.md", "smoke/c.txt", '"check it"']);
  assert.deepEqual(list[0].source, { kind: "file", path: `${dir}/a.md` });
  assert.equal(list[0].text, "Do A");
  assert.deepEqual(r.ok && r.added, list.map((t) => t.id));
});

test("manager_add_all_or_nothing", () => {
  const dir = tree({ "good.md": "ok", "bad/x.md": "---\nfoo: 1\n---\nbody" });
  const { mgr, events } = setup({ cwd: dir });
  const [good, nope, bad] = [`${dir}/good.md`, `${dir}/nope.md`, `${dir}/bad`];
  assert.deepEqual(mgr.add({ mentions: [good, nope, bad], typed: "t" }), {
    ok: false,
    errors: [
      { mention: 1, message: `@${nope}: not found (type \\@ for a literal @)` },
      { mention: 2, message: `${bad}/x.md:2: unknown setting "foo"` },
    ],
  });
  assert.deepEqual(mgr.list(), []);
  assert.deepEqual(events, []);
});

test("manager_add_folder_errors_name_the_mention", () => {
  const dir = tree({ "empty/": "", "my dir/": "" });
  const { mgr } = setup({ cwd: dir });
  const r = mgr.add({ mentions: [`${dir}/empty`, `${dir}/my dir/`], typed: null });
  assert.deepEqual(r, {
    ok: false,
    errors: [
      { mention: 0, message: `@${dir}/empty: no task files (.md or .txt)` },
      { mention: 1, message: `@"${dir}/my dir/": no task files (.md or .txt)` },
    ],
  });
});

test("manager_add_skips_duplicates", () => {
  const dir = tree({ "t/a.md": "A", "t/b.md": "B" });
  const { mgr } = setup({ cwd: dir });
  const r = mgr.add({ mentions: [`${dir}/t`, `${dir}/t/a.md`], typed: null });
  assert.equal(r.ok && r.added.length, 2);
  assert.deepEqual(r.ok && r.duplicates, ["t/a.md"]);
  assert.deepEqual(mgr.add({ mentions: [`${dir}/t/b.md`], typed: null }), { ok: true, added: [], duplicates: ["t/b.md"] });
  assert.equal(mgr.list().length, 2);
});

test("manager_add_paths_outside_cwd", () => {
  const dir = tree({ "x.md": "X", "sub/": "" });
  const { mgr } = setup({ cwd: `${dir}/sub` });
  mgr.add({ mentions: [`${dir}/x.md`], typed: null });
  assert.equal(mgr.list()[0].name, "../x.md");
});

test("manager_file_settings_layering", () => {
  const dir = tree({ "f.md": "---\nmodel: opus\nmax-steps: 7\nsession: mine\n---\nThe body" });
  const f = `${dir}/f.md`;
  {
    const { mgr, fakes } = setup({ cwd: dir });
    mgr.add({ mentions: [f], typed: null });
    const id = mgr.list()[0].id;
    assert.equal(mgr.list()[0].effective.model, "opus");
    assert.equal(mgr.list()[0].effective.maxSteps, 7);
    mgr.setOverrides(id, { model: "sonnet" });
    assert.equal(mgr.list()[0].effective.model, "sonnet");
    assert.equal(mgr.start(id).ok, true);
    assert.equal(fakes[0].spec.args.session, "duckwright-1");
    assert.equal(fakes[0].spec.taskFile, f);
    assert.equal(fakes[0].spec.task, "The body");
  }
  {
    const { mgr } = setup({ cwd: dir, argv: ["--model", "haiku"] });
    mgr.add({ mentions: [f], typed: null });
    assert.equal(mgr.list()[0].effective.model, "haiku");
  }
});

test("manager_file_skill_reaches_preflight", () => {
  const dir = tree({ "s.md": "skill", "f.md": "---\nskill: s.md\n---\nbody" });
  const seen: string[] = [];
  const { mgr } = setup({ cwd: dir, preflight: (a: RunArgs) => { seen.push(a.skill); return null; } });
  mgr.add({ mentions: [`${dir}/f.md`], typed: null });
  mgr.start(mgr.list()[0].id);
  assert.deepEqual(seen, [resolvePath(`${dir}/s.md`)]);
});

test("manager_summary_names_file_tasks", async () => {
  const dir = tree({ "a.md": "A" });
  const { mgr, fakes } = setup({ cwd: dir });
  mgr.add({ mentions: [`${dir}/a.md`], typed: null });
  mgr.start(mgr.list()[0].id);
  fakes[0].finish(outcome("pass"));
  await tick();
  assert.match(mgr.summary().lines[1] ?? "", /^pass  a\.md  /);
});

function pastRun(id: string, status: "pass" | "fail" | "stop", over: Partial<PastRun> = {}): PastRun {
  const out = outcome(status);
  return {
    id, workdir: `/runs/${id}`, text: `text of ${id}`, source: { kind: "typed" }, fileSettings: {},
    events: [{ type: "run:end", at: 1, outcome: out }], outcome: out, startedAt: 0, ...over,
  };
}

test("manager_past_tasks_first", () => {
  const dir = tree({ "a.md": "A" });
  const file = `${dir}/a.md`;
  const p1 = pastRun("20260101-000000-a", "fail");
  const p2 = pastRun("20260101-000001-b", "pass", { source: { kind: "file", path: file } });
  const { mgr, events } = setup({ cwd: dir, past: [p1, p2] });
  mgr.addTyped("new");
  const list = mgr.list();
  assert.deepEqual(list.map((t) => t.id), [1, 2, 3]);
  assert.equal(list[0].state, "failed");
  assert.equal(list[0].runId, p1.id);
  assert.equal(list[0].runCount, 0);
  assert.deepEqual(list[0].past, { runId: p1.id, events: p1.events });
  assert.equal(list[1].state, "passed");
  assert.deepEqual(list[1].source, { kind: "file", path: file });
  assert.equal(list[1].name, "a.md");
  assert.equal("past" in list[2], false);
  assert.deepEqual(events.map((e) => e.type), ["task:added"]);
});

test("manager_created_at_stamped_and_stable", async () => {
  let t = 0;
  const now = () => (t += 100);
  const { mgr, fakes, events } = setup({ now });
  const id1 = mgr.addTyped("a");
  mgr.addTyped("b");
  assert.deepEqual(mgr.list().map((x) => x.createdAt), [100, 200]);
  const added = events.flatMap((e) => (e.type === "task:added" ? [e.task.createdAt] : []));
  assert.deepEqual(added, [100, 200]);
  mgr.start(id1);
  fakes[0].finish(outcome("pass"));
  await tick();
  assert.equal(mgr.list()[0].createdAt, 100);
  assert.deepEqual(mgr.list().map((x) => x.id), [1, 2]);
});

test("manager_created_at_file_task", () => {
  const dir = tree({ "a.md": "A" });
  const { mgr, events } = setup({ cwd: dir, now: () => 300 });
  mgr.add({ mentions: [`${dir}/a.md`], typed: null });
  const added = events.flatMap((e) => (e.type === "task:added" ? [e.task.createdAt] : []));
  assert.deepEqual(added, [300]);
});

test("manager_past_created_at_is_started_at", () => {
  const { mgr } = setup({ past: [pastRun("20260101-000000-a", "pass", { startedAt: 42 })] });
  assert.equal(mgr.list()[0].createdAt, 42);
});

test("manager_past_excluded_from_summary", () => {
  const { mgr } = setup({ past: [pastRun("20260101-000000-a", "fail")] });
  assert.deepEqual(mgr.summary(), { lines: [], exitCode: 0 });
});

test("manager_rerun_past_task", async () => {
  const dir = tree({ "a.md": "A" });
  const file = `${dir}/a.md`;
  const p = pastRun("20260101-000000-a", "fail", { source: { kind: "file", path: file }, text: "past text" });
  const { mgr, fakes } = setup({ cwd: dir, past: [p] });
  assert.equal(mgr.start(1).ok, true);
  assert.equal(fakes[0].spec.task, "past text");
  assert.equal(fakes[0].spec.taskFile, file);
  const t = mgr.list()[0];
  assert.equal(t.runId, "run-1");
  assert.equal(t.past?.runId, "run-1");
  assert.equal(t.runCount, 1);
  assert.equal(t.state, "running");
  fakes[0].finish(outcome("pass"));
  await tick();
  assert.equal(mgr.list()[0].state, "passed");
  assert.match(mgr.summary().lines[1] ?? "", /^pass  a\.md  /);
});

test("manager_past_file_duplicate", () => {
  const dir = tree({ "a.md": "A" });
  const file = `${dir}/a.md`;
  const { mgr } = setup({ cwd: dir, past: [pastRun("20260101-000000-a", "pass", { source: { kind: "file", path: file } })] });
  const r = mgr.add({ mentions: [file], typed: null });
  assert.deepEqual(r, { ok: true, added: [], duplicates: ["a.md"] });
  assert.equal(mgr.list().length, 1);
});

test("manager_notify_emits_toast", () => {
  const { mgr, events } = setup();
  mgr.notify("error", "x");
  assert.deepEqual(events[events.length - 1], { type: "toast", level: "error", message: "x" });
});
