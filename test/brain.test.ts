import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";

import { Ajv } from "ajv";

import { ALLOWED_COMMANDS, Brain, BrainError, DECISION_SCHEMA } from "../src/brain.ts";
import { CHECKS } from "../src/expect.ts";
import { AbortedError } from "../src/proc.ts";
import type { ProcResult } from "../src/proc.ts";
import { fakeRunner, tmpDir } from "./helpers.ts";

const GOOD = {
  evaluation_previous_goal: "ok",
  memory: "m",
  next_goal: "g",
  actions: [{ cmd: "click", args: ["e3"] }],
};

function env(kw: Record<string, unknown> = {}): ProcResult {
  return { code: 0, stdout: JSON.stringify({ is_error: false, total_cost_usd: 0.01, structured_output: GOOD, ...kw }), stderr: "" };
}

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

const brainError = (re?: RegExp) => (e: unknown) => e instanceof BrainError && (!re || re.test(e.message));

test("decide_argv", async () => {
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: ["prompts/system.md", "skill.md"], runner: fake }).decide("PROMPT");
  const { argv, stdin, timeoutSec } = fake.calls[0];
  assert.deepEqual(argv.slice(0, 6), ["claude", "-p", "--output-format", "json", "--tools", ""]);
  assert.deepEqual(argv.slice(6, 9), ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]);
  assert.ok(!argv.includes("--setting-sources"));
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]), DECISION_SCHEMA);
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  const files = argv.flatMap((a, i) => (a === "--append-system-prompt-file" ? [argv[i + 1]] : []));
  assert.deepEqual(files, ["prompts/system.md", "skill.md"]);
  assert.equal(stdin, "PROMPT");
  assert.equal(timeoutSec, 60);
});

test("decide_parses", async () => {
  const [d, cost] = await new Brain({ systemFiles: [], runner: fakeRunner(env()) }).decide("x");
  assert.deepEqual(d, { evaluationPreviousGoal: "ok", memory: "m", nextGoal: "g", actions: [{ cmd: "click", args: ["e3"] }] });
  assert.equal(cost, 0.01);
});

test("missing_cost_is_zero", async () => {
  const r: ProcResult = { code: 0, stdout: JSON.stringify({ structured_output: GOOD }), stderr: "" };
  assert.equal((await new Brain({ systemFiles: [], runner: fakeRunner(r) }).decide("x"))[1], 0);
});

test("boolean_or_string_cost_is_zero", async () => {
  for (const c of [true, "0.5", null]) {
    const [, cost] = await new Brain({ systemFiles: [], runner: fakeRunner(env({ total_cost_usd: c })) }).decide("x");
    assert.equal(cost, 0);
  }
});

test("decide_error_envelope", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner(env({ is_error: true, result: "boom" })) }).decide("x"),
    brainError(/boom/),
  );
});

test("decide_missing_structured_output", async () => {
  const r: ProcResult = { code: 0, stdout: JSON.stringify({ is_error: false, result: "text" }), stderr: "" };
  await assert.rejects(new Brain({ systemFiles: [], runner: fakeRunner(r) }).decide("x"), brainError());
});

test("decide_non_json_stdout", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner({ code: 0, stdout: "not json", stderr: "" }) }).decide("x"),
    brainError(/^non-JSON output: /),
  );
});

test("decide_timeout", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner({ code: -1, stdout: "", stderr: "timeout" }) }).decide("x"),
    brainError(/^timeout$/),
  );
});

test("decide_nonzero_exit", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner({ code: 2, stdout: "", stderr: "bad" }) }).decide("x"),
    brainError(/bad/),
  );
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner({ code: 2, stdout: "", stderr: " " }) }).decide("x"),
    brainError(/^claude exited 2$/),
  );
});

for (const so of [
  { memory: "m", next_goal: "g", actions: [] },
  { ...GOOD, actions: [{ cmd: "click" }] },
  { ...GOOD, actions: ["click"] },
  { ...GOOD, actions: [{ cmd: "click", args: [1] }] },
  { ...GOOD, actions: "x" },
  { ...GOOD, actions: [] },
  [1],
]) {
  test(`malformed_structured_output ${JSON.stringify(so)}`, async () => {
    await assert.rejects(
      new Brain({ systemFiles: [], runner: fakeRunner(env({ structured_output: so })) }).decide("x"),
      brainError(),
    );
  });
}

test("non_dict_envelope", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner({ code: 0, stdout: "[1]", stderr: "" }) }).decide("x"),
    brainError(/^envelope is not an object$/),
  );
});

test("error_envelope_carries_cost", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner(env({ is_error: true, result: "boom", total_cost_usd: 0.07 })) }).decide("x"),
    (e: unknown) => e instanceof BrainError && e.cost === 0.07,
  );
});

test("brain_error_cost_defaults_to_zero", async () => {
  assert.equal(new BrainError("x").cost, 0);
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner({ code: -1, stdout: "", stderr: "timeout" }) }).decide("x"),
    (e: unknown) => e instanceof BrainError && e.cost === 0,
  );
});

test("parse_failure_after_cost_carries_cost", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner(env({ structured_output: null, total_cost_usd: 0.02 })) }).decide("x"),
    (e: unknown) => e instanceof BrainError && e.cost === 0.02,
  );
});

test("malformed_action_message_shows_the_action", async () => {
  await assert.rejects(
    new Brain({ systemFiles: [], runner: fakeRunner(env({ structured_output: { ...GOOD, actions: [{ cmd: "click" }] } })) }).decide("x"),
    brainError(/^malformed action: \{"cmd":"click"\}$/),
  );
});

const anyOf = (DECISION_SCHEMA as any).properties.actions.items.anyOf;

test("schema_restricts_cmd_to_allowed", () => {
  const [done, expect, other, expectRequest, request, twofa] = anyOf;
  assert.deepEqual(done.properties.cmd, { const: "done" });
  assert.deepEqual(expect.properties.cmd, { const: "expect" });
  assert.deepEqual(expectRequest.properties.cmd, { const: "expect-request" });
  assert.deepEqual(request.properties.cmd, { const: "request" });
  assert.deepEqual(twofa.properties.cmd, { const: "twofa" });
  const cmds = new Set<string>([...other.properties.cmd.enum, "done", "expect", "expect-request", "request", "twofa"]);
  assert.deepEqual(cmds, new Set<string>(ALLOWED_COMMANDS));
  assert.ok(!cmds.has("playwright-cli"));
});

test("schema_request_takes_two_to_four_args", () => {
  const validate = new Ajv({ strict: false }).compile((DECISION_SCHEMA as any).properties.actions.items);
  const ok = (a: unknown) => validate(a) as boolean;
  assert.ok(ok({ cmd: "request", args: ["GET", "/api/items"] }));
  assert.ok(ok({ cmd: "request", args: ["POST", "/api/items", "{}", "201"] }));
  assert.ok(!ok({ cmd: "request", args: ["GET"] }));
  assert.ok(!ok({ cmd: "request", args: ["POST", "/a", "{}", "201", "x"] }));
});

test("schema_done_requires_status_and_answer", () => {
  const validate = new Ajv({ strict: false }).compile((DECISION_SCHEMA as any).properties.actions.items);
  const ok = (a: unknown) => validate(a) as boolean;
  assert.ok(ok({ cmd: "done", args: ["success", "42"] }));
  assert.ok(ok({ cmd: "done", args: ["failure", "gave up"] }));
  assert.ok(!ok({ cmd: "done", args: [] }));
  assert.ok(!ok({ cmd: "done", args: ["success"] }));
  assert.ok(!ok({ cmd: "done", args: ["42", "x"] }));
  assert.ok(ok({ cmd: "click", args: ["e1"] }));
  assert.ok(!ok({ cmd: "eval", args: ["1"] }));
  assert.ok(ok({ cmd: "expect", args: ["visible", "e1"] }));
  assert.ok(ok({ cmd: "expect", args: ["text", "e1", "Hi"] }));
  assert.ok(ok({ cmd: "expect", args: ["e1", "text", "Hi"] }));
  assert.ok(!ok({ cmd: "expect", args: ["e1", "toHaveText", "Hi"] }));
  assert.ok(!ok({ cmd: "expect", args: [] }));
  assert.ok(!ok({ cmd: "expect", args: ["text", "e1", "a", "b"] }));
  assert.ok(ok({ cmd: "expect-request", args: ["POST", "/api/login", "201"] }));
  assert.ok(ok({ cmd: "expect-request", args: ["GET", "/api/items", "200", "data.id", "42"] }));
  assert.ok(!ok({ cmd: "expect-request", args: ["POST", "/api/login"] }));
  assert.ok(!ok({ cmd: "expect-request", args: ["a", "b", "c", "d", "e", "f"] }));
});

test("schema_expect_checks_match_expect_module", () => {
  assert.deepEqual(anyOf[1].properties.args.contains, { enum: Object.keys(CHECKS) });
});

test("snapshot_dir_argv_and_cwd", async () => {
  const tmp = tmpDir();
  process.chdir(tmp);
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: [], runner: fake, snapshotDir: "runs/r1/page" }).decide("P");
  const { argv, timeoutSec, cwd: dir } = fake.calls[0];
  assert.deepEqual(argv.slice(0, 9), [
    "claude", "-p", "--output-format", "json",
    "--tools", "Read,Grep", "--allowedTools", "Read,Grep", "--restricted",
  ]);
  assert.deepEqual(argv.slice(9, 12), ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]);
  assert.equal(dir, path.join(tmp, "runs", "r1", "page"));
  assert.equal(timeoutSec, 120);
});

test("no_snapshot_dir_passes_no_cwd", async () => {
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: [], runner: fake }).decide("P");
  assert.ok(!fake.calls[0].argv.includes("--restricted"));
  assert.deepEqual(fake.calls[0].argv.slice(4, 6), ["--tools", ""]);
  assert.equal(fake.calls[0].cwd, undefined);
});

test("explicit_timeout_wins_in_snapshot_mode", async () => {
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: [], runner: fake, timeout: 30, snapshotDir: "p" }).decide("P");
  assert.equal(fake.calls[0].timeoutSec, 30);
});

test("snapshot_mode_resolves_system_files", async () => {
  // claude runs inside snapshotDir, so relative prompt paths must not be read from there.
  const tmp = tmpDir();
  process.chdir(tmp);
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: ["skill.md"], runner: fake, snapshotDir: "page" }).decide("P");
  const argv = fake.calls[0].argv;
  assert.equal(argv[argv.indexOf("--append-system-prompt-file") + 1], path.join(tmp, "skill.md"));
});

test("grep_false_runs_without_tools_even_with_snapshot_dir", async () => {
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: ["skill.md"], runner: fake, snapshotDir: "page" }).decide("P", false);
  assert.deepEqual(fake.calls[0].argv.slice(4, 6), ["--tools", ""]);
  assert.ok(!fake.calls[0].argv.includes("--restricted"));
  assert.equal(fake.calls[0].cwd, undefined);
  const argv = fake.calls[0].argv;
  assert.equal(argv[argv.indexOf("--append-system-prompt-file") + 1], "skill.md");
});

test("decide carries the abort signal", async () => {
  const ac = new AbortController();
  const fake = fakeRunner(env());
  await new Brain({ systemFiles: [], runner: fake, signal: ac.signal }).decide("P");
  assert.equal(fake.calls[0].signal, ac.signal);
});

test("decide lets AbortedError through", async () => {
  const brain = new Brain({ systemFiles: [], runner: async () => { throw new AbortedError(); } });
  await assert.rejects(brain.decide("p"), (e: unknown) => e instanceof AbortedError);
});
