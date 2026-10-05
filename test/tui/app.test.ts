import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { Key as InkKey } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement as h } from "react";

import type { RunOutcome } from "../../src/events.ts";
import { App, fromInk } from "../../src/tui/app.ts";
import { decision, ev, FakeManager, snapshot } from "./fake-manager.ts";

afterEach(() => cleanup());

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SGR = /\x1b\[[0-9;]*m/g;

interface Harness {
  frame(): string;
  raw(): string;
  type(...inputs: string[]): Promise<void>;
  quits: Array<Error | undefined>;
  forced: number;
  log: string[];
}

function mount(manager: FakeManager, size = { columns: 100, rows: 24 }): Harness {
  const quits: Array<Error | undefined> = [];
  const harness: Harness = {
    quits, forced: 0, log: manager.log,
    frame: () => (r.lastFrame() ?? "").replace(SGR, ""),
    raw: () => r.lastFrame() ?? "",
    async type(...inputs: string[]) {
      for (const input of inputs) {
        r.stdin.write(input);
        await settle();
      }
    },
  };
  const r = render(h(App, {
    manager, size, tickMs: 10,
    onQuit: (e?: Error) => {
      manager.log.push("onQuit");
      quits.push(e);
    },
    onForceExit: () => {
      harness.forced++;
    },
  }));
  return harness;
}

const OUTCOME: RunOutcome = {
  status: "pass", exitCode: 0, success: true, answer: "The price is 42", steps: 1, costUsd: 0.0123,
  historyPath: "runs/x/history.json", export: { kind: "written", path: "runs/x/test.spec.ts" }, warnings: [], error: null,
};

test("app_empty_workspace", async () => {
  const t = mount(new FakeManager());
  await settle();
  const f = t.frame();
  assert.match(f, /🦆 duckwright/);
  assert.match(f, /Describe a task to add…/);
  assert.match(f, /a add/);
});

test("app_add_tasks_in_a_row", async () => {
  const m = new FakeManager();
  const t = mount(m);
  await settle();
  await t.type("a", "Check the price", "\r", "Second", "\r");
  const f = t.frame();
  assert.deepEqual(m.log, ["addTyped:Check the price", "addTyped:Second"]);
  assert.match(f, /"Check the price"/);
  assert.match(f, /"Second"/);
  assert.match(f, /› Describe a task to add…/, "the box is empty again");
  assert.match(f, /⏎ add/, "focus stays in the add box");
});

test("app_start_shows_live_timeline", async () => {
  const m = new FakeManager([snapshot(1, "Check the price", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  const d = decision("Open the shop", [["goto", "https://shop.test"]]);
  m.run(1, "r1", [ev.start(), ev.step(1), ev.phase(1, "thinking")]);
  await settle();
  assert.match(t.frame(), /● /);
  assert.match(t.frame(), /thinking…/);
  m.run(1, "r1", [ev.decision(1, d, 0.011), ev.actionStart(1, 0), ev.actionResult(1, 0, "ok"), ev.stepEnd(1, d, ["ok"])]);
  await settle();
  const f = t.frame();
  assert.match(f, /✓ 1 +Open the shop/);
  assert.match(f, /\$0\.011/);
});

test("app_two_runs_different_states", async () => {
  const m = new FakeManager([
    snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 }),
    snapshot(2, "Second", { state: "paused", runId: "r2", runCount: 1 }),
  ]);
  const t = mount(m);
  await settle();
  m.run(1, "r1", [ev.start(), ev.step(1), ev.decision(1, decision("a", [["click", "e1"]]), 0.041)]);
  m.run(2, "r2", [ev.start(), ev.step(1), ev.decision(1, decision("b", [["click", "e2"]]), 0.022), ev.control("paused")]);
  await settle();
  const f = t.frame();
  assert.match(f, /● "First" +\$0\.041/);
  assert.match(f, /‖ "Second" +\$0\.022/);
  assert.match(f, /\$0\.0630/, "header total");
});

test("app_pause_and_step_selected", async () => {
  const m = new FakeManager([
    snapshot(1, "First"),
    snapshot(2, "Second", { state: "running", runId: "r2", runCount: 1 }),
  ]);
  const t = mount(m);
  await settle();
  await t.type("j", "p");
  m.update(2, { state: "paused" });
  await settle();
  await t.type("n", "s");
  assert.deepEqual(m.log, ["pause:2", "step:2", "stop:2"]);
});

test("app_settings_form", async () => {
  const m = new FakeManager([snapshot(1, "First")]);
  const t = mount(m);
  await settle();
  await t.type("o", "\x1b[B", "\x7f", "\x7f", "0");
  assert.match(t.frame(), /Settings/);
  assert.match(t.frame(), /› max steps +0 /);
  assert.match(t.frame(), /max-steps must be a whole number/, "inline error");
  await t.type("\r");
  assert.deepEqual(m.overrides, [], "an invalid form does not save");
  assert.match(t.frame(), /Settings/, "the form stays open");
  await t.type("\x7f", "7", "\r");
  assert.deepEqual(m.overrides, [{ id: 1, o: { maxSteps: 7 } }]);
  assert.doesNotMatch(t.frame(), /Settings/, "the form closes on save");
});

test("app_quit_with_active_runs", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1" })]);
  m.active = 2;
  const t = mount(m);
  await settle();
  await t.type("q");
  assert.match(t.frame(), /stop 2 runs and quit\?/);
  assert.deepEqual(t.quits, []);
  await t.type("y");
  assert.deepEqual(m.log, ["stopAll", "onQuit"]);
  assert.deepEqual(t.quits, [undefined]);
});

test("app_quit_without_runs_leaves_at_once", async () => {
  const m = new FakeManager();
  const t = mount(m);
  await settle();
  await t.type("q");
  assert.deepEqual(m.log, ["onQuit"]);
});

test("app_ctrlc_third_press_force_exits", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1" })]);
  m.active = 1;
  m.stopAllResult = new Promise(() => {}); // the runs never finish stopping
  const t = mount(m);
  await settle();
  await t.type("\x03");
  assert.match(t.frame(), /stop 1 run(s)? and quit\?/);
  await t.type("\x03");
  assert.deepEqual(m.log, ["stopAll"]);
  assert.equal(t.forced, 0);
  await t.type("\x03");
  assert.equal(t.forced, 1);
  assert.deepEqual(t.quits, []);
});

function withCosts(): FakeManager {
  const m = new FakeManager([
    snapshot(1, "Idle one"),
    snapshot(2, "Busy one", { state: "running", runId: "r2", runCount: 1 }),
  ]);
  return m;
}

test("app_narrow_layouts", async () => {
  // Sidebar cost "$0.041"; the header total is "$0.0410", so look for the 3-decimal form only.
  const sidebarCost = /\$0\.041(?!0)/;
  for (const [columns, rows, check] of [
    [100, 24, (f: string) => {
      assert.match(f, sidebarCost);
      assert.match(f, /source: typed/);
    }],
    [70, 24, (f: string) => {
      assert.doesNotMatch(f, sidebarCost, "60–89 columns: no cost in the sidebar");
      assert.match(f, /"Busy one"/);
      assert.match(f, /source: typed/);
    }],
    [59, 24, (f: string) => {
      assert.match(f, /"Busy one"/, "the focused pane (the list) is shown");
      assert.doesNotMatch(f, /source: typed/, "the detail pane is hidden");
    }],
    [39, 7, (f: string) => {
      assert.match(f, /terminal too small/);
      assert.match(f, /q quit/);
      assert.doesNotMatch(f, /duckwright/);
    }],
  ] as const) {
    const m = withCosts();
    const t = mount(m, { columns, rows });
    await settle();
    m.run(2, "r2", [ev.start(), ev.step(1), ev.decision(1, decision("a", [["click", "e1"]]), 0.041)]);
    await settle();
    check(t.frame());
    assert.deepEqual(t.quits, [], `${columns}x${rows} renders without crashing`);
    cleanup();
  }
});

test("app_sanitizes_task_text", async () => {
  const m = new FakeManager([{ ...snapshot(1, "a\x1b[2Jb"), name: "a\x1b[2Jb" }]);
  const t = mount(m);
  await settle();
  assert.ok(!t.raw().includes("\x1b[2J"), "no escape from the task reaches the terminal");
  assert.match(t.frame(), /○ ab/);
});

test("app_render_crash_stops_all", async () => {
  const broken = { ...snapshot(1, "First"), effective: undefined } as unknown as ReturnType<typeof snapshot>;
  const m = new FakeManager([broken]);
  const t = mount(m);
  await settle();
  assert.deepEqual(m.log, ["stopAll", "onQuit"]);
  assert.equal(t.quits.length, 1);
  assert.ok(t.quits[0] instanceof Error);
});

test("app_end_banner", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  const d = decision("Finish", [["done", "true", "The price is 42"]]);
  m.run(1, "r1", [
    ev.start(), ev.step(1), ev.decision(1, d, 0.0123), ev.actionStart(1, 0), ev.actionResult(1, 0, "done"),
    ev.stepEnd(1, d, ["done"]), ev.end(OUTCOME),
  ]);
  m.update(1, { state: "passed" });
  await settle();
  const f = t.frame();
  assert.match(f, /✓ success/);
  assert.match(f, /Answer: The price is 42/);
  assert.match(f, /History: runs\/x\/history\.json/);
  assert.match(f, /Test: runs\/x\/test\.spec\.ts/);
});

const NO_KEY: InkKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false,
  end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false,
  meta: false, super: false, hyper: false, capsLock: false, numLock: false,
};

test("from_ink_maps_keys", () => {
  assert.deepEqual(fromInk("a", NO_KEY), { input: "a", name: null, ctrl: false, meta: false, shift: false });
  assert.deepEqual(fromInk("c", { ...NO_KEY, ctrl: true }), { input: "c", name: null, ctrl: true, meta: false, shift: false });
  assert.equal(fromInk("", { ...NO_KEY, return: true, meta: true }).name, "return");
  assert.equal(fromInk("", { ...NO_KEY, upArrow: true }).name, "up");
  assert.equal(fromInk("", { ...NO_KEY, pageDown: true }).name, "pageDown");
  assert.equal(fromInk("", { ...NO_KEY, backspace: true }).name, "backspace");
  assert.equal(fromInk("", { ...NO_KEY, delete: true }).name, "delete");
  assert.equal(fromInk("", { ...NO_KEY, tab: true, shift: true }).shift, true);
});
