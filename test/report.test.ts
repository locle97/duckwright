import assert from "node:assert/strict";
import { test } from "node:test";

import { RunEvents } from "../src/events.ts";
import type { RunOutcome } from "../src/events.ts";
import { stepLine } from "../src/prompt.ts";
import type { StepRecord } from "../src/prompt.ts";
import { attachPlain, printOutcome } from "../src/report/plain.ts";

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  status: "pass", exitCode: 0, success: true, answer: "a", steps: 2, costUsd: 0.0213,
  historyPath: "runs/x/history.json", export: { kind: "off" }, warnings: [], error: null, ...over,
});

function print(o: RunOutcome): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  printOutcome(o, (l) => out.push(l), (l) => err.push(l));
  return { out, err };
}

test("print_pass_with_written_export_and_warning", () => {
  const r = print(outcome({ export: { kind: "written", path: "runs/x/duckwright.spec.ts" }, warnings: ["careful"] }));
  assert.deepEqual(r.out, [
    "Result: success", "Answer: a", "Steps: 2  Cost: $0.0213", "History: runs/x/history.json",
    "Test: runs/x/duckwright.spec.ts",
  ]);
  assert.deepEqual(r.err, ["warning: careful"]);
});

test("print_fail_with_skipped_export", () => {
  const r = print(outcome({ status: "fail", exitCode: 1, success: false, export: { kind: "skipped" } }));
  assert.deepEqual(r.out, [
    "Result: failure", "Answer: a", "Steps: 2  Cost: $0.0213", "History: runs/x/history.json",
    "Test: not exported (run did not succeed)",
  ]);
  assert.deepEqual(r.err, []);
});

test("print_failed_export_goes_to_stderr", () => {
  const r = print(outcome({ export: { kind: "failed", message: "nothing to export" } }));
  assert.equal(r.out.length, 4);
  assert.deepEqual(r.err, ["export failed: nothing to export"]);
});

test("print_error_outcome_only_prints_error", () => {
  const r = print(outcome({ status: "stop", exitCode: 130, success: false, error: "interrupted", answer: "interrupted" }));
  assert.deepEqual(r, { out: [], err: ["interrupted"] });
});

test("attach_plain_prints_step_line_on_step_end", () => {
  const events = new RunEvents();
  const lines: string[] = [];
  const off = attachPlain(events, (l) => lines.push(l));
  const record: StepRecord = {
    step: 1, decision: { evaluationPreviousGoal: "ev", memory: "", nextGoal: "goal", actions: [{ cmd: "click", args: ["e1"] }] },
    results: ["ok"], codes: [null],
  };
  events.emit({ type: "step:start", step: 1 });
  events.emit({ type: "step:end", record, cost: 0, durationMs: 1 });
  assert.deepEqual(lines, [stepLine(record)]);
  off();
  events.emit({ type: "step:end", record, cost: 0, durationMs: 1 });
  assert.equal(lines.length, 1);
});

test("print_video_line", () => {
  const r = print(outcome({ video: "video.webm" }));
  assert.deepEqual(r.out, [
    "Result: success", "Answer: a", "Steps: 2  Cost: $0.0213", "History: runs/x/history.json",
    "Video: runs/x/video.webm",
  ]);
  assert.equal(print(outcome()).out.some((l) => l.startsWith("Video:")), false);
});

test("printOutcome jev steps line", () => {
  const r = print(outcome({ jevSteps: 3, steps: 5 }));
  assert.equal(r.out[r.out.indexOf("Steps: 5  Cost: $0.0213") + 1], "Jev steps: 3/5");
  assert.equal(print(outcome()).out.some((l) => l.startsWith("Jev steps")), false);
  const e = print(outcome({ jevSteps: 3, error: "boom" }));
  assert.deepEqual(e.out, []);
  assert.deepEqual(e.err, ["boom"]);
});
