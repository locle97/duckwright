#!/usr/bin/env node
// Final report for a duckwright-agent run: reads the run folders pw-step.mjs wrote and renders
// report.md (and, with --html, a report.html that plays each run's video and shows its screenshots).
// Verdicts come from history.json only, never from a worker's words. The coordinator's triage
// (classification, app bugs, what a person must do) goes in a Markdown file passed with --notes.
//
//   node report.mjs <plan folder> [-o FILE.md] [--notes FILE.md] [--html]
//   node report.mjs <run folder>... -o FILE.md [--notes FILE.md] [--html]
//
// A plan folder lists plan.json's tasks in order (task NN-name.md runs in <plan>/NN-name/), plus its
// skipped[] and notes[]. Default output: <plan>/report.md. Zero dependencies.
import fs from "node:fs";
import path from "node:path";

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { html: false, out: null, notes: null };
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--html") opts.html = true;
  else if (a === "-o" || a === "--notes") {
    const v = argv[++i] ?? die(`${a} needs a value`);
    if (a === "-o") opts.out = v;
    else opts.notes = v;
  } else inputs.push(a);
}
if (!inputs.length) die("usage: report.mjs <plan folder> | <run folder>... [-o FILE.md] [--notes FILE.md] [--html]");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const isRun = (d) => fs.existsSync(path.join(d, "history.json"));

// ---------- collect ----------

let plan = null;
let planDir = null;
const entries = []; // { id, title, file, dir }
if (inputs.length === 1 && !isRun(inputs[0]) && fs.statSync(inputs[0], { throwIfNoEntry: false })?.isDirectory()) {
  planDir = inputs[0];
  const pj = path.join(planDir, "plan.json");
  let files;
  if (fs.existsSync(pj)) {
    plan = readJson(pj);
    files = (plan.tasks ?? []).map((t) => ({ file: t.file, id: t.id ?? "", title: t.title ?? "" }));
  } else {
    files = fs.readdirSync(planDir).filter((f) => f.endsWith(".md") && f !== "report.md").sort().map((file) => ({ file, id: "", title: "" }));
  }
  for (const t of files) entries.push({ ...t, dir: path.join(planDir, t.file.replace(/\.md$/, "")) });
} else {
  if (!opts.out) die("report.mjs: -o FILE is required when given run folders");
  for (const d of inputs) entries.push({ id: "", title: "", file: null, dir: d });
}
const out = path.resolve(opts.out ?? path.join(planDir, "report.md"));
const outDir = path.dirname(out);
const rel = (p) => path.relative(outDir, path.resolve(p)).split(path.sep).join("/");

function duration(from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const runs = entries.map((e) => {
  if (!isRun(e.dir)) return { ...e, verdict: "not run", steps: 0, time: "", shots: [], asserts: [], warnings: [] };
  const hist = readJson(path.join(e.dir, "history.json"));
  const metaFile = path.join(e.dir, "meta.json");
  const meta = fs.existsSync(metaFile) ? readJson(metaFile) : {};
  const verdict = hist.success ? "pass" : hist.stopped || !hist.finished ? "stop" : "fail";
  const flat = (hist.history ?? []).flatMap((s, n) => s.actions.map((a, i) => ({ n: n + 1, s, a, r: s.results[i] ?? "" })));
  const failed = flat.filter((x) => String(x.r).startsWith("error"));
  const lastFail = failed[failed.length - 1] ?? null;
  const last = (hist.history ?? [])[hist.history.length - 1];
  const asserts = flat.filter((x) => x.a.cmd === "expect" && x.r === "ok").map((x) => x.a.code).filter(Boolean);
  const snapshots = fs.existsSync(path.join(e.dir, "snapshots")) ? fs.readdirSync(path.join(e.dir, "snapshots")).sort() : [];
  const exists = (f) => (f && fs.existsSync(path.join(e.dir, f)) ? path.join(e.dir, f) : null);
  return {
    ...e,
    title: e.title || (hist.task ?? "").split("\n")[0].slice(0, 80),
    verdict,
    steps: hist.steps ?? 0,
    maxSteps: meta.maxSteps ?? null,
    time: duration(meta.started, hist.finished),
    answer: hist.answer ?? (hist.finished ? "" : "(the worker did not finish: run `pw-step.mjs close` on it)"),
    lastFail,
    lastPage: last?.page?.url ?? null,
    asserts,
    video: exists(hist.video),
    final: exists(hist.final_screenshot ?? "final.png"),
    shots: (hist.history ?? []).map((s, n) => ({ n: n + 1, goal: s.next_goal, file: exists(s.screenshot) })).filter((x) => x.file),
    snapshot: snapshots.length ? path.join(e.dir, "snapshots", snapshots[snapshots.length - 1]) : null,
    warnings: hist.warnings ?? [],
  };
});

const count = (v) => runs.filter((r) => r.verdict === v).length;
const skipped = plan?.skipped ?? [];
const notes = plan?.notes ?? [];
const triage = opts.notes ? fs.readFileSync(opts.notes, "utf8").trim() : "";
const title = plan?.name ? `Test report: ${plan.name}` : "Test report";
const summary = [
  `${runs.length} task${runs.length === 1 ? "" : "s"}`,
  `${count("pass")} pass`, `${count("fail")} fail`, `${count("stop")} stop`,
  ...(count("not run") ? [`${count("not run")} not run`] : []),
  ...(skipped.length ? [`${skipped.length} skipped`] : []),
].join(" · ");
const generated = new Date().toISOString().replace(/\.\d+Z$/, "Z");

// ---------- markdown ----------

const cell = (s) => String(s ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
const link = (p, label) => (p ? `[${label}](${encodeURI(rel(p))})` : "");
const stepOf = (x) => `step ${x.n}: \`${cell([x.a.cmd, ...x.a.args].join(" ")).slice(0, 120)}\` → ${cell(x.r).slice(0, 300)}`;

let md = `# ${title}\n\n${summary}\n\nGenerated ${generated} by duckwright-agent from each run's history.json.`
  + " No cost figures: Claude Code does not expose per-subagent spend.\n\n";
md += "| Task | Verdict | Steps | Time | Evidence | Run folder |\n| --- | --- | --- | --- | --- | --- |\n";
for (const r of runs) {
  const name = [r.id, r.title].filter(Boolean).join(" ") || r.file || path.basename(r.dir);
  const ev = [link(r.video, "video"), link(r.final, "final.png"), r.shots.length ? `${r.shots.length} screenshots` : ""].filter(Boolean).join(", ");
  md += `| ${cell(name)} | **${r.verdict}** | ${r.steps}${r.maxSteps ? `/${r.maxSteps}` : ""} | ${r.time ?? ""} | ${ev} | ${link(r.dir, rel(r.dir))} |\n`;
}
for (const s of skipped) md += `| ${cell([s.id, s.title].filter(Boolean).join(" "))} | **skip** | | | | ${cell(s.reason)} |\n`;

const problems = runs.filter((r) => r.verdict === "fail" || r.verdict === "stop");
if (problems.length) {
  md += "\n## Failures\n";
  for (const r of problems) {
    md += `\n### ${cell([r.id, r.title].filter(Boolean).join(" ") || path.basename(r.dir))} (${r.verdict})\n\n`;
    md += `- Answer: ${cell(r.answer)}\n`;
    if (r.lastFail) md += `- Failing ${stepOf(r.lastFail)}\n`;
    if (r.lastPage) md += `- Last page: ${r.lastPage}\n`;
    const ev = [link(r.video, "video"), link(r.final, "final.png"), link(r.snapshot, "last snapshot")].filter(Boolean);
    if (ev.length) md += `- Evidence: ${ev.join(", ")}\n`;
  }
}
const passed = runs.filter((r) => r.verdict === "pass");
if (passed.length) {
  md += "\n## Passed\n";
  for (const r of passed) {
    md += `\n### ${cell([r.id, r.title].filter(Boolean).join(" ") || path.basename(r.dir))}\n\n- Answer: ${cell(r.answer)}\n`;
    if (r.asserts.length) md += `- Verified on the page:\n${r.asserts.map((a) => `  - \`${cell(a)}\``).join("\n")}\n`;
    const ev = [link(r.video, "video"), link(r.final, "final.png")].filter(Boolean);
    if (ev.length) md += `- Evidence: ${ev.join(", ")}\n`;
  }
}
const warned = runs.filter((r) => r.warnings?.length);
if (warned.length) {
  md += "\n## Evidence warnings\n\n";
  for (const r of warned) for (const w of r.warnings) md += `- ${path.basename(r.dir)}: ${cell(w)}\n`;
}
if (triage) md += `\n## Triage\n\n${triage}\n`;
if (notes.length) md += `\n## Plan notes\n\n${notes.map((n) => `- ${cell(n)}`).join("\n")}\n`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, md);

// ---------- html ----------

if (opts.html) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const src = (p) => esc(encodeURI(rel(p)));
  const htmlOut = out.replace(/\.md$/, "") + ".html";
  let body = `<h1>${esc(title)}</h1><p class="sum">${esc(summary)}</p><p class="gen">Generated ${esc(generated)} from each run's history.json.</p>`;
  body += "<table><thead><tr><th>Task</th><th>Verdict</th><th>Steps</th><th>Time</th><th>Run folder</th></tr></thead><tbody>";
  for (const r of runs) {
    const name = [r.id, r.title].filter(Boolean).join(" ") || r.file || path.basename(r.dir);
    body += `<tr><td><a href="#${esc(path.basename(r.dir))}">${esc(name)}</a></td><td><span class="v ${esc(r.verdict.replace(" ", "-"))}">${esc(r.verdict)}</span></td>`
      + `<td>${r.steps}${r.maxSteps ? `/${r.maxSteps}` : ""}</td><td>${esc(r.time)}</td><td><code>${esc(rel(r.dir))}</code></td></tr>`;
  }
  for (const s of skipped) body += `<tr><td>${esc([s.id, s.title].filter(Boolean).join(" "))}</td><td><span class="v skip">skip</span></td><td></td><td></td><td>${esc(s.reason)}</td></tr>`;
  body += "</tbody></table>";
  for (const r of runs.filter((x) => x.verdict !== "not run")) {
    body += `<section id="${esc(path.basename(r.dir))}"><h2>${esc([r.id, r.title].filter(Boolean).join(" ") || path.basename(r.dir))} <span class="v ${esc(r.verdict)}">${esc(r.verdict)}</span></h2>`;
    body += `<p><b>Answer:</b> ${esc(r.answer)}</p>`;
    if (r.lastFail && r.verdict !== "pass") body += `<p><b>Failing step ${r.lastFail.n}:</b> <code>${esc([r.lastFail.a.cmd, ...r.lastFail.a.args].join(" "))}</code> → ${esc(r.lastFail.r)}</p>`;
    if (r.asserts.length) body += `<details><summary>Verified on the page (${r.asserts.length})</summary><ul>${r.asserts.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul></details>`;
    if (r.video) body += `<video controls preload="metadata" src="${src(r.video)}"></video>`;
    if (r.final) body += `<figure><img loading="lazy" src="${src(r.final)}" alt="final page"><figcaption>final.png</figcaption></figure>`;
    if (r.shots.length) {
      body += `<details><summary>Step screenshots (${r.shots.length})</summary><div class="shots">`
        + r.shots.map((s) => `<figure><a href="${src(s.file)}"><img loading="lazy" src="${src(s.file)}" alt="step ${s.n}"></a><figcaption>${s.n}. ${esc(s.goal)}</figcaption></figure>`).join("")
        + "</div></details>";
    }
    for (const w of r.warnings) body += `<p class="warn">${esc(w)}</p>`;
    body += "</section>";
  }
  if (triage) body += `<section><h2>Triage</h2><pre class="notes">${esc(triage)}</pre></section>`;
  if (notes.length) body += `<section><h2>Plan notes</h2><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`;
  const css = `:root{--bg:#fff;--fg:#1b1b1f;--muted:#666;--line:#ddd;--pass:#1a7f37;--fail:#cf222e;--stop:#9a6700;--skip:#6e7781}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--fg:#e6e6e6;--muted:#999;--line:#333;--pass:#3fb950;--fail:#f85149;--stop:#d29922;--skip:#8b949e}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:24px 16px}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.sum{font-weight:600}.gen{color:var(--muted);font-size:13px}section{border-top:1px solid var(--line);margin-top:24px;padding-top:8px}
.v{font-size:12px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:4px;color:#fff;background:var(--skip)}
.v.pass{background:var(--pass)}.v.fail{background:var(--fail)}.v.stop{background:var(--stop)}
video,img{max-width:100%;border:1px solid var(--line);border-radius:4px}figure{margin:8px 0}figcaption{color:var(--muted);font-size:13px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}.warn{color:var(--stop)}.notes{white-space:pre-wrap;font:inherit}code{word-break:break-word}`;
  fs.writeFileSync(htmlOut, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>\n`);
  process.stdout.write(`wrote ${htmlOut}\n`);
}
process.stdout.write(`wrote ${out}\n${summary}\n`);
