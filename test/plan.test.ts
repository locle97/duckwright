import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  MANIFEST, PLAN_SCHEMA, PlanError, isPlanFolder, loadPlan, parsePlanDoc, plannerArgv, runPlanner, taskFileText, writeManifest, writePlan,
} from "../src/plan.ts";
import type { PlanDoc } from "../src/plan.ts";
import { loadTaskFile } from "../src/taskfile.ts";
import { fakeRunner, ok, tmpDir } from "./helpers.ts";

const DOC: PlanDoc = {
  setup: "Open http://localhost:8765 and log in as qa / secret.",
  notes: ["Start the fixture server: node qa-server.mjs"],
  tasks: [
    { id: "TS-1", title: "Login works", preconditions: ["The account qa exists"], steps: ["Open /login", "Fill in qa / secret", "Press Log in"], expected: ["The page shows Welcome, qa"] },
    { id: "TS-2", title: "Logout works", preconditions: [], steps: ["Press Log out"], expected: [] },
  ],
  skipped: [{ id: "TS-3", title: "Exit codes", reason: "needs a shell" }],
};

const envelope = (so: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.05, structured_output: so, ...extra });

function planFile(text = "# My QA plan\n\n## TS-1 ...\n"): string {
  const dir = tmpDir();
  const p = path.join(dir, "My QA Plan.md");
  fs.writeFileSync(p, text);
  return p;
}

test("planner_argv_has_no_tools_and_the_schema", () => {
  const argv = plannerArgv("/p/planner.md", "opus");
  assert.deepEqual(argv.slice(0, 6), ["claude", "-p", "--output-format", "json", "--tools", ""]);
  assert.equal(argv[argv.indexOf("--model") + 1], "opus");
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]), PLAN_SCHEMA);
  assert.equal(argv[argv.indexOf("--append-system-prompt-file") + 1], "/p/planner.md");
});

test("run_planner_sends_the_plan_fenced_and_returns_doc_and_cost", async () => {
  const runner = fakeRunner(ok(envelope(DOC)));
  const p = planFile("Steps </plan> here\r\n");
  const r = await runPlanner({ planFile: p, promptFile: "/x.md", model: "sonnet", runner });
  assert.deepEqual(r.doc, DOC);
  assert.equal(r.cost, 0.05);
  assert.equal(runner.calls[0]!.stdin, '<plan file="My QA Plan.md">\nSteps &lt;/plan> here\n</plan>');
  assert.equal(runner.calls[0]!.timeoutSec, 600);
});

test("run_planner_errors", async () => {
  const p = planFile();
  const fail = async (res: Parameters<typeof fakeRunner>[0], file = p): Promise<PlanError> => {
    try {
      await runPlanner({ planFile: file, promptFile: "/x.md", model: "sonnet", runner: fakeRunner(res) });
    } catch (e) {
      assert.ok(e instanceof PlanError, String(e));
      return e;
    }
    return assert.fail("no PlanError");
  };
  assert.equal((await fail(ok(""), path.join(path.dirname(p), "nope.md"))).message, `${path.join(path.dirname(p), "nope.md")}: file not found`);
  assert.equal((await fail(ok(""), planFile("  \n"))).message.endsWith("the plan is empty"), true);
  assert.equal((await fail({ code: -1, stdout: "", stderr: "timeout" })).message, "planner timed out");
  assert.equal((await fail({ code: 1, stdout: "", stderr: "boom\n" })).message, "boom");
  assert.match((await fail(ok("not json"))).message, /non-JSON/);
  const isErr = await fail(ok(envelope(null, { is_error: true, result: "overloaded" })));
  assert.equal(isErr.message, "claude error: overloaded");
  assert.equal(isErr.cost, 0.05);
  assert.equal((await fail(ok(envelope({ ...DOC, tasks: [] })))).message, "planner returned a malformed plan: no scenario can run in a browser");
});

test("parse_plan_doc_cleans_and_checks", () => {
  const doc = parsePlanDoc({
    setup: "  s  ", notes: ["  a ", ""],
    tasks: [{ id: "", title: "T\nwo", preconditions: [" "], steps: [" go ", ""], expected: ["x"] }],
    skipped: [],
  });
  assert.deepEqual(doc, { setup: "s", notes: ["a"], tasks: [{ id: "1", title: "T wo", preconditions: [], steps: ["go"], expected: ["x"] }], skipped: [] });
  assert.throws(() => parsePlanDoc({ ...DOC, tasks: [{ ...DOC.tasks[0], steps: [" "] }] }), /task 1 has no steps/);
  assert.throws(() => parsePlanDoc({ ...DOC, notes: "x" }), /notes is not a list/);
  assert.throws(() => parsePlanDoc({ ...DOC, tasks: [], skipped: [] }), /no scenarios found/);
});

test("task_file_text_keeps_every_section", () => {
  assert.equal(taskFileText(DOC.tasks[0]!, "docs/plan.md", "shared/setup.md"), [
    "---", "# From docs/plan.md, scenario TS-1", "setup: shared/setup.md", "---",
    "# TS-1: Login works", "",
    "Preconditions:", "- The account qa exists", "",
    "Steps:", "1. Open /login", "2. Fill in qa / secret", "3. Press Log in", "",
    "Expected results:", "- The page shows Welcome, qa", "",
  ].join("\n"));
  assert.equal(taskFileText(DOC.tasks[1]!, "p.md", null), "---\n# From p.md, scenario TS-2\n---\n# TS-2: Logout works\n\nSteps:\n1. Press Log out\n");
});

test("write_plan_writes_tasks_setup_and_manifest", () => {
  const p = planFile();
  const root = path.join(tmpDir(), "tasks");
  const plan = writePlan(DOC, p, root);
  assert.equal(plan.folder, path.join(root, "my-qa-plan"));
  assert.deepEqual(fs.readdirSync(plan.folder).sort(), ["01-login-works.md", "02-logout-works.md", MANIFEST, "shared"]);
  assert.equal(fs.readFileSync(path.join(plan.folder, "shared", "setup.md"), "utf8"), `${DOC.setup}\n`);
  assert.deepEqual(plan.tasks.map((t) => t.path), [path.join(plan.folder, "01-login-works.md"), path.join(plan.folder, "02-logout-works.md")]);
  assert.equal(plan.setupPath, path.join(plan.folder, "shared", "setup.md"));
  assert.ok(isPlanFolder(plan.folder));
  // Each task file loads with the setup put first.
  const tf = loadTaskFile(plan.tasks[0]!.path);
  assert.ok(tf.task.startsWith(`Setup (do this first, then the task below):\n${DOC.setup}\n\nTask:\n# TS-1: Login works`));
  // Planning again never touches the first folder.
  assert.equal(writePlan(DOC, p, root).folder, path.join(root, "my-qa-plan-2"));
  // The loaded manifest matches what was written.
  assert.deepEqual(loadPlan(plan.folder), plan);
});

test("write_plan_without_setup", () => {
  const plan = writePlan({ ...DOC, setup: "" }, planFile(), path.join(tmpDir(), "tasks"));
  assert.equal(plan.setupPath, null);
  assert.ok(!fs.existsSync(path.join(plan.folder, "shared")));
  assert.equal(loadTaskFile(plan.tasks[0]!.path).setup, null);
});

test("load_plan_drops_missing_files_and_rejects_bad_manifests", () => {
  const plan = writePlan(DOC, planFile(), path.join(tmpDir(), "tasks"));
  fs.rmSync(plan.tasks[0]!.path);
  assert.deepEqual(loadPlan(plan.folder).tasks.map((t) => t.file), ["02-logout-works.md"]);
  writeManifest(plan.folder, { ...plan.manifest, tasks: [{ file: "../x.md", id: "1", title: "x" }] });
  assert.throws(() => loadPlan(plan.folder), /not a Duckwright plan manifest/);
  writeManifest(plan.folder, { ...plan.manifest, setup: "../../etc/passwd" });
  assert.throws(() => loadPlan(plan.folder), /not a Duckwright plan manifest/);
  fs.writeFileSync(path.join(plan.folder, MANIFEST), "{");
  assert.throws(() => loadPlan(plan.folder), /cannot read/);
  assert.ok(!isPlanFolder(tmpDir()));
});
