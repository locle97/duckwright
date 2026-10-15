import assert from "node:assert/strict";
import fs from "node:fs";
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
