#!/usr/bin/env node
// Guarded action runner for the duckwright-agent skill: stands in for Duckwright's harness when the
// app itself cannot be used. A worker subagent never calls playwright-cli directly; every browser action
// goes through this script, which checks it against an allow-list, runs it, verifies `expect` checks on
// the live page, and records a history.json that the duckwright-playwright skill can read.
//
//   node pw-step.mjs init   --run DIR --task FILE [--origin URL]... [--headed] [--video] [--screenshot]
//   node pw-step.mjs act    --run DIR [--goal TEXT] -- <cmd> [args...]
//   node pw-step.mjs finish --run DIR success|failure "<answer>"
//   node pw-step.mjs close  --run DIR "<reason>"     (coordinator only: a worker that never finished)
//
// Evidence, as Duckwright's app writes it: `--video` (or `video: true` in the task) records the whole run
// to video.webm; `--screenshot` (or `screenshot: true`) saves screenshots/step-NNN.png after every step.
// finish and close always save final.png. report.mjs turns run folders into the final report.
//
// Zero dependencies. Needs `playwright-cli` on PATH.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED = new Set([
  "goto", "click", "fill", "type", "press", "select", "check", "uncheck", "dblclick", "hover", "drag",
  "tab-new", "tab-select", "tab-close", "go-back", "screenshot", "snapshot", "expect",
]);
// Commands that may change the page: a fresh snapshot is taken after them.
const CHANGES_PAGE = new Set([
  "goto", "click", "fill", "type", "press", "select", "check", "uncheck", "dblclick", "drag",
  "tab-new", "tab-select", "tab-close", "go-back",
]);
const REF = /^[a-z]*\d+$/;
const KEY = /^[A-Za-z0-9+]+$/;
const FRONT_KEYS = new Set(["max-steps", "state", "setup", "env", "accounts", "model", "headed", "network", "video", "screenshot"]);
const SNAPSHOT_INLINE = 8000;
const TIMEOUT_MS = 30000;
const VIDEO_NAME = "video.webm";
const SCREENSHOTS_DIR = "screenshots";
const FINAL_PNG = "final.png";

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

// ---------- cli ----------

function winQuote(a) {
  return `"${a.replaceAll('"', '""')}"`;
}

function pwRun(session, args, timeout = TIMEOUT_MS) {
  const argv = [`-s=${session}`, ...args];
  const win = process.platform === "win32";
  // Argv list, never a shell, except for npm's .cmd shim on Windows (then every argument is quoted).
  const r = win
    ? spawnSync("playwright-cli", argv.map(winQuote), { encoding: "utf8", timeout, shell: true })
    : spawnSync("playwright-cli", argv, { encoding: "utf8", timeout });
  if (r.error) {
    return { code: -1, stdout: "", stderr: r.error.code === "ENOENT" ? "playwright-cli not found on PATH" : String(r.error.message) };
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const RAN_CODE = /(?<![^\n])### Ran Playwright code\n```\w*\n((?:(?!```)[^\n]*\n)*?(?!```)[^\n]+)\n```/;
const extractCode = (stdout) => stdout.match(RAN_CODE)?.[1]?.trim() ?? null;
const errText = (r) => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).slice(0, 600);
const cliError = (r) => `error: ${errText(r)}`;

function pageOf(stdout) {
  return {
    url: stdout.match(/^- Page URL: (.*)$/m)?.[1]?.trim() ?? null,
    title: stdout.match(/^- Page Title: (.*)$/m)?.[1]?.trim() ?? null,
  };
}

// ---------- run folder ----------

const q = (s) => JSON.stringify(s);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadRun(dir) {
  const metaFile = path.join(dir, "meta.json");
  if (!fs.existsSync(metaFile)) die(`${dir} is not a run folder (no meta.json): run init first`);
  const meta = readJson(metaFile);
  const hist = readJson(path.join(dir, "history.json"));
  return { meta, hist };
}

function saveMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

function save(dir, hist) {
  fs.writeFileSync(path.join(dir, "history.json"), `${JSON.stringify(hist, null, 2)}\n`);
}

// ---------- task file ----------

function parseTaskFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "").replaceAll("\r\n", "\n");
  const fm = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end === -1) die(`${file}: front matter is not closed with ---`);
    body = text.slice(text.indexOf("\n", end + 1) + 1);
    for (const [i, raw] of text.slice(4, end).split("\n").entries()) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line) continue;
      const m = line.match(/^([a-z-]+):\s*(.*)$/);
      if (!m) die(`${file}:${i + 2}: not a 'key: value' line`);
      if (!FRONT_KEYS.has(m[1])) die(`${file}:${i + 2}: unknown key '${m[1]}'`);
      fm[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  body = body.trim();
  if (!body) die(`${file}: the task has no text`);
  return { fm, body };
}

// ---------- init ----------

function cmdInit(opts) {
  const dir = opts.run ?? die("init: --run DIR is required");
  const taskFile = opts.task ?? die("init: --task FILE is required");
  const { fm, body } = parseTaskFile(taskFile);
  const here = path.dirname(path.resolve(taskFile));
  let text = body;
  if (fm.setup) {
    const setupFile = path.resolve(here, fm.setup);
    if (!fs.existsSync(setupFile)) die(`${taskFile}: setup file not found: ${setupFile}`);
    text = `Setup (do this first, then the task below):\n${fs.readFileSync(setupFile, "utf8").trim()}\n\nTask:\n${body}`;
  }
  const state = fm.state ? path.resolve(here, fm.state) : null;
  if (state && !fs.existsSync(state)) {
    die(`${taskFile}: state file not found: ${state}. A person must save it once with: playwright-cli state-save <file>`, 3);
  }
  let envPath = null;
  if (fm.env && fm.env !== "none") {
    envPath = /[\\/]|\.md$/.test(fm.env) ? path.resolve(here, fm.env) : path.resolve("environments", `${fm.env}.md`);
    if (!fs.existsSync(envPath)) die(`${taskFile}: environment file not found: ${envPath}`);
  }
  const origins = [];
  for (const o of opts.origin ?? []) {
    try {
      origins.push(new URL(o).origin);
    } catch {
      die(`init: --origin '${o}' is not a URL`);
    }
  }
  const maxSteps = fm["max-steps"] ? Number(fm["max-steps"]) : 25;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) die(`${taskFile}: max-steps must be a whole number of at least 1`);
  const flag = (key) => {
    if (opts[key]) return true;
    if (fm[key] === undefined) return false;
    if (fm[key] !== "true" && fm[key] !== "false") die(`${taskFile}: ${key} must be true or false, got ${q(fm[key])}`);
    return fm[key] === "true";
  };
  const video = flag("video");
  const screenshot = flag("screenshot");

  fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
  const session = `dw-${path.basename(path.resolve(dir))}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60);
  const meta = { session, origins, state, maxSteps, taskFile, video, screenshot, started: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "task.txt"), `${text}\n`);
  const hist = {
    task: text,
    task_file: taskFile,
    ...(fm.env && fm.env !== "none" ? { env: { name: fm.env, path: envPath } } : {}),
    ...(state ? { state: path.relative(process.cwd(), state) } : {}),
    success: false,
    answer: null,
    steps: 0,
    history: [],
  };

  const open = pwRun(session, ["open", "about:blank", ...(opts.headed ? ["--headed"] : [])], 60000);
  if (open.code !== 0) {
    saveMeta(dir, meta);
    save(dir, hist);
    die(`could not open the browser: ${cliError(open)}`, 1);
  }
  // Started before the state is loaded, as the app does, so the recording covers the whole run.
  if (video) {
    const v = pwRun(session, ["video-start", path.resolve(dir, VIDEO_NAME)]);
    if (v.code === 0) meta.videoStarted = true;
    else (hist.warnings ??= []).push(`video failed to start: ${errText(v).slice(0, 200)}`);
  }
  saveMeta(dir, meta);
  save(dir, hist);
  if (state) {
    const load = pwRun(session, ["state-load", state]);
    if (load.code !== 0) die(`could not load the state file: ${cliError(load)}`, 1);
  }
  process.stdout.write(
    `run: ${dir}\nsession: ${session}\nmax-steps: ${maxSteps}\n`
    + `allowed origins: ${origins.length ? origins.join(", ") : "(any: pass --origin to restrict goto)"}\n`
    + `evidence: video ${meta.videoStarted ? "recording" : video ? "failed to start" : "off"}, step screenshots ${screenshot ? "on" : "off"}\n`
    + `--- task ---\n${text}\n`,
  );
}

// ---------- expect (the harness's checks, ported) ----------

const CHECKS = {
  visible: ["ref"], text: ["ref", "expected"], contains: ["ref", "expected"], value: ["ref", "expected"],
  checked: ["ref"], unchecked: ["ref"], url: ["expected"],
};
const READ = {
  visible: "isVisible()", text: "textContent()", contains: "textContent()",
  value: "inputValue()", checked: "isChecked()", unchecked: "isChecked()",
};
const MATCHER = { visible: "toBeVisible()", checked: "toBeChecked()", unchecked: "not.toBeChecked()" };
const NAMED = { text: "toHaveText", contains: "toContainText", value: "toHaveValue", url: "toHaveURL" };
const LITERAL = new RegExp(
  String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|(?:(?<=\()|(?<=, )|(?<=: ))/(?:[^/\\\n]|\\.)+/[a-z]*`, "g",
);
const LOCATOR_METHODS = new Set([
  "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId",
  "locator", "frameLocator", "contentFrame", "first", "last", "nth", "filter", "and", "or",
]);
const JS_WS = new RegExp("[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+", "g");
const norm = (s) => String(s ?? "").replaceAll("​", "").replace(JS_WS, " ").replace(/^ +| +$/g, "");

// The locator from generate-locator is spliced into run-code, so it must be a plain locator chain.
function isLocator(loc) {
  if (loc.includes("\n") || !/^(?:getBy[A-Za-z]+|locator|frameLocator)\(/.test(loc)) return false;
  const rest = loc.replace(LITERAL, "0");
  return /^[A-Za-z0-9_.(){}:, ]*$/.test(rest)
    && [...rest.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].every((m) => LOCATOR_METHODS.has(m[1]));
}

function runExpect(session, args) {
  const check = args[0];
  if (!Object.hasOwn(CHECKS, check)) {
    return [`error: expect check '${check}' not allowed (allowed: ${Object.keys(CHECKS).join(", ")})`, null];
  }
  const names = CHECKS[check];
  if (args.length - 1 !== names.length) {
    return [`error: usage: expect ${check} ${names.map((n) => `<${n}>`).join(" ")}`, null];
  }
  if (names[0] === "ref" && !REF.test(args[1])) return [`error: expect ref must be a snapshot ref like e15, got ${q(args[1])}`, null];

  let subject = "page";
  let js = "async page => page.url()";
  if (check !== "url") {
    const g = pwRun(session, ["generate-locator", args[1], "--raw"]);
    if (g.code !== 0) return [cliError(g), null];
    const loc = g.stdout.trim();
    if (!isLocator(loc)) return [`error: expect: unusable locator ${q(loc)}`, null];
    subject = `page.${loc}`;
    js = `async page => await page.${loc}.${READ[check]}`;
  }
  const r = pwRun(session, ["run-code", js, "--raw"]);
  if (r.code !== 0) return [cliError(r), null];
  let actual;
  try {
    actual = JSON.parse(r.stdout);
  } catch {
    return [`error: expect: unreadable result ${q(r.stdout.trim())}`, null];
  }
  if (check in MATCHER) {
    const want = check !== "unchecked";
    if (actual !== want) {
      return [`error: expect ${check} failed: element is ${check === "visible" ? "not visible" : check === "checked" ? "not checked" : "checked"}`, null];
    }
    return ["ok", `await expect(${subject}).${MATCHER[check]};`];
  }
  let expected = args[args.length - 1];
  let got;
  if (check === "text" || check === "contains") {
    expected = norm(expected);
    got = norm(actual);
  } else {
    got = typeof actual === "string" ? actual : actual == null ? "" : String(actual);
  }
  if (check === "contains" ? !got.includes(expected) : got !== expected) {
    return [`error: expect ${check} failed: expected ${check === "contains" ? "to contain " : ""}${q(expected)}, got ${q(got)}`, null];
  }
  return ["ok", `await expect(${subject}).${NAMED[check]}(${q(expected)});`];
}

// ---------- act ----------

function checkAction(meta, cmd, args) {
  if (!ALLOWED.has(cmd)) return `command '${cmd}' is not allowed (allowed: ${[...ALLOWED].join(", ")})`;
  if (cmd === "expect") return null; // checked in runExpect
  const flags = args.filter((a) => a.startsWith("-"));
  const okFlags = cmd === "fill" || cmd === "type" ? ["--submit"] : [];
  const bad = flags.filter((f) => !okFlags.includes(f));
  // A value that starts with '-' is a flag to playwright-cli, so refuse it rather than pass it through.
  if (bad.length) return `flag ${bad[0]} is not allowed for ${cmd}`;
  const need = (n, what) => (args.length - flags.length === n ? null : `usage: ${cmd} ${what}`);
  switch (cmd) {
    case "goto": {
      const e = need(1, "<url>");
      if (e) return e;
      let u;
      try {
        u = new URL(args[0]);
      } catch {
        return `goto needs a full URL, got ${q(args[0])}`;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return `goto only opens http(s) URLs, got ${u.protocol}`;
      if (meta.origins.length && !meta.origins.includes(u.origin)) {
        return `goto ${u.origin} is outside the allowed origins (${meta.origins.join(", ")})`;
      }
      return null;
    }
    case "click": case "dblclick": case "hover": case "check": case "uncheck":
      return need(1, "<ref>") ?? (REF.test(args[0]) ? null : `${cmd} needs a snapshot ref like e15, got ${q(args[0])}`);
    case "fill": case "type": {
      const rest = args.filter((a) => !a.startsWith("--"));
      if (cmd === "fill") return rest.length === 2 && REF.test(rest[0]) ? null : "usage: fill <ref> <text> [--submit]";
      return rest.length === 1 ? null : "usage: type <text> [--submit]";
    }
    case "select":
      return args.length === 2 && REF.test(args[0]) ? null : "usage: select <ref> <value>";
    case "drag":
      return args.length === 2 && args.every((a) => REF.test(a)) ? null : "usage: drag <ref> <ref>";
    case "press":
      return args.length === 1 && KEY.test(args[0]) ? null : "usage: press <Key>";
    case "tab-new":
      return args.length <= 1 ? null : "usage: tab-new [url]";
    case "tab-select":
      return args.length === 1 && /^\d+$/.test(args[0]) ? null : "usage: tab-select <index>";
    case "tab-close":
      return args.length <= 1 && args.every((a) => /^\d+$/.test(a)) ? null : "usage: tab-close [index]";
    default:
      return args.length === 0 ? null : `${cmd} takes no arguments`;
  }
}

function snapshotOf(dir, meta, n) {
  const file = path.join(dir, "snapshots", `${String(n).padStart(3, "0")}.yml`);
  const r = pwRun(meta.session, ["snapshot", `--filename=${path.resolve(file)}`]);
  if (r.code !== 0 || !fs.existsSync(file)) return { file: null, text: cliError(r) };
  return { file, text: fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n") };
}

function cmdAct(opts, rest) {
  const dir = opts.run ?? die("act: --run DIR is required");
  const { meta, hist } = loadRun(dir);
  if (hist.finished) die("this run is finished: start a new run folder");
  const [cmd, ...args] = rest;
  if (!cmd) die("act: give a command after --");
  if (hist.steps >= meta.maxSteps) {
    die(`step limit reached (${meta.maxSteps}): finish now with: finish --run ${dir} failure "<reason>"`, 4);
  }
  const refused = checkAction(meta, cmd, args);
  if (refused) die(`refused: ${refused}`, 2);

  let result;
  let code = null;
  let page = null;
  let snap = null;
  if (cmd === "expect") {
    [result, code] = runExpect(meta.session, args);
  } else if (cmd === "snapshot") {
    result = "ok";
  } else if (cmd === "screenshot") {
    const file = path.resolve(dir, `screenshot-${String(hist.steps + 1).padStart(3, "0")}.png`);
    const r = pwRun(meta.session, ["screenshot", `--filename=${file}`]);
    result = r.code === 0 ? `ok (saved ${path.relative(process.cwd(), file)})` : cliError(r);
  } else {
    const r = pwRun(meta.session, [cmd, ...args]);
    result = r.code === 0 ? "ok" : cliError(r);
    if (r.code === 0) {
      code = extractCode(r.stdout);
      page = pageOf(r.stdout);
    }
  }
  const failed = result.startsWith("error");
  if (cmd === "snapshot" || (CHANGES_PAGE.has(cmd) && !failed)) {
    snap = snapshotOf(dir, meta, hist.steps + 1);
    if (!page || !page.url) {
      // goto/click print the page status; a bare snapshot does not
      const s = pwRun(meta.session, ["run-code", "async page => ({url: page.url(), title: await page.title()})", "--raw"]);
      try {
        page = s.code === 0 ? JSON.parse(s.stdout) : page;
      } catch { /* leave page as it is */ }
    }
  }
  let shot = null;
  if (meta.screenshot) {
    const rel = `${SCREENSHOTS_DIR}/step-${String(hist.steps + 1).padStart(3, "0")}.png`;
    fs.mkdirSync(path.join(dir, SCREENSHOTS_DIR), { recursive: true });
    const r = pwRun(meta.session, ["screenshot", `--filename=${path.resolve(dir, rel)}`]);
    shot = r.code === 0 && fs.existsSync(path.join(dir, rel))
      ? { screenshot: rel }
      : { screenshot_error: r.code === 0 ? "no file was written" : errText(r).slice(0, 200) };
  }
  hist.history.push({
    next_goal: opts.goal ?? "",
    memory: "",
    actions: [{ cmd, args, code }],
    results: [result],
    ...(page ? { page } : {}),
    ...shot,
  });
  hist.steps = hist.history.length;
  save(dir, hist);

  let out = `step ${hist.steps}/${meta.maxSteps} | ${cmd} ${args.map(q).join(" ")} → ${result}\n`;
  if (page?.url) out += `page: ${page.url}${page.title ? ` | ${page.title}` : ""}\n`;
  if (snap) {
    if (!snap.file) out += `snapshot failed: ${snap.text}\n`;
    else if (snap.text.length <= SNAPSHOT_INLINE) out += `--- snapshot (${snap.file}) ---\n${snap.text}`;
    else out += `snapshot is large (${snap.text.length} chars), saved to ${snap.file}: Grep it for the element you need, and Read only the part around it.\n`;
  }
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (failed) process.exitCode = 1;
}

// ---------- finish ----------

function cmdFinish(opts, rest) {
  const dir = opts.run ?? die("finish: --run DIR is required");
  const [verdict, ...answerWords] = rest;
  if (verdict !== "success" && verdict !== "failure") die('finish: the first argument must be the literal "success" or "failure"');
  const answer = answerWords.join(" ").trim();
  if (!answer) die("finish: give the final answer or the reason after the verdict");
  const { meta, hist } = loadRun(dir);
  if (hist.finished) die("this run is already finished");

  let success = verdict === "success";
  let note = "";
  if (success) {
    const flat = hist.history.flatMap((s) => s.actions.map((a, i) => ({ a, r: s.results[i] })));
    const passed = flat.filter((x) => x.a.cmd === "expect" && x.r === "ok").length;
    const last = flat[flat.length - 1];
    if (passed === 0) {
      note = "refused: a success needs at least one passing `expect` on the page. Run one, then finish again.";
    } else if (last && last.r.startsWith("error")) {
      note = "refused: the last action failed. Fix or re-check it, then finish again.";
    }
    if (note) {
      process.stdout.write(`${note}\n`);
      process.exitCode = 1;
      return;
    }
  }
  wrapUp(dir, meta, hist);
  hist.success = success;
  hist.answer = answer;
  hist.finished = new Date().toISOString();
  save(dir, hist);
  process.stdout.write(`Result: ${verdict}\nAnswer: ${answer}\nSteps: ${hist.steps}\nHistory: ${path.join(dir, "history.json")}\n${evidenceLine(dir, hist)}`);
  if (!success) process.exitCode = 1;
}

// Save the last screenshot, finalize the video, close the browser. Never throws: evidence that could
// not be saved becomes a warning in history.json.
function wrapUp(dir, meta, hist) {
  const final = pwRun(meta.session, ["screenshot", `--filename=${path.resolve(dir, FINAL_PNG)}`]);
  if (final.code === 0 && fs.existsSync(path.join(dir, FINAL_PNG))) hist.final_screenshot = FINAL_PNG;
  if (meta.videoStarted) {
    const v = pwRun(meta.session, ["video-stop"], 60000);
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, VIDEO_NAME)).size;
    } catch { /* missing */ }
    if (v.code === 0 && size > 0) hist.video = VIDEO_NAME;
    else {
      (hist.warnings ??= []).push(v.code !== 0
        ? `video failed to stop: ${errText(v).slice(0, 200)}`
        : `video was not saved: ${VIDEO_NAME} is missing or empty`);
    }
  }
  pwRun(meta.session, ["close"]);
}

function evidenceLine(dir, hist) {
  const shots = hist.history.filter((s) => s.screenshot).length;
  const parts = [
    ...(hist.video ? [path.join(dir, hist.video)] : []),
    ...(hist.final_screenshot ? [path.join(dir, hist.final_screenshot)] : []),
    ...(shots ? [`${shots} step screenshots in ${path.join(dir, SCREENSHOTS_DIR)}`] : []),
  ];
  const warn = (hist.warnings ?? []).map((w) => `Warning: ${w}\n`).join("");
  return `${parts.length ? `Evidence: ${parts.join(", ")}\n` : ""}${warn}`;
}

// ---------- close (coordinator) ----------

// For a worker that returned without finish (out of context, stopped): keep the evidence, close the
// browser and mark the run stopped. Never a success.
function cmdClose(opts, rest) {
  const dir = opts.run ?? die("close: --run DIR is required");
  const reason = rest.join(" ").trim() || "the worker stopped without finishing";
  const { meta, hist } = loadRun(dir);
  if (hist.finished) die("this run is already finished");
  wrapUp(dir, meta, hist);
  hist.success = false;
  hist.stopped = true;
  hist.answer = `stopped: ${reason}`;
  hist.finished = new Date().toISOString();
  save(dir, hist);
  process.stdout.write(`Result: stop\nAnswer: ${hist.answer}\nSteps: ${hist.steps}\nHistory: ${path.join(dir, "history.json")}\n${evidenceLine(dir, hist)}`);
}

// ---------- main ----------

function parse(argv) {
  const opts = {};
  const rest = [];
  const multi = new Set(["origin"]);
  const flagsWithValue = new Set(["run", "task", "origin", "goal"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--headed" || a === "--video" || a === "--screenshot") opts[a.slice(2)] = true;
    else if (a.startsWith("--") && flagsWithValue.has(a.slice(2))) {
      const k = a.slice(2);
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      if (multi.has(k)) (opts[k] ??= []).push(v);
      else opts[k] = v;
    } else rest.push(a);
  }
  return { opts, rest };
}

const [sub, ...argv] = process.argv.slice(2);
const { opts, rest } = parse(argv);
if (sub === "init") cmdInit(opts);
else if (sub === "act") cmdAct(opts, rest);
else if (sub === "finish") cmdFinish(opts, rest);
else if (sub === "close") cmdClose(opts, rest);
else die("usage: pw-step.mjs init|act|finish|close (see the header of this file)");
