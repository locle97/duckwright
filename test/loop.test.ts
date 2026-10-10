import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { BrainError } from "../src/brain.ts";
import type { Decision, StepInput } from "../src/brain.ts";
import { RunControl } from "../src/control.ts";
import { RunEvents } from "../src/events.ts";
import type { RunEvent } from "../src/events.ts";
import { JevAuthError, JevError, HybridBrain } from "../src/jev.ts";
import { Agent } from "../src/loop.ts";
import { AbortedError } from "../src/proc.ts";
import type { ProcResult } from "../src/proc.ts";
import { historyLines } from "../src/prompt.ts";
import type { StepRecord } from "../src/prompt.ts";
import { PlaywrightCLI, PlaywrightError } from "../src/pw.ts";
import { createTwoFactor } from "../src/twofa.ts";
import { tmpDir } from "./helpers.ts";

class FakePW extends PlaywrightCLI {
  calls: [string, unknown[]][] = [];
  closed = 0;
  openCode: number;
  snapError: boolean;
  runStdout: string;

  constructor({ openCode = 0, snapError = false, runStdout = "tabs" } = {}) {
    super();
    this.openCode = openCode;
    this.snapError = snapError;
    this.runStdout = runStdout;
  }

  override async run(cmd: string, args: string[]): Promise<ProcResult> {
    this.calls.push([cmd, [...args]]);
    return { code: 0, stdout: this.runStdout, stderr: "" };
  }

  override async open(headed: boolean): Promise<ProcResult> {
    this.calls.push(["open", [headed]]);
    return { code: this.openCode, stdout: "", stderr: "open failed" };
  }

  override async stateLoad(p: string): Promise<void> {
    this.calls.push(["state-load", [p]]);
  }

  override async close(): Promise<void> {
    this.closed += 1;
  }

  override async snapshot(_p: string): Promise<string> {
    if (this.snapError) throw new PlaywrightError("snap boom");
    return "- page";
  }
}

/** Returns the given snapshots one per step (the last one repeats). */
class SizedPW extends FakePW {
  snapshots: string[];

  constructor(snapshots: string[]) {
    super();
    this.snapshots = snapshots;
  }

  override async snapshot(_p: string): Promise<string> {
    return this.snapshots.length > 1 ? this.snapshots.shift()! : this.snapshots[0];
  }
}

class FakeBrain {
  prompts: string[] = [];
  greps: boolean[] = [];
  steps: (StepInput | undefined)[] = [];
  script: (Decision | Error)[];

  constructor(script: (Decision | Error)[]) {
    this.script = script;
  }

  async decide(prompt: string, grep = true, step?: StepInput): Promise<[Decision, number]> {
    this.prompts.push(prompt);
    this.greps.push(grep);
    this.steps.push(step);
    const item = this.script[Math.min(this.prompts.length - 1, this.script.length - 1)];
    if (item instanceof Error) throw item;
    return [item, 0.5];
  }
}

function dec(actions: [string, string[]][] = [], memory = "m"): Decision {
  return { evaluationPreviousGoal: "ev", memory, nextGoal: "goal", actions: actions.map(([cmd, args]) => ({ cmd, args })) };
}

const agent = (pw: PlaywrightCLI, brain: FakeBrain, opts: Partial<ConstructorParameters<typeof Agent>[0]> = {}) =>
  new Agent({ task: "t", pw, brain, workdir: tmpDir(), ...opts });

test("finishes_on_done", async () => {
  const pw = new FakePW();
  const r = await agent(pw, new FakeBrain([dec([["goto", ["u"]]]), dec([["done", ["success", "ok"]]])])).run();
  assert.deepEqual([r.success, r.answer, r.steps], [true, "ok", 2]);
  assert.equal(r.costUsd, 1.0);
  assert.equal(pw.closed, 1);
});

test("stops_at_max_steps", async () => {
  const pw = new FakePW();
  const brain = new FakeBrain([dec([["hover", ["e1"]]]), dec([["hover", ["e2"]]]), dec([["hover", ["e3"]]])]);
  const r = await agent(pw, brain, { maxSteps: 3 }).run();
  assert.deepEqual([r.success, r.steps, r.answer], [false, 3, "max steps reached"]);
  assert.equal(pw.closed, 1);
});

test("consecutive_brain_failures", async () => {
  const pw = new FakePW();
  const r = await agent(pw, new FakeBrain([new BrainError("kaput")]), { maxFailures: 3 }).run();
  assert.equal(r.success, false);
  assert.equal(r.steps, 3);
  assert.equal(r.answer, "stopped after 3 consecutive brain failures: kaput");
  assert.equal(pw.closed, 1);
  assert.deepEqual(r.history[0].results, ["brain error: kaput"]);
});

test("brain_failure_counter_resets", async () => {
  const brain = new FakeBrain([
    new BrainError("a"), new BrainError("b"), dec([["hover", ["e1"]]]), new BrainError("c"),
    new BrainError("d"), dec([["done", ["success", "x"]]]),
  ]);
  const r = await agent(new FakePW(), brain, { maxFailures: 3 }).run();
  assert.ok(r.success && r.steps === 6);
});

test("repeat_nudge", async () => {
  const brain = new FakeBrain([dec([["hover", ["e1"]]])]);
  await agent(new FakePW(), brain, { maxSteps: 4 }).run();
  assert.ok(brain.prompts.slice(0, 3).every((p) => !p.includes("You are repeating")));
  assert.ok(brain.prompts[3].includes("You are repeating the same actions; try a different approach."));
});

test("close_on_exception", async () => {
  const pw = new FakePW({ snapError: true });
  await assert.rejects(agent(pw, new FakeBrain([dec()])).run(), PlaywrightError);
  assert.equal(pw.closed, 1);
});

test("open_failure_raises", async () => {
  const pw = new FakePW({ openCode: 1 });
  await assert.rejects(agent(pw, new FakeBrain([dec()])).run(), /open failed/);
  assert.equal(pw.closed, 1);
});

test("on_step_and_memory", async () => {
  const seen: StepRecord[] = [];
  const brain = new FakeBrain([dec([["hover", ["e1"]]], "remember"), dec([["done", ["success", "x"]]])]);
  await agent(new FakePW(), brain, { onStep: (r) => seen.push(r) }).run();
  assert.equal(seen.length, 2);
  assert.ok(brain.prompts[1].includes("remember"));
});

test("brain_error_cost_is_counted", async () => {
  const a = agent(new FakePW(), new FakeBrain([new BrainError("refused", 0.25), dec([["done", ["success", "x"]]])]));
  const r = await a.run();
  assert.equal(r.costUsd, 0.75);
  assert.equal(a.costUsd, 0.75);
});

test("running_cost_survives_exception", async () => {
  class SnapFailsSecond extends FakePW {
    n = 0;
    override async snapshot(_p: string): Promise<string> {
      this.n += 1;
      if (this.n === 2) throw new PlaywrightError("snap boom");
      return "- page";
    }
  }
  const a = agent(new SnapFailsSecond(), new FakeBrain([dec([["hover", ["e1"]]])]));
  await assert.rejects(a.run(), PlaywrightError);
  assert.equal(a.costUsd, 0.5);
});

test("state_loaded_after_open", async () => {
  const pw = new FakePW();
  const dir = tmpDir();
  await agent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { state: path.join(dir, "auth.json") }).run();
  assert.deepEqual(pw.calls.slice(0, 2), [["open", [false]], ["state-load", [path.join(dir, "auth.json")]]]);
});

test("no_state_skips_state_load", async () => {
  const pw = new FakePW();
  await agent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])])).run();
  assert.ok(pw.calls.every((c) => c[0] !== "state-load"));
});

const GOTO_OUT = "### Ran Playwright code\n```js\nawait page.goto('u');\n```\n";

test("step_records_generated_code", async () => {
  const r = await agent(new FakePW({ runStdout: GOTO_OUT }), new FakeBrain([dec([["goto", ["u"]]]), dec([["done", ["success", "ok"]]])])).run();
  assert.deepEqual(r.history[0].codes, ["await page.goto('u');"]);
  assert.deepEqual(r.history[1].codes, [null]);
});

test("brain_error_step_has_no_codes", async () => {
  const r = await agent(new FakePW({ runStdout: GOTO_OUT }), new FakeBrain([new BrainError("x"), dec([["done", ["success", "ok"]]])])).run();
  assert.deepEqual(r.history[0].codes, []);
});

test("state_load_failure_closes_browser", async () => {
  class BadState extends FakePW {
    override async stateLoad(_p: string): Promise<void> {
      throw new PlaywrightError("bad state");
    }
  }
  const pw = new BadState();
  await assert.rejects(agent(pw, new FakeBrain([]), { state: "/x/a.json" }).run(), /bad state/);
  assert.equal(pw.closed, 1);
});

test("library_default_is_full_mode", async () => {
  const brain = new FakeBrain([dec([["done", ["success", "ok"]]])]);
  await agent(new FakePW(), brain).run();
  assert.ok(brain.prompts[0].includes("<page_snapshot>\n- page\n</page_snapshot>"));
});

test("grep_mode_prompt_has_no_page_text", async () => {
  const brain = new FakeBrain([dec([["done", ["success", "ok"]]])]);
  await agent(new FakePW(), brain, { snapshotMode: "grep" }).run();
  assert.ok(brain.prompts[0].includes("<page_snapshot_file>"));
  assert.ok(!brain.prompts[0].includes("- page"));
  assert.deepEqual(brain.greps, [true]);
});

test("full_mode_never_greps", async () => {
  const brain = new FakeBrain([dec([["done", ["success", "ok"]]])]);
  await agent(new SizedPW(["x".repeat(50_000)]), brain, { snapshotMode: "full" }).run();
  assert.ok(brain.prompts[0].includes("<page_snapshot>"));
  assert.deepEqual(brain.greps, [false]);
});

for (const [size, greps] of [[5_000, false], [5_001, true]] as const) {
  test(`hybrid_threshold ${size}`, async () => {
    const brain = new FakeBrain([dec([["done", ["success", "ok"]]])]);
    await agent(new SizedPW(["x".repeat(size)]), brain, { snapshotMode: "hybrid" }).run();
    assert.deepEqual(brain.greps, [greps]);
    assert.equal(brain.prompts[0].includes("<page_snapshot_file>"), greps);
    assert.equal(brain.prompts[0].includes("<page_snapshot>"), !greps);
  });
}

test("hybrid_switches_per_step", async () => {
  const brain = new FakeBrain([dec([["goto", ["u"]]]), dec([["goto", ["v"]]]), dec([["done", ["success", "ok"]]])]);
  await agent(new SizedPW(["small", "y".repeat(9_000), "small again"]), brain, { snapshotMode: "hybrid" }).run();
  assert.deepEqual(brain.greps, [false, true, false]);
  assert.ok(brain.prompts[0].includes("<page_snapshot>\nsmall\n</page_snapshot>"));
  assert.ok(brain.prompts[1].includes("snapshot.yml: 1 lines, 9000 characters."));
});

test("agent aborts mid-decide and still closes the browser", async () => {
  const ac = new AbortController();
  const pw = new FakePW();
  const brain = new FakeBrain([dec([["hover", ["e1"]]])]);
  const decide = brain.decide.bind(brain);
  brain.decide = async (prompt: string, grep = true) => {
    if (brain.prompts.length === 1) {
      ac.abort();
      throw new AbortedError();
    }
    return decide(prompt, grep);
  };
  const a = agent(pw, brain, { signal: ac.signal });
  await assert.rejects(a.run(), AbortedError);
  assert.equal(pw.closed, 1);
  assert.equal(a.costUsd, 0.5); // cost from the step before the abort is kept
});

test("agent checks the signal before each step", async () => {
  const ac = new AbortController();
  ac.abort();
  const pw = new FakePW();
  const brain = new FakeBrain([dec([["hover", ["e1"]]])]);
  await assert.rejects(agent(pw, brain, { signal: ac.signal }).run(), AbortedError);
  assert.deepEqual(brain.prompts, []);
  assert.equal(pw.closed, 1);
});

test("abort is not counted as a brain failure", async () => {
  const brain = new FakeBrain([new AbortedError()]);
  await assert.rejects(agent(new FakePW(), brain).run(), AbortedError);
  assert.equal(brain.prompts.length, 1);
});

test("brain failure after an abort is an interrupt", async () => {
  const ac = new AbortController();
  const brain = new FakeBrain([dec([["hover", ["e1"]]])]);
  brain.decide = async () => {
    ac.abort();
    throw new BrainError("claude exited -2", 0.1);
  };
  const a = agent(new FakePW(), brain, { signal: ac.signal });
  await assert.rejects(a.run(), AbortedError);
  assert.equal(a.costUsd, 0.1);
});

const done = () => dec([["done", ["success", "x"]]]);
const collect = (events: RunEvents) => {
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  return seen;
};

test("loop_event_order_normal_step", async () => {
  const events = new RunEvents();
  const seen = collect(events);
  await agent(new FakePW(), new FakeBrain([done()]), { events }).run();
  assert.deepEqual(seen.map((e) => e.type), [
    "step:start", "phase", "phase", "decision", "phase", "action:start", "action:result", "step:end",
  ]);
  assert.deepEqual(seen.flatMap((e) => (e.type === "phase" ? [e.phase] : [])), ["observing", "thinking", "acting"]);
});

test("loop_event_order_brain_error", async () => {
  const events = new RunEvents();
  const seen = collect(events);
  await agent(new FakePW(), new FakeBrain([new BrainError("x", 0.25), done()]), { events }).run();
  const first = seen.slice(0, 5);
  assert.deepEqual(first.map((e) => e.type), ["step:start", "phase", "phase", "brain:error", "step:end"]);
  const [, , , be, end] = first;
  assert.ok(be.type === "brain:error" && be.failures === 1 && be.cost === 0.25);
  assert.ok(end.type === "step:end" && end.cost === 0.25);
});

test("loop_step_costs_sum", async () => {
  const events = new RunEvents();
  const seen = collect(events);
  const r = await agent(new FakePW(), new FakeBrain([new BrainError("x", 0.25), dec([["hover", ["e1"]]]), done()]), { events }).run();
  const sum = seen.reduce((s, e) => s + (e.type === "step:end" ? e.cost : 0), 0);
  assert.equal(sum, r.costUsd);
});

test("loop_pause_holds_before_observe", async () => {
  const events = new RunEvents();
  const seen = collect(events);
  const control = new RunControl(new AbortController(), events);
  const pw = new SnapCounter();
  control.pause();
  const p = agent(pw, new FakeBrain([done()]), { events, control }).run();
  await new Promise((r) => setImmediate(r));
  assert.equal(pw.snaps, 0);
  assert.ok(!seen.some((e) => e.type === "step:start"));
  control.resume();
  assert.equal((await p).success, true);
});

class SnapCounter extends FakePW {
  snaps = 0;
  override async snapshot(p: string): Promise<string> {
    this.snaps += 1;
    return super.snapshot(p);
  }
}

test("loop_step_runs_exactly_one", async () => {
  const events = new RunEvents();
  const seen = collect(events);
  const control = new RunControl(new AbortController(), events);
  control.pause();
  const brain = new FakeBrain([dec([["hover", ["e1"]]]), done()]);
  const p = agent(new FakePW(), brain, { events, control }).run();
  control.step();
  while (!seen.some((e) => e.type === "step:end")) await new Promise((r) => setImmediate(r));
  assert.equal(control.state, "paused");
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.filter((e) => e.type === "step:start").length, 1);
  control.resume();
  await p;
});

test("loop_stop_while_paused_aborts", async () => {
  const ac = new AbortController();
  const control = new RunControl(ac);
  const pw = new FakePW();
  control.pause();
  const p = agent(pw, new FakeBrain([done()]), { control, signal: ac.signal }).run();
  await new Promise((r) => setImmediate(r));
  control.stop();
  await assert.rejects(p, AbortedError);
  assert.equal(pw.closed, 1);
});

const LIST = "### Result\n1. [GET] http://h/a => [200] OK\n";
const DETAILS = "### Result\nGeneral\n  duration: 5ms\n";

class NetPW extends FakePW {
  clearCodes: number[] = [];
  listFailures: string[] = [];
  listThrow: Error | null = null;

  override async run(cmd: string, args: string[]): Promise<ProcResult> {
    this.calls.push([cmd, [...args]]);
    if (cmd === "requests" && args[0] === "--clear") {
      const code = this.clearCodes.shift() ?? 0;
      return { code, stdout: "", stderr: code ? "x" : "" };
    }
    if (cmd === "requests") {
      if (this.listThrow) throw this.listThrow;
      const f = this.listFailures.shift();
      if (f !== undefined) return { code: 1, stdout: "", stderr: f };
      return { code: 0, stdout: LIST, stderr: "" };
    }
    if (cmd === "request") return { code: 0, stdout: DETAILS, stderr: "" };
    return { code: 0, stdout: this.runStdout, stderr: "" };
  }
}

const cmds = (pw: FakePW) => pw.calls.map(([c, a]) => (c === "requests" && a[0] === "--clear" ? "requests --clear" : c));

test("network_call_order", async () => {
  const pw = new NetPW();
  await agent(pw, new FakeBrain([dec([["click", ["e1"]]]), dec([["done", ["success", "ok"]]])]), { network: true }).run();
  const c = cmds(pw).filter((x) => x !== "close");
  assert.deepEqual(c.slice(0, 2), ["open", "requests --clear"]);
  const expected = ["tab-list", "click", "requests", "request", "requests --clear", "tab-list"];
  assert.deepEqual(c.slice(2, 2 + expected.length), expected);
});

test("network_state_load_then_clear", async () => {
  const pw = new NetPW();
  await agent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { network: true, state: "s.json" }).run();
  assert.deepEqual(cmds(pw).slice(0, 3), ["open", "state-load", "requests --clear"]);
});

test("network_done_step_captured", async () => {
  const r = await agent(new NetPW(), new FakeBrain([dec([["done", ["success", "ok"]]])]), { network: true }).run();
  assert.equal(r.history[0].network?.length, 1);
});

test("network_ids_continue_across_steps", async () => {
  const workdir = tmpDir();
  const r = await agent(new NetPW(), new FakeBrain([dec([["hover", ["e1"]]]), dec([["done", ["success", "ok"]]])]), { network: true, workdir }).run();
  assert.equal(r.history[0].network?.[0].id, "0001");
  assert.equal(r.history[1].network?.[0].id, "0002");
  assert.ok(fs.existsSync(path.join(workdir, "network", "0002", "request.json")));
});

test("network_brain_error_clear_only", async () => {
  const pw = new NetPW();
  const r = await agent(pw, new FakeBrain([new BrainError("k"), dec([["done", ["success", "ok"]]])]), { network: true }).run();
  const c = cmds(pw);
  // open, initial clear, tab-list, (brain error) clear, tab-list, ...
  assert.deepEqual(c.slice(0, 5), ["open", "requests --clear", "tab-list", "requests --clear", "tab-list"]);
  assert.equal("network" in r.history[0], false);
  assert.equal("networkErrors" in r.history[0], false);
});

test("network_requests_failure_recorded", async () => {
  const pw = new NetPW();
  pw.listFailures = ["boom"];
  const r = await agent(pw, new FakeBrain([dec([["hover", ["e1"]]]), dec([["done", ["success", "ok"]]])]), { network: true }).run();
  assert.deepEqual(r.history[0].network, []);
  assert.deepEqual(r.history[0].networkErrors, ["requests: boom"]);
  assert.equal(r.success, true);
  assert.equal(r.steps, 2);
});

test("network_no_errors_key_when_clean", async () => {
  const r = await agent(new NetPW(), new FakeBrain([dec([["done", ["success", "ok"]]])]), { network: true }).run();
  assert.equal("networkErrors" in r.history[0], false);
});

test("network_initial_clear_error_skips_brain_error_step", async () => {
  const pw = new NetPW();
  pw.clearCodes = [1];
  pw.listFailures = ["boom"];
  const brain = new FakeBrain([new BrainError("k"), dec([["hover", ["e1"]]]), dec([["hover", ["e2"]]])]);
  const r = await agent(pw, brain, { network: true, maxSteps: 3 }).run();
  assert.equal("networkErrors" in r.history[0], false);
  assert.deepEqual(r.history[1].networkErrors, ["initial requests --clear: x", "requests: boom"]);
  assert.equal(r.history.length, 3);
  assert.equal("networkErrors" in r.history[2], false);
});

test("network_initial_clear_error_dropped", async () => {
  const pw = new NetPW();
  pw.clearCodes = [1];
  const r = await agent(pw, new FakeBrain([new BrainError("k")]), { network: true, maxFailures: 3 }).run();
  assert.equal(r.history.length, 3);
  assert.ok(r.history.every((h) => !("networkErrors" in h)));
});

test("network_off_by_default", async () => {
  const pw = new NetPW();
  const workdir = tmpDir();
  await agent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { workdir }).run();
  assert.ok(!cmds(pw).some((c) => c.startsWith("request")));
  assert.equal(fs.existsSync(path.join(workdir, "network")), false);
});

test("network_aborted_propagates", async () => {
  const pw = new NetPW();
  pw.listThrow = new AbortedError();
  await assert.rejects(agent(pw, new FakeBrain([dec([["hover", ["e1"]]])]), { network: true }).run(), AbortedError);
  assert.equal(pw.closed, 1);
});

test("network_expect_request_checks_previous_step", async () => {
  const brain = new FakeBrain([dec([["click", ["e1"]]]), dec([["expect-request", ["GET", "/a", "200"]], ["done", ["success", "ok"]]])]);
  const r = await agent(new NetPW(), brain, { network: true }).run();
  assert.equal(r.history[1].results[0], "ok");
  assert.match(r.history[1].codes[0]!, /^const apiResponse1 = page\.waitForResponse/);
});

test("expect_request_first_step_has_no_calls", async () => {
  const brain = new FakeBrain([dec([["expect-request", ["GET", "/a", "200"]]]), dec([["done", ["failure", "x"]]])]);
  const r = await agent(new NetPW(), brain, { network: true }).run();
  assert.equal(r.history[0].results[0], "error: expect-request failed: no GET /a in the previous step's calls (saw: no calls)");
});

test("expect_request_without_network_capture_errors", async () => {
  const brain = new FakeBrain([dec([["expect-request", ["GET", "/a", "200"]]]), dec([["done", ["failure", "x"]]])]);
  const r = await agent(new FakePW(), brain).run();
  assert.equal(r.history[0].results[0], "error: expect-request needs network capture (run without --no-network)");
});

test("request_action_uses_earlier_captured_calls_and_records_origin", async () => {
  class ReqPW extends NetPW {
    override async run(cmd: string, args: string[]): Promise<ProcResult> {
      if (cmd === "requests" && args[0] !== "--clear") {
        this.calls.push([cmd, [...args]]);
        const n = this.calls.filter(([c, a]) => c === "requests" && a[0] !== "--clear").length;
        return { code: 0, stdout: n === 1 ? "### Result\n1. [POST] https://shop.example.com/api/items => [201] Created\n" : "### Result\n", stderr: "" };
      }
      if (cmd === "tab-list") {
        this.calls.push([cmd, [...args]]);
        return { code: 0, stdout: "- 0: (current) [Shop](https://shop.example.com/)\n", stderr: "" };
      }
      if (cmd === "run-code") {
        this.calls.push([cmd, [...args]]);
        return { code: 0, stdout: '{"status":201,"bytes":2,"text":"{}","type":"application/json","location":null}', stderr: "" };
      }
      return super.run(cmd, args);
    }
  }
  const r = await agent(new ReqPW(), new FakeBrain([
    dec([["click", ["e1"]]]),
    dec([["request", ["POST", "/api/items", '{"t":1}']]]),
    dec([["done", ["success", "ok"]]]),
  ]), { network: true }).run();
  assert.equal(r.history[1].results[0], "ok 201 {}");
  assert.deepEqual(r.history[1].requestOrigins, ["https://shop.example.com"]);
  assert.equal(r.history[0].requestOrigins, undefined);
});

const TF_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TF_CODE = "287082"; // the RFC 6238 code at t=59 s
const ECHO = `### Ran Playwright code\n\`\`\`js\nawait page.getByLabel('Code').fill('${TF_CODE}');\n\`\`\`\n`;
const twofa = () => createTwoFactor({
  secret: TF_SECRET, human: null, timeoutSec: 5, signal: new AbortController().signal, now: () => 59_000,
});

test("twofa_codes_are_scrubbed_from_records_events_and_prompts", async () => {
  // Every playwright-cli reply echoes the code, as a page that shows what you typed would.
  const pw = new FakePW({ runStdout: ECHO });
  const brain = new FakeBrain([dec([["twofa", ["totp", "e1"]]]), dec([["done", ["success", "ok"]]])]);
  const events = new RunEvents();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const r = await agent(pw, brain, { twofa: twofa(), events }).run();
  assert.equal(r.success, true);
  assert.deepEqual(r.history[0].results, ["ok"]);
  assert.deepEqual(r.history[0].codes, ["await page.getByLabel('Code').fill('[2FA CODE]');"]);
  assert.ok(!brain.prompts[1].includes(TF_CODE), "the next prompt is clean");
  assert.ok(brain.prompts[1].includes("[2FA CODE]"));
  const blob = JSON.stringify([r, seen]);
  assert.ok(!blob.includes(TF_CODE), "records and events are clean");
  assert.ok(!blob.includes(TF_SECRET));
});

test("twofa_codes_are_scrubbed_from_the_final_answer", async () => {
  const pw = new FakePW({ runStdout: ECHO });
  const brain = new FakeBrain([dec([["twofa", ["totp", "e1"]]]), dec([["done", ["success", `code was ${TF_CODE}`]]])]);
  const r = await agent(pw, brain, { twofa: twofa() }).run();
  assert.equal(r.answer, "code was [2FA CODE]");
});

test("twofa_codes_are_scrubbed_from_network_entries_and_files", async () => {
  class EchoNet extends NetPW {
    override async run(cmd: string, args: string[]): Promise<ProcResult> {
      if (cmd === "requests" && args[0] !== "--clear") {
        return { code: 0, stdout: `### Result\n1. [GET] http://h/a?c=${TF_CODE} => [200] OK\n`, stderr: "" };
      }
      return super.run(cmd, args);
    }
  }
  const workdir = tmpDir();
  const r = await agent(new EchoNet({ runStdout: ECHO }), new FakeBrain([dec([["twofa", ["totp", "e1"]]]), dec([["done", ["success", "ok"]]])]),
    { network: true, workdir, twofa: twofa() }).run();
  assert.equal(r.history[0].network?.[0].url, "http://h/a?c=[2FA CODE]");
  const file = fs.readFileSync(path.join(workdir, "network", "0001", "request.json"), "utf8");
  assert.ok(!file.includes(TF_CODE));
  assert.ok(file.includes("[2FA CODE]"));
});

test("twofa_codes_are_scrubbed_from_the_snapshot_file_and_the_decision", async () => {
  class SnapPW extends FakePW {
    last = "";
    override async run(cmd: string, args: string[]): Promise<ProcResult> {
      if (cmd === "fill") this.last = args[1];
      return super.run(cmd, args);
    }
    override async snapshot(p: string): Promise<string> {
      const text = `- textbox "Code": "${this.last}"`;
      fs.writeFileSync(p, text);
      return text;
    }
  }
  const workdir = tmpDir();
  const leaky = dec([["done", ["success", "ok"]]], `the code was ${TF_CODE}`);
  const brain = new FakeBrain([dec([["twofa", ["totp", "e1"]]]), leaky]);
  const events = new RunEvents();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const files: string[] = [];
  const base = brain.decide.bind(brain);
  brain.decide = async (prompt: string, grep = true) => {
    files.push(fs.readFileSync(path.join(workdir, "page", "snapshot.yml"), "utf8"));
    return base(prompt, grep);
  };
  const r = await agent(new SnapPW({ runStdout: ECHO }), brain, { workdir, twofa: twofa(), events }).run();
  assert.equal(files[1], '- textbox "Code": "[2FA CODE]"');
  assert.ok(brain.prompts[1].includes('"[2FA CODE]"'));
  assert.ok(!brain.prompts[1].includes(TF_CODE));
  assert.ok(!fs.readFileSync(path.join(workdir, "page", "snapshot.yml"), "utf8").includes(TF_CODE));
  assert.equal(r.history[1].decision.memory, "the code was [2FA CODE]");
  const decisions = seen.filter((e) => e.type === "decision");
  assert.ok(!JSON.stringify(decisions).includes(TF_CODE));
  assert.ok(JSON.stringify(decisions).includes("[2FA CODE]"));
});

test("without_twofa_nothing_is_scrubbed", async () => {
  const brain = new FakeBrain([dec([["done", ["success", TF_CODE]]])]);
  const r = await agent(new FakePW(), brain).run();
  assert.equal(r.answer, TF_CODE);
});

class EvidencePW extends FakePW {
  shotFail: string | null = null;
  shotThrow: Error | null = null;
  startThrow: Error | null = null;

  override async screenshot(p: string): Promise<void> {
    this.calls.push(["screenshot", [p]]);
    if (this.shotThrow) throw this.shotThrow;
    if (this.shotFail) throw new PlaywrightError(this.shotFail);
    fs.writeFileSync(p, "png");
  }

  override async videoStart(p: string): Promise<void> {
    this.calls.push(["video-start", [p]]);
    if (this.startThrow) throw this.startThrow;
  }

  override async videoStop(): Promise<void> {
    this.calls.push(["video-stop", []]);
    fs.writeFileSync(path.join(this.dir, "video.webm"), "x");
  }

  override async close(): Promise<void> {
    this.calls.push(["close", []]);
    await super.close();
  }

  dir = "";
}

const evAgent = (pw: EvidencePW, brain: FakeBrain, opts: Partial<ConstructorParameters<typeof Agent>[0]> = {}) => {
  const workdir = tmpDir();
  pw.dir = workdir;
  return new Agent({ task: "t", pw, brain, workdir, ...opts });
};
const names = (pw: EvidencePW) => pw.calls.map((c) => c[0]);

test("evidence_off_runs_nothing", async () => {
  const pw = new EvidencePW();
  const a = evAgent(pw, new FakeBrain([dec([["hover", ["e1"]]]), dec([["done", ["success", "ok"]]])]));
  await a.run();
  assert.ok(!names(pw).some((n) => ["screenshot", "video-start", "video-stop"].includes(n)));
  assert.equal(fs.existsSync(path.join(a.workdir, "screenshots")), false);
  assert.deepEqual(a.evidence, { video: null, warnings: [] });
});

test("screenshot_every_step_including_brain_error", async () => {
  const pw = new EvidencePW();
  const events = new RunEvents();
  const ends: StepRecord[] = [];
  events.subscribe((e) => { if (e.type === "step:end") ends.push(e.record); });
  const a = evAgent(pw, new FakeBrain([new BrainError("x"), dec([["done", ["success", "ok"]]])]), { screenshot: true, events });
  const r = await a.run();
  const shots = pw.calls.filter((c) => c[0] === "screenshot").map((c) => c[1][0] as string);
  assert.equal(shots.length, 2);
  assert.ok(shots[0].endsWith("screenshots/step-001.png") && shots[1].endsWith("screenshots/step-002.png"));
  assert.deepEqual(ends.map((e) => e.screenshot), ["screenshots/step-001.png", "screenshots/step-002.png"]);
  assert.deepEqual(r.history.map((h) => h.screenshot), ["screenshots/step-001.png", "screenshots/step-002.png"]);
});

test("screenshot_failure_is_a_warning", async () => {
  const pw = new EvidencePW();
  pw.shotFail = "boom";
  const a = evAgent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { screenshot: true });
  const r = await a.run();
  assert.equal(r.success, true);
  assert.equal(r.history[0].screenshotError, "boom");
  assert.ok(!("screenshot" in r.history[0]));
  assert.deepEqual(a.evidence.warnings, ["screenshot failed at step 1: boom"]);
});

test("screenshot_error_is_scrubbed", async () => {
  const pw = new EvidencePW();
  const tf = twofa();
  pw.shotFail = `bad ${TF_SECRET}`;
  const a = evAgent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { screenshot: true, twofa: tf });
  const r = await a.run();
  assert.ok(!JSON.stringify(r.history).includes(TF_SECRET));
  assert.ok(!a.evidence.warnings.join().includes(TF_SECRET));
  assert.equal(a.evidence.warnings.length, 1);
});

test("screenshot_abort_propagates_and_stops_video", async () => {
  const pw = new EvidencePW();
  pw.shotThrow = new AbortedError();
  const a = evAgent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { screenshot: true, video: true });
  await assert.rejects(a.run(), AbortedError);
  assert.deepEqual(names(pw).slice(-3), ["screenshot", "video-stop", "close"]);
});

test("video_start_stop_order", async () => {
  const pw = new EvidencePW();
  const a = evAgent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { video: true });
  await a.run();
  const n = names(pw);
  assert.equal(n[0], "open");
  assert.equal(n[1], "video-start");
  assert.ok((pw.calls[1][1][0] as string).endsWith("/video.webm"));
  assert.deepEqual(n.slice(-2), ["video-stop", "close"]);
  assert.equal(a.evidence.video, "video.webm");

  const pw2 = new EvidencePW({ snapError: true });
  const a2 = evAgent(pw2, new FakeBrain([dec()]), { video: true });
  await assert.rejects(a2.run(), PlaywrightError);
  assert.deepEqual(names(pw2).slice(-2), ["video-stop", "close"]);
});

test("video_start_failure_skips_stop", async () => {
  const pw = new EvidencePW();
  pw.startThrow = new PlaywrightError("nope");
  const a = evAgent(pw, new FakeBrain([dec([["done", ["success", "ok"]]])]), { video: true });
  const r = await a.run();
  assert.equal(r.success, true);
  assert.ok(!names(pw).includes("video-stop"));
  assert.deepEqual(a.evidence.warnings, ["video failed to start: nope"]);
});

test("agent_environment_in_every_step_prompt", async () => {
  const script = [dec([["hover", ["e1"]]]), dec([["hover", ["e2"]]]), dec([["hover", ["e3"]]])];
  const withEnv = new FakeBrain(script);
  await agent(new FakePW(), withEnv, { maxSteps: 3, environment: "ENV-TEXT" }).run();
  assert.equal(withEnv.prompts.length, 3);
  assert.ok(withEnv.prompts.every((p) => p.includes("<environment>\nENV-TEXT\n</environment>")));
  const without = new FakeBrain(script);
  await agent(new FakePW(), without, { maxSteps: 3 }).run();
  assert.ok(without.prompts.every((p) => !p.includes("<environment>")));
});

test("decide receives StepInput", async () => {
  const pw = new FakePW();
  const brain = new FakeBrain([dec([["hover", ["e1"]]]), dec([["done", ["success", "ok"]]])]);
  const r = await agent(pw, brain).run();
  const [s1, s2] = brain.steps;
  assert.equal(s1!.ctx.step, 1);
  assert.equal(s1!.ctx.task, "t");
  assert.equal(s1!.ctx.memory, "");
  assert.deepEqual(s1!.ctx.historyLines, []);
  assert.equal(s1!.ctx.nudged, false);
  assert.equal(s1!.ctx.previousFailed, false);
  assert.equal(s1!.obs.snapshot, "- page");
  assert.deepEqual(s2!.ctx.historyLines, historyLines(r.history.slice(0, 1)));
  assert.equal(s2!.ctx.memory, "m");
});

test("StepInput is scrubbed", async () => {
  class LeakPW extends FakePW {
    override async snapshot(_p: string): Promise<string> {
      return `- button "${TF_SECRET}" [ref=e1]`;
    }
  }
  const leakyDec = dec([["hover", ["e1"]]], `memo ${TF_SECRET}`);
  const brain = new FakeBrain([leakyDec, dec([["done", ["success", "ok"]]])]);
  const secretTask = `do ${TF_SECRET}`;
  await agent(new LeakPW({ runStdout: `tab ${TF_SECRET}` }), brain, { twofa: twofa(), task: secretTask }).run();
  for (const s of brain.steps) {
    const blob = JSON.stringify([s!.ctx.task, s!.ctx.memory, s!.ctx.historyLines, s!.obs.tabs, s!.obs.snapshot]);
    assert.ok(!blob.includes(TF_SECRET), "no secret");
  }
  assert.match(brain.steps[1]!.obs.snapshot, /^- button ".+" \[ref=e1\]$/);
  assert.notEqual(brain.steps[1]!.obs.snapshot, `- button "${TF_SECRET}" [ref=e1]`);
});

test("nudged flag", async () => {
  const brain = new FakeBrain([dec([["hover", ["e1"]]])]);
  await agent(new FakePW(), brain, { maxSteps: 4 }).run();
  assert.deepEqual(brain.steps.map((s) => s!.ctx.nudged), [false, false, false, true]);
});

test("previousFailed flag", async () => {
  const failing = new FakeBrain([dec([["bogus", []]]), dec([["hover", ["e1"]]])]);
  await agent(new FakePW(), failing, { maxSteps: 2 }).run();
  assert.equal(failing.steps[1]!.ctx.previousFailed, true);
  const brainErr = new FakeBrain([new BrainError("x"), dec([["hover", ["e1"]]])]);
  await agent(new FakePW(), brainErr, { maxSteps: 2 }).run();
  assert.equal(brainErr.steps[1]!.ctx.previousFailed, true);
  const ok = new FakeBrain([dec([["hover", ["e1"]]]), dec([["hover", ["e1"]]])]);
  await agent(new FakePW(), ok, { maxSteps: 2 }).run();
  assert.equal(ok.steps[1]!.ctx.previousFailed, false);
});

test("costUsd on records", async () => {
  const brain = new FakeBrain([new BrainError("x", 0.25), dec([["done", ["success", "ok"]]])]);
  const r = await agent(new FakePW(), brain).run();
  assert.equal(r.history[0].costUsd, 0.25);
  assert.equal(r.history[0].decision.source, "claude");
  assert.equal(r.history[0].decision.jev, null);
  assert.equal(r.history[1].costUsd, 0.5);
});

test("brain error record carries jev", async () => {
  const e = new BrainError("x");
  e.jev = { action: "click", action_confidence: 0.5, target: "e1", target_confidence: 0.4, routed: "low_confidence" };
  const r = await agent(new FakePW(), new FakeBrain([e, dec([["done", ["success", "ok"]]])])).run();
  assert.deepEqual(r.history[0].decision.jev, e.jev);
});

test("JevError does not count as a failure", async () => {
  let asked = 0;
  const claude = new FakeBrain([dec([["click", ["e1"]]]), dec([["done", ["success", "ok"]]])]);
  const brain = new HybridBrain({
    jev: { ask: async () => { asked += 1; throw new JevError("jev http 500", 0); } },
    claude,
  });
  class BtnPW extends FakePW {
    override async snapshot(_p: string): Promise<string> {
      return '- button "B" [ref=e1]';
    }
  }
  const r = await new Agent({ task: "t", pw: new BtnPW(), brain, workdir: tmpDir(), maxFailures: 1 }).run();
  assert.equal(r.success, true);
  assert.equal(r.answer, "ok");
  assert.equal(asked, 1);
  assert.ok(r.history.every((h) => !h.results.some((x) => x.startsWith("brain error:"))));
});

test("JevAuthError stops the run", async () => {
  const pw = new FakePW();
  await assert.rejects(agent(pw, new FakeBrain([new JevAuthError()])).run(), JevAuthError);
  assert.equal(pw.closed, 1);
});
