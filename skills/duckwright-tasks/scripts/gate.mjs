#!/usr/bin/env node
// Preflight for an investigation run (a probe or a scoped explore). Duckwright has no host guard on
// --allow-writes, so this is the guard. Run it before asking the user to say yes, and again before the run.
//
//   node gate.mjs --root ROOT --env NAME --url URL --mode probe|probe-write|explore|explore-write [--state FILE]
//
// Prints OK or REFUSE with the reason. Exit 0 = OK, 1 = refuse, 2 = bad usage.
// Reads the testing map and the env file; checks that a state file exists but never reads it.
// It can only check what the files say: a production host nobody wrote down looks like any other host, so the
// env must be opted in by name (investigate-envs), and the consent message must name the host.
import fs from "node:fs";
import path from "node:path";

const MODES = ["probe", "probe-write", "explore", "explore-write"];
const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[(process.argv[i] ?? "").replace(/^--/, "")] = process.argv[i + 1];
if (!a.root || !a.env || !a.url || !MODES.includes(a.mode)) {
  console.error(`usage: gate.mjs --root ROOT --env NAME --url URL --mode ${MODES.join("|")} [--state FILE]`);
  process.exit(2);
}
const refuse = (m) => { console.log(`REFUSE: ${m}`); process.exit(1); };
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const flat = (t) => Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(t ?? "")?.[1] ?? "").split("\n")
  .filter((l) => /^[\w-]+:/.test(l)).map((l) => [l.split(":")[0], l.slice(l.indexOf(":") + 1).trim()]));
const list = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const env = read(path.join(a.root, "environments", `${a.env}.md`));
if (env === null) refuse(`no environment file environments/${a.env}.md under ${a.root}`);
const map = flat(read(path.join(a.root, ".duckwright", "testing-map.md")));
if (!list(map["investigate-envs"]).includes(a.env)) refuse(`'${a.env}' is not in the testing map's investigate-envs; the user must opt it in`);

let target;
try { target = new URL(a.url); } catch { refuse(`not a URL: ${a.url}`); }
const m = /base url[^\n]*\n*\s*(?:[-*]\s*)?<?(https?:\/\/[^\s)>]+)/i.exec(env);
if (!m) refuse("the env file has no Base URL, so the target host cannot be checked");
if (new URL(m[1]).host !== target.host) refuse(`${target.host} is not the env's host ${new URL(m[1]).host}`);
if (/\b(prod|production|live)\b/i.test(a.env) || /\bthis is (the )?(prod|production|live)\b/i.test(env.slice(0, 1500))) refuse("the env looks like production");
const hit = list(map["off-limits-terms"]).find((t) => (target.pathname + target.search).toLowerCase().includes(t.toLowerCase()));
if (hit) refuse(`the URL matches the off-limits term '${hit}'`);
if (a.mode.endsWith("write") && !list(map["write-envs"]).includes(a.env)) refuse(`writes need '${a.env}' in the testing map's write-envs`);
if (a.state && !fs.existsSync(path.resolve(a.root, a.state))) refuse(`state file ${a.state} does not exist; a person makes it`);
console.log(`OK: ${a.mode} on ${target.host} (env ${a.env})${a.mode.endsWith("write") ? "; data prefix, PROBE- names and cleanup rules apply" : ""}`);
