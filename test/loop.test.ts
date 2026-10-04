import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { BrainError } from "../src/brain.ts";
import type { Decision } from "../src/brain.ts";
import { Agent } from "../src/loop.ts";
import { AbortedError } from "../src/proc.ts";
import type { ProcResult } from "../src/proc.ts";
import type { StepRecord } from "../src/prompt.ts";
import { PlaywrightCLI, PlaywrightError } from "../src/pw.ts";
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
  script: (Decision | Error)[];

  constructor(script: (Decision | Error)[]) {
    this.script = script;
  }

  async decide(prompt: string, grep = true): Promise<[Decision, number]> {
    this.prompts.push(prompt);
    this.greps.push(grep);
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
