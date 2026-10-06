import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { Brain, BrainError } from "../src/brain.ts";
import type { Action } from "../src/brain.ts";
import { PROMPTS, historyJson, main, version } from "../src/cli.ts";
import type { AgentLike, CliDeps, TuiHandle, TuiModule } from "../src/cli.ts";
import type { ManagerEvent, ManagerLike } from "../src/runs/manager.ts";
import type { PastRun } from "../src/runs/past.ts";
import type { AgentOptions, RunResult } from "../src/loop.ts";
import { AbortedError } from "../src/proc.ts";
import type { StepRecord } from "../src/prompt.ts";
import { PlaywrightError } from "../src/pw.ts";
import { tmpDir } from "./helpers.ts";

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

interface Env {
  tmp: string;
  argv: string[];
  out: string[];
  err: string[];
  deps(over?: Partial<CliDeps>): Partial<CliDeps>;
}

function never(): AgentLike {
  throw new Error("should not run");
}

function env(): Env {
  const tmp = tmpDir();
  process.chdir(tmp);
  const skill = path.join(tmp, "SKILL.md");
  fs.writeFileSync(skill, "x");
  const out: string[] = [];
  const err: string[] = [];
  return {
    tmp, out, err,
    argv: ["task", "--skill", skill],
    deps: (over = {}) => ({
      which: (n) => "/usr/bin/" + n,
      createAgent: never,
      stdout: (l) => out.push(...l.split("\n")),
      stderr: (l) => err.push(...l.split("\n")),
      ...over,
    }),
  };
}

function runDirs(tmp: string): string[] {
  const root = path.join(tmp, "runs");
  return fs.existsSync(root) ? fs.readdirSync(root).sort().map((n) => path.join(root, n)) : [];
}

function histories(tmp: string): any[] {
  return runDirs(tmp).filter((d) => fs.existsSync(path.join(d, "history.json")))
    .map((d) => JSON.parse(fs.readFileSync(path.join(d, "history.json"), "utf8")));
}

function history(tmp: string): any {
  const all = histories(tmp);
  assert.equal(all.length, 1);
  return all[0];
}

function result(success: boolean, history: StepRecord[] = [], cost = 0): RunResult {
  return { success, answer: "a", steps: 1, costUsd: cost, history };
}

/** An agent that calls `run` with its options; `run` may set agent.costUsd. */
function agentWith(run: (opts: AgentOptions, agent: AgentLike) => Promise<RunResult>) {
  return (opts: AgentOptions): AgentLike => {
    const agent: AgentLike = { costUsd: 0, run: () => run(opts, agent) };
    return agent;
  };
}

const rec = (actions: Action[], results: string[], codes: (string | null)[] = []): StepRecord => ({
  step: 1, decision: { evaluationPreviousGoal: "", memory: "", nextGoal: "", actions }, results, codes,
});

test("oserror_writes_history", async () => {
  const e = env();
  const boom = Object.assign(new Error("claude vanished"), { name: "OSError" });
  assert.equal(await main(e.argv, e.deps({ createAgent: agentWith(async () => { throw boom; }) })), 1);
  const data = history(e.tmp);
  assert.equal(data.success, false);
  assert.equal(data.answer, "error: OSError: claude vanished");
  assert.ok(e.err.join("\n").includes("OSError"));
});

test("playwright_error_history_shape", async () => {
  const e = env();
  const r: StepRecord = {
    step: 1,
    decision: { evaluationPreviousGoal: "ev", memory: "mem", nextGoal: "goal", actions: [{ cmd: "click", args: ["e1"] }] },
    results: ["ok"],
    codes: ["await page.getByRole('button', { name: 'Go' }).click();"],
  };
  const createAgent = agentWith(async (opts) => {
    opts.events!.emit({ type: "step:end", record: r, cost: 0, durationMs: 0 });
    throw new PlaywrightError("snapshot died");
  });
  assert.equal(await main(e.argv, e.deps({ createAgent })), 1);
  assert.deepEqual(history(e.tmp), {
    task: "task",
    task_file: null,
    success: false,
    answer: "playwright error: snapshot died",
    steps: 1,
    cost_usd: 0,
    history: [{
      step: 1,
      evaluation_previous_goal: "ev",
      memory: "mem",
      next_goal: "goal",
      actions: [{ cmd: "click", args: ["e1"], code: "await page.getByRole('button', { name: 'Go' }).click();" }],
      results: ["ok"],
    }],
  });
  assert.ok(e.out.some((l) => l.startsWith("step 1 | ev | goal | click e1 → ok")));
});

test("history_json_defaults_for_records_without_codes", () => {
  const step = historyJson("t", false, "a", 1, 0, [rec([{ cmd: "click", args: ["e1"] }], ["brain error: x"])]).history[0];
  assert.deepEqual(step.actions, [{ cmd: "click", args: ["e1"], code: null }]);
});

test("keyboard_interrupt_writes_history", async () => {
  const e = env();
  assert.equal(await main(e.argv, e.deps({ createAgent: agentWith(async () => { throw new AbortedError(); }) })), 130);
  assert.equal(history(e.tmp).success, false);
});

test("abort writes interrupted history and exits 130", async () => {
  const e = env();
  const ac = new AbortController();
  const createAgent = agentWith(async (opts, agent) => {
    // The agent gets a per-run signal that follows the process one.
    assert.equal(opts.signal!.aborted, false);
    agent.costUsd = 0.02;
    ac.abort();
    throw new AbortedError();
  });
  assert.equal(await main(e.argv, e.deps({ signal: ac.signal, createAgent })), 130);
  const h = history(e.tmp);
  assert.equal(h.answer, "interrupted");
  assert.equal(h.cost_usd, 0.02);
  assert.deepEqual(e.err, ["interrupted"]);
});

test("spawn failure is reported as error and exits 1", async () => {
  const e = env();
  const spawnErr = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  assert.equal(await main(e.argv, e.deps({ createAgent: agentWith(async () => { throw spawnErr; }) })), 1);
  assert.equal(history(e.tmp).answer, "error: Error: spawn claude ENOENT");
});

test("failure_history_records_running_cost", async () => {
  const e = env();
  const createAgent = agentWith(async (_o, agent) => {
    agent.costUsd = 0.42;
    throw new PlaywrightError("snapshot died");
  });
  assert.equal(await main(e.argv, e.deps({ createAgent })), 1);
  assert.equal(history(e.tmp).cost_usd, 0.42);
});

test("missing_system_md_exits_2", async () => {
  const e = env();
  const prompts = { ...PROMPTS, system: path.join(e.tmp, "nope", "system.md") };
  assert.equal(await main(e.argv, e.deps({ prompts })), 2);
  assert.ok(e.err.join("\n").includes("system prompt not found"));
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("default_prompts_live_in_package", () => {
  const root = path.resolve(import.meta.dirname, "..");
  assert.equal(PROMPTS.system, path.join(root, "prompts", "system.md"));
  assert.equal(PROMPTS.defaultSkill, path.join(root, "prompts", "playwright-cli.md"));
  for (const p of Object.values(PROMPTS)) assert.ok(fs.statSync(p).isFile(), p);
});

test("default_prompts_found_from_any_cwd", async () => {
  const e = env();
  assert.equal(await main(["task"], e.deps({ createAgent: agentWith(async () => result(true)) })), 0);
});

test("relative_skill_resolves_against_cwd", async () => {
  const e = env();
  fs.writeFileSync(path.join(e.tmp, "my-skill.md"), "x");
  const ok = agentWith(async () => result(true));
  assert.equal(await main(["t", "--skill", "my-skill.md"], e.deps({ createAgent: ok })), 0);
  assert.equal(await main(["t", "--skill", "nope.md"], e.deps({ createAgent: ok })), 2);
  assert.ok(e.err.join("\n").includes("skill not found"));
});

test("agent_skill_omits_find_and_eval", () => {
  assert.equal(/\b(find|eval)\b/.test(fs.readFileSync(PROMPTS.defaultSkill, "utf8")), false);
});

test("run_dirs_do_not_collide", async () => {
  const e = env();
  const ok = agentWith(async () => result(true));
  assert.equal(await main(e.argv, e.deps({ createAgent: ok })), 0);
  assert.equal(await main(e.argv, e.deps({ createAgent: ok })), 0);
  assert.equal(histories(e.tmp).length, 2);
});

test("allow_file_access_help_warns", async () => {
  const e = env();
  assert.equal(await main(["--help"], e.deps()), 0);
  assert.ok(e.out.join(" ").split(/\s+/).join(" ").includes("trusted"));
});

test("missing_state_file_exits_2", async () => {
  const e = env();
  assert.equal(await main([...e.argv, "--state", "nope.json"], e.deps()), 2);
  assert.ok(e.err.join("\n").includes("state file not found"));
});

test("state_passed_to_agent_as_absolute_path", async () => {
  const e = env();
  fs.writeFileSync(path.join(e.tmp, "auth.json"), "{}");
  let state: string | null | undefined;
  const createAgent = agentWith(async (opts) => {
    state = opts.state;
    return result(true);
  });
  assert.equal(await main([...e.argv, "--state", "auth.json"], e.deps({ createAgent })), 0);
  assert.equal(state, path.join(e.tmp, "auth.json"));
});

test("system_prompt_says_browser_is_open", () => {
  const text = fs.readFileSync(PROMPTS.system, "utf8");
  assert.ok(text.includes("browser is already open"));
  assert.ok(text.includes("no `open` command"));
});

test("version_flag", async () => {
  const e = env();
  assert.equal(await main(["--version"], e.deps()), 0);
  assert.deepEqual(e.out, [`duckwright ${version()}`]);
  assert.match(version(), /^\d+\.\d+\.\d+/);
});

test("system_prompt_documents_expect", () => {
  const text = fs.readFileSync(PROMPTS.system, "utf8");
  assert.ok(text.includes("screenshot, expect, expect-request, request, done"));
  assert.ok(text.includes('{"cmd": "request", "args": ["POST", "/api/todos", "{\\"title\\":\\"x\\"}", "201"]}'));
  assert.ok(text.includes("Safe to batch before it: fill, type, select, check, uncheck, hover, expect, request."));
  assert.ok(text.includes('{"cmd": "expect-request", "args": ["POST", "/api/login", "201"]}'));
  assert.ok(text.includes('{"cmd": "expect", "args": ["text", "e15", '));
  for (const check of ["visible", "value", "checked", "unchecked", "url"]) assert.ok(text.includes(`"${check}"`));
});

const GOTO = "await page.goto('https://example.com');";
const EXPECT = "await expect(page).toHaveURL(\"https://example.com/\");";

function writeRun(tmp: string, success = true, code: string | null = GOTO): string {
  const runDir = path.join(tmp, "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "history.json"), JSON.stringify({
    task: "t", success, answer: "", steps: 1, cost_usd: 0,
    history: [{ step: 1, actions: [{ cmd: "goto", args: ["u"], code }], results: ["ok"] }],
  }));
  return runDir;
}

test("export_subcommand_writes_spec", async () => {
  const e = env();
  const runDir = writeRun(e.tmp);
  assert.equal(await main(["export", runDir], e.deps()), 0);
  const spec = path.join(runDir, "duckwright.spec.ts");
  assert.ok(fs.statSync(spec).isFile());
  assert.ok(e.out.includes(`Test: ${spec}`));
});

test("export_subcommand_output_flag", async () => {
  const e = env();
  const runDir = writeRun(e.tmp);
  const out = path.join(e.tmp, "e2e", "greet.spec.ts");
  assert.equal(await main(["export", runDir, "-o", out], e.deps()), 0);
  assert.ok(fs.statSync(out).isFile());
  assert.equal(fs.existsSync(path.join(runDir, "duckwright.spec.ts")), false);
});

test("export_skips_preflight", async () => {
  const e = env();
  assert.equal(await main(["export", writeRun(e.tmp)], e.deps({ which: () => null })), 0);
});

test("export_failed_run_exits_1", async () => {
  const e = env();
  const runDir = writeRun(e.tmp, false);
  assert.equal(await main(["export", runDir], e.deps()), 1);
  assert.ok(e.err.join("\n").includes("did not succeed"));
  assert.equal(fs.existsSync(path.join(runDir, "duckwright.spec.ts")), false);
});

test("export_bad_path_exits_2", async () => {
  const e = env();
  assert.equal(await main(["export", path.join(e.tmp, "nope")], e.deps()), 2);
  assert.equal(e.err.length, 1);
});

test("export_warnings_go_to_stderr", async () => {
  const e = env();
  assert.equal(await main(["export", writeRun(e.tmp)], e.deps()), 0);
  assert.ok(e.err.join("\n").includes("warning: no assertions recorded"));
});

function writeApiRun(tmp: string, withCall = true): string {
  const runDir = path.join(tmp, "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  const network = withCall
    ? [{ id: "0001", method: "GET", url: "http://a/api/x", status: 200, statusText: "OK", type: "fetch", durationMs: 1 }]
    : [];
  fs.writeFileSync(path.join(runDir, "history.json"), JSON.stringify({
    task: "t", success: true, answer: "", steps: 1, cost_usd: 0,
    history: [{ step: 1, actions: [{ cmd: "goto", args: ["u"], code: GOTO }], results: ["ok"], network }],
  }));
  return runDir;
}

test("export_api_subcommand_writes_api_spec", async () => {
  const e = env();
  const runDir = writeApiRun(e.tmp);
  assert.equal(await main(["export", "--api", runDir], e.deps()), 0);
  const spec = path.join(runDir, "duckwright.api.spec.ts");
  assert.ok(fs.statSync(spec).isFile());
  assert.ok(e.out.includes(`Test: ${spec}`));
  assert.equal(fs.existsSync(path.join(runDir, "duckwright.spec.ts")), false);
});

test("export_api_without_calls_exits_1", async () => {
  const e = env();
  const runDir = writeApiRun(e.tmp, false);
  assert.equal(await main(["export", "--api", runDir], e.deps()), 1);
  assert.ok(e.err.join("\n").includes("no API calls were captured"));
  assert.equal(fs.existsSync(path.join(runDir, "duckwright.api.spec.ts")), false);
});

test("export_usage_error_exits_2", async () => {
  const e = env();
  assert.equal(await main(["export"], e.deps()), 2);
  assert.deepEqual(e.err, [
    "usage: duckwright export [-h] [--api] [-o FILE] run",
    "duckwright export: error: the following arguments are required: run",
  ]);
});

function fakeRun(success = true, actions?: Action[], codes?: (string | null)[]) {
  const acts = actions ?? [{ cmd: "goto", args: ["u"] }, { cmd: "expect", args: ["url", "u"] }];
  const r = rec(acts, acts.map(() => "ok"), codes ?? [GOTO, EXPECT]);
  return agentWith(async (opts) => {
    opts.events!.emit({ type: "step:end", record: r, cost: 0, durationMs: 0 });
    return result(success, [r]);
  });
}

test("run_with_export_writes_spec", async () => {
  const e = env();
  assert.equal(await main([...e.argv, "--export"], e.deps({ createAgent: fakeRun() })), 0);
  const [runDir] = runDirs(e.tmp);
  assert.ok(fs.statSync(path.join(runDir, "history.json")).isFile());
  const spec = path.join(runDir, "duckwright.spec.ts");
  assert.ok(fs.statSync(spec).isFile());
  assert.ok(e.out[e.out.length - 2].startsWith("History: "));
  assert.equal(e.out[e.out.length - 1], `Test: ${path.relative(e.tmp, spec)}`);
});

test("run_without_export_writes_no_spec", async () => {
  const e = env();
  assert.equal(await main(e.argv, e.deps({ createAgent: fakeRun() })), 0);
  assert.equal(fs.existsSync(path.join(runDirs(e.tmp)[0], "duckwright.spec.ts")), false);
});

test("run_export_on_failed_run", async () => {
  const e = env();
  assert.equal(await main([...e.argv, "--export"], e.deps({ createAgent: fakeRun(false) })), 1);
  assert.equal(fs.existsSync(path.join(runDirs(e.tmp)[0], "duckwright.spec.ts")), false);
  assert.ok(e.out.includes("Test: not exported (run did not succeed)"));
});

test("run_export_failure_keeps_exit_0", async () => {
  const e = env();
  const createAgent = fakeRun(true, [{ cmd: "done", args: ["success", "a"] }], [null]);
  assert.equal(await main([...e.argv, "--export"], e.deps({ createAgent })), 0);
  assert.equal(histories(e.tmp).length, 1);
  assert.ok(e.err.join("\n").includes("export failed: nothing to export"));
});

test("run_output_lines", async () => {
  const e = env();
  assert.equal(await main(e.argv, e.deps({ createAgent: agentWith(async () => result(true, [], 0.0213)) })), 0);
  assert.deepEqual(e.out.slice(0, 3), ["Result: success", "Answer: a", "Steps: 1  Cost: $0.0213"]);
  assert.match(e.out[3], /^History: runs\/\d{8}-\d{6}-[a-z]+-[a-z]+\/history\.json$/);
});

function taskFile(tmp: string, text: string, name = "tasks/t.md"): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return name;
}

interface Seen {
  task?: string;
  maxSteps?: number;
  headed?: boolean;
  state?: string | null;
  model?: string;
}

function recordRun(success = true): [Seen, (opts: AgentOptions) => AgentLike] {
  const seen: Seen = {};
  return [seen, agentWith(async (opts) => {
    Object.assign(seen, {
      task: opts.task, maxSteps: opts.maxSteps, headed: opts.headed,
      state: opts.state, model: (opts.brain as Brain).model,
    });
    return result(success);
  })];
}

test("file_runs_body_with_settings", async () => {
  const e = env();
  const f = taskFile(e.tmp, "---\nmax-steps: 7\nheaded: true\nmodel: opus\n---\nOpen a\nthen b\n");
  const [seen, createAgent] = recordRun();
  assert.equal(await main([...e.argv.slice(1), "-f", f], e.deps({ createAgent })), 0);
  assert.deepEqual(seen, { task: "Open a\nthen b", maxSteps: 7, headed: true, state: null, model: "opus" });
  const data = history(e.tmp);
  assert.equal(data.task, "Open a\nthen b");
  assert.equal(data.task_file, "tasks/t.md");
});

test("cli_flag_beats_file", async () => {
  const e = env();
  const f = taskFile(e.tmp, "---\nmax-steps: 7\nexport: true\n---\nGo\n");
  let maxSteps: number | undefined;
  const inner = fakeRun();
  const createAgent = (opts: AgentOptions) => {
    maxSteps = opts.maxSteps;
    return inner(opts);
  };
  assert.equal(await main([...e.argv.slice(1), "-f", f, "--max-steps", "3", "--no-export"], e.deps({ createAgent })), 0);
  assert.equal(maxSteps, 3);
  assert.equal(fs.existsSync(path.join(runDirs(e.tmp)[0], "duckwright.spec.ts")), false);
});

test("file_export_setting_writes_spec", async () => {
  const e = env();
  const f = taskFile(e.tmp, "---\nexport: true\n---\nGo\n");
  assert.equal(await main([...e.argv.slice(1), "-f", f], e.deps({ createAgent: fakeRun() })), 0);
  assert.ok(fs.existsSync(path.join(runDirs(e.tmp)[0], "duckwright.spec.ts")));
});

test("cli_state_relative_to_cwd_with_file", async () => {
  const e = env();
  const f = taskFile(e.tmp, "---\nstate: auth.json\n---\nGo\n");
  fs.writeFileSync(path.join(e.tmp, "tasks", "auth.json"), "{}");
  fs.writeFileSync(path.join(e.tmp, "cli.json"), "{}");
  const [seen, createAgent] = recordRun();
  assert.equal(await main([...e.argv.slice(1), "-f", f], e.deps({ createAgent })), 0);
  assert.equal(seen.state, path.join(e.tmp, "tasks", "auth.json"));
  assert.equal(await main([...e.argv.slice(1), "-f", f, "--state", "cli.json"], e.deps({ createAgent })), 0);
  assert.equal(seen.state, path.join(e.tmp, "cli.json"));
});

test("task_and_file_exits_2", async () => {
  const e = env();
  const f = taskFile(e.tmp, "Go\n");
  assert.equal(await main([...e.argv, "-f", f], e.deps()), 2);
  assert.ok(e.err[0].startsWith("usage: duckwright [-h]"));
  assert.equal(e.err[e.err.length - 1], "duckwright: error: give a task or --file, not both");
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("neither_task_nor_file_exits_2", async () => {
  const e = env();
  assert.equal(await main(e.argv.slice(1), e.deps()), 2);
  assert.ok(e.err.join("\n").includes("error: give a task or --file"));
});

test("file_error_exits_2_without_runs", async () => {
  const e = env();
  const f = taskFile(e.tmp, "---\nmodel:\n---\nGo\n");
  assert.equal(await main([...e.argv.slice(1), "-f", f], e.deps()), 2);
  assert.deepEqual(e.err, ['tasks/t.md:2: "model" has no value']);
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("file_task_file_on_failure_path", async () => {
  const e = env();
  const f = taskFile(e.tmp, "Go\n");
  const createAgent = agentWith(async () => { throw new PlaywrightError("snapshot died"); });
  assert.equal(await main([...e.argv.slice(1), "-f", f], e.deps({ createAgent })), 1);
  const data = history(e.tmp);
  assert.equal(data.task_file, "tasks/t.md");
  assert.equal(data.task, "Go");
});

test("plain_task_has_null_task_file", async () => {
  const e = env();
  const [, createAgent] = recordRun();
  assert.equal(await main(e.argv, e.deps({ createAgent })), 0);
  assert.equal(history(e.tmp).task_file, null);
});

test("task_named_export_still_runs", async () => {
  const e = env();
  const [seen, createAgent] = recordRun();
  assert.equal(await main(["--skill", e.argv[2], "--", "export"], e.deps({ createAgent })), 0);
  assert.equal(seen.task, "export");
});

type Outcome = boolean | Error;

function recordRuns(outcomes: Outcome[]): [[string, number | undefined, boolean | undefined, string][], (o: AgentOptions) => AgentLike] {
  const calls: [string, number | undefined, boolean | undefined, string][] = [];
  const queue = [...outcomes];
  return [calls, agentWith(async (opts) => {
    calls.push([opts.task, opts.maxSteps, opts.headed, (opts.brain as Brain).model]);
    const out = queue.shift()!;
    if (out instanceof Error) throw out;
    return result(out, [], 0.25);
  })];
}

function summary(out: string[]): string[] {
  const i = out.findIndex((l) => l.startsWith("Batch: "));
  return out.slice(i).map((l) => l.replace(/runs\/[^/]+\//, "runs/<id>/"));
}

test("single_file_output_unchanged", async () => {
  const e = env();
  const f = taskFile(e.tmp, "Go\n");
  const [, createAgent] = recordRuns([true]);
  assert.equal(await main([...e.argv.slice(1), "-f", f], e.deps({ createAgent })), 0);
  assert.ok(!e.out.join("\n").includes("[1/1]") && !e.out.join("\n").includes("Batch:"));
  assert.equal(e.out[0], "Result: success");
});

test("single_file_from_folder_is_a_single_run", async () => {
  const e = env();
  taskFile(e.tmp, "Go\n", "tasks/a.md");
  const [, createAgent] = recordRuns([true]);
  assert.equal(await main([...e.argv.slice(1), "-f", "tasks"], e.deps({ createAgent })), 0);
  assert.ok(!e.out.join("\n").includes("Batch:"));
  assert.equal(history(e.tmp).task_file, "tasks/a.md");
});

test("batch_runs_files_in_order_with_own_settings", async () => {
  const e = env();
  const a = taskFile(e.tmp, "---\nmax-steps: 7\nheaded: true\n---\nA\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const [calls, createAgent] = recordRuns([true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps({ createAgent })), 0);
  assert.deepEqual(calls, [["A", 7, true, "sonnet"], ["B", 25, false, "sonnet"]]);
  assert.deepEqual(histories(e.tmp).map((h) => h.task_file).sort(), ["tasks/a.md", "tasks/b.md"]);
});

test("run_dirs_named_after_task_files", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/01-login.md");
  const b = taskFile(e.tmp, "B\n", "tasks/Check Out.txt");
  const [, createAgent] = recordRuns([true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps({ createAgent })), 0);
  assert.deepEqual(runDirs(e.tmp).map((d) => path.basename(d).replace(/^\d{8}-\d{6}-/, "")), ["01-login", "check-out"]);
});

test("command_line_run_dir_gets_random_words", async () => {
  const e = env();
  const [, createAgent] = recordRuns([true]);
  assert.equal(await main(e.argv, e.deps({ createAgent })), 0);
  const [runDir] = runDirs(e.tmp);
  assert.match(path.basename(runDir), /^\d{8}-\d{6}-[a-z]+-[a-z]+$/);
});

test("batch_cli_flag_applies_to_all", async () => {
  const e = env();
  const a = taskFile(e.tmp, "---\nmax-steps: 7\n---\nA\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const [calls, createAgent] = recordRuns([true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, b, "--max-steps", "3", "--model", "opus"], e.deps({ createAgent })), 0);
  assert.deepEqual(calls, [["A", 3, false, "opus"], ["B", 3, false, "opus"]]);
});

test("batch_from_folder", async () => {
  const e = env();
  taskFile(e.tmp, "B\n", "tasks/b.md");
  taskFile(e.tmp, "A\n", "tasks/a.md");
  taskFile(e.tmp, "{}", "tasks/auth.json");
  const [calls, createAgent] = recordRuns([true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", "tasks"], e.deps({ createAgent })), 0);
  assert.deepEqual(calls.map((c) => c[0]), ["A", "B"]);
  assert.deepEqual(histories(e.tmp).map((h) => h.task_file).sort(), ["tasks/a.md", "tasks/b.md"]);
});

test("repeated_file_flag_extends", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const [calls, createAgent] = recordRuns([true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, "-f", b], e.deps({ createAgent })), 0);
  assert.deepEqual(calls.map((c) => c[0]), ["A", "B"]);
});

test("batch_failure_continues_and_exits_1", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const [calls, createAgent] = recordRuns([false, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps({ createAgent })), 1);
  assert.equal(calls.length, 2);
  assert.ok(e.out.includes("[1/2] tasks/a.md"));
  assert.ok(e.out.includes("[2/2] tasks/b.md"));
  assert.deepEqual(summary(e.out), [
    "Batch: 1 passed, 1 failed, 0 not run  Cost: $0.5000",
    "fail  tasks/a.md  $0.2500  runs/<id>/history.json",
    "pass  tasks/b.md  $0.2500  runs/<id>/history.json",
  ]);
});

test("batch_total_includes_cost_spent_before_a_crash", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const createAgent = agentWith(async (opts, agent) => {
    if (opts.task === "A") {
      agent.costUsd = 0.125; // spent before the crash
      throw new PlaywrightError("x");
    }
    return result(true, [], 0.25);
  });
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps({ createAgent })), 1);
  assert.deepEqual(summary(e.out), [
    "Batch: 1 passed, 1 failed, 0 not run  Cost: $0.3750",
    "fail  tasks/a.md  $0.1250  runs/<id>/history.json",
    "pass  tasks/b.md  $0.2500  runs/<id>/history.json",
  ]);
});

test("batch_crash_counts_as_fail", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const [calls, createAgent] = recordRuns([new PlaywrightError("x"), true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps({ createAgent })), 1);
  assert.equal(calls.length, 2);
});

test("batch_all_pass_exits_0", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "B\n", "tasks/b.md");
  const [, createAgent] = recordRuns([true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps({ createAgent })), 0);
  assert.equal(summary(e.out)[0], "Batch: 2 passed, 0 failed, 0 not run  Cost: $0.5000");
});

test("batch_bad_file_runs_nothing", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "---\nmodel:\n---\nGo\n", "tasks/b.md");
  const c = taskFile(e.tmp, "", "tasks/c.md");
  assert.equal(await main([...e.argv.slice(1), "-f", a, b, c], e.deps()), 2);
  assert.deepEqual(e.err, ['tasks/b.md:2: "model" has no value', "tasks/c.md: no task text"]);
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("batch_preflight_failure_runs_nothing", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  const b = taskFile(e.tmp, "---\nstate: nope.json\n---\nGo\n", "tasks/b.md");
  assert.equal(await main([...e.argv.slice(1), "-f", a, b], e.deps()), 2);
  assert.equal(e.err.length, 1);
  assert.ok(e.err[0].startsWith("tasks/b.md: state file not found: "));
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("batch_interrupt_stops_and_summarises", async () => {
  const e = env();
  const files = ["a", "b", "c"].map((n) => taskFile(e.tmp, `${n}\n`, `tasks/${n}.md`));
  const [calls, createAgent] = recordRuns([new AbortedError(), true, true]);
  assert.equal(await main([...e.argv.slice(1), "-f", ...files], e.deps({ createAgent })), 130);
  assert.equal(calls.length, 1);
  assert.equal(history(e.tmp).answer, "interrupted");
  assert.deepEqual(summary(e.out), [
    "Batch: 0 passed, 0 failed, 2 not run  Cost: $0.0000",
    "stop  tasks/a.md  $0.0000  runs/<id>/history.json",
    "skip  tasks/b.md  -  -",
    "skip  tasks/c.md  -  -",
  ]);
});

test("task_after_file_is_read_as_file", async () => {
  const e = env();
  const a = taskFile(e.tmp, "A\n", "tasks/a.md");
  assert.equal(await main([...e.argv.slice(1), "-f", a, "Open the site"], e.deps()), 2);
  assert.deepEqual(e.err, ["Open the site: file not found"]);
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("empty_folder_exits_2", async () => {
  const e = env();
  taskFile(e.tmp, "{}", "tasks/auth.json");
  assert.equal(await main([...e.argv.slice(1), "-f", "tasks"], e.deps()), 2);
  assert.deepEqual(e.err, ["tasks: no task files (.md or .txt)"]);
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("batch_reports_folder_and_file_errors_in_order", async () => {
  const e = env();
  taskFile(e.tmp, "---\nfoo: 1\n---\nGo\n", "bad.md");
  taskFile(e.tmp, "{}", "empty/auth.json");
  taskFile(e.tmp, "{}", "none/auth.json");
  assert.equal(await main([...e.argv.slice(1), "-f", "bad.md", "empty/", "none"], e.deps()), 2);
  assert.deepEqual(e.err, [
    'bad.md:2: unknown setting "foo"',
    "empty/: no task files (.md or .txt)",
    "none: no task files (.md or .txt)",
  ]);
  assert.equal(fs.existsSync(path.join(e.tmp, "runs")), false);
});

test("unstattable_file_is_a_one_line_error", async () => {
  const e = env();
  assert.equal(await main([...e.argv.slice(1), "-f", "a".repeat(300)], e.deps()), 2);
  assert.equal(e.err.length, 1);
  assert.ok(e.err[0].startsWith("a".repeat(300) + ": cannot read: "));
});

test("snapshot_mode_prompts", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const [full, grep, hybrid, system] = [PROMPTS.snapshotFull, PROMPTS.snapshotGrep, PROMPTS.snapshotHybrid, PROMPTS.system].map(read);
  assert.ok(full.includes("## Reading the page") && grep.includes("## Reading the page"));
  assert.ok(hybrid.includes("## Reading the page"));
  assert.ok(hybrid.includes("<page_snapshot>") && hybrid.includes("<page_snapshot_file>"));
  assert.ok(hybrid.includes("Grep") && hybrid.includes("5,000 characters"));
  assert.ok(!system.includes("## Reading the page"));
  assert.ok(grep.includes("Grep") && grep.includes("snapshot.yml"));
  assert.ok(!full.includes("Grep"));
  assert.ok(system.includes("snapshot.yml")); // untrusted section covers tool output
});

interface Captured {
  mode?: string;
  dir?: string | null;
  files?: string[];
  workdir?: string;
}

function capture(): [Captured, (o: AgentOptions) => AgentLike] {
  const seen: Captured = {};
  return [seen, agentWith(async (opts) => {
    const brain = opts.brain as Brain;
    Object.assign(seen, { mode: opts.snapshotMode, dir: brain.snapshotDir, files: [...brain.systemFiles], workdir: opts.workdir });
    return result(true);
  })];
}

test("hybrid_is_default", async () => {
  const e = env();
  const [seen, createAgent] = capture();
  assert.equal(await main(e.argv, e.deps({ createAgent })), 0);
  assert.equal(seen.mode, "hybrid");
  assert.equal(seen.dir, path.join(seen.workdir!, "page"));
  assert.deepEqual(seen.files!.slice(0, 2), [PROMPTS.system, PROMPTS.snapshotHybrid]);
});

for (const [flag, mode, hasDir, md] of [
  ["--snapshot-full", "full", false, "snapshotFull"],
  ["--snapshot-grep", "grep", true, "snapshotGrep"],
  ["--snapshot-hybrid", "hybrid", true, "snapshotHybrid"],
] as const) {
  test(`snapshot_flags ${flag}`, async () => {
    const e = env();
    const [seen, createAgent] = capture();
    assert.equal(await main([...e.argv, flag], e.deps({ createAgent })), 0);
    assert.equal(seen.mode, mode);
    assert.equal(seen.dir, hasDir ? path.join(seen.workdir!, "page") : null);
    assert.deepEqual(seen.files!.slice(0, 2), [PROMPTS.system, PROMPTS[md]]);
  });
}

test("two_snapshot_flags_are_an_error", async () => {
  const e = env();
  assert.equal(await main([...e.argv, "--snapshot-full", "--snapshot-grep"], e.deps()), 2);
  assert.ok(e.err.join("\n").includes("not allowed with argument"));
});

test("snapshot_file_setting_and_cli_override", async () => {
  const e = env();
  fs.writeFileSync(path.join(e.tmp, "t.md"), "---\nsnapshot: full\n---\nDo it\n");
  const [seen, createAgent] = capture();
  const skill = e.argv[2];
  assert.equal(await main(["-f", "t.md", "--skill", skill], e.deps({ createAgent })), 0);
  assert.equal(seen.mode, "full");
  assert.equal(await main(["-f", "t.md", "--skill", skill, "--snapshot-grep"], e.deps({ createAgent })), 0);
  assert.equal(seen.mode, "grep");
});

for (const md of ["snapshotFull", "snapshotGrep", "snapshotHybrid"] as const) {
  test(`missing_mode_prompt_exits_2 ${md}`, async () => {
    const e = env();
    assert.equal(await main(e.argv, e.deps({ prompts: { ...PROMPTS, [md]: path.join(e.tmp, "nope.md") } })), 2);
    assert.ok(e.err.join("\n").includes("system prompt not found"));
  });
}

test("brain error inside a run is not a crash", async () => {
  const e = env();
  const createAgent = agentWith(async () => { throw new BrainError("unexpected"); });
  assert.equal(await main(e.argv, e.deps({ createAgent })), 1);
  assert.equal(history(e.tmp).answer, "error: BrainError: unexpected");
});

test("a failure after Ctrl-C counts as interrupted", async () => {
  const e = env();
  const ac = new AbortController();
  const createAgent = agentWith(async () => {
    ac.abort();
    throw new PlaywrightError("tab-list exited -2");
  });
  assert.equal(await main(e.argv, e.deps({ signal: ac.signal, createAgent })), 130);
  assert.equal(history(e.tmp).answer, "interrupted");
});

test("costs round like Python", async () => {
  const e = env();
  assert.equal(await main(e.argv, e.deps({ createAgent: agentWith(async () => result(true, [], 0.03125)) })), 0);
  assert.equal(e.out[2], "Steps: 1  Cost: $0.0312");
});

interface FakeTui {
  load: () => Promise<TuiModule>;
  loads: number;
  restores: number;
  manager: ManagerLike | null;
}

/** A TUI that adds one task, starts it, and finishes when the run ends (or rejects `done`). */
function fakeTui(rejectWith: Error | null = null): FakeTui {
  const fake: FakeTui = { loads: 0, restores: 0, manager: null, load: null as never };
  fake.load = async () => {
    fake.loads++;
    return {
      startTui({ manager }): TuiHandle {
        fake.manager = manager;
        const id = manager.addTyped("do it");
        const done = new Promise<void>((resolve, reject) => {
          const off = manager.subscribe((e) => {
            if (e.type === "task:updated" && e.task.state === "passed") {
              off();
              // The manager records the outcome a tick after the state flips.
              setImmediate(() => (rejectWith ? reject(rejectWith) : resolve()));
            }
          });
        });
        manager.start(id);
        return { done, restoreTerminal: () => void fake.restores++, quit: () => {} };
      },
    };
  };
  return fake;
}

const tuiAgent = agentWith(async () => result(true, [], 0.5));

test("tui_needs_tty", async () => {
  const e = env();
  const fake = fakeTui();
  const code = await main(["--tui", "--skill", e.argv[2]], e.deps({ isTTY: () => false, loadTui: fake.load }));
  assert.equal(code, 2);
  assert.deepEqual(e.err, ["--tui needs an interactive terminal"]);
  assert.equal(fake.loads, 0);
});

test("tui_rejects_task_and_file", async () => {
  const e = env();
  const fake = fakeTui();
  const over = e.deps({ isTTY: () => true, loadTui: fake.load });
  assert.equal(await main(["--tui", "task"], over), 2);
  assert.ok(e.err.some((l) => l.includes("give tasks inside the TUI, not with --tui")));
  e.err.length = 0;
  assert.equal(await main(["--tui", "-f", "a.md"], over), 2);
  assert.ok(e.err.some((l) => l.includes("give tasks inside the TUI, not with --tui")));
  assert.equal(fake.loads, 0);
});

test("tui_max_parallel_needs_tui", async () => {
  const e = env();
  assert.equal(await main([...e.argv, "--max-parallel", "2"], e.deps()), 2);
  assert.ok(e.err.some((l) => l.includes("--max-parallel needs --tui")));
});

test("tui_preflight_fails_before_load", async () => {
  const e = env();
  const fake = fakeTui();
  const code = await main(["--tui", "--skill", path.join(e.tmp, "missing.md")],
    e.deps({ isTTY: () => true, loadTui: fake.load }));
  assert.equal(code, 2);
  assert.ok(e.err[0].startsWith("playwright-cli skill not found"));
  assert.equal(fake.loads, 0);
});

test("tui_prints_summary_and_exit_code", async () => {
  const e = env();
  const fake = fakeTui();
  const code = await main(["--tui", "--skill", e.argv[2]],
    e.deps({ isTTY: () => true, loadTui: fake.load, createAgent: tuiAgent }));
  assert.equal(code, 0);
  assert.equal(fake.restores, 1);
  assert.ok(e.out[0].startsWith("Batch: 1 passed, 0 failed, 0 stopped"));
  assert.ok(e.out[1].startsWith('pass  "do it"'));
});

test("tui_restores_terminal_when_done_rejects", async () => {
  const e = env();
  const fake = fakeTui(new Error("boom"));
  await assert.rejects(
    main(["--tui", "--skill", e.argv[2]],
      e.deps({ isTTY: () => true, loadTui: fake.load, createAgent: tuiAgent })),
    /boom/,
  );
  assert.equal(fake.restores, 1);
});

test("tui_max_parallel_reaches_manager", async () => {
  const e = env();
  const fake = fakeTui();
  await main(["--tui", "--max-parallel", "1", "--skill", e.argv[2]],
    e.deps({ isTTY: () => true, loadTui: fake.load, createAgent: tuiAgent }));
  const m = fake.manager!;
  const a = m.addTyped("a");
  const b = m.addTyped("b");
  assert.equal(m.start(a).ok, true);
  const second = m.start(b);
  assert.equal(second.ok, false);
  await m.stopAll();
});

/** A TUI that starts one task (if `start`), and closes only when asked to quit, like the real one. */
function quitOnlyTui(start: boolean) {
  const fake = { quits: 0, restores: 0, load: null as never as () => Promise<TuiModule> };
  fake.load = async () => ({
    startTui({ manager }): TuiHandle {
      if (start) manager.start(manager.addTyped("do it"));
      let resolve!: () => void;
      const done = new Promise<void>((r) => { resolve = r; });
      return {
        done,
        restoreTerminal: () => void fake.restores++,
        quit: () => {
          fake.quits++;
          void manager.stopAll().then(resolve);
        },
      };
    },
  });
  return fake;
}

/** An agent that runs until the signal aborts. */
const untilAborted = agentWith((opts) => new Promise((_, reject) => {
  opts.signal!.addEventListener("abort", () => reject(new AbortedError()), { once: true });
}));

test("tui_outside_sigint_quits", { timeout: 5000 }, async () => {
  const e = env();
  const fake = quitOnlyTui(true);
  const ac = new AbortController();
  const p = main(["--tui", "--skill", e.argv[2]],
    e.deps({ isTTY: () => true, loadTui: fake.load, createAgent: untilAborted, signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  assert.equal(await p, 130);
  assert.equal(fake.quits, 1);
  assert.equal(fake.restores, 1);
  assert.equal(e.out[0], "Batch: 0 passed, 0 failed, 1 stopped  Cost: $0.0000");
  assert.ok(e.out[1].startsWith('stop  "do it"'));
});

test("tui_outside_sigint_quits_without_runs", { timeout: 5000 }, async () => {
  const e = env();
  const fake = quitOnlyTui(false);
  const ac = new AbortController();
  const p = main(["--tui", "--skill", e.argv[2]],
    e.deps({ isTTY: () => true, loadTui: fake.load, signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  assert.equal(await p, 130);
  assert.equal(fake.quits, 1);
  assert.deepEqual(e.out, []);
});

// ---- past runs, themes and sink warnings ----

function aPastRun(): PastRun {
  const outcome = {
    exitCode: 0, success: true, answer: "a", steps: 1, costUsd: 0, historyPath: "/runs/x/history.json",
    export: { kind: "off" }, warnings: [], error: null,
  } as unknown as PastRun["outcome"];
  return {
    id: "20260101-000000-old", workdir: "/runs/20260101-000000-old", text: "old task",
    source: { kind: "typed" }, fileSettings: {}, events: [], outcome, startedAt: 0,
  };
}

interface OptsTui { load: () => Promise<TuiModule>; opts: any; manager: ManagerLike | null }
function optsTui(): OptsTui {
  const t: OptsTui = { opts: null, manager: null, load: null as never };
  t.load = async () => ({
    startTui(o): TuiHandle {
      t.opts = o;
      t.manager = o.manager;
      return { done: Promise.resolve(), restoreTerminal: () => {}, quit: () => {} };
    },
  });
  return t;
}

test("past_and_theme_need_tui", async () => {
  for (const [flags, msg] of [
    [["--past", "3"], "--past needs --tui"],
    [["--theme", "dark"], "--theme needs --tui"],
  ] as const) {
    const e = env();
    assert.equal(await main([...e.argv, ...flags], e.deps()), 2);
    assert.ok(e.err.some((l) => l.includes(msg)), msg);
  }
  const e1 = env();
  assert.equal(await main(["--tui", "--past", "x"], e1.deps()), 2);
  assert.ok(e1.err.some((l) => l.includes("argument --past: invalid int value: 'x'")));
  const e2 = env();
  assert.equal(await main(["--tui", "--theme", "blue"], e2.deps()), 2);
  assert.ok(e2.err.some((l) => l.includes("invalid choice: 'blue'")));
});

test("tui_passes_theme_notices_and_past", async () => {
  for (const [skipped, notices] of [
    [2, ["skipped 2 unreadable run folders in runs/"]],
    [1, ["skipped 1 unreadable run folder in runs/"]],
    [0, []],
  ] as const) {
    const e = env();
    const t = optsTui();
    let limit = -1;
    const code = await main(["--tui", "--theme", "light", "--past", "5", "--skill", e.argv[2]], e.deps({
      isTTY: () => true, loadTui: t.load,
      loadPastRuns: (l) => { limit = l; return { runs: [aPastRun()], skipped }; },
    }));
    assert.equal(code, 0);
    assert.equal(limit, 5);
    assert.equal(t.opts.theme, "light");
    assert.deepEqual(t.opts.notices, notices);
    assert.equal(t.manager!.list()[0].past?.runId, "20260101-000000-old");
  }
});

test("tui_past_theme_defaults_and_zero", async () => {
  const e = env();
  const t = optsTui();
  let limit = -1;
  await main(["--tui", "--skill", e.argv[2]], e.deps({
    isTTY: () => true, loadTui: t.load, loadPastRuns: (l) => { limit = l; return { runs: [], skipped: 0 }; },
  }));
  assert.equal(limit, 20);
  assert.equal(t.opts.theme, "auto");

  const e2 = env();
  let called = false;
  await main(["--tui", "--past", "0", "--skill", e2.argv[2]], e2.deps({
    isTTY: () => true, loadTui: optsTui().load, loadPastRuns: () => { called = true; return { runs: [], skipped: 0 }; },
  }));
  assert.equal(called, false);
});

/** An agent factory that blocks events.jsonl by making it a directory. */
const sinkBlocker = (inner = result(true)) => (opts: AgentOptions): AgentLike => {
  fs.mkdirSync(path.join(opts.workdir, "events.jsonl"), { recursive: true });
  return { costUsd: 0, run: async () => inner };
};

test("tui_sink_warning_becomes_toast", async () => {
  const e = env();
  const toasts: ManagerEvent[] = [];
  const load = async (): Promise<TuiModule> => ({
    startTui({ manager }): TuiHandle {
      manager.subscribe((ev) => { if (ev.type === "toast") toasts.push(ev); });
      const id = manager.addTyped("do it");
      const done = new Promise<void>((resolve) => {
        const off = manager.subscribe((ev) => {
          if (ev.type === "task:updated" && ev.task.state === "passed") { off(); setImmediate(resolve); }
        });
      });
      manager.start(id);
      return { done, restoreTerminal: () => {}, quit: () => {} };
    },
  });
  await main(["--tui", "--skill", e.argv[2]], e.deps({
    isTTY: () => true, loadTui: load, loadPastRuns: () => ({ runs: [], skipped: 0 }), createAgent: sinkBlocker(),
  }));
  const t = toasts.find((x) => x.type === "toast" && x.message.startsWith("could not write "));
  assert.ok(t && t.type === "toast" && t.level === "error");
});

test("plain_sink_warning_on_stderr", async () => {
  const e = env();
  assert.equal(await main(e.argv, e.deps({ createAgent: sinkBlocker() })), 0);
  const w = e.err.filter((l) => l.startsWith("warning: could not write "));
  assert.equal(w.length, 1);
  assert.ok(w[0].includes("events.jsonl"));
  assert.ok(!e.out.some((l) => l.includes("could not write")));

  const e2 = env();
  fs.writeFileSync(path.join(e2.tmp, "a.md"), "task a\n");
  fs.writeFileSync(path.join(e2.tmp, "b.md"), "task b\n");
  assert.equal(await main(["-f", "a.md", "b.md", "--skill", e2.argv[2]], e2.deps({ createAgent: sinkBlocker() })), 0);
  assert.equal(e2.err.filter((l) => l.startsWith("warning: could not write ")).length, 2);
  assert.ok(!e2.out.some((l) => l.includes("could not write")));
});
