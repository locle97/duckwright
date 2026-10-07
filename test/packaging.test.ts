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
  // npm still runs `prepare` during pack, and vite prints its build log ahead of the JSON.
  const [pack] = JSON.parse(out.slice(out.lastIndexOf("\n[\n") + 1));
  files = pack.files.map((f: { path: string }) => f.path).sort();
  name = pack.name;
});

test("package_bundles_build_and_prompts", () => {
  for (const p of [
    "dist/bin.js", "dist/cli.js", "prompts/system.md", "prompts/playwright-cli.md",
    "prompts/snapshot-full.md", "prompts/snapshot-grep.md", "prompts/snapshot-hybrid.md", "prompts/planner.md",
    "dist/web/index.js", "dist/web/server.js", "dist/web-ui/index.html",
    "package.json", "README.md", "LICENSE",
  ]) assert.ok(files.includes(p), p);
  assert.ok(!files.some((p) => /^(src|test|scripts|docs|examples|benchmark_tasks|benchmark_plans)\//.test(p)));
});

test("package_ships_the_built_web_ui_with_assets", () => {
  assert.ok(files.some((p) => /^dist\/web-ui\/assets\/.+\.js$/.test(p)));
  assert.ok(files.some((p) => /^dist\/web-ui\/assets\/.+\.css$/.test(p)));
  assert.ok(!files.some((p) => p.startsWith("web/")));
});

test("package_name_and_command", () => {
  assert.equal(name, "duckwright");
  assert.deepEqual(pkg.bin, { duckwright: "dist/bin.js" });
  assert.ok(fs.readFileSync(path.join(ROOT, "dist", "bin.js"), "utf8").startsWith("#!/usr/bin/env node\n"));
});

test("package_runtime_deps_are_ink_and_react", () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["ink", "react"]);
  assert.equal(pkg.engines.node, ">=22.18");
});

test("package_declares_mit_license", () => {
  assert.equal(pkg.license, "MIT");
});

test("dist_loads_tui_lazily", () => {
  const cli = fs.readFileSync(path.join(ROOT, "dist", "cli.js"), "utf8");
  assert.match(cli, /import\("\.\/tui\/index\.js"\)/);
  assert.doesNotMatch(cli, /^\s*import\b[^;\n]*from\s+["'](ink|react)["']/m);
  assert.ok(files.includes("dist/tui/index.js"));
});
