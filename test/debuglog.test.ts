import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DebugLog, debugRunner, estimateTokens, promptSections } from "../src/debuglog.ts";
import { RunEvents } from "../src/events.ts";
import type { Observation } from "../src/observe.ts";
import { buildPrompt } from "../src/prompt.ts";
import type { ProcResult, Runner } from "../src/proc.ts";
import { Scrubber } from "../src/scrub.ts";
import { tmpDir } from "./helpers.ts";

const OBS: Observation = { tabs: "tab0", snapshot: "SNAP", truncated: false, lines: 3, chars: 40 };

function clock(...times: number[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

function setup(o: Partial<ConstructorParameters<typeof DebugLog>[0]> = {}) {
  const dir = tmpDir();
  const file = path.join(dir, "debug.log");
  const out: string[] = [];
  const warnings: string[] = [];
  const log = new DebugLog({
    runId: "run1", file, console: (t) => out.push(t), onWarning: (m) => warnings.push(m),
    readFile: (p) => `CONTENT of ${p}`, ...o,
  });
  return { dir, file, out, warnings, log };
}

const ENV = JSON.stringify({
  result: "ok", total_cost_usd: 0.0123, duration_ms: 1400, duration_api_ms: 1200,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
});
const ok = (stdout = ENV, stderr = ""): ProcResult => ({ code: 0, stdout, stderr });
const ARGV = ["claude", "-p", "--append-system-prompt-file", "/sys/a.md", "--tools", ""];

test("estimateTokens", () => {
  assert.equal(estimateTokens(10), 3);
});

test("promptSections paste and file mode", () => {
  const paste = buildPrompt("do it", 2, 9, [], "m", OBS, { environment: "env", nudge: "NUDGE here" });
  const s = promptSections(paste);
  assert.deepEqual(s.map((x) => x.name), ["header", "task", "environment", "memory", "tabs", "history", "other", "page_snapshot", "total"]);
  assert.equal(s.at(-1)!.chars, paste.length);
  assert.equal(s.find((x) => x.name === "task")!.chars, "<task>\ndo it\n</task>".length);
  const file = buildPrompt("t", 1, 9, [], "", OBS, { paste: false });
  const f = promptSections(file).map((x) => x.name);
  assert.deepEqual(f, ["header", "task", "memory", "tabs", "history", "page_snapshot_file", "total"]);
});

test("run header on creation", () => {
  const { file, log, out } = setup();
  assert.ok(log);
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text, `===== [debug run1] run =====\nlog: ${path.resolve(file)}\n\n`);
  assert.deepEqual(out, [text]);
});

test("debugRunner block content and pass-through", async () => {
  const { file, log, out } = setup({ now: clock(1000, 2500) });
  const prompt = buildPrompt("do it", 1, 9, [], "", OBS);
  const result = ok();
  const seen: unknown[][] = [];
  const inner: Runner = async (...a) => { seen.push(a); return result; };
  const signal = new AbortController().signal;
  const opts = { cwd: "/w", signal };
  const got = await debugRunner(inner, log)(ARGV, prompt, 30, opts);
  assert.equal(got, result);
  assert.equal(seen[0][0], ARGV);
  assert.equal(seen[0][1], prompt);
  assert.equal(seen[0][2], 30);
  assert.equal(seen[0][3], opts);
  await debugRunner(inner, log)(ARGV, prompt, 30);
  assert.equal(seen[1].length, 4);
  assert.equal(seen[1][3], undefined);
  const text = fs.readFileSync(file, "utf8");
  for (const s of [
    `argv: ${JSON.stringify(ARGV)}`, "cwd: /w", "mode: paste", "  /sys/a.md (", "----- prompt (stdin) -----\n" + prompt,
    "exit: 0  wall: 1.50s", '"total_cost_usd": 0.0123',
    "input tokens: 10  output tokens: 5  cache read: 3  cache write: 2", "cost: $0.0123  duration_ms: 1400  duration_api_ms: 1200",
    "===== [debug run1] step 0 · claude =====", "cwd: (inherited)",
  ]) assert.ok(text.includes(s), s);
  assert.equal(text.split("===== [debug run1] system prompts =====").length, 2);
  assert.ok(text.indexOf("system prompts") < text.indexOf("step 0 · claude"));
  assert.ok(text.includes("----- /sys/a.md (") && text.includes("CONTENT of /sys/a.md"));
  assert.equal(out.join(""), text);
});

test("grep mode, n/a, stderr, timeout, raw stdout", async () => {
  const { file, log } = setup();
  const run = (r: ProcResult, argv = ARGV) => debugRunner(async () => r, log)(argv, "P\n", 1);
  await run(ok(JSON.stringify({ usage: { input_tokens: "x" } }), "boom"), [...ARGV, "--restricted"]);
  await run(ok("not json"));
  await run({ code: -1, stdout: "", stderr: "timeout" });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("mode: grep"));
  assert.ok(text.includes("input tokens: n/a  output tokens: n/a  cache read: n/a  cache write: n/a"));
  assert.ok(text.includes("cost: $n/a  duration_ms: n/a  duration_api_ms: n/a"));
  assert.ok(text.includes("----- stderr -----\nboom"));
  assert.ok(text.includes("not json\n----- usage -----"));
  assert.ok(text.includes("exit: -1 (timeout)"));
  assert.equal(text.split("----- stderr -----").length, 3); // boom + timeout's "timeout"
});

test("thrown error rethrown unchanged, no usage section", async () => {
  const { file, log } = setup();
  const err = new TypeError("bad");
  await assert.rejects(debugRunner(async () => { throw err; }, log)(ARGV, "p", 1), (e) => e === err);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("error: TypeError: bad"));
  assert.ok(!text.includes("----- usage -----"));
});

test("step number from step:start", async () => {
  const { file, log } = setup();
  const events = new RunEvents();
  log.attach(events);
  const r = debugRunner(async () => ok(), log);
  await r(ARGV, "p", 1);
  events.emit({ type: "step:start", step: 4 });
  await r(ARGV, "p", 1);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("] step 0 · claude ="));
  assert.ok(text.includes("] step 4 · claude ="));
});

test("unreadable system prompt file", async () => {
  const { file, log } = setup({ readFile: () => { throw new Error("nope"); } });
  await debugRunner(async () => ok(), log)(ARGV, "p", 1);
  assert.ok(fs.readFileSync(file, "utf8").includes("(cannot read: nope)"));
});

test("redaction of secrets in file and console", async () => {
  const sc = new Scrubber();
  sc.addSecret("JBSWY3DPEHPK3PXP");
  sc.addCode("834512");
  const { file, log, out } = setup({ secrets: ["sk-key-123"], scrub: (t) => sc.scrub(t) });
  const env = JSON.stringify({ result: "Bearer xyz sk-key-123 834512", usage: { input_tokens: 10 } });
  await debugRunner(async () => ok(env, "JBSWY3DPEHPK3PXP"), log)(ARGV, "prompt sk-key-123 JBSWY3DPEHPK3PXP 834512", 1);
  const text = fs.readFileSync(file, "utf8");
  for (const s of ["sk-key-123", "JBSWY3DPEHPK3PXP", "834512", "Bearer xyz"]) {
    assert.ok(!text.includes(s), s);
    assert.ok(!out.join("").includes(s), s);
  }
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(text.includes("input tokens: 10"));
});

test("summary on run:end", async () => {
  const { file, log } = setup();
  const events = new RunEvents();
  log.attach(events);
  const r = debugRunner(async () => ok(), log);
  await r(ARGV, "p", 1);
  await r(ARGV, "p", 1);
  events.emit({ type: "run:end", outcome: {} as never });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("claude: 2 calls  input 20  output 10  cache read 6  cache write 4 tokens  cost $0.0246\n"));
  assert.ok(text.includes("total cost: $0.0246"));
  assert.ok(!text.includes("jev:") && !text.includes("routes:"));

  const b = setup();
  const ev2 = new RunEvents();
  b.log.attach(ev2);
  await debugRunner(async () => ok(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1 } })), b.log)(ARGV, "p", 1);
  await debugRunner(async () => ok(), b.log)(ARGV, "p", 1);
  ev2.emit({ type: "run:end", outcome: {} as never });
  assert.ok(fs.readFileSync(b.file, "utf8").includes("tokens  cost $0.0223  (usage missing on 1 calls)\n"));
});

test("write failure warns once, console continues, no throw", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "missing", "debug.log");
  const out: string[] = [];
  const warnings: string[] = [];
  const log = new DebugLog({ runId: "r", file, console: (t) => out.push(t), onWarning: (m) => warnings.push(m), readFile: () => "x" });
  await debugRunner(async () => ok(), log)(ARGV, "p", 1);
  await debugRunner(async () => ok(), log)(ARGV, "p", 1);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith(`debug log: cannot write ${path.resolve(file)}: `));
  assert.equal(out.length, 1 + 1 + 2); // run header, system prompts, two calls
});
