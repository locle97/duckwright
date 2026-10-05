import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { RunEvent } from "../../src/events.ts";
import { jsonlSink } from "../../src/runs/sink.ts";
import { tmpDir } from "../helpers.ts";

test("sink_appends_one_line_per_event", () => {
  const file = path.join(tmpDir(), "events.jsonl");
  const fails: string[] = [];
  const s = jsonlSink(file, (m) => fails.push(m));
  const events = [
    { type: "run:start", at: 1, task: "t", maxSteps: 3, model: "m", snapshot: "full", headed: false, session: "s", workdir: "w" },
    { type: "step:start", at: 2, step: 1 },
    { type: "run:end", at: 3, outcome: { status: "pass" } },
  ] as unknown as RunEvent[];
  for (const e of events) s(e);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(text.trimEnd().split("\n").map((l) => JSON.parse(l)), events);
  assert.equal(fails.length, 0);
});

test("sink_failure_calls_on_fail_once", () => {
  const tmp = tmpDir();
  fs.writeFileSync(path.join(tmp, "f"), "");
  const file = path.join(tmp, "f", "events.jsonl");
  const fails: string[] = [];
  const s = jsonlSink(file, (m) => fails.push(m));
  const e = { type: "step:start", at: 1, step: 1 } as unknown as RunEvent;
  for (let i = 0; i < 5; i++) s(e);
  assert.equal(fails.length, 1);
  assert.ok(fails[0].startsWith(`could not write ${file}: `));
});
