#!/usr/bin/env node
// Compact inventory of Duckwright run history for turning runs into Playwright tests.
// Usage: node runs-brief.mjs PATH [--code]
// PATH is a plan folder (tasks/<plan>/, has plan.json and one folder per task), a run-tasks folder
// (tasks/<plan>/<task>/ or runs/), or one run folder / history.json. Read-only.
// Prints one block per run: verdict, task, env, state file, every action's recorded code (with --code),
// assertions, API calls, and what the export cannot replay. history.json is never printed whole.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const withCode = args.includes("--code");
const target = args.find((a) => !a.startsWith("--"));
if (!target) { console.error("usage: runs-brief.mjs PATH [--code]"); process.exit(2); }

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const cut = (s, n = 140) => { const t = String(s ?? "").replace(/\s+/g, " "); return t.length > n ? t.slice(0, n) + "…" : t; };

function find(dir, depth) {
  if (!isDir(dir)) return [];
  if (existsSync(path.join(dir, "history.json"))) return [dir];
  if (depth === 0) return [];
  return readdirSync(dir).sort().flatMap((n) => (n.startsWith(".") || n === "node_modules" ? [] : find(path.join(dir, n), depth - 1)));
}

let runs;
if (/history\.json$/.test(target)) runs = [path.dirname(target)];
else runs = find(target, 3);
if (!runs.length) { console.error(`no history.json under ${target}`); process.exit(1); }

const plan = isDir(target) ? readJson(path.join(target, "plan.json")) : null;
if (plan) {
  console.log(`plan ${plan.name}  source: ${cut(plan.source)}`);
  (plan.notes ?? []).forEach((n) => console.log(`  note: ${cut(n, 200)}`));
  (plan.skipped ?? []).forEach((s) => console.log(`  skipped in plan: ${s.id} ${s.title} (${cut(s.reason)})`));
  const withRun = new Set(runs.map((r) => path.basename(r)));
  for (const t of plan.tasks ?? []) {
    const stem = t.file.replace(/\.md$/, "");
    if (!withRun.has(stem)) console.log(`  NO RUN for task ${t.id} ${t.file} (not run yet): nothing to convert`);
  }
  console.log();
}

let convertible = 0;
for (const dir of runs) {
  const h = readJson(path.join(dir, "history.json"));
  if (!h || !Array.isArray(h.history)) { console.log(`## ${dir}\n  unreadable history.json: skip\n`); continue; }
  const planTask = plan?.tasks?.find((t) => t.file.replace(/\.md$/, "") === path.basename(dir));
  const flags = [];
  let asserts = 0, reqAsserts = 0, setups = 0, manual = 0, tabs = 0, noCode = 0;
  const lines = [];
  h.history.forEach((s, i) => {
    for (const [j, a] of (s.actions ?? []).entries()) {
      const res = String(s.results?.[j] ?? "");
      const ok = res === "ok" || res.startsWith("ok");
      if (a.cmd === "expect") asserts++;
      else if (a.cmd === "expect-request") reqAsserts++;
      else if (a.cmd === "request") setups++;
      else if (a.cmd === "twofa" && ["sms", "email", "passkey"].includes(a.args?.[0])) manual++;
      else if (/^tab-/.test(a.cmd)) tabs++;
      else if (!a.code && ok && !["done", "note", "screenshot", "snapshot", "wait"].includes(a.cmd)) noCode++;
      lines.push(`    ${i + 1}.${j + 1} ${a.cmd} ${cut((a.args ?? []).join(" "), 80)}${ok ? "" : `  [${cut(res, 60)}]`}${withCode && a.code ? `\n        ${cut(a.code, 300)}` : ""}`);
    }
  });
  if (!h.success) flags.push("run FAILED: do not convert");
  else convertible++;
  if (asserts + reqAsserts === 0) flags.push("no assertions recorded");
  if (setups) flags.push(`${setups} request setup call(s): need storageState/cookies`);
  if (tabs) flags.push(`${tabs} tab command(s): hand-edit, single page assumed`);
  if (manual) flags.push(`${manual} manual 2FA step(s): cannot run unattended`);
  if (noCode) flags.push(`${noCode} ok action(s) with no recorded code (state file or similar)`);
  console.log(`## ${planTask ? `${planTask.id} ${planTask.title}` : path.basename(dir)}  [${h.success ? "success" : "failure"}]`);
  console.log(`  run folder: ${dir}${existsSync(path.join(dir, "duckwright.spec.ts")) ? "  (has duckwright.spec.ts)" : ""}`);
  console.log(`  task: ${cut(h.task, 200)}`);
  console.log(`  task file: ${h.task_file ?? "(inline)"}  steps ${h.steps}  asserts ${asserts}  api-asserts ${reqAsserts}  answer: ${cut(h.answer, 100)}`);
  if (h.env?.path) console.log(`  env: ${h.env.path}`);
  flags.forEach((f) => console.log(`  ! ${f}`));
  lines.forEach((l) => console.log(l));
  console.log();
}
console.log(`${runs.length} run(s), ${convertible} convertible (successful)`);
