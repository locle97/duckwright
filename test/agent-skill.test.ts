import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ALLOWED_COMMANDS } from "../src/brain.ts";

// skills/duckwright-agent runs on its own (no src/ imports), against a stand-in playwright-cli.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills/duckwright-agent/scripts");
const stepPath = path.join(scripts, "pw-step.mjs");
const posix = process.platform !== "win32";

const FAKE_CLI = `#!/usr/bin/env bash
shift
cmd=$1; shift
case "$cmd" in
  snapshot) for a in "$@"; do case $a in --filename=*) printf -- '- button "Go" [ref=e1]\\n' > "\${a#--filename=}";; esac; done;;
  generate-locator) echo "getByRole('button', { name: 'Go' })";;
  video-start) echo "$1" > .video-path;;
  video-stop) printf webm > "$(cat .video-path)"; rm .video-path;;
  screenshot) for a in "$@"; do case $a in --filename=*) printf 'png' > "\${a#--filename=}";; esac; done;;
  run-code) case "$1" in *isVisible*) echo true;; *textContent*) echo '"Go"';; *title*) echo '{"url":"https://x.test/","title":"X"}';; *) echo '"https://x.test/"';; esac;;
  click) printf '### Page\\n- Page URL: https://x.test/\\n- Page Title: X\\n### Ran Playwright code\\n\`\`\`js\\nawait page.getByRole('"'"'button'"'"', { name: '"'"'Go'"'"' }).click();\\n\`\`\`\\n';;
  goto) printf '### Page\\n- Page URL: %s\\n- Page Title: X\\n### Ran Playwright code\\n\`\`\`js\\nawait page.goto('"'"'%s'"'"');\\n\`\`\`\\n' "$1" "$1";;
esac
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-agent-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/playwright-cli"), FAKE_CLI, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "task.md"), "---\nmax-steps: 6\n---\nOpen the page and click Go.\n");
  const env = { ...process.env, PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}` };
  const step = (...args: string[]) => spawnSync("node", [stepPath, ...args], { cwd: dir, env, encoding: "utf8" });
  return { dir, step, run: (...a: string[]) => step("act", "--run", "r1", "--", ...a) };
}

test("agent_skill_allow_list_is_a_subset_of_the_harness_allow_list", () => {
  const src = fs.readFileSync(stepPath, "utf8");
  const listed = /const ALLOWED = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  assert.ok(listed.length > 0);
  // snapshot is the one extra: the harness takes snapshots itself, the worker asks for one
  for (const cmd of listed.filter((c) => c !== "snapshot")) {
    assert.ok((ALLOWED_COMMANDS as readonly string[]).includes(cmd), `${cmd} is not a harness command`);
  }
  for (const banned of ["eval", "find", "open", "close", "run-code", "state-save", "cookie-list", "upload", "request", "twofa"]) {
    assert.ok(!listed.includes(banned), `${banned} must not be allowed`);
  }
});

test("agent_skill_runner_records_a_run_the_exporter_can_use", { skip: !posix }, () => {
  const { dir, step, run } = setup();
  const init = step("init", "--run", "r1", "--task", "task.md", "--origin", "https://x.test");
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Open the page and click Go\./);

  assert.equal(run("goto", "https://x.test/").status, 0);
  assert.equal(run("goto", "https://evil.test/").status, 2);
  assert.equal(run("eval", "1").status, 2);
  assert.equal(run("click", "e1").status, 0);
  assert.equal(run("fill", "e1", "-x").status, 2);

  const early = step("finish", "--run", "r1", "success", "ok");
  assert.equal(early.status, 1);
  assert.match(early.stdout, /needs at least one passing `expect`/);

  const bad = run("expect", "text", "e1", "Nope");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /expect text failed/);
  assert.equal(run("expect", "text", "e1", "Go").status, 0);
  const done = step("finish", "--run", "r1", "success", "done");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /Result: success/);

  const hist = JSON.parse(fs.readFileSync(path.join(dir, "r1/history.json"), "utf8"));
  assert.equal(hist.success, true);
  assert.equal(hist.history[1].actions[0].code, "await page.getByRole('button', { name: 'Go' }).click();");

  const spec = path.join(dir, "out/f.spec.ts");
  const exp = spawnSync("node", [path.join(scripts, "export-spec.mjs"), "r1", "-o", spec], { cwd: dir, encoding: "utf8" });
  assert.equal(exp.status, 0, exp.stderr);
  const text = fs.readFileSync(spec, "utf8");
  assert.match(text, /await page\.goto\('https:\/\/x\.test\/'\);/);
  assert.match(text, /await expect\(page\.getByRole\('button', \{ name: 'Go' \}\)\)\.toHaveText\("Go"\);/);
  assert.ok(!text.includes("Nope"), "a failed check is not exported");
});

test("agent_skill_step_limit_forces_a_finish", { skip: !posix }, () => {
  const { step, run } = setup();
  assert.equal(step("init", "--run", "r1", "--task", "task.md").status, 0);
  for (let i = 0; i < 6; i++) assert.equal(run("snapshot").status, 0);
  const over = run("snapshot");
  assert.equal(over.status, 4);
  assert.match(over.stderr, /step limit reached/);
  const fail = step("finish", "--run", "r1", "failure", "ran out of steps");
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /Result: failure/);
});

test("agent_skill_bash_guard_allows_only_the_runner", () => {
  const guard = (command: string, agent_type: string | null = "duckwright:duckwright-worker") =>
    spawnSync("node", [path.join(scripts, "bash-guard.mjs")], { input: JSON.stringify({ agent_type, tool_input: { command } }), encoding: "utf8" }).status;
  assert.equal(guard('node .claude/skills/duckwright-agent/scripts/pw-step.mjs act --run r -- goto "https://a.b/?x=1&y=2"'), 0);
  assert.equal(guard("node x/pw-step.mjs act --run r -- click e1; rm -rf /"), 2);
  assert.equal(guard("node x/pw-step.mjs act --run r -- fill e1 \"$(cat ~/.ssh/id_rsa)\""), 2);
  assert.equal(guard("node x/pw-step.mjs act --run r -- click e1 | tee out"), 2);
  assert.equal(guard("cat ~/.ssh/id_rsa"), 2);
  assert.equal(guard("playwright-cli open"), 2);
  assert.equal(guard("cat ~/.ssh/id_rsa", "duckwright-worker"), 2);
  // the hook is plugin-wide: every other agent and the main session are left alone
  assert.equal(guard("npm test", null), 0);
  assert.equal(guard("npm test", "general-purpose"), 0);
});

test("duckwright_plugin_manifest_is_consistent", () => {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
  const pkg = read("package.json");
  const plugin = read(".claude-plugin/plugin.json");
  assert.equal(plugin.name, "duckwright");
  assert.equal(plugin.version, pkg.version, "plugin.json version must follow package.json");
  const market = read(".claude-plugin/marketplace.json");
  assert.deepEqual(market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [["duckwright", "./"]]);
  const hooks = read("hooks/hooks.json").hooks.PreToolUse[0];
  assert.equal(hooks.matcher, "Bash");
  const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/(.+?)"/.exec(hooks.hooks[0].command)?.[1] ?? "";
  assert.ok(fs.existsSync(path.join(root, rel)), `hook script ${rel} must exist`);
  const agent = fs.readFileSync(path.join(root, "agents/duckwright-worker.md"), "utf8");
  assert.match(agent, /^---\nname: duckwright-worker\n/);
  assert.ok(!/^hooks:/m.test(agent), "plugin agents cannot carry hooks: they live in hooks/hooks.json");
});

test("agent_skill_records_video_and_screenshots_as_evidence", { skip: !posix }, () => {
  const { dir, step, run } = setup();
  fs.writeFileSync(path.join(dir, "vtask.md"), "---\nvideo: true\n---\nClick Go.\n");
  const init = step("init", "--run", "r1", "--task", "vtask.md", "--screenshot");
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /evidence: video recording, step screenshots on/);
  assert.equal(run("click", "e1").status, 0);
  assert.equal(run("expect", "visible", "e1").status, 0);
  const done = step("finish", "--run", "r1", "success", "clicked");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /Evidence: .*video\.webm, .*final\.png, 2 step screenshots/);

  const hist = JSON.parse(fs.readFileSync(path.join(dir, "r1/history.json"), "utf8"));
  assert.equal(hist.video, "video.webm");
  assert.equal(hist.final_screenshot, "final.png");
  assert.equal(hist.history[0].screenshot, "screenshots/step-001.png");
  assert.ok(fs.existsSync(path.join(dir, "r1/screenshots/step-002.png")));

  const bad = path.join(dir, "bad.md");
  fs.writeFileSync(bad, "---\nvideo: maybe\n---\nx\n");
  const refused = step("init", "--run", "r2", "--task", "bad.md");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /video must be true or false/);
});

test("agent_skill_close_stops_an_unfinished_run_and_report_lists_it", { skip: !posix }, () => {
  const { dir, step } = setup();
  const plan = path.join(dir, "tasks/p");
  fs.mkdirSync(plan, { recursive: true });
  fs.writeFileSync(path.join(plan, "01-go.md"), "---\nvideo: true\n---\nClick Go.\n");
  fs.writeFileSync(path.join(plan, "02-later.md"), "Later.\n");
  fs.writeFileSync(path.join(plan, "plan.json"), JSON.stringify({
    version: 1, name: "p", notes: ["seed the db"],
    skipped: [{ id: "S1", title: "Two users", reason: "needs two browsers" }],
    tasks: [{ file: "01-go.md", id: "T1", title: "Go" }, { file: "02-later.md", id: "T2", title: "Later" }],
  }));
  assert.equal(step("init", "--run", "tasks/p/01-go", "--task", "tasks/p/01-go.md").status, 0);
  assert.equal(step("act", "--run", "tasks/p/01-go", "--", "click", "e1").status, 0);
  const closed = step("close", "--run", "tasks/p/01-go", "worker ran out of context");
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /Result: stop/);
  const hist = JSON.parse(fs.readFileSync(path.join(plan, "01-go/history.json"), "utf8"));
  assert.equal(hist.success, false);
  assert.equal(hist.stopped, true);
  assert.equal(hist.video, "video.webm");

  fs.writeFileSync(path.join(dir, "triage.md"), "T1: environment problem.\n");
  const rep = spawnSync("node", [path.join(scripts, "report.mjs"), "tasks/p", "--notes", "triage.md", "--html"], { cwd: dir, encoding: "utf8" });
  assert.equal(rep.status, 0, rep.stderr);
  const md = fs.readFileSync(path.join(plan, "report.md"), "utf8");
  assert.match(md, /2 tasks · 0 pass · 0 fail · 1 stop · 1 not run · 1 skipped/);
  assert.match(md, /\| T1 Go \| \*\*stop\*\* \| 1\/25 \|.*\[video\]\(01-go\/video\.webm\)/);
  assert.match(md, /\| T2 Later \| \*\*not run\*\*/);
  assert.match(md, /\| S1 Two users \| \*\*skip\*\* \|.*needs two browsers/);
  assert.match(md, /Answer: stopped: worker ran out of context/);
  assert.match(md, /## Triage\n\nT1: environment problem\./);
  assert.match(md, /- seed the db/);
  const html = fs.readFileSync(path.join(plan, "report.html"), "utf8");
  assert.match(html, /<video controls preload="metadata" src="01-go\/video\.webm"><\/video>/);
});
