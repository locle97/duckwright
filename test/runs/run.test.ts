import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { RunArgs } from "../../src/args.ts";
import { RunEvents } from "../../src/events.ts";
import type { RunEvent } from "../../src/events.ts";
import type { AgentOptions, RunResult } from "../../src/loop.ts";
import type { StepRecord } from "../../src/prompt.ts";
import { AbortedError } from "../../src/proc.ts";
import type { Human } from "../../src/twofa.ts";
import { PROMPTS, startRun } from "../../src/runs/run.ts";
import type { AgentLike, RunDeps, RunSpec } from "../../src/runs/run.ts";
import { tmpDir } from "../helpers.ts";

const GOTO = "await page.goto('https://example.com');";
const EXPECT = "await expect(page).toHaveURL(\"https://example.com/\");";

function args(over: Partial<RunArgs> = {}): RunArgs {
  return {
    task: "task", file: null, maxSteps: 5, model: "m", headed: false, skill: PROMPTS.defaultSkill,
    session: "s-1", state: null, allowFileAccess: false, export: false, snapshot: "full", print: false, maxParallel: null, plan: null, network: true, twofaTimeout: 300, web: false, port: null, ...over,
  };
}

const rec = (codes: (string | null)[] = [GOTO, EXPECT]): StepRecord => ({
  step: 1,
  decision: { evaluationPreviousGoal: "", memory: "", nextGoal: "", actions: [{ cmd: "goto", args: ["u"] }, { cmd: "expect", args: ["url", "u"] }] },
  results: ["ok", "ok"], codes,
});

const result = (success: boolean, history: StepRecord[] = [], cost = 0): RunResult =>
  ({ success, answer: "a", steps: 1, costUsd: cost, history });

function agentWith(run: (opts: AgentOptions, agent: AgentLike) => Promise<RunResult>) {
  return (opts: AgentOptions): AgentLike => {
    const agent: AgentLike = { costUsd: 0, run: () => run(opts, agent) };
    return agent;
  };
}

function setup(createAgent: RunDeps["createAgent"], over: Partial<RunArgs> = {}, signal = new AbortController().signal) {
  const tmp = tmpDir();
  const spec: RunSpec = { task: "task", taskFile: null, args: args(over) };
  const deps: RunDeps = { prompts: PROMPTS, signal, createAgent, runsDir: path.join(tmp, "runs") };
  return { tmp, spec, deps };
}

const readHistory = (workdir: string) => JSON.parse(fs.readFileSync(path.join(workdir, "history.json"), "utf8"));
const step = (opts: AgentOptions, r: StepRecord) =>
  opts.events!.emit({ type: "step:end", record: r, cost: 0, durationMs: 0 });

test("run_pass_writes_history_and_outcome", async () => {
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()], 0.5); }));
  const h = startRun(spec, deps);
  const o = await h.done;
  assert.equal(o.status, "pass");
  assert.equal(o.exitCode, 0);
  assert.equal(o.success, true);
  assert.equal(o.error, null);
  assert.equal(o.costUsd, 0.5);
  assert.equal(o.historyPath, path.join(h.workdir, "history.json"));
  assert.equal(h.id, path.basename(h.workdir));
  assert.deepEqual(o.export, { kind: "off" });
  assert.equal(readHistory(h.workdir).success, true);
});

test("run_fail_outcome", async () => {
  const { spec, deps } = setup(agentWith(async () => result(false)));
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "fail");
  assert.equal(o.exitCode, 1);
  assert.equal(o.success, false);
  assert.equal(o.error, null);
  assert.equal(o.answer, "a");
});

test("run_crash_outcome", async () => {
  const boom = Object.assign(new Error("claude vanished"), { name: "OSError" });
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, rec()); throw boom; }));
  const h = startRun(spec, deps);
  const o = await h.done;
  assert.equal(o.status, "fail");
  assert.equal(o.exitCode, 1);
  assert.equal(o.error, "error: OSError: claude vanished");
  assert.equal(o.answer, "error: OSError: claude vanished");
  assert.equal(o.steps, 1);
  const data = readHistory(h.workdir);
  assert.equal(data.answer, "error: OSError: claude vanished");
  assert.equal(data.history.length, 1);
});

test("run_stop_via_control", async () => {
  const { spec, deps } = setup(agentWith((opts) => new Promise((_, reject) => {
    if (opts.signal!.aborted) reject(new AbortedError());
    opts.signal!.addEventListener("abort", () => reject(new AbortedError()));
  })));
  const h = startRun(spec, deps);
  h.control.stop();
  const o = await h.done;
  assert.equal(o.status, "stop");
  assert.equal(o.exitCode, 130);
  assert.equal(o.error, "interrupted");
  assert.equal(readHistory(h.workdir).answer, "interrupted");
});

test("run_process_signal_interrupts", async () => {
  const ac = new AbortController();
  const { spec, deps } = setup(agentWith(async (opts) => {
    assert.notEqual(opts.signal, ac.signal);
    ac.abort();
    throw new Error("child died first");
  }), {}, ac.signal);
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "stop");
  assert.equal(o.exitCode, 130);
});

test("run_emits_start_and_end_once", async () => {
  const { spec, deps } = setup(agentWith(async () => result(true)));
  const h = startRun(spec, deps);
  const seen: RunEvent[] = [];
  h.events.subscribe((e) => seen.push(e));
  const o = await h.done;
  const starts = seen.filter((e) => e.type === "run:start");
  const ends = seen.filter((e) => e.type === "run:end");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(seen[0].type, "run:start");
  assert.equal(seen.at(-1)!.type, "run:end");
  assert.deepEqual((ends[0] as Extract<RunEvent, { type: "run:end" }>).outcome, o);
  const s = starts[0] as Extract<RunEvent, { type: "run:start" }>;
  assert.equal(s.workdir, h.workdir);
  assert.equal(s.session, "s-1");
});

test("run_export_written_skipped_failed", async () => {
  const written = setup(agentWith(async () => result(true, [rec()])), { export: true });
  const w = await startRun(written.spec, written.deps).done;
  assert.equal(w.export.kind, "written");
  assert.ok(fs.statSync((w.export as { path: string }).path).isFile());

  const skipped = setup(agentWith(async () => result(false, [rec()])), { export: true });
  assert.deepEqual((await startRun(skipped.spec, skipped.deps).done).export, { kind: "skipped" });

  const failed = setup(agentWith(async () => result(true, [rec([null, null])])), { export: true });
  const f = await startRun(failed.spec, failed.deps).done;
  assert.equal(f.export.kind, "failed");
  assert.equal(f.status, "pass");
  assert.match((f.export as { message: string }).message, /nothing to export/);
});

test("run_two_concurrent_isolated", async () => {
  const seen: AgentOptions[] = [];
  const createAgent = agentWith((opts) => {
    seen.push(opts);
    return new Promise((resolve, reject) => {
      if (opts.signal!.aborted) reject(new AbortedError());
      opts.signal!.addEventListener("abort", () => reject(new AbortedError()));
      if (seen.length === 2) setImmediate(() => resolve(result(true)));
    });
  });
  const a = setup(createAgent);
  const b = { ...setup(createAgent, { session: "s-2" }) };
  b.deps.runsDir = a.deps.runsDir;
  const h1 = startRun(a.spec, a.deps);
  const h2 = startRun(b.spec, b.deps);
  assert.notEqual(h1.workdir, h2.workdir);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.map((o) => o.pw.session), ["s-1", "s-2"]);
  assert.notEqual(seen[0].signal, seen[1].signal);
  h1.control.stop();
  assert.equal((await h1.done).status, "stop");
  assert.equal(seen[1].signal!.aborted, false);
  assert.equal((await h2.done).status, "pass");
});

test("run_makerundir_failure_settles", async () => {
  const tmp = tmpDir();
  const file = path.join(tmp, "not-a-dir");
  fs.writeFileSync(file, "x");
  const { spec, deps } = setup(agentWith(async () => result(true)));
  const h = startRun(spec, { ...deps, runsDir: file });
  const ends: RunEvent[] = [];
  h.events.subscribe((e) => { if (e.type === "run:end") ends.push(e); });
  assert.equal(h.id, "");
  assert.equal(h.workdir, "");
  const o = await h.done;
  assert.equal(o.status, "fail");
  assert.equal(o.exitCode, 1);
  assert.equal(o.historyPath, null);
  assert.ok(o.error);
  assert.equal(ends.length, 1);
});

test("run_writes_events_jsonl", async () => {
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()], 0.5); }));
  const h = startRun(spec, deps);
  const seen: RunEvent[] = [];
  h.events.subscribe((e) => seen.push(e));
  await h.done;
  const lines = fs.readFileSync(path.join(h.workdir, "events.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, JSON.parse(JSON.stringify(seen)));
  assert.equal(lines[lines.length - 1].type, "run:end");
});

test("run_failing_sink_keeps_outcome", async () => {
  const body = async (opts: AgentOptions) => { step(opts, rec()); return result(true, [rec()], 0.5); };
  const warnings: string[] = [];
  const bad = setup((opts) => {
    fs.mkdirSync(path.join(opts.workdir, "events.jsonl"));
    return agentWith(body)(opts);
  });
  bad.deps.onWarning = (m) => warnings.push(m);
  const good = setup(agentWith(body));
  const { historyPath: _a, ...o1 } = await startRun(bad.spec, bad.deps).done;
  const { historyPath: _b, ...o2 } = await startRun(good.spec, good.deps).done;
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith("could not write "));
  assert.ok(warnings[0].includes("events.jsonl"));
  assert.deepEqual(o1, o2);
});

const NET = { id: "0001", method: "GET", url: "http://h/", status: 200, statusText: "OK", type: "fetch", durationMs: 1 };
const stepKeys = (h: { history: Record<string, unknown>[] }) => h.history[0];

test("history_json_network_keys", async () => {
  const r = { ...rec(), network: [NET], networkErrors: ["requests: boom"] };
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, r); return result(true, [r]); }));
  const h = startRun(spec, deps);
  await h.done;
  const s = stepKeys(readHistory(h.workdir));
  assert.deepEqual(Object.keys(s).slice(-3), ["results", "network", "network_errors"]);
  assert.deepEqual(s.network, [NET]);
  assert.deepEqual(s.network_errors, ["requests: boom"]);
});

test("history_json_network_empty_no_errors", async () => {
  const r = { ...rec(), network: [] };
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, r); return result(true, [r]); }));
  const h = startRun(spec, deps);
  await h.done;
  const s = stepKeys(readHistory(h.workdir));
  assert.deepEqual(s.network, []);
  assert.equal("network_errors" in s, false);
});

test("history_json_no_network_keys", async () => {
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()]); }));
  const h = startRun(spec, deps);
  await h.done;
  const s = stepKeys(readHistory(h.workdir));
  assert.equal("network" in s, false);
  assert.equal("network_errors" in s, false);
});

test("start_run_passes_network", async () => {
  const seen: (boolean | undefined)[] = [];
  const mk = () => agentWith(async (opts) => { seen.push(opts.network); return result(true); });
  await startRun(...(({ spec, deps }) => [spec, deps] as const)(setup(mk(), { network: false }))).done;
  await startRun(...(({ spec, deps }) => [spec, deps] as const)(setup(mk()))).done;
  assert.deepEqual(seen, [false, true]);
});

test("history_json_writes_request_origins_only_when_used", async () => {
  const mk = (origins: (string | null)[]) => ({
    ...rec(), results: ["ok 200"], codes: ["request GET /a"], requestOrigins: origins,
  });
  const run = async (r: StepRecord) => {
    const { spec, deps } = setup(agentWith(async (opts) => { step(opts, r); return result(true, [r]); }));
    const h = startRun(spec, deps);
    await h.done;
    return stepKeys(readHistory(h.workdir));
  };
  assert.deepEqual((await run(mk(["https://shop.example.com"]))).request_origins, ["https://shop.example.com"]);
  assert.equal("request_origins" in (await run(mk([null]))), false);
});

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("run_gives_the_agent_a_twofa_provider_built_from_the_env_secret", async () => {
  let code = "";
  const { spec, deps } = setup(agentWith(async (opts) => {
    code = await opts.twofa!.totp();
    return result(true);
  }));
  deps.env = { DUCKWRIGHT_TOTP_SECRET: RFC_SECRET };
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "pass");
  assert.match(code, /^\d{6}$/);
});

test("run_without_an_env_secret_has_no_secret_and_no_human_by_default", async () => {
  let message = "";
  const { spec, deps } = setup(agentWith(async (opts) => {
    try { await opts.twofa!.totp(); } catch (e) { message = (e as Error).message; }
    return result(true);
  }));
  deps.env = {};
  await startRun(spec, deps).done;
  assert.equal(message, "no way to ask for a code (stdin is not a terminal)");
});

test("run_humanfor_gets_the_run_signal_and_events_and_the_timeout_comes_from_args", async () => {
  const seen: unknown[] = [];
  const human: Human = {
    code: (_k, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new AbortedError()), { once: true })),
    approve: async () => {},
  };
  let message = "";
  const { spec, deps } = setup(agentWith(async (opts) => {
    try { await opts.twofa!.code("sms"); } catch (e) { message = (e as Error).message; }
    return result(true);
  }), { twofaTimeout: 0.05 });
  deps.env = {};
  deps.humanFor = (ctx) => { seen.push(ctx.signal instanceof AbortSignal, ctx.events instanceof RunEvents); return human; };
  const h = startRun(spec, deps);
  await h.done;
  assert.deepEqual(seen, [true, true]);
  assert.equal(message, "timed out waiting for the 2FA code");
  const types = fs.readFileSync(path.join(h.workdir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
  assert.ok(types.includes("twofa:wait") && types.includes("twofa:done"));
});

test("run_with_an_invalid_env_secret_fails_the_run", async () => {
  const { spec, deps } = setup(agentWith(async () => result(true)));
  deps.env = { DUCKWRIGHT_TOTP_SECRET: "!!" };
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "fail");
  assert.match(o.error ?? "", /not a valid TOTP secret/);
});
