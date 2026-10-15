import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { main } from "../src/cli.ts";
import { checkTasks } from "../src/check.ts";
import { tmpDir } from "./helpers.ts";

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

function project(files: Record<string, string>): string {
  const tmp = tmpDir();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true });
    fs.writeFileSync(path.join(tmp, name), text);
  }
  process.chdir(tmp);
  return tmp;
}

const ENV = "# Local\n\n## Base URL\n\nhttp://localhost:3000\n";

test("check_ok_file_with_env", () => {
  project({ "environments/local.md": ENV, "t.md": "---\nenv: local\n---\nOpen http://localhost:3000.\n" });
  const r = checkTasks(["t.md"]);
  assert.deepEqual(r.ok, ["t.md"]);
  assert.deepEqual(r.findings, []);
});

test("check_reports_front_matter_errors_with_line", () => {
  project({ "t.md": "---\nbogus: 1\n---\nx\n" });
  const r = checkTasks(["t.md"]);
  assert.deepEqual(r.ok, []);
  assert.equal(r.findings[0].level, "error");
  assert.match(r.findings[0].message, /t\.md:2: unknown setting "bogus"/);
});

test("check_refuses_allow_file_access_in_a_task_file", () => {
  project({ "t.md": "---\nallow-file-access: true\n---\nx\n" });
  assert.match(checkTasks(["t.md"]).findings[0].message, /allow-file-access must be passed on the command line/);
});

test("check_missing_or_empty_setup_is_an_error", () => {
  project({ "a.md": "---\nsetup: nope.md\n---\nx\n", "b.md": "---\nsetup: empty.md\n---\nx\n", "empty.md": "  \n" });
  const r = checkTasks(["a.md", "b.md"]);
  assert.equal(r.findings.filter((f) => f.level === "error").length, 2);
  assert.match(r.findings[0].message, /setup .*nope\.md: file not found/);
  assert.match(r.findings[1].message, /is empty/);
});

test("check_env_missing_too_large_and_empty_are_errors", () => {
  project({
    "environments/big.md": "x".repeat(16385),
    "environments/blank.md": "\n",
    "a.md": "---\nenv: ghost\n---\nx\n",
    "b.md": "---\nenv: big\n---\nx\n",
    "c.md": "---\nenv: blank\n---\nx\n",
  });
  const msgs = checkTasks(["a.md", "b.md", "c.md"]).findings.map((f) => f.message);
  assert.match(msgs[0], /environment file not found/);
  assert.match(msgs[1], /too large/);
  assert.match(msgs[2], /is empty/);
});

test("check_warns_when_env_leaves_no_room_for_explore", () => {
  project({ "environments/fat.md": "y".repeat(14000), "t.md": "---\nenv: fat\n---\nx\n" });
  const r = checkTasks(["t.md"]);
  assert.deepEqual(r.ok, ["t.md"]);
  assert.equal(r.findings[0].level, "warning");
  assert.match(r.findings[0].message, /explore needs room/);
});

test("check_missing_state_file_is_a_warning_not_an_error", () => {
  project({ "t.md": "---\nstate: .auth/a.json\n---\nx\n" });
  const r = checkTasks(["t.md"]);
  assert.deepEqual(r.ok, ["t.md"]);
  assert.match(r.findings[0].message, /state file not found/);
  assert.equal(r.findings[0].level, "warning");
});

test("check_env_none_skips_the_environment", () => {
  project({ "t.md": "---\nenv: none\n---\nx\n" });
  assert.deepEqual(checkTasks(["t.md"]).findings, []);
});

test("check_expands_folders_like_f", () => {
  project({ "d/01.md": "one\n", "d/02.txt": "two\n", "d/shared/setup.md": "s\n", "d/.hidden.md": "h\n" });
  assert.deepEqual(checkTasks(["d"]).ok, [`d${path.sep}01.md`, `d${path.sep}02.txt`]);
  const e = checkTasks(["nodir-or-file.md"]);
  assert.match(e.findings[0].message, /file not found/);
});

test("check_cli_exit_codes_and_output", async () => {
  project({ "good.md": "x\n", "bad.md": "---\nbogus: 1\n---\nx\n" });
  const out: string[] = [];
  const err: string[] = [];
  const deps = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
  assert.equal(await main(["check", "good.md"], deps), 0);
  assert.deepEqual(out, ["ok: good.md", "1 ok, 0 errors, 0 warnings"]);
  out.length = 0;
  assert.equal(await main(["check", "good.md", "bad.md"], deps), 2);
  assert.match(err.join("\n"), /error: bad\.md:2: unknown setting "bogus"/);
  assert.equal(out.at(-1), "1 ok, 1 error, 0 warnings");
});

test("check_cli_needs_no_tools_on_path", async () => {
  project({ "good.md": "x\n" });
  assert.equal(await main(["check", "good.md"], { stdout: () => {}, stderr: () => {}, which: () => null }), 0);
});

test("check_cli_usage_errors", async () => {
  project({});
  const err: string[] = [];
  const deps = { stdout: () => {}, stderr: (s: string) => err.push(s) };
  assert.equal(await main(["check"], deps), 2);
  assert.match(err.join("\n"), /file_or_folder/);
  err.length = 0;
  assert.equal(await main(["check", "--bogus", "x.md"], deps), 2);
  assert.match(err.join("\n"), /unrecognized arguments: --bogus/);
  const out: string[] = [];
  assert.equal(await main(["check", "-h"], { stdout: (s: string) => out.push(s), stderr: () => {} }), 0);
  assert.match(out.join("\n"), /usage: duckwright check/);
});
