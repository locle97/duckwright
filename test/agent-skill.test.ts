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
  // snapshot is the one extra: the harness takes snapshots itself, the worker asks for one
  for (const cmd of listed.filter((c) => c !== "snapshot")) {
    assert.ok(ALLOWED_COMMANDS.includes(cmd), `${cmd} is not a harness command`);
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
  const guard = (command: string) =>
    spawnSync("node", [path.join(scripts, "bash-guard.mjs")], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" }).status;
  assert.equal(guard('node .claude/skills/duckwright-agent/scripts/pw-step.mjs act --run r -- goto "https://a.b/?x=1&y=2"'), 0);
  assert.equal(guard("node x/pw-step.mjs act --run r -- click e1; rm -rf /"), 2);
  assert.equal(guard("node x/pw-step.mjs act --run r -- fill e1 \"$(cat ~/.ssh/id_rsa)\""), 2);
  assert.equal(guard("node x/pw-step.mjs act --run r -- click e1 | tee out"), 2);
  assert.equal(guard("cat ~/.ssh/id_rsa"), 2);
  assert.equal(guard("playwright-cli open"), 2);
});
