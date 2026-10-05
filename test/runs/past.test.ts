import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { RunEvent, RunOutcome } from "../../src/events.ts";
import type { HistoryData } from "../../src/export.ts";
import { loadPastRuns, readEventsJsonl } from "../../src/runs/past.ts";
import { historyJson } from "../../src/runs/run.ts";
import { tmpDir } from "../helpers.ts";

const rec = (codes: (string | null)[]) => ({
  step: 1,
  decision: {
    evaluationPreviousGoal: "e", memory: "m", nextGoal: "n",
    actions: [{ cmd: "goto", args: ["u"] }, { cmd: "click", args: ["e1"] }],
  },
  results: ["ok"], codes,
});

function hist(over: Partial<HistoryData> = {}): HistoryData {
  return { ...historyJson("typed task", true, "done", 1, 0.25, [rec(["code1"])]), ...over };
}

function mkRun(runsDir: string, name: string, history?: unknown, eventsText?: string): string {
  const dir = path.join(runsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (history !== undefined) {
    fs.writeFileSync(path.join(dir, "history.json"), typeof history === "string" ? history : JSON.stringify(history));
  }
  if (eventsText !== undefined) fs.writeFileSync(path.join(dir, "events.jsonl"), eventsText);
  return dir;
}

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  status: "pass", exitCode: 0, success: true, answer: "a", steps: 1, costUsd: 0, historyPath: null,
  export: { kind: "off" }, warnings: [], error: null, ...over,
});
const startEv = (): RunEvent => ({
  type: "run:start", at: 1, task: "t", maxSteps: 3, model: "real", snapshot: "full", headed: true, session: "s", workdir: "w",
});
const endEv = (o: RunOutcome): RunEvent => ({ type: "run:end", at: 2, outcome: o });
const lines = (...e: RunEvent[]) => e.map((x) => JSON.stringify(x)).join("\n") + "\n";

test("past_newest_n_oldest_first", () => {
  const runs = tmpDir();
  for (const n of ["20261001-100000-a", "20261002-100000-b", "20261003-100000-c"]) mkRun(runs, n, hist());
  mkRun(runs, "notes", hist());
  mkRun(runs, "x-20261004-100000", hist());
  fs.writeFileSync(path.join(runs, "20261005-100000-f"), "");
  const r = loadPastRuns({ runsDir: runs, limit: 2 });
  assert.deepEqual(r.runs.map((x) => x.id), ["20261002-100000-b", "20261003-100000-c"]);
  assert.equal(r.skipped, 0);
  assert.equal(r.runs[0].workdir, path.join(runs, "20261002-100000-b"));
});

test("past_limit_zero_and_missing_dir", () => {
  const runs = tmpDir();
  mkRun(runs, "20261001-100000-a", hist());
  assert.deepEqual(loadPastRuns({ runsDir: runs, limit: 0 }), { runs: [], skipped: 0 });
  assert.deepEqual(loadPastRuns({ runsDir: path.join(runs, "nope"), limit: 3 }), { runs: [], skipped: 0 });
});

test("past_invalid_history_skipped_and_counted", () => {
  const runs = tmpDir();
  mkRun(runs, "20261001-100000-a", hist());
  const badSteps = hist();
  (badSteps.history[0] as unknown as { results: unknown }).results = "no";
  mkRun(runs, "20261002-100000-b", badSteps);
  mkRun(runs, "20261003-100000-c", { ...hist(), success: "yes" });
  mkRun(runs, "20261004-100000-d", "{");
  mkRun(runs, "20261005-100000-e");
  const r = loadPastRuns({ runsDir: runs, limit: 5 });
  assert.equal(r.runs.length, 1);
  assert.equal(r.skipped, 4);
  mkRun(runs, "20261006-100000-f", hist());
  const r1 = loadPastRuns({ runsDir: runs, limit: 1 });
  assert.equal(r1.runs.length, 1);
  assert.equal(r1.skipped, 0);
});

test("past_state_mapping_from_history", () => {
  const runs = tmpDir();
  mkRun(runs, "20261001-100000-a", hist({ success: true, answer: "yay" }));
  mkRun(runs, "20261002-100000-b", hist({ success: false, answer: "interrupted" }));
  mkRun(runs, "20261003-100000-c", hist({ success: false, answer: "boom" }));
  const [a, b, c] = loadPastRuns({ runsDir: runs, limit: 3 }).runs;
  const check = (r: typeof a, status: string, exitCode: number, error: string | null) => {
    assert.equal(r.outcome.status, status);
    assert.equal(r.outcome.exitCode, exitCode);
    assert.equal(r.outcome.error, error);
    assert.equal(r.outcome.costUsd, 0.25);
    assert.equal(r.outcome.historyPath, path.join(r.workdir, "history.json"));
    assert.deepEqual(r.outcome.export, { kind: "off" });
    assert.deepEqual(r.outcome.warnings, []);
    assert.equal(r.outcome.steps, 1);
  };
  check(a, "pass", 0, null);
  check(b, "stop", 130, "interrupted");
  check(c, "fail", 1, "boom");
});

test("past_synthesised_events", () => {
  const runs = tmpDir();
  const h = hist({ steps: 2 });
  h.history[0].actions[1].code = null;
  const dir = mkRun(runs, "20261001-100000-a", h);
  const { runs: [r] } = loadPastRuns({ runsDir: runs, limit: 1 });
  assert.deepEqual(r.events.map((e) => e.type),
    ["run:start", "step:start", "decision", "action:result", "action:result", "step:end", "run:end"]);
  const mt = fs.statSync(path.join(dir, "history.json")).mtimeMs;
  assert.ok(r.events.every((e) => e.at === mt));
  const [start, , dec, ar1, ar2, end] = r.events as [
    Extract<RunEvent, { type: "run:start" }>, RunEvent, Extract<RunEvent, { type: "decision" }>,
    Extract<RunEvent, { type: "action:result" }>, Extract<RunEvent, { type: "action:result" }>,
    Extract<RunEvent, { type: "step:end" }>,
  ];
  assert.deepEqual({ ...start }, {
    type: "run:start", at: mt, task: "typed task", maxSteps: 2, model: "", snapshot: "hybrid", headed: false, session: "", workdir: dir,
  });
  assert.equal(dec.cost, 0);
  assert.equal(ar1.result, "ok");
  assert.equal(ar1.code, "code1");
  assert.equal(ar2.result, "");
  assert.equal(ar2.code, null);
  assert.equal(end.cost, 0);
  assert.equal(end.durationMs, 0);
  assert.deepEqual(end.record.codes, ["code1", null]);
  const zero = tmpDir();
  mkRun(zero, "20261001-100000-a", hist({ steps: 0, history: [] }));
  const z = loadPastRuns({ runsDir: zero, limit: 1 }).runs[0].events[0] as Extract<RunEvent, { type: "run:start" }>;
  assert.equal(z.maxSteps, 1);
});

test("past_prefers_complete_events_jsonl", () => {
  const runs = tmpDir();
  const evs = [startEv(), endEv(outcome({ status: "pass" }))];
  mkRun(runs, "20261001-100000-a", hist({ success: false }), lines(...evs));
  const { runs: [r] } = loadPastRuns({ runsDir: runs, limit: 1 });
  assert.deepEqual(r.events, evs);
  assert.equal(r.outcome.status, "pass");
});

test("past_falls_back_on_bad_events_jsonl", () => {
  const runs = tmpDir();
  const good = lines(startEv(), endEv(outcome()));
  mkRun(runs, "20261001-100000-a", hist(), good.replace('"run:start"', '"run:start') );
  mkRun(runs, "20261002-100000-b", hist(), lines(startEv(), { type: "bogus", at: 1 } as unknown as RunEvent, endEv(outcome())));
  mkRun(runs, "20261003-100000-c", hist(), lines(startEv()));
  const r = loadPastRuns({ runsDir: runs, limit: 3 });
  assert.equal(r.skipped, 0);
  assert.equal(r.runs.length, 3);
  for (const run of r.runs) {
    const first = run.events[0] as Extract<RunEvent, { type: "run:start" }>;
    assert.equal(first.type, "run:start");
    assert.equal(first.model, "");
  }
  assert.equal(readEventsJsonl(""), null);
  assert.equal(readEventsJsonl(JSON.stringify({ type: "run:start" }) + "\n"), null);
  assert.equal(readEventsJsonl(good)?.length, 2);
  assert.equal(readEventsJsonl(good.trimEnd())?.length, 2);
});

test("past_task_source", () => {
  const tmp = tmpDir();
  const runs = path.join(tmp, "runs");
  const tf = path.join(tmp, "t.md");
  fs.writeFileSync(tf, "---\nmodel: opus\nsession: x\n---\nDo the file thing\n");
  mkRun(runs, "20261001-100000-a", hist({ task_file: tf }));
  mkRun(runs, "20261002-100000-b", hist({ task_file: path.join(tmp, "missing.md") }));
  const bad = path.join(tmp, "bad.md");
  fs.writeFileSync(bad, "---\nmodel: opus\nnever closed\n");
  mkRun(runs, "20261003-100000-c", hist({ task_file: bad }));
  const nofile = hist();
  delete (nofile as Partial<HistoryData>).task_file;
  mkRun(runs, "20261004-100000-d", nofile);
  mkRun(runs, "20261005-100000-e", hist({ task_file: "t.md" }));
  const [a, b, c, d, e] = loadPastRuns({ runsDir: runs, limit: 5, cwd: tmp }).runs;
  assert.deepEqual(a.source, { kind: "file", path: tf });
  assert.equal(a.text, "Do the file thing");
  assert.deepEqual(a.fileSettings, { model: "opus" });
  for (const r of [b, c, d]) {
    assert.deepEqual(r.source, { kind: "typed" });
    assert.equal(r.text, "typed task");
    assert.deepEqual(r.fileSettings, {});
  }
  assert.deepEqual(e.source, { kind: "file", path: "t.md" });
});

test("past_run_end_outcome_validated", () => {
  const good = lines(startEv(), endEv(outcome()));
  assert.equal(readEventsJsonl(good)?.length, 2);
  const bad = (o: unknown) => JSON.stringify(startEv()) + "\n" + JSON.stringify({ type: "run:end", at: 2, outcome: o }) + "\n";
  assert.equal(readEventsJsonl(JSON.stringify({ type: "run:end", at: 1 }) + "\n"), null);
  assert.equal(readEventsJsonl(bad({ ...outcome(), status: "weird" })), null);
  assert.equal(readEventsJsonl(bad({ ...outcome(), costUsd: "1" })), null);
  assert.equal(readEventsJsonl(bad({ ...outcome(), steps: null })), null);
  assert.equal(readEventsJsonl(bad({ ...outcome(), warnings: "x" })), null);
  const step = JSON.stringify({ type: "step:start", at: 1, step: "1" });
  assert.equal(readEventsJsonl(step + "\n" + JSON.stringify(endEv(outcome())) + "\n"), null);
});
