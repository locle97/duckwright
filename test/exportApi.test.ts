import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ExportError } from "../src/export.ts";
import type { HistoryData } from "../src/export.ts";
import { API_HEADER, renderApiSpec } from "../src/exportApi.ts";
import { tmpDir } from "./helpers.ts";

type Entry = { id: string; method: string; url: string; status: number | null; statusText: string; type: string | null; durationMs: number | null };
const entry = (id: string, method: string, url: string, status: number | null, type: string | null = "fetch"): Entry =>
  ({ id, method, url, status, statusText: "", type, durationMs: 1 });

function run(entries: Entry[][], success = true, task = "login"): HistoryData {
  const history = entries.map((network, i) => ({
    step: i + 1, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [], network,
  }));
  return { task, task_file: null, success, answer: "", steps: history.length, cost_usd: 0, history } as unknown as HistoryData;
}

function capture(runDir: string, id: string, headers: { name: string; value: string }[], body?: string): void {
  const dir = path.join(runDir, "network", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ id, step: 1, method: "X", url: "u", headers }));
  if (body !== undefined) fs.writeFileSync(path.join(dir, "request-body.txt"), body);
}

const refused = (re: RegExp) => (e: unknown) => e instanceof ExportError && e.exitCode === 1 && re.test(e.message);

test("renders_exact_api_spec", () => {
  const tmp = tmpDir();
  capture(tmp, "0001", [{ name: "content-type", value: "application/json" }, { name: "x-trace", value: "t" }], '{"user":"a"}');
  capture(tmp, "0002", [{ name: "accept", value: "*/*" }]);
  const { spec, warnings } = renderApiSpec(run([
    [entry("0001", "POST", "http://app.test/api/login", 201), entry("0003", "GET", "http://app.test/app.js", 200, "script")],
    [entry("0002", "GET", "http://app.test/api/me", 200, "xhr")],
  ]), tmp);
  assert.equal(spec, API_HEADER + "\n" + 'test("login (API)", async ({ request }) => {\n'
    + '  const res1 = await request.fetch("http://app.test/api/login", {\n'
    + '    method: "POST",\n'
    + '    headers: {"content-type":"application/json"},\n'
    + '    data: {"user":"a"},\n'
    + "  });\n"
    + "  expect(res1.status()).toBe(201);\n"
    + '  const res2 = await request.fetch("http://app.test/api/me", {\n'
    + '    method: "GET",\n'
    + '    headers: {"accept":"*/*"},\n'
    + "  });\n"
    + "  expect(res2.status()).toBe(200);\n"
    + "});\n");
  assert.deepEqual(warnings, []);
});

test("failed_run_refused", () => {
  assert.throws(() => renderApiSpec(run([[entry("0001", "GET", "http://a/b", 200)]], false), tmpDir()), refused(/did not succeed/));
});

test("no_network_keys_refused", () => {
  const data = run([]);
  data.history = [{ step: 1, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [] }];
  assert.throws(() => renderApiSpec(data, tmpDir()), refused(/no API calls were captured/));
});

test("only_non_api_calls_refused", () => {
  assert.throws(
    () => renderApiSpec(run([[entry("0001", "GET", "http://a/x.png", 200, "image")]]), tmpDir()),
    refused(/no API calls were captured/),
  );
});

test("failed_call_dropped_with_warning", () => {
  const tmp = tmpDir();
  capture(tmp, "0002", []);
  const { spec, warnings } = renderApiSpec(run([[
    entry("0001", "GET", "http://a/dead", null), entry("0002", "GET", "http://a/ok", 200),
  ]]), tmp);
  assert.doesNotMatch(spec, /dead/);
  assert.match(spec, /http:\/\/a\/ok/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /0001.*failed/);
});

test("hostile_strings_stay_inside_literals", () => {
  const tmp = tmpDir();
  const url = 'http://a/p?q=`${process.exit()}`"\\n';
  capture(tmp, "0001", [{ name: "content-type", value: "text/plain" }], 'a"\n`${x}`');
  const { spec } = renderApiSpec(run([[entry("0001", "POST", url, 200)]]), tmp);
  assert.ok(spec.includes(`request.fetch(${JSON.stringify(url)}, {`));
  assert.ok(spec.includes(`data: ${JSON.stringify('a"\n`${x}`')},`));
  assert.equal(spec.split("\n").filter((l) => l.includes("process.exit")).length, 1);
});

test("missing_capture_files_exports_bare_call_with_warning", () => {
  const tmp = tmpDir();
  const { spec, warnings } = renderApiSpec(run([[entry("0001", "GET", "http://a/x", 200)]]), tmp);
  assert.ok(spec.includes('method: "GET",\n  });'));
  assert.doesNotMatch(spec, /headers:|data:/);
  assert.match(warnings.join("\n"), /0001.*request\.json/);
});

test("invalid_json_body_falls_back_to_string", () => {
  const tmp = tmpDir();
  capture(tmp, "0001", [{ name: "content-type", value: "application/json" }], "{not json");
  const { spec } = renderApiSpec(run([[entry("0001", "POST", "http://a/x", 200)]]), tmp);
  assert.ok(spec.includes('data: "{not json",'));
});

test("redactions_warn_and_never_leak", () => {
  const tmp = tmpDir();
  capture(tmp, "0001", [{ name: "authorization", value: "[REDACTED]" }, { name: "content-type", value: "application/json" }], '{"password":"[REDACTED]"}');
  const { spec, warnings } = renderApiSpec(run([[entry("0001", "POST", "http://a/x?token=[REDACTED]", 200)]]), tmp);
  assert.doesNotMatch(spec, /authorization/i);
  assert.match(warnings.join("\n"), /auth/i);
  assert.match(warnings.join("\n"), /body.*\[REDACTED\]/);
  assert.match(warnings.join("\n"), /url.*\[REDACTED\]/i);
});
