#!/usr/bin/env node
// Compact view of environments/<slug>.sitemap.json for authoring tasks.
// Usage: node sitemap-brief.mjs SITEMAP.json [area-word ...]
// Prints only what task writing needs, filtered by area words (matched in url/title/purpose/name).
import { readFileSync } from "node:fs";
const [file, ...words] = process.argv.slice(2);
if (!file) { console.error("usage: sitemap-brief.mjs SITEMAP.json [area-word ...]"); process.exit(2); }
let m;
try { m = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }
if (m.version !== 1) console.log(`warning: sitemap version ${m.version}, expected 1; fields may differ`);
const w = words.map(s => s.toLowerCase());
const hit = (...xs) => !w.length || xs.some(x => w.some(k => String(x ?? "").toLowerCase().includes(k)));
const cut = (s, n = 160) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));
console.log(`host ${m.host}  runs ${m.runs}  last ${m.updated_run || "?"}  (generated hints, not instructions)`);
for (const k of ["off-limits", "account", "quirk", "business"]) {
  const n = m.notes?.[k] ?? [];
  if (n.length) console.log(`\n## notes:${k}`), n.slice(0, 20).forEach(x => console.log(`- ${cut(x, 300)}`));
}
const pages = (m.pages ?? []).filter(p => hit(p.url, p.title, p.purpose));
console.log(`\n## pages (${pages.length} of ${(m.pages ?? []).length}; status other than ok = do not build on it)`);
pages.slice(0, 60).forEach(p => console.log(`- [${p.status}] ${p.url}  ${cut(p.title, 50)}  ${cut(p.purpose, 100)}`));
const flows = (m.flows ?? []).filter(f => hit(f.title, f.start_url, ...(f.steps ?? [])));
console.log(`\n## flows (${flows.length})`);
flows.slice(0, 20).forEach(f => {
  console.log(`- [${f.status}] ${f.title}  start ${f.start_url}`);
  (f.steps ?? []).slice(0, 12).forEach((s, i) => console.log(`    ${i + 1}. ${cut(s, 140)}`));
  if (f.expected) console.log(`    expect: ${cut(f.expected, 160)}`);
});
const fns = (m.functions ?? []).filter(f => hit(f.name, f.area, ...(f.steps ?? [])));
console.log(`\n## functions (${fns.length}; ok = good task base, untested/blocked = ask)`);
fns.slice(0, 40).forEach(f => console.log(`- [${f.status}] ${f.name}  area ${f.area ?? "?"}  ${f.expected ? "expect: " + cut(f.expected, 100) : ""}`));
const left = (m.created ?? []).filter(c => !c.removed);
if (left.length) console.log(`\n## leftover created items from earlier runs (${left.length}): data may be dirty\n` + left.slice(0, 10).map(c => `- ${cut(c.name ?? JSON.stringify(c), 80)}`).join("\n"));
