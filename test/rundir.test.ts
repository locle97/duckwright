import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ADJECTIVES, NOUNS, makeRunDir, randomLabel, runLabel, slugify } from "../src/rundir.ts";
import { tmpDir } from "./helpers.ts";

const NOW = new Date(2026, 9, 3, 10, 15, 0);

test("slugify", () => {
  assert.equal(slugify("01-todomvc"), "01-todomvc");
  assert.equal(slugify("  My Login_Flow!! "), "my-login-flow");
  assert.equal(slugify("Đăng nhập"), "dang-nhap");
  assert.equal(slugify("Café Crème"), "cafe-creme");
  assert.equal(slugify("日本語"), "");
  assert.equal(slugify("a".repeat(39) + "-bbb"), "a".repeat(39));
});

test("label_from_task_file_stem", () => {
  assert.equal(runLabel("benchmark_tasks/01-todomvc.md"), "01-todomvc");
  assert.equal(runLabel("tasks/Check Out.txt"), "check-out");
});

test("label_random_words_without_file_or_usable_name", () => {
  const first = () => 0;
  assert.equal(runLabel(null, first), "brave-acorn");
  assert.equal(runLabel("tasks/日本語.md", first), "brave-acorn");
});

test("random_label_shape", () => {
  const [adj, noun] = randomLabel().split("-");
  assert.ok(ADJECTIVES.includes(adj) && NOUNS.includes(noun));
  const last = () => 0.9999;
  assert.equal(randomLabel(last), "zesty-willow");
});

test("make_run_dir_names_and_clashes", () => {
  const root = path.join(tmpDir(), "runs");
  const dirs = [1, 2, 3].map(() => makeRunDir(root, "tasks/login.md", NOW));
  assert.deepEqual(dirs.map((d) => path.basename(d)), [
    "20261003-101500-login", "20261003-101500-login-2", "20261003-101500-login-3",
  ]);
  assert.ok(dirs.every((d) => fs.statSync(d).isDirectory()));
});

test("make_run_dir_command_line_task", () => {
  const p = makeRunDir(path.join(tmpDir(), "runs"), null, NOW);
  assert.match(path.basename(p), /^20261003-101500-[a-z]+-[a-z]+$/);
});
