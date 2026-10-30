import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkTasks } from "../src/check.ts";
import { ENV_MAX_BYTES } from "../src/environment.ts";
import { KEYS } from "../src/taskfile.ts";

// The skill scripts are installed on their own, so they cannot import from src/. They copy a few
// harness rules; these tests fail when the copies drift.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const lintPath = path.join(root, "skills/duckwright-tasks/scripts/check-tasks.mjs");
const doctorPath = path.join(root, "skills/duckwright-setup/scripts/doctor.mjs");
const lint = await import(lintPath);

test("skill_linter_front_matter_keys_match_taskfile", () => {
  assert.deepEqual(Object.keys(lint.KEYS).sort(), Object.keys(KEYS).sort());
});

test("skill_scripts_env_limit_matches_environment", () => {
  assert.equal(lint.ENV_MAX_BYTES, ENV_MAX_BYTES);
  const doctor = fs.readFileSync(doctorPath, "utf8");
  assert.equal(Number(/const ENV_MAX_BYTES = (\d+);/.exec(doctor)?.[1]), ENV_MAX_BYTES);
});

test("skill_doctor_and_linter_agree_on_testing_map_keys", () => {
  const keys = (file: string) => {
    const m = /const MAP_KEYS = new Set\(\[([^\]]*)\]\)/.exec(fs.readFileSync(file, "utf8"));
    return (m?.[1].match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1)).sort();
  };
  assert.ok(keys(lintPath).length > 0);
  assert.deepEqual(keys(doctorPath), keys(lintPath));
});

test("duckwright_check_accepts_the_skill_example_tasks", () => {
  const e2e = path.join(root, "docs/design/task-authoring-skill/examples/project-larder/e2e");
  const cwd = process.cwd();
  process.chdir(e2e);
  try {
    const r = checkTasks(["tasks/basket-promo-codes", "tasks/basket-promo-codes-2"]);
    assert.deepEqual(r.findings.filter((f) => f.level === "error"), []);
    assert.equal(r.ok.length, 6);
  } finally {
    process.chdir(cwd);
  }
});

test("skill_runs_brief_lists_plan_runs_and_flags_failures", async () => {
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-brief-"));
  try {
    fs.mkdirSync(path.join(dir, "01-a"));
    fs.mkdirSync(path.join(dir, "02-b"));
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({
      version: 1, name: "p", source: "s", setup: null, notes: [], skipped: [],
      tasks: [{ file: "01-a.md", id: "A", title: "First" }, { file: "02-b.md", id: "B", title: "Second" }, { file: "03-c.md", id: "C", title: "Third" }],
    }));
    const run = (success: boolean) => JSON.stringify({
      task: "t", task_file: null, success, answer: "", steps: 1,
      history: [{ step: 1, actions: [{ cmd: "goto", args: ["https://x.test"], code: "await page.goto('https://x.test');" }], results: ["ok"] }],
    });
    fs.writeFileSync(path.join(dir, "01-a/history.json"), run(true));
    fs.writeFileSync(path.join(dir, "02-b/history.json"), run(false));
    const out = execFileSync("node", [path.join(root, "skills/duckwright-playwright/scripts/runs-brief.mjs"), dir, "--code"], { encoding: "utf8" });
    assert.match(out, /## A First {2}\[success\]/);
    assert.match(out, /## B Second {2}\[failure\][\s\S]*run FAILED/);
    assert.match(out, /NO RUN for task C/);
    assert.match(out, /await page\.goto/);
    assert.match(out, /2 run\(s\), 1 convertible/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skill_linter_accepts_account_placeholders_and_still_flags_others", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-lint-"));
  fs.mkdirSync(path.join(dir, "tasks/x"), { recursive: true });
  const task = (body: string) => `---\nmax-steps: 12\n---\nSteps:\n${body}\n\nExpected results:\n- The heading "Recipes" is visible.\n`;
  fs.writeFileSync(path.join(dir, "tasks/x/01-login.md"), task(
    "1. Open http://localhost:9091/login.\n2. Fill \"Email\" with {{admin.username}} and \"Password\" with {{admin.password}}, then click \"Login\".",
  ));
  fs.writeFileSync(path.join(dir, "tasks/x/02-todo.md"), task("1. Open http://localhost:9091/{{page}}."));
  const r = spawnSync(process.execPath, [lintPath, "--root", dir, path.join(dir, "tasks/x")], { encoding: "utf8" });
  const placeholders = r.stdout.split("\n").filter((l) => l.includes("placeholder text"));
  assert.equal(placeholders.length, 1, r.stdout);
  assert.match(placeholders[0], /02-todo\.md/);
});

test("skill_linter_accepts_base_url_and_flags_a_written_base_url", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-lint-"));
  try {
    fs.mkdirSync(path.join(dir, "tasks/x"), { recursive: true });
    fs.mkdirSync(path.join(dir, "environments"));
    fs.writeFileSync(path.join(dir, "environments/local.md"), "## Base URL\n\nhttp://localhost:9091\n");
    const task = (body: string) => `---\nenv: local\nmax-steps: 12\n---\nSteps:\n${body}\n\nExpected results:\n- The heading "Recipes" is visible.\n`;
    fs.writeFileSync(path.join(dir, "tasks/x/01-placeholder.md"), task("1. Open {{BASE_URL}}/recipes."));
    fs.writeFileSync(path.join(dir, "tasks/x/02-written.md"), task("1. Open http://localhost:9091/recipes."));
    const r = spawnSync(process.execPath, [lintPath, "--root", dir, path.join(dir, "tasks/x")], { encoding: "utf8" });
    assert.ok(!r.stdout.includes("01-placeholder.md"), r.stdout);
    const written = r.stdout.split("\n").filter((l) => l.includes("write {{BASE_URL}}"));
    assert.equal(written.length, 1, r.stdout);
    assert.match(written[0], /02-written\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
