// Keeps skills/duckwright-tasks in step with the harness, and checks the worked example still passes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ALLOWED_COMMANDS } from "../src/brain.ts";
import { ENV_MAX_BYTES } from "../src/environment.ts";
import { loadPlan } from "../src/plan.ts";
import { KEYS, loadTaskFile } from "../src/taskfile.ts";

const SKILL = path.resolve("skills/duckwright-tasks");
const SCRIPT = path.join(SKILL, "scripts/check-tasks.mjs");
const EXAMPLE = path.resolve("examples/project-larder/e2e");
const FOLDER = path.join(EXAMPLE, "tasks/basket-promo-codes");

test("linter_keys_match_taskfile_keys", async () => {
  const lint = await import(SCRIPT);
  assert.deepEqual(Object.keys(lint.KEYS).sort(), Object.keys(KEYS).sort());
  assert.equal(lint.ENV_MAX_BYTES, ENV_MAX_BYTES);
});

test("harness_constraints_lists_every_allowed_command", () => {
  const ref = fs.readFileSync(path.join(SKILL, "references/harness-constraints.md"), "utf8");
  for (const c of ALLOWED_COMMANDS) assert.ok(ref.includes(c), `harness-constraints.md does not mention ${c}`);
  for (const k of Object.keys(KEYS)) assert.ok(ref.includes(k), `harness-constraints.md does not mention ${k}`);
});

test("worked_example_loads_with_the_real_parsers", () => {
  const plan = loadPlan(FOLDER);
  assert.equal(plan.tasks.length, 3);
  for (const t of plan.tasks) assert.ok(loadTaskFile(t.path).task.startsWith("Setup (do this first"));
});

test("worked_example_passes_the_linter", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", EXAMPLE, FOLDER], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^0 error\(s\)/m);
});

test("linter_rejects_out_of_browser_steps", () => {
  const dir = fs.mkdtempSync(path.join(EXAMPLE, "..", ".tmp-"));
  try {
    const f = path.join(dir, "bad.md");
    fs.writeFileSync(f, "---\nallow-file-access: true\n---\nRun npm run db:seed.\nUpload the file a.png.\n");
    const r = spawnSync(process.execPath, [SCRIPT, "--root", EXAMPLE, f], { encoding: "utf8" });
    assert.equal(r.status, 1);
    for (const m of ["allow-file-access", "needs a shell", "`upload` is not an allowed command", "no checks"]) assert.ok(r.stdout.includes(m), m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
