import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { Key as InkKey } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement as h } from "react";

import type { RunOutcome } from "../../src/events.ts";
import { App, fromInk } from "../../src/tui/app.ts";
import type { TuiFiles } from "../../src/tui/app.ts";
import { AddBox } from "../../src/tui/addBox.ts";
import { EMPTY_COMPOSE } from "../../src/tui/compose.ts";
import { DEFAULT_THEME, resolveTheme, ROLE } from "../../src/tui/theme.ts";
import type { Theme } from "../../src/tui/theme.ts";
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

/** Fake file access over `tree` (relDir -> names; folder names end with "/"). */
function fakeFiles(tree: Record<string, string[]>): TuiFiles {
  const known = new Set<string>();
  for (const [dir, names] of Object.entries(tree)) {
    for (const n of names) known.add((dir === "" ? "" : `${dir}/`) + n);
  }
  return {
    readdir: (rel) => (tree[rel] ?? []).map((n) => (n.endsWith("/") ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false })),
    exists: (p) => known.has(p) || known.has(`${p.replace(/\/$/, "")}/`),
  };
}
const FILES = fakeFiles({ "": ["tasks/", "a.md"], tasks: ["login.md", "smoke.md"] });

function mount(manager: FakeManager, size = { columns: 100, rows: 24 }, files: TuiFiles = FILES,
  opts: { theme?: Theme; notices?: string[] } = {}): Harness {
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
    manager, size, tickMs: 10, files, theme: opts.theme, notices: opts.notices,
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
  assert.match(f, /Describe a task, or @ a task file or folder…/);
  assert.match(f, /a add/);
});

test("app_add_tasks_in_a_row", async () => {
  const m = new FakeManager();
  const t = mount(m);
  await settle();
  await t.type("a", "Check the price", "\r", "Second", "\r");
  const f = t.frame();
  assert.deepEqual(m.log, ["add:|Check the price", "add:|Second"]);
  assert.match(f, /"Check the price"/);
  assert.match(f, /"Second"/);
  assert.match(f, /› Describe a task, or @ a task file or folder…/, "the box is empty again");
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
  await t.type("p"); // newest first: task 2 is selected
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
    await t.type("j"); // newest first: move from "Busy one" down to "Idle one"
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

test("app_keys_without_rerender_between_them", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1" })]);
  m.active = 1;
  const quits: Array<Error | undefined> = [];
  const r = render(h(App, { manager: m, size: { columns: 100, rows: 24 }, tickMs: 10, onQuit: (e?: Error) => quits.push(e), onForceExit: () => {} }));
  await settle();
  for (const k of ["a", "h", "e", "l", "l", "o", "\r", "x", "\r"]) r.stdin.write(k);
  await settle();
  assert.deepEqual(m.log, ["add:|hello", "add:|x"]);
  r.stdin.write("\x1b"); // alone: Ink reads an escape followed at once by "q" as alt+q
  await settle();
  for (const k of ["q", "y"]) r.stdin.write(k);
  await settle();
  assert.deepEqual(m.log.slice(2), ["stopAll"]);
  assert.deepEqual(quits, [undefined]);
});

test("app_manager_throw_on_key_stops_all", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1" })]);
  m.pause = () => {
    throw new Error("pause exploded");
  };
  const t = mount(m);
  await settle();
  await t.type("p");
  assert.deepEqual(m.log, ["stopAll", "onQuit"]);
  assert.equal(t.quits[0]?.message, "pause exploded");
});

test("app_ctrlc_third_press_force_exits_while_stopping", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 })]);
  m.active = 1;
  m.stopAll = () => {
    m.log.push("stopAll");
    // Like the real manager: stopping a run emits at once, inside the key's handling.
    m.run(1, "r1", [ev.control("stopping")]);
    m.update(1, { state: "stopping" });
    return new Promise(() => {});
  };
  const t = mount(m);
  await settle();
  await t.type("\x03");
  m.update(1, { state: "running" }); // a run event between presses
  await settle();
  await t.type("\x03");
  assert.deepEqual(m.log, ["stopAll"]);
  assert.equal(t.forced, 0);
  await t.type("\x03");
  assert.equal(t.forced, 1);
});

test("app_quitting_ignores_keys", async () => {
  const m = new FakeManager([
    snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 }),
    snapshot(2, "Second"),
  ]);
  m.active = 1;
  m.stopAllResult = new Promise(() => {});
  const t = mount(m);
  await settle();
  await t.type("q", "y");
  m.update(1, { state: "stopping" });
  await settle();
  let f = t.frame();
  assert.doesNotMatch(f, /and quit\?/, "the confirm closes");
  assert.match(f, /"First"/, "the panes stay");
  assert.match(f, /■ /, "stopping is shown");
  assert.match(f, /stopping 1 run…/);
  await t.type("\x1b");
  await t.type("n", "j", "\r", "a", "x", "\r", "q", "d", "y");
  f = t.frame();
  assert.deepEqual(m.log, ["stopAll"], "no key acts while quitting");
  assert.deepEqual(t.quits, []);
  assert.match(f, /stopping 1 run…/);
  await t.type("\x03", "\x03");
  assert.equal(t.forced, 0);
  await t.type("\x03");
  assert.equal(t.forced, 1, "ctrl+c still counts toward force exit");
});

test("app_quit_signal_stops_all", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 })]);
  m.active = 1;
  let finish!: () => void;
  m.stopAllResult = new Promise((r) => { finish = r; });
  const quit = new AbortController();
  const quits: Array<Error | undefined> = [];
  const r = render(h(App, {
    manager: m, size: { columns: 100, rows: 24 }, tickMs: 10, quitSignal: quit.signal,
    onQuit: (e?: Error) => quits.push(e), onForceExit: () => {},
  }));
  await settle();
  quit.abort();
  await settle();
  assert.deepEqual(m.log, ["stopAll"]);
  assert.match((r.lastFrame() ?? "").replace(SGR, ""), /stopping 1 run…/);
  r.stdin.write("\r");
  await settle();
  assert.deepEqual(m.log, ["stopAll"]);
  finish();
  await settle();
  assert.deepEqual(quits, [undefined]);
});

test("app_sanitizes_settings", async () => {
  const t0 = snapshot(1, "First");
  const effective = { ...t0.effective, model: "gpt\nx", snapshot: "hy\rbrid" as never };
  const m = new FakeManager([{ ...t0, overrides: { model: "gpt\nx" }, effective }]);
  const t = mount(m);
  await settle();
  assert.match(t.frame(), /model +gpt x/, "an override is drawn on one line");
  assert.match(t.frame(), /snapshot mode +hybrid/, "a default loses its controls");
});

test("app_too_small_quits_from_any_mode", async () => {
  const m = new FakeManager([snapshot(1, "First")]);
  const t = mount(m, { columns: 39, rows: 7 });
  await settle();
  await t.type("a", "q");
  assert.deepEqual(m.log, ["onQuit"], "q quits instead of being typed into the hidden box");
  cleanup();
  const busy = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 })]);
  busy.active = 1;
  const u = mount(busy, { columns: 39, rows: 7 });
  await settle();
  await u.type("a", "\x1b");
  assert.match(u.frame(), /stop 1 run and quit\?/);
  assert.match(u.frame(), /y yes · n no/);
  await u.type("y");
  assert.deepEqual(busy.log, ["stopAll", "onQuit"]);
});

test("app_detail_shows_file_source", async () => {
  const m = new FakeManager([snapshot(1, "body", { source: { kind: "file", path: "tasks/a.md" }, name: "tasks/a.md" })]);
  const t = mount(m);
  await settle();
  assert.match(t.frame(), /source: tasks\/a\.md/);
});

test("app_completion_file", async () => {
  const m = new FakeManager();
  const t = mount(m);
  await settle();
  await t.type("a", "@", "t", "a", "s", "k", "s", "/", "l");
  assert.match(t.frame(), /tasks\/login\.md/);
  assert.match(t.frame(), /tab complete/);
  await t.type("\r");
  assert.match(t.frame(), /› @tasks\/login\.md/);
  assert.doesNotMatch(t.frame(), /tab complete/);
  await t.type("\r");
  assert.deepEqual(m.log, ["add:tasks/login.md|"]);
});

test("app_completion_folder", async () => {
  const t = mount(new FakeManager());
  await settle();
  await t.type("a", "@", "t", "a", "s");
  assert.match(t.frame(), /folder · 2/);
  await t.type("\t");
  assert.match(t.frame(), /› @tasks\//);
  assert.match(t.frame(), /tasks\/login\.md/);
  await t.type("\x1b");
  assert.doesNotMatch(t.frame(), /tasks\/login\.md/);
  assert.match(t.frame(), /esc back/, "still in the add box");
  await t.type("\x1b");
  assert.match(t.frame(), /a add/);
});

test("app_mixed_submission", async () => {
  const m = new FakeManager([snapshot(1, "older")]);
  const t = mount(m);
  await settle();
  await t.type("a", "@a.md check the price", "\r");
  assert.deepEqual(m.log, ["add:a.md|check the price"]);
  const f = t.frame();
  assert.match(f, /› Describe a task, or @/, "the box is empty again");
  assert.match(f, /source: typed/);
  assert.match(f, /││ check the price/, "the detail pane shows the new task");
});

test("app_bad_mention_adds_nothing", async () => {
  const m = new FakeManager();
  m.addResult = { ok: false, errors: [{ mention: 1, message: "@nope.md: not found (type \\@ for a literal @)" }] };
  const t = mount(m);
  await settle();
  await t.type("a", "@a.md @nope.md x", "\r");
  const f = t.frame();
  assert.match(f, /@nope\.md: not found \(type \\@ for a literal @\)/);
  assert.match(f, /› @a\.md @nope\.md x/);
  assert.match(f, /No tasks yet/);
  // The next edit clears the error.
  await t.type("y");
  assert.doesNotMatch(t.frame(), /not found/);
});

test("app_duplicate_toast", async () => {
  const m = new FakeManager();
  m.addResult = { ok: true, added: [], duplicates: ["a.md"] };
  const t = mount(m);
  await settle();
  // Typed at once, the mention still opens the list (the cursor ends inside it): accept, then submit.
  await t.type("a", "@a.md", "\r", "\r");
  assert.match(t.frame(), /already added: a\.md/);
  assert.match(t.frame(), /› Describe a task, or @/);
});

test("app_completion_sanitizes_names", async () => {
  const t = mount(new FakeManager(), undefined, fakeFiles({ "": ["evil\x1b[2J.md"] }));
  await settle();
  await t.type("a", "@", "e", "v");
  assert.match(t.frame(), /evil/);
  assert.ok(!t.raw().includes("\x1b[2J"));
});

test("app_missing_mention_is_red", () => {
  // Ink draws no colours under the test renderer, so read the colours off the element tree.
  const compose = { ...EMPTY_COMPOSE, text: "@a.md @zz.md x", cursor: 3 };
  const coloured: [string, unknown][] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object" || !("props" in node)) return;
    const props = (node as { props: { color?: unknown; children?: unknown } }).props;
    const kids = props.children;
    if (typeof kids === "string" && props.color !== undefined) coloured.push([kids, props.color]);
    visit(kids);
  };
  for (const focused of [false, true]) {
    coloured.length = 0;
    visit(AddBox({ compose, focused, width: 80, exists: FILES.exists, errors: [] }));
    assert.deepEqual(coloured.filter(([, c]) => c === ROLE.error).map(([t]) => t), ["@zz.md"], `focused ${focused}`);
    // While focused the cursor cell ("m") is drawn inverse; the rest of "@a.md" stays accent.
    assert.equal(coloured.filter(([, c]) => c === ROLE.accent).map(([t]) => t).join(""), focused ? "@a.d" : "@a.md");
  }
});

test("app_past_task_shows_timeline", async () => {
  const d = decision("open the page", [["goto", "https://x.test"]]);
  const outcome: RunOutcome = { ...OUTCOME, steps: 1, costUsd: 0.25 };
  const events = [ev.start(), ev.step(1), ev.decision(1, d, 0.25), ev.stepEnd(1, d, ["ok"]), ev.end(outcome)];
  const m = new FakeManager([snapshot(1, "Past one", {
    runId: "20261001-100000-a", past: { runId: "20261001-100000-a", events },
  })]);
  const t = mount(m);
  await settle();
  const f = t.frame();
  assert.match(f, /past run 20261001-100000-a/);
  assert.match(f, /open the page/);
  assert.match(f, /✓ success/);
  assert.match(f, /\$0\.250/);
  assert.doesNotMatch(f, /step 1\//);
  assert.doesNotMatch(f, /running/);
});

test("app_past_run_id_is_sanitized", async () => {
  const d = decision("open the page", [["goto", "https://x.test"]]);
  const events = [ev.start(), ev.step(1), ev.decision(1, d, 0.25), ev.stepEnd(1, d, ["ok"]), ev.end({ ...OUTCOME, steps: 1 })];
  const id = "20261001-100000-b\x1b[31mX";
  const m = new FakeManager([snapshot(1, "Past one", { runId: id, past: { runId: id, events } })]);
  const t = mount(m);
  await settle();
  assert.doesNotMatch(t.frame(), /\x1b/);
  assert.match(t.frame(), /past run 20261001-100000-b/);
});

test("app_filter_narrows_sidebar", async () => {
  const m = new FakeManager([snapshot(1, "alpha"), snapshot(2, "beta"), snapshot(3, "gamma")]);
  const t = mount(m);
  await settle();
  await t.type("/", "e", "t");
  let f = t.frame();
  assert.match(f, /TASKS \/et 1\/3/);
  assert.match(f, /"beta"/);
  assert.match(f, /\/et▌/);
  assert.doesNotMatch(f, /"alpha"/);
  await t.type("\r");
  assert.match(t.frame().split("\n").filter((l) => l.trim() !== "").pop() ?? "", /^\s*filter "et" · /);
  await t.type("\x1b");
  f = t.frame();
  assert.match(f, /TASKS(?! \/)/);
  for (const n of ["alpha", "beta", "gamma"]) assert.match(f, new RegExp(`"${n}"`));
});

test("app_no_color_theme", async () => {
  const m = new FakeManager([snapshot(1, "alpha")]);
  const plain = mount(m, undefined, undefined, { theme: resolveTheme("dark", { NO_COLOR: "1" }) });
  await settle();
  assert.match(plain.frame(), /┏/);
  assert.doesNotMatch(plain.raw(), /\x1b\[(3[0-9]|9[0-7]|38;)/);
  cleanup();
  const colour = mount(new FakeManager([snapshot(1, "alpha")]), undefined, undefined, { theme: DEFAULT_THEME });
  await settle();
  assert.doesNotMatch(colour.frame(), /┏/);
});

test("app_notices_toast", async () => {
  const t = mount(new FakeManager(), undefined, undefined, { notices: ["skipped 1 unreadable run folder in runs/"] });
  await settle();
  assert.match(t.frame(), /skipped 1 unreadable run folder in runs\//);
});

test("addbox_no_color_mentions", () => {
  const compose = { ...EMPTY_COMPOSE, text: "@a.md @zz.md x", cursor: 3 };
  const found: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object" || !("props" in node)) return;
    const props = (node as { props: { color?: unknown; borderColor?: unknown; children?: unknown } }).props;
    if (props.color !== undefined) found.push(props.color);
    visit(props.children);
  };
  for (const focused of [false, true]) {
    visit(AddBox({ compose, focused, width: 80, exists: FILES.exists, errors: [], theme: resolveTheme("dark", { NO_COLOR: "1" }) }));
  }
  assert.deepEqual(found, []);
});
