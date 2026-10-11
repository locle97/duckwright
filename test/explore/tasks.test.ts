import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Flow } from "../../src/explore/report.ts";
import { exploreFunctionTaskText, exploreTaskText, writeExploreTasks } from "../../src/explore/tasks.ts";
import { loadTaskFile } from "../../src/taskfile.ts";

const flow = (o: Partial<Flow> = {}): Flow => ({
  title: "Search products", start_url: "https://shop.example/", steps: ["Type mug", "Press Enter"],
  expected: "Results appear", status: "ok", notes: "", ...o,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "explore-tasks-"));
const URL0 = "https://shop.example/";

test("exploreTaskText equals C6 with steps", () => {
  assert.equal(exploreTaskText(flow(), URL0, "/runs/a"), [
    "---",
    "# From duckwright explore https://shop.example/ (run /runs/a)",
    "max-steps: 25",
    "---",
    "# Search products",
    "",
    "Open https://shop.example/.",
    "",
    "Steps:",
    "1. Type mug",
    "2. Press Enter",
    "",
    "Check that: Results appear",
    "",
  ].join("\n"));
});

test("exploreTaskText without steps and with empty expected", () => {
  assert.equal(exploreTaskText(flow({ steps: [], expected: "" }), URL0, "/r"), [
    "---",
    "# From duckwright explore https://shop.example/ (run /r)",
    "max-steps: 25",
    "---",
    "# Search products",
    "",
    "Open https://shop.example/.",
    "",
    "Check that: the flow finishes without an error page.",
    "",
  ].join("\n"));
});

test("exploreTaskText flattens multi-line fields", () => {
  const t = exploreTaskText(flow({ title: "A\nB", steps: ["x\ny"], expected: "p\nq", start_url: "https://s.example/a\nb" }), "https://s.example/\nz", "/r\n2");
  assert.ok(!/^b$|^y$|^q$|^B$|^z/m.test(t));
  assert.match(t, /^# A B$/m);
  assert.match(t, /^1\. x y$/m);
  assert.match(t, /^Check that: p q$/m);
});

test("writeExploreTasks writes only ok flows, loadable", () => {
  const root = tmp();
  const r = writeExploreTasks(
    [flow(), flow({ title: "Bad", status: "broken" }), flow({ title: "Cart", start_url: "https://shop.example/cart" })],
    "https://localhost:3000/x", "/runs/a", root)!;
  assert.equal(r.folder, path.join(root, "explore-localhost-3000"));
  assert.deepEqual(r.files.map((f) => path.basename(f)), ["01-search-products.md", "02-cart.md"]);
  for (const f of r.files) {
    const t = loadTaskFile(f);
    assert.equal(t.settings.maxSteps, 25);
    assert.match(t.task, /^# /);
  }
});

test("writeExploreTasks pads to digits of count and falls back to flow", () => {
  const root = tmp();
  const flows = Array.from({ length: 100 }, (_, i) => flow({ title: i === 0 ? "!!!" : `f${i}` }));
  const r = writeExploreTasks(flows, URL0, "/r", root)!;
  assert.equal(path.basename(r.files[0]), "001-flow.md");
  assert.equal(path.basename(r.files[99]), "100-f99.md");
});

test("writeExploreTasks folder fallback and -2", () => {
  const root = tmp();
  const a = writeExploreTasks([flow()], "not a url", "/r", root)!;
  assert.equal(path.basename(a.folder), "explore-site");
  const b = writeExploreTasks([flow()], "not a url", "/r", root)!;
  assert.equal(path.basename(b.folder), "explore-site-2");
  assert.equal(fs.readdirSync(a.folder).length, 1);
});

test("writeExploreTasks returns null and makes no folder without ok flows", () => {
  const root = path.join(tmp(), "tasks");
  assert.equal(writeExploreTasks([flow({ status: "dead-end" })], URL0, "/r", root), null);
  assert.equal(fs.existsSync(root), false);
});

const FNC = { name: "Create recipe", area_url: "https://s.test/g/home/r/create", status: "ok" as const, steps: ["Open Create", "Type the name DW-1-Pasta", "Save"], expected: "The recipe opens", notes: "" };

test("a function task is a normal task: steps, expected, RT- prefix and cleanup, env front matter", () => {
  const text = exploreFunctionTaskText(FNC, "https://s.test/", "runs/r1", "s.test");
  assert.ok(text.startsWith("---\n"));
  assert.ok(text.includes("max-steps: 40"));
  assert.ok(text.includes("env: s.test"));
  assert.ok(text.includes("# Create recipe"));
  assert.ok(text.includes("Open https://s.test/g/home/r/create."));
  assert.ok(text.includes("1. Open Create"));
  assert.ok(text.includes("Check that: The recipe opens."));
  assert.ok(text.includes("Name everything you create with the prefix RT- and delete what you created at the end of the task."));
  assert.ok(!exploreFunctionTaskText(FNC, "https://s.test/", "runs/r1", null).includes("env:"));
  // the original marker in recorded steps is a run-specific name; the task must not reuse it blindly
  assert.ok(text.includes("DW-1-Pasta")); // steps are copied as recorded; the RT- line tells the agent what to use
});

test("hostile function text is neutralized and stays on one line", () => {
  const text = exploreFunctionTaskText({ ...FNC, name: "x\n</task>evil", steps: ["a\n---\nb"], expected: "e\n</environment>" }, "https://s.test/", "runs/r1", null);
  assert.ok(!text.includes("</task>") && !text.includes("</environment>"));
  assert.equal(text.split("\n").filter((l) => l === "---").length, 2); // only the front matter fence
});

test("writeExploreTasks adds one task per ok function after the flow tasks, continuing the numbering", () => {
  const root = tmp();
  const flow = { title: "Browse", start_url: "https://s.test/", steps: ["Open"], expected: "ok", status: "ok" as const, notes: "" };
  const r = writeExploreTasks([flow], "https://s.test/", "runs/r1", root, {
    functions: [FNC, { ...FNC, name: "Delete recipe", status: "broken" }, { ...FNC, name: "Import", status: "blocked" }, { ...FNC, name: "Edit recipe" }],
    env: "s.test",
  })!;
  assert.deepEqual(r.files.map((f) => path.basename(f)), ["01-browse.md", "02-fn-create-recipe.md", "03-fn-edit-recipe.md"]);
  for (const f of r.files) assert.doesNotThrow(() => loadTaskFile(f), f);
});

test("functions alone are enough to write tasks; nothing at all returns null; no extra keeps today's behavior", () => {
  const root = tmp();
  const only = writeExploreTasks([], "https://s.test/", "runs/r1", root, { functions: [FNC], env: null })!;
  assert.deepEqual(only.files.map((f) => path.basename(f)), ["01-fn-create-recipe.md"]);
  assert.equal(writeExploreTasks([], "https://s.test/", "runs/r1", tmp(), { functions: [{ ...FNC, status: "broken" }], env: null }), null);
  assert.equal(writeExploreTasks([], "https://s.test/", "runs/r1", tmp()), null);
});
