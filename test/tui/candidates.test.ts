import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { nodeReadDir, rank, walk } from "../../src/tui/candidates.ts";
import type { Candidate, CandidateIndex, ReadDir } from "../../src/tui/candidates.ts";
import { tmpDir } from "../helpers.ts";

/** A ReadDir over `tree` (relDir -> names; folder names end with "/"), recording every folder read. */
function fakeReadDir(tree: Record<string, string[]>): ReadDir & { read: string[] } {
  const read: string[] = [];
  const fn = ((rel: string) => {
    read.push(rel);
    return (tree[rel] ?? []).map((n) => (n.endsWith("/") ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false }));
  }) as ReadDir & { read: string[] };
  fn.read = read;
  return fn;
}

const index = (paths: string[]): CandidateIndex => ({
  items: paths.map((p): Candidate => ({ path: p, folder: p.endsWith("/"), count: p.endsWith("/") ? 1 : 0 })),
  truncated: false,
});
const paths = (cs: Candidate[]): string[] => cs.map((c) => c.path);

test("candidates_skip_rules_and_counts", () => {
  const r = fakeReadDir({
    "": [".git/", "node_modules/", "runs/", "tasks/", "README.md", "notes.TXT", "x.json", 'q"a.md'],
    tasks: ["a.md", "b.md", "deep/", "empty/"],
    "tasks/deep": ["c.md"],
    "tasks/empty": ["img.png"],
  });
  const idx = walk(r);
  assert.equal(idx.truncated, false);
  assert.deepEqual(paths(idx.items), ["README.md", "notes.TXT", "tasks/", "tasks/a.md", "tasks/b.md", "tasks/deep/", "tasks/deep/c.md"]);
  assert.equal(idx.items.find((c) => c.path === "tasks/")?.count, 2);
  assert.equal(idx.items.find((c) => c.path === "tasks/deep/")?.count, 1);
  assert.equal(idx.items.find((c) => c.path === "README.md")?.folder, false);
  assert.deepEqual(r.read.filter((d) => [".git", "node_modules", "runs"].includes(d)), []);
  assert.ok(r.read.includes("tasks/empty"));
});

test("candidates_walk_cap", () => {
  const r = fakeReadDir({ "": Array.from({ length: 6000 }, (_, i) => `f${i}.md`) });
  const idx = walk(r);
  assert.equal(idx.truncated, true);
  assert.ok(idx.items.length <= 5000);
  assert.equal(walk(r, 10).items.length, 10);
  assert.equal(walk(fakeReadDir({ "": ["a.md"] })).truncated, false);
});

test("candidates_rank_order", () => {
  const idx = index(["tasks/smoke/", "tasks/smoke-login.md", "benchmark_tasks/05-saucedemo-checkout.md", "docs/misc.md"]);
  assert.deepEqual(paths(rank(idx, "tasks/sm")), ["tasks/smoke/", "tasks/smoke-login.md", "benchmark_tasks/05-saucedemo-checkout.md"]);
  assert.deepEqual(rank(idx, "zz"), []);
  assert.equal(rank(idx, "SMOKE")[0]?.path, "tasks/smoke/");
});

test("candidates_rank_prefers_segment_starts", () => {
  assert.deepEqual(paths(rank(index(["xlogin.md", "auth/login.md"]), "login")), ["auth/login.md", "xlogin.md"]);
});

test("candidates_rank_empty_query", () => {
  const idx = index(["b/c/d.md", "z.md", "b/", "a/x.md", "a.md"]);
  assert.deepEqual(paths(rank(idx, "")), ["a.md", "b/", "z.md", "a/x.md", "b/c/d.md"]);
});

test("candidates_node_readdir_survives_loops_and_errors", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.md"), "A");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.md"), "B");
  fs.symlinkSync("..", path.join(dir, "sub", "loop"));
  fs.symlinkSync("a.md", path.join(dir, "l.md"));
  fs.symlinkSync("missing.md", path.join(dir, "broken.md"));
  const got = paths(walk(nodeReadDir(dir)).items);
  for (const p of ["a.md", "l.md", "sub/", "sub/b.md"]) assert.ok(got.includes(p), p);
  assert.ok(!got.some((p) => p.startsWith("sub/loop")));
  assert.ok(!got.includes("broken.md"));
  assert.deepEqual(nodeReadDir(dir)("missing"), []);
});
