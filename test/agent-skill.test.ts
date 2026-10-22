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
  // snapshot is the one extra: the harness takes snapshots itself, a step agent asks for one
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

test("agent_skill_runs_in_small_turns_with_reports_and_opens_headed", { skip: !posix }, () => {
  const { dir, step, run } = setup();
  const log = path.join(dir, "cli.log");
  fs.writeFileSync(path.join(dir, "bin/playwright-cli"), `#!/usr/bin/env bash\necho "$@" >> ${log}\n${FAKE_CLI.split("\n").slice(1).join("\n")}`, { mode: 0o755 });
  const init = step("init", "--run", "r1", "--task", "task.md", "--turn-budget", "2");
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /mode: headed {2}turn-budget: 2/);
  assert.match(fs.readFileSync(log, "utf8"), /open about:blank --headed/);

  assert.equal(run("goto", "https://x.test/").status, 0);
  assert.equal(run("click", "e1").status, 0);
  const over = run("snapshot");
  assert.equal(over.status, 5);
  assert.match(over.stderr, /turn budget reached/);

  const noLabel = step("report", "--run", "r1", "done", "ok");
  assert.notEqual(noLabel.status, 0);
  const rep = step("report", "--run", "r1", "--label", "1. Open and click", "done", "Clicked Go; page shows the Go button.");
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /^report 1 saved \(done\), steps 1-2/);
  assert.match(fs.readFileSync(path.join(dir, "r1/reports/001.md"), "utf8"), /Clicked Go/);

  // a new turn starts with a fresh budget, and status shows the earlier report
  assert.equal(run("expect", "visible", "e1").status, 0);
  const status = step("status", "--run", "r1");
  assert.match(status.stdout, /this turn: 1\/2/);
  assert.match(status.stdout, /\[done\] 1\. Open and click: Clicked Go/);
  assert.match(status.stdout, /passing checks \(1\): expect visible e1/);
});

test("agent_skill_headless_flag_and_front_matter_turn_headed_off", { skip: !posix }, () => {
  for (const [args, front, want] of [[["--headless"], "", false], [[], "headed: false\n", false], [["--headed"], "headed: false\n", true], [[], "", true]] as const) {
    const { dir, step } = setup();
    const log = path.join(dir, "cli.log");
    fs.writeFileSync(path.join(dir, "bin/playwright-cli"), `#!/usr/bin/env bash\necho "$@" >> ${log}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "task.md"), `---\n${front}---\nDo it.\n`);
    assert.equal(step("init", "--run", "r1", "--task", "task.md", ...args).status, 0);
    assert.equal(/--headed/.test(fs.readFileSync(log, "utf8")), want, `${args} ${front}`);
  }
});

test("agent_skill_bash_guard_allows_only_the_runner", () => {
  const guard = (command: string, agent_type: string | null = "duckwright:duckwright-step") =>
    spawnSync("node", [path.join(scripts, "bash-guard.mjs")], { input: JSON.stringify({ agent_type, tool_input: { command } }), encoding: "utf8" }).status;
  assert.equal(guard('node .claude/skills/duckwright-agent/scripts/pw-step.mjs act --run r -- goto "https://a.b/?x=1&y=2"'), 0);
  assert.equal(guard("node x/pw-step.mjs act --run r -- click e1; rm -rf /"), 2);
  assert.equal(guard("node x/pw-step.mjs act --run r -- fill e1 \"$(cat ~/.ssh/id_rsa)\""), 2);
  assert.equal(guard("node x/pw-step.mjs act --run r -- click e1 | tee out"), 2);
  assert.equal(guard("cat ~/.ssh/id_rsa"), 2);
  assert.equal(guard("playwright-cli open"), 2);
  assert.equal(guard("node x/pw-step.mjs report --run r --label L done \"ok\""), 0);
  assert.equal(guard("node x/pw-step.mjs status --run r"), 0);
  assert.equal(guard("node x/pw-step.mjs init --run r --task t.md"), 2); // the coordinator opens and finishes runs
  assert.equal(guard("node x/pw-step.mjs finish --run r success ok"), 2);
  assert.equal(guard("cat ~/.ssh/id_rsa", "duckwright-step"), 2);
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
  const agent = fs.readFileSync(path.join(root, "agents/duckwright-step.md"), "utf8");
  assert.match(agent, /^---\nname: duckwright-step\n/);
  assert.ok(!/^hooks:/m.test(agent), "plugin agents cannot carry hooks: they live in hooks/hooks.json");
});
