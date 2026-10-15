#!/usr/bin/env node
// Check that a project is ready for Duckwright and for the duckwright-tasks skill.
//
//   node doctor.mjs [--root <duckwright root>]      (root defaults to the current folder)
//
// Prints `ok|warn|fail: message`. Exit 0 = no failures, 1 = failures. Read-only; no dependencies; Node 22+.
// Never reads state files or .env* files: it only checks that state files exist.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ENV_MAX_BYTES = 16384; // src/environment.ts
const MAP_KEYS = new Set(["default-env", "write-envs", "investigate-envs", "data-prefix", "off-limits-terms", "allow-literals"]);
const STALE_AFTER_RUNS = 3; // src/explore: a page unseen this many runs is stale

let root = process.cwd();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--root") root = path.resolve(process.argv[++i] ?? ".");
  else { console.error("usage: doctor.mjs [--root DIR]"); process.exit(2); }
}

let failed = 0;
const say = (level, msg) => { if (level === "fail") failed++; console.log(`${level}: ${msg}`); };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const rel = (p) => path.relative(process.cwd(), p) || ".";

// 1. Tools.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj > 22 || (maj === 22 && min >= 18)) say("ok", `node ${process.versions.node}`);
else say("fail", `node ${process.versions.node}: Duckwright needs 22.18 or later`);
for (const [bin, fix, level] of [
  ["duckwright", "npm install -g duckwright", "fail"],
  ["playwright-cli", "npm i -g @playwright/cli@latest", "fail"],
  ["claude", "install Claude Code and log in", "fail"],
]) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) say(level, `${bin} not found on PATH: ${fix}`);
  else say("ok", `${bin} ${r.stdout.trim().split("\n")[0]}`);
}

// 2. Root layout.
if (!exists(path.join(root, "environments"))) say("fail", `no environments/ in ${rel(root)}: is this the Duckwright root? (run duckwright from the folder that holds it)`);
else say("ok", `root ${rel(root)}`);

// 3. Testing map.
const mapPath = path.join(root, ".duckwright", "testing-map.md");
const mapText = read(mapPath);
if (mapText === null) say("warn", `no testing map at ${rel(mapPath)}: run /duckwright-setup to write one`);
else {
  const m = /^---\n([\s\S]*?)\n---/.exec(mapText);
  if (!m) say("fail", `${rel(mapPath)}: front matter is missing or not closed with ---`);
  else {
    const seen = new Set();
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const key = t.split(":")[0].trim();
      if (!MAP_KEYS.has(key)) say("fail", `${rel(mapPath)}: unknown key "${key}" (allowed: ${[...MAP_KEYS].join(", ")})`);
      else if (seen.has(key)) say("fail", `${rel(mapPath)}: "${key}" is set twice`);
      seen.add(key);
    }
  }
  const todos = mapText.split("\n").filter((l) => /\bTODO\b/.test(l)).length;
  if (todos) say("warn", `${rel(mapPath)}: ${todos} line(s) still say TODO`);
  else say("ok", `testing map ${rel(mapPath)}`);
}

// 4. CLAUDE.md section, in the root or any parent up to the filesystem root.
let claude = null;
for (let d = root; ; d = path.dirname(d)) {
  const p = path.join(d, "CLAUDE.md");
  const t = read(p);
  if (t !== null && /^##\s+Duckwright\b/m.test(t)) { claude = { p, t }; break; }
  if (path.dirname(d) === d) break;
}
if (!claude) say("warn", "no `## Duckwright` section in a CLAUDE.md at or above the root: Claude sessions will not find the map");
else if (/<[^>\n]*(folder|path)[^>\n]*>/.test(claude.t)) say("warn", `${rel(claude.p)}: the Duckwright section still has <placeholders>`);
else say("ok", `CLAUDE.md section in ${rel(claude.p)}`);

// 5. Environment files.
const envDir = path.join(root, "environments");
const envFiles = exists(envDir) ? fs.readdirSync(envDir).filter((f) => f.endsWith(".md")) : [];
if (!envFiles.length && exists(envDir)) say("warn", "environments/ has no .md file: write one, or run duckwright explore <url>");
for (const f of envFiles) {
  const p = path.join(envDir, f);
  const size = fs.statSync(p).size;
  const t = read(p) ?? "";
  if (size > ENV_MAX_BYTES) say("fail", `${rel(p)}: ${size} bytes, over the ${ENV_MAX_BYTES} limit`);
  else if (size > ENV_MAX_BYTES * 0.8) say("warn", `${rel(p)}: ${size} bytes; explore needs room for its generated block`);
  else if (!t.trim()) say("fail", `${rel(p)} is empty`);
  else if (!/base url/i.test(t)) say("warn", `${rel(p)}: no "Base URL" section`);
  else say("ok", `${rel(p)} (${size} bytes)`);
  if (/\bTODO\b/.test(t)) say("warn", `${rel(p)}: still says TODO`);
}

// 6. .gitignore keeps state files out of git.
let ignored = false;
for (let d = root; ; d = path.dirname(d)) {
  const t = read(path.join(d, ".gitignore"));
  if (t !== null && t.split("\n").some((l) => /^\/?(.*\/)?\.auth\/?\*?$/.test(l.trim()))) { ignored = true; break; }
  if (exists(path.join(d, ".git")) || path.dirname(d) === d) break;
}
say(ignored ? "ok" : "warn", ignored ? ".auth/ is git-ignored" : ".auth/ is not in .gitignore: state files hold session cookies");

// 7. State files that tasks name must exist (a person makes them).
const taskRoot = path.join(root, "tasks");
const missing = new Set();
let taskCount = 0;
(function walk(d) {
  if (!exists(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(md|txt)$/.test(e.name)) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(read(p) ?? "");
      const s = fm && /^state:\s*(\S+)/m.exec(fm[1]);
      if (fm) taskCount++;
      if (s && !exists(path.resolve(d, s[1]))) missing.add(path.resolve(d, s[1]));
    }
  }
})(taskRoot);
if (missing.size) for (const p of missing) say("warn", `state file missing: ${rel(p)} (log in once and save it; a run fails preflight without it)`);
else if (taskCount) say("ok", `state files for ${taskCount} task(s) are present`);

// 8. Sitemaps from explore.
for (const f of exists(envDir) ? fs.readdirSync(envDir).filter((f) => f.endsWith(".sitemap.json")) : []) {
  const p = path.join(envDir, f);
  let m;
  try { m = JSON.parse(read(p)); } catch (e) { say("fail", `${rel(p)}: not valid JSON (${e.message})`); continue; }
  if (m.version !== 1) { say("warn", `${rel(p)}: version ${m.version}, expected 1`); continue; }
  const stale = (m.pages ?? []).filter((q) => (m.runs ?? 0) - (q.last_seen_run ?? m.runs) >= STALE_AFTER_RUNS).length;
  const left = (m.created ?? []).filter((c) => !c.removed).length;
  say(stale ? "warn" : "ok", `${rel(p)}: ${(m.pages ?? []).length} pages after ${m.runs} run(s)${stale ? `, ${stale} not seen for ${STALE_AFTER_RUNS}+ runs: run duckwright explore again` : ""}`);
  if (left) say("warn", `${rel(p)}: ${left} item(s) created by earlier explore runs were never removed: clean them up before running write tasks`);
}

// 9. Facts memory of the duckwright-tasks skill (references/memory.md).
const factsDir = path.join(root, ".duckwright", "facts");
for (const f of exists(factsDir) ? fs.readdirSync(factsDir).filter((f) => f.endsWith(".jsonl")) : []) {
  const p = path.join(factsDir, f);
  const ids = new Map();
  let bad = 0;
  for (const line of read(p).split("\n")) {
    if (!line.trim()) continue;
    try { const x = JSON.parse(line); ids.set(x.id, x); } catch { bad++; }
  }
  const now = new Date().toISOString().slice(0, 10);
  const live = [...ids.values()].filter((x) => x.status !== "retired");
  const due = live.filter((x) => x.verify_after && x.verify_after < now).length;
  say(bad ? "warn" : "ok", `${rel(p)}: ${live.length} fact(s)${due ? `, ${due} past their re-verify date` : ""}${bad ? `, ${bad} damaged line(s) skipped` : ""}`);
}
const ga = path.join(root, ".gitattributes");
if (exists(factsDir) && !(exists(ga) && /facts\/\*\.jsonl\s+merge=union/.test(read(ga)))) {
  say("warn", `${rel(ga)}: add ".duckwright/facts/*.jsonl merge=union" so teammates' appended facts merge without conflicts`);
}

console.log(failed ? `\n${failed} failure(s)` : "\nno failures");
process.exit(failed ? 1 : 0);
