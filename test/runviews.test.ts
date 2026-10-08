import assert from "node:assert/strict";
import { test } from "node:test";

import type { Decision } from "../src/brain.ts";
import type { RunEvent, RunOutcome } from "../src/events.ts";
import { foldPast, newRunView, reduceRunEvent, reduceTimeline } from "../src/runviews.ts";
import type { RunView } from "../src/runviews.ts";

const OUTCOME: RunOutcome = {
  status: "pass", exitCode: 0, success: true, answer: "ok", steps: 1, costUsd: 0.5, historyPath: null,
  export: { kind: "off" }, warnings: [], error: null,
};

function dec(goal: string, actions: [string, ...string[]][], memory = "m"): Decision {
  return {
    evaluationPreviousGoal: `eval ${goal}`, memory, nextGoal: goal,
    actions: actions.map(([cmd, ...args]) => ({ cmd, args })),
  } as Decision;
}

const start = (): Extract<RunEvent, { type: "run:start" }> => ({
  type: "run:start", at: 10, task: "t", maxSteps: 7, model: "m", snapshot: "hybrid", headed: false, session: "s", workdir: "/w",
});
const stepStart = (step: number): RunEvent => ({ type: "step:start", at: 11, step });
const decision = (step: number, d: Decision, cost = 0.01): RunEvent => ({ type: "decision", at: 12, step, decision: d, cost });
const actionResult = (step: number, index: number, result: string): RunEvent =>
  ({ type: "action:result", at: 13, step, index, result, code: null });
const stepEnd = (step: number, d: Decision, results: string[]): RunEvent => ({
  type: "step:end", at: 14, record: { step, decision: d, results, codes: results.map(() => null) }, cost: 0, durationMs: 100,
});
const end = (): RunEvent => ({ type: "run:end", at: 15, outcome: OUTCOME });

test("newRunView starts following with no steps", () => {
  const v = newRunView("r1", start());
  assert.equal(v.runId, "r1");
  assert.equal(v.maxSteps, 7);
  assert.equal(v.startedAt, 10);
  assert.equal(v.follow, true);
  assert.deepEqual(v.steps, []);
});

test("a step's events fold into its view", () => {
  const d = dec("open", [["goto", "https://x"]]);
  let v: RunView = newRunView("r1", start());
  for (const e of [stepStart(1), decision(1, d, 0.02), actionResult(1, 0, "ok"), stepEnd(1, d, ["ok"])]) v = reduceRunEvent(v, e);
  assert.equal(v.steps.length, 1);
  const s = v.steps[0]!;
  assert.equal(s.goal, "open");
  assert.equal(s.status, "ok");
  assert.equal(s.durationMs, 100);
  assert.deepEqual(s.actions, [{ label: "goto https://x", result: "ok" }]);
  assert.equal(v.cost, 0.02);
});

test("an action error marks the step as a warning", () => {
  const d = dec("click", [["click", "e1"]]);
  let v: RunView = newRunView("r1", start());
  for (const e of [stepStart(1), decision(1, d), actionResult(1, 0, "error: nope"), stepEnd(1, d, ["error: nope"])]) v = reduceRunEvent(v, e);
  assert.equal(v.steps[0]!.status, "warn");
});

test("reduceTimeline toggles and expands steps", () => {
  const d = dec("g", [["goto", "u"]]);
  let v: RunView = newRunView("r1", start());
  for (const e of [stepStart(1), decision(1, d), stepEnd(1, d, ["ok"]), stepStart(2), decision(2, dec("g2", [["goto", "v"]]), 0), stepEnd(2, d, ["ok"])]) {
    v = reduceRunEvent(v, e);
  }
  v = reduceTimeline(v, "collapseAll", 0);
  assert.deepEqual(v.expanded, []);
  v = reduceTimeline(v, "first", 0);
  v = reduceTimeline(v, "toggle", 0);
  assert.deepEqual(v.expanded, [0]);
  v = reduceTimeline(v, "expandAll", 0);
  assert.deepEqual(v.expanded, [0, 1]);
  assert.equal(reduceTimeline(newRunView("r", start()), "toggle", 0).expanded.length, 0);
});

test("foldPast gives a read-only view of a finished run", () => {
  const d = dec("g", [["goto", "u"]]);
  const v = foldPast("p1", [start(), stepStart(1), decision(1, d, 0.1), stepEnd(1, d, ["ok"]), end()]);
  assert.equal(v.past, true);
  assert.equal(v.follow, false);
  assert.equal(v.selected, 0);
  assert.deepEqual(v.expanded, []);
  assert.equal(v.cost, 0.5); // the outcome's cost wins
  assert.equal(v.outcome?.status, "pass");
});

test("foldPast without a run:start keeps just the outcome", () => {
  const v = foldPast("p1", [end()]);
  assert.equal(v.past, true);
  assert.deepEqual(v.steps, []);
  assert.equal(v.outcome?.answer, "ok");
});

test("foldPast with a malformed event keeps just the outcome", () => {
  const bad = { type: "decision", at: 1, step: 1, decision: {}, cost: 0 } as unknown as RunEvent;
  const v = foldPast("p1", [start(), stepStart(1), bad, end()]);
  assert.equal(v.past, true);
  assert.deepEqual(v.steps, []);
  assert.equal(v.outcome?.status, "pass");
});

test("reduceTimeline unfollow stops following without touching selection or expanded steps", () => {
  const d = dec("g", [["goto", "u"]]);
  let v: RunView = newRunView("r1", start());
  for (const e of [stepStart(1), decision(1, d), stepEnd(1, d, ["ok"]), stepStart(2), decision(2, d, 0)]) v = reduceRunEvent(v, e);
  assert.equal(v.follow, true);
  const u = reduceTimeline(v, "unfollow", 0);
  assert.equal(u.follow, false);
  assert.equal(u.selected, v.selected);
  assert.deepEqual(u.expanded, v.expanded);
});

const shotEnd = (step: number, d: Decision, extra: Record<string, unknown>): RunEvent => ({
  type: "step:end", at: 14, record: { step, decision: d, results: ["ok"], codes: [null], ...extra }, cost: 0, durationMs: 100,
} as RunEvent);

test("runviews_workdir_and_initial_evidence", () => {
  const d = dec("g", [["goto", "u"]]);
  let v: RunView = newRunView("r1", start());
  assert.equal(v.workdir, "/w");
  assert.equal(v.video, null);
  v = reduceRunEvent(v, stepStart(1));
  assert.equal(v.steps[0]!.screenshot, null);
  assert.equal(v.steps[0]!.screenshotError, null);
  void d;
});

test("runviews_step_screenshot", () => {
  const d = dec("g", [["goto", "u"]]);
  let v: RunView = newRunView("r1", start());
  for (const e of [stepStart(1), decision(1, d), shotEnd(1, d, { screenshot: "screenshots/step-001.png", screenshotError: "boom" })]) v = reduceRunEvent(v, e);
  assert.equal(v.steps[0]!.screenshot, "screenshots/step-001.png");
  assert.equal(v.steps[0]!.screenshotError, "boom");
});

test("runviews_run_end_video", () => {
  const v = reduceRunEvent(newRunView("r1", start()), { type: "run:end", at: 15, outcome: { ...OUTCOME, video: "video.webm" } });
  assert.equal(v.video, "video.webm");
});

test("runviews_rejects_bad_evidence_refs", () => {
  const d = dec("g", [["goto", "u"]]);
  for (const bad of ["../history.json", "screenshots/step-01.png", "screenshots/step-001.png?x", "/etc/passwd", 5]) {
    let v: RunView = newRunView("r1", start());
    for (const e of [stepStart(1), decision(1, d), shotEnd(1, d, { screenshot: bad })]) v = reduceRunEvent(v, e);
    assert.equal(v.steps[0]!.screenshot, null, String(bad));
  }
  let v: RunView = newRunView("r1", start());
  for (const e of [stepStart(1), decision(1, d), shotEnd(1, d, { screenshotError: 5 })]) v = reduceRunEvent(v, e);
  assert.equal(v.steps[0]!.screenshotError, null);
  for (const bad of ["x.webm", "../video.webm"]) {
    const r = reduceRunEvent(newRunView("r1", start()), { type: "run:end", at: 15, outcome: { ...OUTCOME, video: bad } });
    assert.equal(r.video, null, bad);
  }
});

test("fold_past_carries_evidence", () => {
  const d = dec("g", [["goto", "u"]]);
  const v = foldPast("p1", [
    start(), stepStart(1), decision(1, d), shotEnd(1, d, { screenshot: "screenshots/step-001.png", screenshotError: "boom" }),
    { type: "run:end", at: 15, outcome: { ...OUTCOME, video: "video.webm" } },
  ]);
  assert.equal(v.workdir, "/w");
  assert.equal(v.video, "video.webm");
  assert.equal(v.steps[0]!.screenshot, "screenshots/step-001.png");
  assert.equal(v.steps[0]!.screenshotError, "boom");
  const f = foldPast("p2", [{ type: "run:end", at: 15, outcome: { ...OUTCOME, video: "video.webm" } }]);
  assert.equal(f.workdir, "");
  assert.equal(f.video, "video.webm");
});
