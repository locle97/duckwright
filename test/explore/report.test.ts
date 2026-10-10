import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { HistoryData, HistoryStep } from "../../src/export.ts";
import {
  buildExploreReport, consoleErrors, failedRequests, parseFlows, renderExploreMarkdown,
  writeExploreReport, type ExploreReport, type Flow,
} from "../../src/explore/report.ts";

const BASE = "https://shop.example/";

const flow = (o: Partial<Flow> = {}): Flow => ({
  title: "Search", start_url: "https://shop.example/", steps: ["Type mug", "Press Enter"],
  expected: "Results", status: "ok", notes: "", ...o,
});
const ans = (flows: unknown[]) => JSON.stringify({ flows });

const step = (n: number, o: Partial<HistoryStep> = {}): HistoryStep => ({
  step: n, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [], ...o,
});
const entry = (method: string, url: string, status: number | null, statusText: string) =>
  ({ id: "r", method, url, status, statusText, type: null, durationMs: null });
const data = (history: HistoryStep[], o: Partial<HistoryData> = {}): HistoryData => ({
  task: "t", task_file: null, success: true, answer: "", steps: history.length, cost_usd: 0.5, history, ...o,
});

test("parseFlows reads plain JSON", () => {
  const r = parseFlows(ans([flow()]), BASE);
  assert.deepEqual(r, { flows: [flow()], dropped: 0, error: null });
});

test("parseFlows reads fenced JSON and JSON surrounded by prose", () => {
  assert.equal(parseFlows("```json\n" + ans([flow()]) + "\n```", BASE).flows.length, 1);
  assert.equal(parseFlows("Here you go: " + ans([flow()]) + " done.", BASE).flows.length, 1);
});

test("parseFlows reports unreadable answers", () => {
  assert.match(parseFlows("{nope}", BASE).error!, /^invalid JSON: .+/);
  assert.equal(parseFlows("max steps reached", BASE).error, "no JSON object in the answer");
  assert.equal(parseFlows("", BASE).error, "no JSON object in the answer");
  assert.equal(parseFlows('{"a":1}', BASE).error, 'no "flows" list in the answer');
  assert.equal(parseFlows('{"flows":{}}', BASE).error, 'no "flows" list in the answer');
  assert.deepEqual(parseFlows("max steps reached", BASE).flows, []);
});

test("parseFlows resolves relative start_url and drops bad items", () => {
  const items = [
    flow({ start_url: "/pricing" }),
    flow({ start_url: "ftp://x.test/" }),
    flow({ start_url: "http://[bad" }),
    flow({ status: "weird" as never }),
    flow({ title: "" }),
    "str",
    null,
  ];
  const r = parseFlows(ans(items), BASE);
  assert.equal(r.flows.length, 1);
  assert.equal(r.flows[0]!.start_url, "https://shop.example/pricing");
  assert.equal(r.dropped, 6);
});

test("parseFlows applies defaults and drops non-string steps", () => {
  const r = parseFlows(ans([{ title: "A", start_url: "/", status: "broken", steps: ["a", 3, null, "b"] },
    { title: "B", start_url: "/", status: "ok" }]), BASE);
  assert.deepEqual(r.flows[0]!.steps, ["a", "b"]);
  assert.equal(r.flows[0]!.expected, "");
  assert.deepEqual(r.flows[1], { title: "B", start_url: "https://shop.example/", steps: [], expected: "", status: "ok", notes: "" });
});

test("failedRequests keeps errors and null status, skips aborted and ok", () => {
  const d = data([step(1, { network: [
    entry("GET", "https://a/1", 404, "Not Found"),
    entry("GET", "https://a/2", 500, "Err"),
    entry("GET", "https://a/3", null, "net::ERR_FAILED"),
    entry("GET", "https://a/4", null, "net::ERR_ABORTED"),
    entry("GET", "https://a/5", 499, "Cancelled"),
    entry("GET", "https://a/6", 200, "OK"),
    entry("GET", "https://a/7", 301, "Moved"),
  ] })]);
  const f = failedRequests(d);
  assert.deepEqual(f.map((x) => x.url), ["https://a/1", "https://a/2", "https://a/3"]);
  assert.equal(f[2]!.status, null);
  assert.equal(f[0]!.status_text, "Not Found");
});

test("failedRequests groups by method, url and status with unique ascending steps", () => {
  const e = entry("GET", "https://a/1", 404, "Not Found");
  const d = data([step(1, { network: [e, e] }), step(2, { network: [entry("GET", "https://a/1", 500, "x")] }), step(3, { network: [e] })]);
  const f = failedRequests(d);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0]!.steps, [1, 3]);
  assert.deepEqual(f[1]!.steps, [2]);
});

test("consoleErrors groups the same message across steps", () => {
  const d = data([step(1, { console_errors: ["boom", "x"] }), step(2, { console_errors: ["boom"] }), step(3)]);
  assert.deepEqual(consoleErrors(d), [{ message: "boom", steps: [1, 2] }, { message: "x", steps: [1] }]);
});

const opts = { url: "https://shop.example/", runDir: "/runs/a-b", network: true };

test("buildExploreReport has the C4 keys in order and splits flows", () => {
  const d = data([step(1)], { answer: ans([flow(), flow({ title: "Dead", status: "dead-end" }), flow({ title: "Bad", status: "broken" })]) });
  const r = buildExploreReport(d, opts);
  assert.deepEqual(Object.keys(r), ["version", "url", "run_dir", "success", "steps", "cost_usd", "network_checked",
    "failed_requests", "console_errors", "answer_error", "dropped_flows", "broken_flows", "working_flows"]);
  assert.equal(r.version, 1);
  assert.deepEqual(r.broken_flows.map((f) => f.title), ["Dead", "Bad"]);
  assert.deepEqual(r.working_flows.map((f) => f.title), ["Search"]);
  assert.equal(r.answer_error, null);
});

test("buildExploreReport with network off reports no failed requests", () => {
  const d = data([step(1, { network: [entry("GET", "https://a/1", 404, "x")] })]);
  const r = buildExploreReport(d, { ...opts, network: false });
  assert.equal(r.network_checked, false);
  assert.deepEqual(r.failed_requests, []);
});

const base = (o: Partial<ExploreReport> = {}): ExploreReport => ({
  version: 1, url: "https://shop.example/", run_dir: "/runs/a-b", success: true, steps: 3, cost_usd: 0.5,
  network_checked: true, failed_requests: [], console_errors: [], answer_error: null, dropped_flows: 0,
  broken_flows: [], working_flows: [], ...o,
});

test("markdown for an all-empty report", () => {
  assert.equal(renderExploreMarkdown(base()), `# Exploration report: https://shop.example/

Run: /runs/a-b  Steps: 3  Cost: $0.5000  Result: success

## Broken links and failed requests (0)

None.

## Console errors (0)

None.

## Dead ends and broken flows (0)

None.

## Flows that worked (0)

None.
`);
});

test("markdown for a full report", () => {
  const r = base({
    success: false,
    failed_requests: [
      { method: "GET", url: "https://a/1", status: 404, status_text: "Not Found", steps: [3, 5] },
      { method: "POST", url: "https://a/2", status: null, status_text: "net::ERR_FAILED", steps: [2] },
    ],
    console_errors: [{ message: "line1\nline2", steps: [1, 2] }, { message: "solo", steps: [4] }],
    broken_flows: [flow({ title: "Dead\nend", status: "dead-end", notes: "nothing happens" })],
    working_flows: [flow({ steps: [], expected: "" }), flow({ title: "Two", start_url: "https://shop.example/b" })],
  });
  assert.equal(renderExploreMarkdown(r), `# Exploration report: https://shop.example/

Run: /runs/a-b  Steps: 3  Cost: $0.5000  Result: failure

## Broken links and failed requests (2)

- GET https://a/1 → 404 Not Found  (steps 3, 5)
- POST https://a/2 → no response: net::ERR_FAILED  (step 2)

## Console errors (2)

- line1 line2  (steps 1, 2)
- solo  (step 4)

## Dead ends and broken flows (1)

### Dead end (dead-end)

- Start: https://shop.example/
- Steps: 1. Type mug; 2. Press Enter
- Expected: Results
- Notes: nothing happens

## Flows that worked (2)

### Search

- Start: https://shop.example/

### Two

- Start: https://shop.example/b
- Steps: 1. Type mug; 2. Press Enter
- Expected: Results
`);
});

test("markdown with network off", () => {
  const md = renderExploreMarkdown(base({ network_checked: false }));
  assert.match(md, /## Broken links and failed requests \(-\)\n\nNetwork capture was off \(--no-network\), so requests were not checked\.\n\n## Console/);
});

test("markdown for an unreadable answer", () => {
  const md = renderExploreMarkdown(base({ answer_error: "no JSON object in the answer" }));
  assert.match(md, /Result: success\n\nThe agent's answer could not be read as a flow list: no JSON object in the answer\.\n\n## Broken/);
  assert.match(md, /## Dead ends and broken flows \(0\)\n\nNone\.\n\n## Flows that worked \(0\)\n\nNone\.\n$/);
});

test("markdown notes dropped flows", () => {
  const md = renderExploreMarkdown(base({ dropped_flows: 2 }));
  assert.match(md, /Result: success\n\n2 flow\(s\) in the answer were unreadable and left out\.\n\n## Broken/);
});

test("writeExploreReport writes explore.md and explore.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explore-"));
  try {
    const r = base();
    const out = writeExploreReport(dir, r);
    assert.equal(out.md, path.join(dir, "explore.md"));
    assert.equal(out.json, path.join(dir, "explore.json"));
    assert.equal(fs.readFileSync(out.json, "utf8"), JSON.stringify(r, null, 2) + "\n");
    assert.equal(fs.readFileSync(out.md, "utf8"), renderExploreMarkdown(r));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
