#!/usr/bin/env node
// Lint Duckwright task files against the harness's limits and the project's testing map.
//
//   node check-tasks.mjs --root <duckwright root> [--map <file>] [--sitemap <file>] <file|folder>...
//
// --root is the folder `duckwright` is run from (bare `env:` names resolve to <root>/environments/).
// --map defaults to <root>/.duckwright/testing-map.md when it exists; --sitemap is optional (the skill passes
// environments/<slug>.sitemap.json). Folders are read like `duckwright -f`: root-level .md/.txt files, plus plan.json.
//
// Prints `path:line: error|warn: message`. Exit 0 = no errors, 1 = errors, 2 = bad usage.
// No dependencies; Node 22+. Read-only: it never writes a file.

import fs from "node:fs";
import path from "node:path";

// Mirrors src/taskfile.ts KEYS. test/skill-check.test.ts fails when they drift.
export const KEYS = {
  "max-steps": "int", model: "str", headed: "bool", skill: "path", session: "str", state: "path",
  network: "bool", video: "bool", screenshot: "bool", "twofa-timeout": "int", jev: "bool", debug: "bool",
  "jev-threshold": "threshold", snapshot: "snapshot", env: "env", accounts: "accounts", setup: "path",
};
export const ENV_MAX_BYTES = 16384; // src/environment.ts
const MAP_KEYS = new Set(["default-env", "write-envs", "investigate-envs", "data-prefix", "off-limits-terms", "allow-literals"]);

// Things one browser driven through the allow-list cannot do (prompts/system.md "Commands").
const ERRORS = [
  [/\b(run|execute|type)\s+(`|the\s+)?(npm|npx|yarn|pnpm|node|python|curl|wget|make|docker|psql|mysql|rails|bash|sh|script|command|migration)\b/i, "needs a shell: the agent has no shell. Move it to plan.json notes for a person"],
  [/\b(terminal|command line|shell)\b/i, "mentions a terminal or shell: the agent has none"],
  [/\b(sql|psql|database|db table|redis|mongo(db)?)\b/i, "needs database access: seed through the UI or list it as a note for a person"],
  [/\b(upload|attach (a|the) file|choose (a )?file)\b/i, "file upload: `upload` is not an allowed command"],
  [/\b(incognito|private window|second browser|another browser|other browser|two browsers)\b/i, "needs a second browser: each task has exactly one browser session"],
  [/\bfile:\/\/|\b(read|open|edit|create) the file\b/i, "needs file access: the agent cannot read or write files"],
];
ERRORS.push(
  [/\{\{[^}]*\}\}|\bTODO\b|\bTBD\b|<your [^>]*>|<[a-z ]*here>/i, "placeholder text: a task must be complete; use a real value or ask"],
  [/\b(close|quit|exit) (the )?browser\b|\bnew browser (session|context)\b/i, "the harness opens and closes the browser; remove this step"],
);
const WARNINGS = [
  [/\b(looks?|seems?|appears?) (good|right|correct|fine|ok(ay)?)\b|\bworks? (correctly|properly)\b|\bas expected\b/i, "vague check: name the exact text, value, state, URL or API status to expect"],
  [/\b(inbox|mailbox|check (the|your) e-?mail|open the e-?mail|sms|text message)\b/i, "needs an inbox: only works if the testing map names a web mail catcher the browser can open"],
  [/\b(reload|refresh) the page\b/i, "there is no reload command: write \"Open <url> again\""],
  [/\b(new tab|another tab|second tab|switch to the .*tab)\b/i, "tabs: tab-new/tab-select export as // TODO(duckwright); avoid unless the test is about tabs"],
  [/\b(download(ed|s)?)\b/i, "downloads cannot be opened or inspected by the agent"],
  [/\bwait (for )?\d+ ?(s|sec|seconds?|min|minutes?|hours?)\b|\b(tomorrow|next day|overnight)\b/i, "long waits: there is no wait command and steps are capped by max-steps"],
  [/\b(alert|confirm|prompt) (dialog|box|popup)\b|\bnative dialog\b/i, "native browser dialogs: dialog-accept/dismiss are not allowed commands; check the map says how the app behaves"],
  [/\[data-(testid|test|cy|qa)|data-testid=|\bgetBy[A-Z]\w*\(|\bxpath\b|\bquerySelector|css selector|\/\/(div|span|button|input|a)\b/i, "selector in a step: the agent clicks refs from the accessibility snapshot; name the element by its visible label instead"],
];
// {{<id>.username}} and {{<id>.password}}: README "Accounts"; the id rule matches src/accounts/store.ts ID_RE.
const ACCOUNT_PLACEHOLDER = /\{\{[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.(username|password)\}\}/g;
// {{BASE_URL}}: the run fills in its environment's base URL (src/baseUrl.ts), so a task runs on any environment.
const BASE_URL = "{{BASE_URL}}";
const SECRETS = [
  /\b(pass(word|wd)?|secret|token|api[-_ ]?key|otp|pin)\b\s*[:=]\s*\S+/i,
  /\bpass(word|wd)?\s+(is\s+)?["'`][^"'`]+["'`]/i,
  /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{32,}\b/,
  /\bbearer\s+[A-Za-z0-9\-._~+/]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/,
];
const API_CHECK = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/[\w\/:.-]*/;
const CREATES = /\b(create|add a new|register|sign up|new (item|record|post|product|user))\b/i;

const out = [];
const report = (file, line, level, msg) => out.push({ file, line, level, msg });

function readUtf8(p) {
  return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
}

function exists(p, kind = "file") {
  try {
    const s = fs.statSync(p);
    return kind === "file" ? s.isFile() : s.isDirectory();
  } catch {
    return false;
  }
}

/** Flat `key: value` front matter, with the comment and quote rules of src/taskfile.ts. */
function splitFrontMatter(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0].trimEnd() !== "---") return { fm: [], body: lines, bodyStart: 1, closed: true };
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (close === -1) return { fm: [], body: [], bodyStart: 1, closed: false };
  return {
    fm: lines.slice(1, close).map((l, i) => [i + 2, l]),
    body: lines.slice(close + 1),
    bodyStart: close + 2,
    closed: true,
  };
}

function fmValue(raw) {
  const v = raw.trim();
  if (v[0] === "'" || v[0] === '"') {
    const end = v.indexOf(v[0], 1);
    if (end === -1) return { error: "bad quoted value" };
    return { value: v.slice(1, end) };
  }
  const m = /\s#/.exec(raw);
  return { value: (m ? raw.slice(0, m.index) : raw).trim() };
}

function parseFlat(fm, file, allowed) {
  const settings = {};
  for (const [n, line] of fm) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const key = colon === -1 ? s : line.slice(0, colon).trim();
    if (colon === -1 || !key) { report(file, n, "error", 'expected "key: value"'); continue; }
    if (key === "allow-file-access") { report(file, n, "error", "allow-file-access can only be passed on the command line"); continue; }
    if (!allowed(key)) { report(file, n, "error", `unknown setting "${key}"`); continue; }
    if (key in settings) { report(file, n, "error", `"${key}" is set twice`); continue; }
    const { value, error } = fmValue(line.slice(colon + 1));
    if (error) { report(file, n, "error", error); continue; }
    if (!value) { report(file, n, "error", `"${key}" has no value`); continue; }
    settings[key] = { value, line: n };
  }
  return settings;
}

const isEnvPath = (v) => v.includes("/") || v.includes(path.sep) || /\.md$/i.test(v);
const isEnvName = (v) => !isEnvPath(v) && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(v);

function checkValue(file, key, { value: v, line }) {
  const kind = KEYS[key];
  const bad = (m) => report(file, line, "error", m);
  if (kind === "int" && !(/^[0-9]+$/.test(v) && Number(v) >= 1)) bad(`${key} must be a whole number of at least 1`);
  if (key === "twofa-timeout" && Number(v) > 2147483) bad("twofa-timeout must be at most 2147483");
  if (kind === "bool" && v !== "true" && v !== "false") bad(`${key} must be true or false`);
  if (kind === "snapshot" && !["hybrid", "full", "grep"].includes(v)) bad(`${key} must be full, grep or hybrid`);
  if (kind === "threshold" && !(Number(v) > 0 && Number(v) <= 1)) bad(`${key} must be greater than 0 and at most 1`);
  if (kind === "accounts" && !v.split(",").every((id) => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id.trim()))) bad(`${key} must be comma-separated account ids`);
  if (kind === "env" && v !== "none" && !isEnvName(v) && !isEnvPath(v)) bad("env must be an environment name or a path");
}

/** Validates an environment file; returns its text (or null). */
function checkEnvFile(p, from, line) {
  if (!exists(p)) { report(from, line, "error", `environment file not found: ${p}`); return null; }
  const size = fs.statSync(p).size;
  if (size > ENV_MAX_BYTES) report(p, 0, "error", `environment file too large: ${size} bytes (limit ${ENV_MAX_BYTES})`);
  else if (size > ENV_MAX_BYTES * 0.8) report(p, 0, "warn", `environment file is ${size} bytes; explore needs room for its generated block under ${ENV_MAX_BYTES}`);
  let text;
  try { text = readUtf8(p); } catch { report(p, 0, "error", "environment file is not valid UTF-8"); return null; }
  if (!text.trim()) { report(p, 0, "error", "environment file is empty"); return null; }
  text.split("\n").forEach((l, i) => {
    if (SECRETS.some((re) => re.test(l)) && !allowLiteral(l)) report(p, i + 1, "error", "looks like a secret; name where the credential comes from instead");
  });
  return text;
}

let MAP = { settings: {}, terms: [], literals: [], prefix: null };
const allowLiteral = (line) => MAP.literals.some((lit) => lit && line.includes(lit));

function loadMap(p) {
  let text;
  try { text = readUtf8(p); } catch (e) { report(p, 0, "error", `cannot read testing map: ${e.message}`); return; }
  const { fm, closed } = splitFrontMatter(text);
  if (!closed) { report(p, 1, "error", "front matter is not closed with ---"); return; }
  const s = parseFlat(fm, p, (k) => MAP_KEYS.has(k));
  const list = (k) => (s[k]?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  MAP = { settings: s, terms: list("off-limits-terms"), literals: list("allow-literals"), prefix: s["data-prefix"]?.value ?? null };
}

function loadSitemap(p) {
  try {
    const sm = JSON.parse(fs.readFileSync(p, "utf8"));
    if (sm.version !== 1 || !Array.isArray(sm.pages)) throw new Error("not a version 1 sitemap");
    const paths = new Map();
    for (const pg of sm.pages) {
      if (pg.status === "external") continue;
      const u = new URL(pg.url);
      paths.set(u.pathname, pg.status);
      if (pg.pattern) paths.set(pg.pattern, pg.status);
    }
    return { host: sm.host, paths };
  } catch (e) {
    report(p, 0, "warn", `sitemap not used: ${e.message}`);
    return null;
  }
}

function pathKnown(sitemap, pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (sitemap.paths.has(p)) return sitemap.paths.get(p);
  for (const [k, st] of sitemap.paths) {
    if (!k.includes(":")) continue;
    const re = new RegExp("^" + k.split("/").map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$");
    if (re.test(p)) return st;
  }
  return null;
}

function baseUrlOf(envText) {
  const m = /base url[^\n]*\n*\s*(?:[-*]\s*)?<?(https?:\/\/[^\s)>]+)/i.exec(envText ?? "");
  try { return m ? new URL(m[1]) : null; } catch { return null; }
}

function lintBody(file, lines, start, ctx) {
  const text = lines.join("\n");
  if (!text.trim()) { report(file, start, "error", "no task text"); return; }
  lines.forEach((raw, i) => {
    const n = start + i;
    // Environment account and base URL placeholders are real values the run fills in, not unfinished text.
    const l = raw.replace(ACCOUNT_PLACEHOLDER, "account value")
      .replaceAll(BASE_URL, ctx.base ? ctx.base.href.replace(/\/+$/, "") : "the base URL");
    if (raw.includes(BASE_URL) && !ctx.base) report(file, n, "warn", `${BASE_URL} needs an env: with a base URL (the environment file's Base URL, or the Environments page); duckwright check verifies it`);
    for (const [re, msg] of ERRORS) if (re.test(l)) report(file, n, "error", msg);
    for (const [re, msg] of WARNINGS) if (re.test(l)) report(file, n, "warn", msg);
    if (SECRETS.some((re) => re.test(l)) && !allowLiteral(l)) report(file, n, "error", "looks like a secret; sign in with {{<id>.password}} from an environment account or a state file, or list a seed-only value in the map's allow-literals");
    for (const t of MAP.terms) if (l.toLowerCase().includes(t.toLowerCase())) report(file, n, "warn", `mentions off-limits "${t}": reword, or confirm with the user that the step only looks at it`);
    if (API_CHECK.test(l) && ctx.network === "false") report(file, n, "error", "API check with network: false; expect-request needs network capture");
    for (const m of raw.matchAll(/https?:\/\/[^\s"'`)>]+/g)) {
      let u;
      try { u = new URL(m[0].replace(/[.,;:]+$/, "")); } catch { continue; }
      if (ctx.base && u.host === ctx.base.host) report(file, n, "warn", `write ${BASE_URL} instead of the environment's base URL ${u.origin}, so the task runs on any environment`);
    }
    for (const m of l.matchAll(/https?:\/\/[^\s"'`)>]+/g)) {
      let u;
      try { u = new URL(m[0].replace(/[.,;:]+$/, "")); } catch { continue; }
      if (ctx.base && u.host !== ctx.base.host) report(file, n, "warn", `URL ${u.host} is not the environment's host ${ctx.base.host}`);
      if (ctx.sitemap && u.host === ctx.sitemap.host) {
        const st = pathKnown(ctx.sitemap, u.pathname);
        if (st === null) report(file, n, "warn", `${u.pathname} is not in the sitemap; check the route or run duckwright explore again`);
        else if (st !== "ok" && st !== "gated") report(file, n, "warn", `${u.pathname} is "${st}" in the sitemap`);
      }
    }
  });
  if (ctx.isTask && ctx.probe) {
    // A probe (templates/probe.md) asks questions instead of checking results.
    if (!/^\s*find out\b/im.test(text)) report(file, start, "error", 'probe has no "Find out" questions');
    if (!/"facts"\s*:/.test(text)) report(file, start, "error", 'probe does not ask for the {"facts": [...]} answer that facts.mjs ingest reads');
  } else if (ctx.isTask) {
    if (!/^\s*(expected results?:|check that\b)/im.test(text)) report(file, start, "error", 'no checks: add an "Expected results:" list with at least one checkable item');
    const steps = lines.filter((l) => /^\s*\d+\.\s/.test(l)).length;
    const max = Number(ctx.maxSteps ?? 25);
    if (steps && max < steps * 2 + 3) report(file, start, "warn", `max-steps ${max} is tight for ${steps} numbered steps (rule of thumb: 2 per step + 3)`);
    if (MAP.prefix && CREATES.test(text) && !text.includes(MAP.prefix)) report(file, start, "warn", `creates data but never uses the data prefix ${MAP.prefix}`);
  }
}

function lintTask(file, root, sitemap) {
  let text;
  try { text = readUtf8(file); } catch (e) { report(file, 0, "error", `cannot read: ${e.message}`); return; }
  const { fm, body, bodyStart, closed } = splitFrontMatter(text);
  if (!closed) { report(file, 1, "error", "front matter is not closed with ---"); return; }
  const s = parseFlat(fm, file, (k) => Object.hasOwn(KEYS, k));
  for (const [k, v] of Object.entries(s)) checkValue(file, k, v);
  const dir = path.dirname(file);
  if (s.session) report(file, s.session.line, "warn", "session: in a shared task file lets two runs at the same time drive one browser; leave it out");
  if (s.setup) {
    const p = path.resolve(dir, s.setup.value);
    if (!exists(p)) report(file, s.setup.line, "error", `setup file not found: ${p}`);
    else {
      const st = readUtf8(p);
      if (!st.trim()) report(file, s.setup.line, "error", `setup file is empty: ${p}`);
    }
  }
  if (s.state) {
    const p = path.resolve(dir, s.state.value);
    if (!exists(p)) report(file, s.state.line, "warn", `state file not there yet: ${p} (a person creates it; the run fails preflight without it)`);
  }
  let envText = null;
  if (s.env && s.env.value !== "none") {
    const v = s.env.value;
    const p = isEnvName(v) ? path.join(root, "environments", `${v}.md`) : path.resolve(dir, v);
    envText = checkEnvFile(p, file, s.env.line);
  } else if (!s.env) {
    report(file, 1, "warn", "no env: the task only gets an environment when the run passes --env");
  }
  lintBody(file, body, bodyStart, {
    isTask: true, network: s.network?.value, maxSteps: s["max-steps"]?.value, base: baseUrlOf(envText), sitemap,
    probe: fm.some(([, l]) => /^#\s*duckwright-tasks probe:/.test(l)),
  });
}

function lintPlan(folder, root, sitemap) {
  const where = path.join(folder, "plan.json");
  let m;
  try { m = JSON.parse(fs.readFileSync(where, "utf8")); } catch (e) { report(where, 0, "error", `cannot read: ${e.message}`); return; }
  const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (m.version !== 1 || typeof m.name !== "string" || typeof m.source !== "string" || !(m.setup === null || typeof m.setup === "string")
    || !strs(m.notes) || !Array.isArray(m.skipped) || !Array.isArray(m.tasks)) {
    report(where, 0, "error", "not a Duckwright plan manifest (see src/plan.ts loadPlan)");
    return;
  }
  for (const t of m.tasks) {
    if (typeof t?.file !== "string" || typeof t.id !== "string" || typeof t.title !== "string" || t.file !== path.basename(t.file) || t.file.startsWith(".")) {
      report(where, 0, "error", `bad task entry ${JSON.stringify(t)}`);
    } else if (!exists(path.join(folder, t.file))) report(where, 0, "error", `task file missing: ${t.file}`);
  }
  for (const sk of m.skipped) if (typeof sk?.id !== "string" || typeof sk.title !== "string" || typeof sk.reason !== "string") report(where, 0, "error", `bad skipped entry ${JSON.stringify(sk)}`);
  if (m.setup !== null) {
    if (path.isAbsolute(m.setup) || m.setup.split(/[\\/]/).includes("..")) report(where, 0, "error", "setup must be a path inside the folder");
    else {
      const p = path.join(folder, m.setup);
      if (!exists(p)) report(where, 0, "error", `setup file missing: ${m.setup}`);
      else { const t = readUtf8(p); lintBody(p, t.split("\n"), 1, { isTask: false, sitemap }); }
    }
  }
  const listed = new Set(m.tasks.map((t) => t.file));
  for (const f of fs.readdirSync(folder)) {
    if (/\.(md|txt)$/i.test(f) && !f.startsWith(".") && !listed.has(f)) report(where, 0, "warn", `${f} is in the folder but not in plan.json`);
  }
}

function main(argv) {
  const opts = { root: null, map: null, sitemap: null, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "--map" || a === "--sitemap") opts[a.slice(2)] = argv[++i];
    else if (a === "-h" || a === "--help") { console.log("usage: check-tasks.mjs --root DIR [--map FILE] [--sitemap FILE] PATH..."); return 0; }
    else opts.paths.push(a);
  }
  if (!opts.root || !opts.paths.length) { console.error("usage: check-tasks.mjs --root DIR [--map FILE] [--sitemap FILE] PATH..."); return 2; }
  const root = path.resolve(opts.root);
  const mapPath = opts.map ?? path.join(root, ".duckwright", "testing-map.md");
  if (exists(mapPath)) loadMap(mapPath);
  else if (opts.map) report(mapPath, 0, "error", "testing map not found");
  const smPath = opts.sitemap ? path.resolve(opts.sitemap) : null;
  const sitemap = smPath && exists(smPath) ? loadSitemap(smPath) : null;
  if (smPath && !sitemap && !exists(smPath)) report(smPath, 0, "warn", "sitemap not found; URLs are not checked (run duckwright explore)");

  for (const p of opts.paths) {
    if (exists(p, "dir")) {
      const files = fs.readdirSync(p).filter((f) => !f.startsWith(".") && /\.(md|txt)$/i.test(f)).sort();
      if (!files.length) report(p, 0, "error", "no task files (.md or .txt)");
      for (const f of files) lintTask(path.join(p, f), root, sitemap);
      if (exists(path.join(p, "plan.json"))) lintPlan(p, root, sitemap);
    } else if (exists(p)) lintTask(p, root, sitemap);
    else report(p, 0, "error", "file not found");
  }
  for (const r of out) console.log(`${path.relative(process.cwd(), r.file) || r.file}:${r.line}: ${r.level}: ${r.msg}`);
  const errors = out.filter((r) => r.level === "error").length;
  console.log(`${errors} error(s), ${out.length - errors} warning(s)`);
  return errors ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-tasks.mjs")) process.exitCode = main(process.argv.slice(2));
