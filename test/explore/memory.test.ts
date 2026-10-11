// test/explore/memory.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildEvidence, loadMemory, memoryPaths, saveMemory } from "../../src/explore/memory.ts";
import { buildExploreReport } from "../../src/explore/report.ts";
import type { HistoryData } from "../../src/export.ts";
import { emptySitemap } from "../../src/explore/site.ts";
import { NoteSink } from "../../src/explore/notes.ts";
import { tmpDir } from "../helpers.ts";

const HOST = "shop.example";
const step = (n: number, url: string | null, links: string[] = [], extra: object = {}) => ({
  step: n, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [], ...extra,
  ...(url ? { page: { url, title: url, links } } : {}),
});
const data = (over: Partial<HistoryData> = {}): HistoryData => ({
  task: "t", task_file: null, success: true,
  answer: JSON.stringify({ flows: [{ title: "Browse", start_url: "https://shop.example/", steps: [], expected: "", status: "ok", notes: "" }] }),
  steps: 2, cost_usd: 0,
  history: [step(1, "https://shop.example/", ["https://shop.example/a", "https://shop.example/b"]), step(2, "https://shop.example/a")],
  ...over,
});
const run = (d: HistoryData, root: string, extra: object = {}) => {
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  const report = buildExploreReport(d, { url: "https://shop.example/", runDir, network: true });
  return saveMemory({ host: HOST, runDir, data: d, report, startUrl: "https://shop.example/", root, ...extra }).then((r) => ({ ...r, runDir }));
};

test("buildEvidence is null when no page was recorded", () => {
  const d = data({ history: [step(1, null)] });
  assert.equal(buildEvidence(d, buildExploreReport(d, { url: "https://shop.example/", runDir: "r", network: true }), [], { host: HOST, runName: "r", startUrl: "https://shop.example/" }), null);
});

test("a no-history run creates no files", async () => {
  const root = tmpDir();
  const r = await run(data({ history: [step(1, null)] }), root);
  assert.equal(r.md, null);
  assert.equal(fs.existsSync(memoryPaths(HOST, root).sitemap), false);
});

test("save then load: files exist, brief is built, env name is the slug", async () => {
  const root = tmpDir();
  const r = await run(data(), root);
  const p = memoryPaths(HOST, root);
  assert.equal(r.sitemap, p.sitemap);
  assert.ok(fs.existsSync(p.md));
  assert.ok(fs.existsSync(path.join(r.runDir, "explore-memory.json")));
  const mem = loadMemory(HOST, root);
  assert.equal(mem.envName, HOST);
  assert.equal(mem.sitemap?.runs, 1);
  assert.match(mem.brief, /https:\/\/shop\.example\/b/);
});

test("two runs extend the map; an unreadable sitemap is backed up, not overwritten", async () => {
  const root = tmpDir();
  await run(data(), root);
  await run(data({ history: [step(1, "https://shop.example/b", ["https://shop.example/"])] }), root);
  assert.equal(loadMemory(HOST, root).sitemap?.runs, 2);
  const p = memoryPaths(HOST, root);
  fs.writeFileSync(p.sitemap, "{ not json");
  const mem = loadMemory(HOST, root);
  assert.equal(mem.sitemap, null);
  assert.match(mem.warnings.join(), /backup|bak/);
  const baks = fs.readdirSync(path.dirname(p.sitemap)).filter((f) => f.startsWith(`${p.slug}.sitemap.json.bak-`));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(p.sitemap), baks[0]!), "utf8"), "{ not json");
  assert.equal(fs.existsSync(p.sitemap), false);
});

test("an unknown sitemap version is treated as corrupt", () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  fs.mkdirSync(path.dirname(p.sitemap), { recursive: true });
  fs.writeFileSync(p.sitemap, JSON.stringify({ version: 99 }));
  const mem = loadMemory(HOST, root);
  assert.equal(mem.sitemap, null);
  assert.match(mem.warnings.join(), /backup|bak/);
  const baks = fs.readdirSync(path.dirname(p.sitemap)).filter((f) => f.startsWith(`${p.slug}.sitemap.json.bak-`));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(p.sitemap), baks[0]!), "utf8"), JSON.stringify({ version: 99 }));
});

test("a held lock saves pending-merge.json instead of losing the run", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  fs.mkdirSync(path.dirname(p.lock), { recursive: true });
  fs.writeFileSync(p.lock, "");
  const r = await run(data(), root, { lock: { tries: 2, delayMs: 5 } });
  assert.equal(r.sitemap, null);
  assert.match(r.warnings.join(), /lock/);
  assert.ok(fs.existsSync(path.join(r.runDir, "pending-merge.json")));
  assert.equal(fs.existsSync(p.sitemap), false);
});

test("a step-limited run adds pages but stales nothing, and a custom env file is updated in place", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  const seeded = emptySitemap(HOST);
  seeded.runs = 9;
  seeded.pages.push({
    url: "https://shop.example/old", title: "old", purpose: "", status: "ok", http_status: null, depth: 1,
    first_seen_run: 1, last_seen_run: 1, links: [], pattern: null,
  });
  fs.writeFileSync(p.sitemap, JSON.stringify(seeded));
  const envFile = path.join(root, "custom", "mine.md");
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, "# Mine\nhand-written\n");
  await run(data({ success: false, answer: "max steps reached" }), root, { envFile });
  const text = fs.readFileSync(envFile, "utf8");
  assert.ok(text.startsWith("# Mine\nhand-written\n"));
  assert.ok(text.includes("duckwright:generated:start"));
  assert.equal(fs.existsSync(p.md), false);
  const sm = loadMemory(HOST, root).sitemap!;
  assert.equal(sm.runs, 10);
  assert.ok(sm.pages.some((x) => x.url === "https://shop.example/a"));
  assert.equal(sm.pages.find((x) => x.url === "https://shop.example/old")?.status, "ok");
});

test("a completed run stales a long-unseen page (control for the step-limited test)", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  const seeded = emptySitemap(HOST);
  seeded.runs = 9;
  seeded.pages.push({
    url: "https://shop.example/old", title: "old", purpose: "", status: "ok", http_status: null, depth: 1,
    first_seen_run: 1, last_seen_run: 1, links: [], pattern: null,
  });
  fs.writeFileSync(p.sitemap, JSON.stringify(seeded));
  await run(data(), root);
  assert.equal(loadMemory(HOST, root).sitemap!.pages.find((x) => x.url === "https://shop.example/old")?.status, "stale");
});

test("a sitemap whose notes lack some kinds and external_links is accepted and normalised", () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  fs.writeFileSync(p.sitemap, JSON.stringify({
    version: 1, host: HOST, updated_run: "r", runs: 2, pages: [], flows: [], frontier: [], notes: { quirk: ["slow"] },
  }));
  const mem = loadMemory(HOST, root);
  assert.deepEqual(mem.warnings, []);
  assert.deepEqual(mem.sitemap?.notes, { business: [], quirk: ["slow"], "off-limits": [], account: [] });
  assert.deepEqual(mem.sitemap?.external_links, []);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes(".bak-")), []);
});

test("wrong shapes are corrupt", () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  const ok = { version: 1, host: HOST, updated_run: "", runs: 0, pages: [], flows: [], frontier: [], notes: {} };
  for (const bad of [null, [], { ...ok, pages: {} }, { ...ok, flows: null }, { ...ok, frontier: "x" }, { ...ok, notes: 3 }]) {
    fs.writeFileSync(p.sitemap, JSON.stringify(bad));
    assert.equal(loadMemory(HOST, root).sitemap, null);
  }
});

test("a throwing write propagates and releases the lock", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  const d = data();
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  const report = buildExploreReport(d, { url: "https://shop.example/", runDir, network: true });
  fs.rmSync(runDir, { recursive: true });
  await assert.rejects(saveMemory({ host: HOST, runDir, data: d, report, startUrl: "https://shop.example/", root }));
  assert.equal(fs.existsSync(p.lock), false);
});

test("failed pages match visited pages after url normalisation", async () => {
  const root = tmpDir();
  const net = (url: string) => ({ network: [{ method: "GET", url, status: 500, type: "document" }] });
  const d = data({
    history: [
      step(1, "https://shop.example/", [], {}),
      step(2, "https://shop.example/cart/?sid=1", [], net("https://shop.example/cart/?sid=1")),
      step(3, "https://shop.example/pricing/", [], net("https://shop.example/pricing/")),
    ],
  });
  const report = buildExploreReport(d, { url: "https://shop.example/", runDir: "r", network: true });
  const ev = buildEvidence(d, report, [], { host: HOST, runName: "r", startUrl: "https://shop.example/" });
  assert.deepEqual([...ev!.failedPages].sort(), ["https://shop.example/cart", "https://shop.example/pricing"]);
  await run(d, root);
  const sm = loadMemory(HOST, root).sitemap!;
  assert.equal(sm.pages.find((x) => x.url === "https://shop.example/cart")?.status, "broken");
  assert.equal(sm.pages.find((x) => x.url === "https://shop.example/pricing")?.status, "broken");
});

test("an existing but unreadable sitemap is never overwritten; the run goes to pending-merge.json", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  fs.mkdirSync(p.sitemap, { recursive: true });
  const mem = loadMemory(HOST, root);
  assert.equal(mem.sitemap, null);
  assert.equal(mem.brief, "");
  assert.match(mem.warnings.join(), /EISDIR/);
  assert.ok(mem.warnings.join().includes(p.sitemap));
  const r = await run(data(), root);
  assert.equal(r.sitemap, null);
  assert.equal(r.md, null);
  assert.match(r.warnings.join(), /EISDIR/);
  assert.ok(r.warnings.join().includes(p.sitemap));
  assert.ok(fs.existsSync(path.join(r.runDir, "pending-merge.json")));
  assert.ok(fs.statSync(p.sitemap).isDirectory());
  assert.equal(fs.existsSync(p.md), false);
  assert.equal(fs.existsSync(p.lock), false);
});

test("a rejected secret note is counted in explore-memory.json and never stored", async () => {
  const root = tmpDir();
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  const sink = new NoteSink(runDir, HOST);
  assert.match(sink.add(["account", "login password: hunter2hunter2"]), /^error:/);
  const d = data();
  const report = buildExploreReport(d, { url: "https://shop.example/", runDir, network: true });
  await saveMemory({ host: HOST, runDir, data: d, report, startUrl: "https://shop.example/", root });
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, "explore-memory.json"), "utf8"));
  assert.equal(summary.notes_rejected, 1);
  for (const f of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name), "utf8").includes("hunter2"), f.name);
  }
});

test("malformed page and flow entries are dropped without making the file corrupt", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  const goodPage = { url: "https://shop.example/", title: "Home", purpose: "", status: "ok", http_status: 200, depth: 0, first_seen_run: 1, last_seen_run: 1, links: [], pattern: null };
  fs.writeFileSync(p.sitemap, JSON.stringify({
    version: 1, host: HOST, updated_run: "r", runs: 1, frontier: [], notes: {},
    pages: [goodPage, null, 5, { url: 7 }, { url: "mailto:x@y.z", links: [] }, { url: "https://shop.example/nolinks" }, { url: "https://shop.example/badlinks", links: "x" }],
    flows: [null, { title: "x" }, { title: "Ok", start_url: "https://shop.example/", status: "ok" }],
  }));
  const mem = loadMemory(HOST, root);
  assert.ok(mem.sitemap);
  assert.deepEqual(mem.warnings, []);
  assert.deepEqual(mem.sitemap!.pages.map((x) => x.url).sort(), ["https://shop.example/", "https://shop.example/badlinks", "https://shop.example/nolinks"]);
  assert.ok(mem.sitemap!.pages.every((x) => Array.isArray(x.links)));
  assert.deepEqual(mem.sitemap!.flows.map((f) => f.title), ["Ok"]);
  const r = await run(data(), root);
  assert.ok(r.md, "save must succeed");
  assert.equal(r.warnings.length, 0);
});

test("an older sitemap without functions or created loads and gains empty lists", async () => {
  const root = tmpDir();
  await run(data(), root);
  const p = memoryPaths(HOST, root);
  const old = JSON.parse(fs.readFileSync(p.sitemap, "utf8"));
  delete old.functions;
  delete old.created;
  fs.writeFileSync(p.sitemap, JSON.stringify(old));
  const mem = loadMemory(HOST, root);
  assert.deepEqual(mem.sitemap?.functions, []);
  assert.deepEqual(mem.sitemap?.created, []);
  assert.deepEqual(mem.warnings, []);
});

test("malformed function and created entries are dropped, valid ones kept", async () => {
  const root = tmpDir();
  await run(data(), root);
  const p = memoryPaths(HOST, root);
  const sm = JSON.parse(fs.readFileSync(p.sitemap, "utf8"));
  sm.functions = [{ name: "Create recipe", status: "ok" }, { name: "", status: "ok" }, 5, { name: "X", status: "weird" }];
  sm.created = [{ name: "DW-1-A", url: "https://shop.example/r/1?x=1", removed: false, run: 1 }, { name: 5 }, null];
  fs.writeFileSync(p.sitemap, JSON.stringify(sm));
  const mem = loadMemory(HOST, root);
  assert.deepEqual(mem.sitemap?.functions.map((f) => [f.name, f.status]), [["Create recipe", "ok"], ["X", "untested"]]);
  assert.deepEqual(mem.sitemap?.created, [{ name: "DW-1-A", url: "https://shop.example/r/1", removed: false, run: 1 }]);
});

test("saveMemory merges the run's ledger, declared functions and reported functions", async () => {
  const root = tmpDir();
  const d = data({ answer: JSON.stringify({ flows: [], functions: [{ name: "Create recipe", area_url: "https://shop.example/r/create", status: "ok", steps: ["a"], expected: "e", notes: "" }] }) });
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  fs.writeFileSync(path.join(runDir, "notes.jsonl"), JSON.stringify({ step: 1, kind: "function", text: "Delete recipe", url: null }) + "\n");
  fs.writeFileSync(path.join(runDir, "created.jsonl"), JSON.stringify({ step: 2, created: "DW-1-Pasta", url: "https://shop.example/r/1" }) + "\n");
  const report = buildExploreReport(d, { url: "https://shop.example/", runDir, network: true });
  await saveMemory({ host: HOST, runDir, data: d, report, startUrl: "https://shop.example/", root });
  const sm = loadMemory(HOST, root).sitemap!;
  assert.deepEqual(sm.functions.map((f) => [f.name, f.status]).sort(), [["Create recipe", "ok"], ["Delete recipe", "untested"]]);
  assert.deepEqual(sm.created.map((c) => c.name), ["DW-1-Pasta"]);
});
