import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";

import { ROOT } from "./helpers.ts";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
let files: string[] = [];
let name = "";

before(() => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  const [pack] = JSON.parse(out);
  files = pack.files.map((f: { path: string }) => f.path).sort();
  name = pack.name;
});

test("package_bundles_build_and_prompts", () => {
  for (const p of [
    "dist/bin.js", "dist/cli.js", "prompts/system.md", "prompts/playwright-cli.md",
    "prompts/snapshot-full.md", "prompts/snapshot-grep.md", "prompts/snapshot-hybrid.md",
    "package.json", "README.md", "LICENSE",
  ]) assert.ok(files.includes(p), p);
  assert.ok(!files.some((p) => /^(src|test|legacy|scripts|docs|examples|benchmark_tasks)\//.test(p)));
});

test("package_name_and_command", () => {
  assert.equal(name, "duckwright");
  assert.deepEqual(pkg.bin, { duckwright: "dist/bin.js" });
  assert.ok(fs.readFileSync(path.join(ROOT, "dist", "bin.js"), "utf8").startsWith("#!/usr/bin/env node\n"));
});

test("package_has_no_runtime_deps", () => {
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  assert.equal(pkg.engines.node, ">=22.18");
});

test("package_declares_mit_license", () => {
  assert.equal(pkg.license, "MIT");
});
