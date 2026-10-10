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
import { Brain } from "../../src/brain.ts";
import type { JevRecord } from "../../src/brain.ts";
import { HybridBrain, JevAuthError, JevClient } from "../../src/jev.ts";
import { PROMPTS, historyJson, startRun } from "../../src/runs/run.ts";
import type { AgentLike, RunDeps, RunSpec } from "../../src/runs/run.ts";
import { tmpDir } from "../helpers.ts";

const GOTO = "await page.goto('https://example.com');";
const EXPECT = "await expect(page).toHaveURL(\"https://example.com/\");";

function args(over: Partial<RunArgs> = {}): RunArgs {
  return {
    task: "task", file: null, maxSteps: 5, model: "m", headed: false, skill: PROMPTS.defaultSkill,
    session: "s-1", state: null, env: null, allowFileAccess: false, snapshot: "full", print: false, maxParallel: null, plan: null, network: true, video: false, screenshot: false, twofaTimeout: 300, web: false, port: null, jev: false, jevThreshold: 0.8, debug: false, ...over,
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

function setup(createAgent: RunDeps["createAgent"], over: Partial<RunArgs> = {}, signal = new AbortController().signal, env?: Record<string, string | undefined>) {
  const tmp = tmpDir();
  const spec: RunSpec = { task: "task", taskFile: null, args: args(over) };
  const deps: RunDeps = { prompts: PROMPTS, signal, createAgent, runsDir: path.join(tmp, "runs"), ...(env ? { env } : {}) };
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
  assert.equal(o.export.kind, "written");
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
  const written = setup(agentWith(async () => result(true, [rec()])), {});
  const w = await startRun(written.spec, written.deps).done;
  assert.equal(w.export.kind, "written");
  assert.ok(fs.statSync((w.export as { path: string }).path).isFile());

  const skipped = setup(agentWith(async () => result(false, [rec()])), {});
  assert.deepEqual((await startRun(skipped.spec, skipped.deps).done).export, { kind: "skipped" });

  const failed = setup(agentWith(async () => result(true, [rec([null, null])])), {});
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
  const { historyPath: _a, export: _x, ...o1 } = await startRun(bad.spec, bad.deps).done;
  const { historyPath: _b, export: _y, ...o2 } = await startRun(good.spec, good.deps).done;
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
  assert.deepEqual(Object.keys(s).slice(-6), ["results", "cost_usd", "source", "jev", "network", "network_errors"]);
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

test("start_run_passes_evidence_options", async () => {
  let seen: AgentOptions | null = null;
  const { spec, deps } = setup(agentWith(async (opts) => { seen = opts; return result(true); }), { video: true, screenshot: true });
  await startRun(spec, deps).done;
  assert.ok(seen !== null);
  const o = seen as AgentOptions;
  assert.equal(o.video === true && o.screenshot === true, true);
});

test("history_json_evidence_keys", () => {
  const h = historyJson("t", true, "a", 2, 0, [
    { ...rec(), screenshot: "screenshots/step-001.png" },
    { ...rec(), step: 2, screenshotError: "boom" },
  ], null, "video.webm");
  assert.equal(h.video, "video.webm");
  assert.equal(h.history[0].screenshot, "screenshots/step-001.png");
  assert.equal(h.history[1].screenshot_error, "boom");
  assert.equal("screenshot" in h.history[1], false);
});

test("history_json_no_evidence_keys", () => {
  const h = historyJson("t", true, "a", 1, 0, [rec()], null, null);
  const s = JSON.stringify(h);
  assert.equal(s.includes("video") || s.includes("screenshot"), false);
});

const EV = { video: "video.webm", warnings: ["screenshot failed at step 1: boom"] };

test("run_pass_carries_evidence", async () => {
  const { spec, deps } = setup((_o) => {
    const agent: AgentLike = { costUsd: 0, evidence: EV, run: async () => result(true) };
    return agent;
  });
  const h = startRun(spec, deps);
  const o = await h.done;
  assert.equal(o.status, "pass");
  assert.equal(o.video, "video.webm");
  assert.ok(o.warnings.includes(EV.warnings[0]));
  assert.equal(readHistory(h.workdir).video, "video.webm");
});

test("run_fail_carries_evidence", async () => {
  const { spec, deps } = setup((_o) => ({ costUsd: 0, evidence: EV, run: async () => result(false) }));
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "fail");
  assert.equal(o.video, "video.webm");
  assert.ok(o.warnings.includes(EV.warnings[0]));
});

test("run_interrupt_keeps_evidence", async () => {
  const { spec, deps } = setup((_o) => ({ costUsd: 0, evidence: EV, run: async () => { throw new AbortedError(); } }));
  const h = startRun(spec, deps);
  const o = await h.done;
  assert.equal(o.status, "stop");
  assert.equal(o.exitCode, 130);
  assert.equal(o.video, "video.webm");
  assert.ok(o.warnings.includes(EV.warnings[0]));
  assert.equal(readHistory(h.workdir).video, "video.webm");
});

test("run_without_evidence_has_no_video_key", async () => {
  const { spec, deps } = setup(agentWith(async () => result(true)));
  const o = await startRun(spec, deps).done;
  assert.equal("video" in o, false);
});

function inEnvDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "environments"));
  fs.writeFileSync(path.join(dir, "environments", "staging.md"), "Base: https://s\n");
  const prev = process.cwd();
  process.chdir(dir);
  return body(dir).finally(() => process.chdir(prev));
}

test("run_passes_environment_text_to_agent", async () => {
  await inEnvDir(async () => {
    const seen: (string | null | undefined)[] = [];
    const create = agentWith(async (opts) => { seen.push(opts.environment); return result(true, [rec()]); });
    const s = setup(create, { env: "staging" });
    await startRun(s.spec, s.deps).done;
    const n = setup(create, { env: null });
    await startRun(n.spec, n.deps).done;
    assert.equal(seen[0], "Base: https://s");
    assert.equal(seen[1], null);
  });
});

test("history_json_env_present_on_success_and_failure", async () => {
  await inEnvDir(async (dir) => {
    const abs = path.join(fs.realpathSync(dir), "environments", "staging.md");
    const ok = setup(agentWith(async () => result(true, [rec()])), { env: "staging" });
    const h = startRun(ok.spec, ok.deps);
    await h.done;
    const raw = fs.readFileSync(path.join(h.workdir, "history.json"), "utf8");
    const data = JSON.parse(raw);
    assert.deepEqual(data.env, { name: "staging", path: abs });
    const keys = Object.keys(data);
    assert.equal(keys[keys.indexOf("task_file") + 1], "env");
    assert.ok(!raw.includes("https://s"));
    const bad = setup(agentWith(async () => { throw new Error("boom"); }), { env: "staging" });
    const h2 = startRun(bad.spec, bad.deps);
    await h2.done;
    assert.deepEqual(readHistory(h2.workdir).env, { name: "staging", path: abs });
  });
});

test("history_json_env_absent_without_env", () => {
  const a = historyJson("t", true, "a", 1, 0, []);
  assert.ok(!("env" in a));
  assert.deepEqual(a, historyJson("t", true, "a", 1, 0, [], null, null, null));
});

test("run_start_env_failure_fails_run", async () => {
  await inEnvDir(async (dir) => {
    let created = 0;
    const s = setup(agentWith(async () => { created++; return result(true); }), { env: "gone" });
    const h = startRun(s.spec, s.deps);
    const o = await h.done;
    assert.equal(o.exitCode, 1);
    assert.equal(o.error, `environment file not found: ${path.join(fs.realpathSync(dir), "environments", "gone.md")}`);
    assert.equal(created, 0);
    assert.ok(!("env" in readHistory(h.workdir)));
  });
});

const JEV_REC: JevRecord = { action: "click", action_confidence: 0.93, target: "e1236", target_confidence: 0.88, routed: "accepted" };

test("startRun builds HybridBrain with --jev", async () => {
  let seen: AgentOptions | null = null;
  const a = setup(agentWith(async (opts) => { seen = opts; return result(true); }), { jev: true, jevThreshold: 0.9 }, undefined, { TYPESAFE_API_KEY: " k " });
  await startRun(a.spec, a.deps).done;
  const brain = (seen as unknown as AgentOptions).brain as unknown as HybridBrain;
  assert.ok(brain instanceof HybridBrain);
  assert.equal(brain.minConfidence, 0.9);
  assert.equal((brain.jev as JevClient).apiKey, "k");
  assert.ok(brain.claude instanceof Brain);

  let seen2: AgentOptions | null = null;
  const b = setup(agentWith(async (opts) => { seen2 = opts; return result(true); }), { jev: false });
  await startRun(b.spec, b.deps).done;
  assert.ok((seen2 as unknown as AgentOptions).brain instanceof Brain);
});

test("history json jev fields, non-jev run", () => {
  const h = historyJson("t", true, "a", 1, 0, [rec()]);
  assert.deepEqual(Object.keys(h.history[0]).slice(-4), ["results", "cost_usd", "source", "jev"]);
  assert.equal(h.history[0].cost_usd, 0);
  assert.equal(h.history[0].source, "claude");
  assert.equal(h.history[0].jev, null);
  const keys = Object.keys(h);
  assert.deepEqual(keys.slice(keys.indexOf("cost_usd"), keys.indexOf("cost_usd") + 3), ["cost_usd", "jev_steps", "claude_steps"]);
  assert.equal(h.jev_steps, 0);
  assert.equal(h.claude_steps, 1);
});

test("history json jev fields, jev run", () => {
  const d = (source: "jev" | "claude", jev: JevRecord | null) =>
    ({ ...rec().decision, source, jev });
  const h = historyJson("t", true, "a", 3, 0.5, [
    { ...rec(), decision: d("jev", JEV_REC), costUsd: 0.0000012 },
    { ...rec(), step: 2, decision: d("claude", null), costUsd: 0.5 },
    { ...rec(), step: 3, decision: d("claude", { ...JEV_REC, action: null, routed: "error: jev http 500" }), costUsd: 0 },
  ]);
  assert.equal(h.jev_steps, 1);
  assert.equal(h.claude_steps, 2);
  assert.equal(h.history[0].cost_usd, 0.0000012);
  assert.equal(h.history[0].source, "jev");
  assert.deepEqual(h.history[0].jev, JEV_REC);
  assert.equal(h.history[2].jev?.routed, "error: jev http 500");
});

test("jev auth error maps to message", async () => {
  const { spec, deps } = setup(agentWith(async (opts) => { step(opts, rec()); throw new JevAuthError(); }), { jev: true }, undefined, { TYPESAFE_API_KEY: "k" });
  const h = startRun(spec, deps);
  const o = await h.done;
  assert.equal(o.error, "jev error: invalid TYPESAFE_API_KEY");
  assert.equal(o.exitCode, 1);
  assert.equal(readHistory(h.workdir).history.length, 1);
});

test("outcome jevSteps only with --jev", async () => {
  const jr: StepRecord = { ...rec(), decision: { ...rec().decision, source: "jev", jev: JEV_REC } };
  const a = setup(agentWith(async () => result(true, [jr])), { jev: true }, undefined, { TYPESAFE_API_KEY: "k" });
  assert.equal((await startRun(a.spec, a.deps).done).jevSteps, 1);
  const b = setup(agentWith(async () => result(true, [jr])));
  assert.equal("jevSteps" in (await startRun(b.spec, b.deps).done), false);
});

// ---- debug logging ----

const SNAP = '- button "Submit" [ref=e12]\n- link "" [ref=e13] [cursor=pointer]';
const stepInput = (n: number) => ({
  obs: { tabs: "tabs", snapshot: SNAP, truncated: false, lines: 2, chars: 10 },
  ctx: { step: n, task: "T", memory: "M", historyLines: [], nudged: false, previousFailed: false },
});
const CLAUDE_ENV = JSON.stringify({
  total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 6 },
  structured_output: { evaluation_previous_goal: "", memory: "", next_goal: "g", actions: [{ cmd: "snapshot", args: [] }] },
});
const JEV_RESP = JSON.stringify({
  usage: { input_tokens: 100, output_tokens: 20 },
  answers: { action: { choice: "click", confidence: 0.95 }, target: { choice: "e12", confidence: 0.95 } },
});
const debugAgent = agentWith(async (opts) => {
  const brain = opts.brain as unknown as { decide(p: string, g: boolean, s: unknown): Promise<unknown> };
  await brain.decide("prompt", true, stepInput(2));
  await brain.decide("prompt", true, stepInput(1));
  step(opts, rec());
  return result(true, [rec()]);
});

test("debug_on_writes_log_and_console_matches_file", async () => {
  const on = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()]); }), { debug: true });
  const texts: string[] = [];
  on.deps.debugConsole = (t) => texts.push(t);
  const h = startRun(on.spec, on.deps);
  await h.done;
  const file = fs.readFileSync(path.join(h.workdir, "debug.log"), "utf8");
  assert.ok(file.startsWith(`===== [debug ${h.id}] run =====`));
  const blocks = file.trimEnd().split(/\n\n(?======)/);
  assert.ok(blocks[blocks.length - 1].startsWith(`===== [debug ${h.id}] summary =====`));
  assert.equal(texts.join(""), file);

  const quiet = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()]); }), { debug: true });
  const hq = startRun(quiet.spec, quiet.deps);
  await hq.done;
  assert.ok(fs.existsSync(path.join(hq.workdir, "debug.log")));

  const off = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()]); }));
  const ho = startRun(off.spec, off.deps);
  await ho.done;
  assert.equal(fs.existsSync(path.join(ho.workdir, "debug.log")), false);
  assert.equal(
    fs.readFileSync(path.join(ho.workdir, "history.json"), "utf8"),
    fs.readFileSync(path.join(h.workdir, "history.json"), "utf8"),
  );
});

test("debug_unwritable_log_warns_once_and_keeps_outcome", async () => {
  const tmp = tmpDir();
  const warnings: string[] = [];
  const runsDir = path.join(tmp, "runs");
  const deps: RunDeps = {
    prompts: PROMPTS, signal: new AbortController().signal, runsDir, onWarning: (m) => warnings.push(m),
    createAgent: agentWith(async (opts) => {
      // The folder exists by now; make debug.log unwritable before the log is first used.
      step(opts, rec());
      return result(true, [rec()]);
    }),
  };
  // Pre-create debug.log as a directory by hooking the first run:start (the log is created before it).
  const spec: RunSpec = { task: "task", taskFile: null, args: args({ debug: true }) };
  const baseline = setup(agentWith(async (opts) => { step(opts, rec()); return result(true, [rec()]); }));
  const expected = await startRun(baseline.spec, baseline.deps).done;
  const h = startRun(spec, deps);
  fs.mkdirSync(path.join(h.workdir, "debug.log"), { recursive: true });
  const o = await h.done;
  assert.equal(o.status, expected.status);
  assert.equal(o.exitCode, expected.exitCode);
  assert.equal(warnings.filter((m) => m.includes("debug log: cannot write")).length, 1);
});

test("debug_jev_wiring_logs_blocks_and_redacts_key", async () => {
  const seen: string[] = [];
  const { spec, deps } = setup(debugAgent, { jev: true, debug: true }, undefined, { TYPESAFE_API_KEY: "sk-test-key" });
  const texts: string[] = [];
  deps.debugConsole = (t) => texts.push(t);
  deps.runner = async () => ({ code: 0, stdout: CLAUDE_ENV, stderr: "" });
  deps.jevTransport = async (_u, init) => {
    seen.push(String((init.headers as Record<string, string>).Authorization));
    return { status: 200, text: async () => JEV_RESP };
  };
  const h = startRun(spec, deps);
  await h.done;
  const file = fs.readFileSync(path.join(h.workdir, "debug.log"), "utf8");
  assert.deepEqual(seen, ["Bearer sk-test-key"]);
  assert.ok(file.includes("jev request"));
  assert.ok(file.includes("outcome: accepted"));
  assert.ok(file.includes("outcome: skipped"));
  assert.ok(/claude/.test(file));
  assert.ok(!file.includes("sk-test-key"));
  assert.ok(!texts.join("").includes("sk-test-key"));
});

test("debug_off_still_uses_injected_seams", async () => {
  let runnerCalls = 0;
  let jevCalls = 0;
  const { spec, deps } = setup(debugAgent, { jev: true }, undefined, { TYPESAFE_API_KEY: "k" });
  deps.runner = async () => { runnerCalls++; return { code: 0, stdout: CLAUDE_ENV, stderr: "" }; };
  deps.jevTransport = async () => { jevCalls++; return { status: 200, text: async () => JEV_RESP }; };
  const h = startRun(spec, deps);
  await h.done;
  assert.equal(runnerCalls, 1);
  assert.equal(jevCalls, 1);
  assert.equal(fs.existsSync(path.join(h.workdir, "debug.log")), false);
});

test("debug_without_jev_never_calls_jev_transport", async () => {
  let jevCalls = 0;
  const { spec, deps } = setup(debugAgent, { debug: true });
  deps.runner = async () => ({ code: 0, stdout: CLAUDE_ENV, stderr: "" });
  deps.jevTransport = async () => { jevCalls++; return { status: 200, text: async () => JEV_RESP }; };
  await startRun(spec, deps).done;
  assert.equal(jevCalls, 0);
});
