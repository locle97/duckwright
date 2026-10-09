import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, mock, test } from "node:test";

import { TaskFileError, expandTaskPaths, loadTaskFile, settingValue, taskPaths } from "../src/taskfile.ts";
import { ROOT, tmpDir } from "./helpers.ts";

function w(dir: string, text: string | Buffer, name = "t.md"): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function err(p: string): string {
  try {
    loadTaskFile(p);
  } catch (e) {
    assert.ok(e instanceof TaskFileError, String(e));
    return e.message;
  }
  assert.fail("no TaskFileError");
}

const cwd = process.cwd();
const home = process.env.HOME;
afterEach(() => {
  process.chdir(cwd);
  process.env.HOME = home;
  mock.restoreAll();
});

test("body_only", () => {
  const tmp = tmpDir();
  const tf = loadTaskFile(w(tmp, "  Open a\nthen b \n\n"));
  assert.equal(tf.task, "Open a\nthen b");
  assert.deepEqual(tf.settings, {});
  assert.equal(tf.baseDir, tmp);
});

test("front_matter_and_body", () => {
  const p = w(tmpDir(), "---\nmodel: opus\nmax-steps: 15\nheaded: true\nsession: s1\n---\nGo\n");
  const tf = loadTaskFile(p);
  assert.deepEqual(tf.settings, { model: "opus", maxSteps: 15, headed: true, session: "s1" });
  assert.equal(tf.task, "Go");
});

test("comments_and_quotes", () => {
  const p = w(tmpDir(), '---\n# c\n\nmodel: sonnet   # trailing\nsession: "a # b"  # c\n---\nGo');
  assert.deepEqual(loadTaskFile(p).settings, { model: "sonnet", session: "a # b" });
});

test("quoted_typed_values", () => {
  const p = w(tmpDir(), "---\nheaded: \"true\"\nmax-steps: '15'\n---\nGo");
  assert.deepEqual(loadTaskFile(p).settings, { headed: true, maxSteps: 15 });
});

test("quoted_value_then_comment_without_space", () => {
  const p = w(tmpDir(), '---\nsession: "a b"#c\n---\nGo');
  assert.deepEqual(loadTaskFile(p).settings, { session: "a b" });
});

for (const mode of ["full", "grep", "hybrid"]) {
  test(`snapshot_setting ${mode}`, () => {
    const p = w(tmpDir(), `---\nsnapshot: ${mode}\n---\nGo`);
    assert.deepEqual(loadTaskFile(p).settings, { snapshot: mode });
  });
}

test("bad_snapshot_setting_is_a_located_error", () => {
  const p = w(tmpDir(), "---\nsnapshot: fast\n---\nGo");
  assert.match(err(p), /:2: snapshot must be full, grep or hybrid, got "fast"$/);
});

test("bom_and_crlf", () => {
  const tf = loadTaskFile(w(tmpDir(), Buffer.from("\xef\xbb\xbf---\r\nmodel: opus\r\n---\r\nGo\r\n", "latin1")));
  assert.deepEqual(tf.settings, { model: "opus" });
  assert.equal(tf.task, "Go");
});

test("closing_rule_allows_trailing_space", () => {
  const tf = loadTaskFile(w(tmpDir(), "---  \nmodel: x\n---\t\nGo"));
  assert.deepEqual(tf.settings, { model: "x" });
  assert.equal(tf.task, "Go");
});

test("paths_resolve_from_file_dir", () => {
  const tmp = tmpDir();
  const p = w(tmp, "---\nstate: auth.json\nskill: ../s.md\n---\nGo", "tasks/t.md");
  const s = loadTaskFile(p).settings;
  assert.equal(s.state, path.join(tmp, "tasks", "auth.json"));
  assert.equal(s.skill, path.join(tmp, "s.md"));
});

test("tilde_path_expanded", () => {
  const tmp = tmpDir();
  process.env.HOME = tmp;
  const p = w(tmp, "---\nstate: ~/a.json\n---\nGo", "sub/t.md");
  assert.equal(loadTaskFile(p).settings.state, path.join(tmp, "a.json"));
});

test("tilde of the current user expands", () => {
  const tmp = tmpDir();
  process.env.HOME = tmp;
  const p = w(tmp, `---\nstate: ~${os.userInfo().username}/x.json\n---\nGo`, "sub/t.md");
  assert.equal(loadTaskFile(p).settings.state, path.join(tmp, "x.json"));
});

test("body_rule_is_kept", () => {
  assert.equal(loadTaskFile(w(tmpDir(), "---\nmodel: x\n---\nA\n---\nB")).task, "A\n---\nB");
});

test("body_hash_lines_are_kept", () => {
  const text = "# Login\n\nOpen a  # not a comment";
  assert.equal(loadTaskFile(w(tmpDir(), text + "\n")).task, text);
});

test("value_keeps_colon_and_unspaced_hash", () => {
  const p = w(tmpDir(), "---\nsession: team:a#1\n---\nGo");
  assert.deepEqual(loadTaskFile(p).settings, { session: "team:a#1" });
});

test("hash_without_space_is_kept", () => {
  const tmp = tmpDir();
  let p = w(tmp, "---\nmodel:#x\nsession: #gone\n---\nGo");
  assert.match(err(p), /"session" has no value/);
  p = w(tmp, "---\nmodel:#x\n---\nGo");
  assert.deepEqual(loadTaskFile(p).settings, { model: "#x" });
});

test("huge_max_steps_is_a_located_error", () => {
  const p = w(tmpDir(), "---\nmax-steps: " + "9".repeat(5000) + "\n---\nGo");
  assert.ok(err(p).startsWith(`${p}:2: max-steps must be a whole number of at least 1`));
});

test("max-steps above safe integer is a located error", () => {
  const p = w(tmpDir(), "---\nmax-steps: 9007199254740992\n---\nGo");
  assert.ok(err(p).startsWith(`${p}:2: max-steps must be a whole number of at least 1`));
  const q = w(tmpDir(), "---\nmax-steps: 9007199254740991\n---\nGo");
  assert.equal(loadTaskFile(q).settings.maxSteps, Number.MAX_SAFE_INTEGER);
});

for (const value of ["~nosuchuser-duckwright/x.json", "a\x00b"]) {
  test(`unusable_path_is_a_located_error ${JSON.stringify(value)}`, () => {
    const p = w(tmpDir(), `---\nstate: ${value}\n---\nGo`);
    assert.ok(err(p).startsWith(`${p}:2: state is not a usable path: `));
  });
}

test("symlink_loop_is_not_a_crash", () => {
  const tmp = tmpDir();
  fs.symlinkSync(path.join(tmp, "loop2"), path.join(tmp, "loop1"));
  fs.symlinkSync(path.join(tmp, "loop1"), path.join(tmp, "loop2"));
  const p = w(tmp, "---\nstate: loop1/x.json\n---\nGo");
  assert.equal(loadTaskFile(p).settings.state, path.join(tmp, "loop1", "x.json"));
});

test("error_names_path_as_typed", () => {
  process.chdir(tmpDir());
  assert.equal(err("./tasks//missing.md"), "./tasks//missing.md: file not found");
});

test("key_is_case_sensitive", () => {
  const p = w(tmpDir(), "---\nModel: opus\n---\nGo");
  assert.equal(err(p), `${p}:2: unknown setting "Model"`);
});

test("inherited_object_keys_are_unknown_settings", () => {
  const p = w(tmpDir(), "---\nconstructor: x\n---\nGo");
  assert.equal(err(p), `${p}:2: unknown setting "constructor"`);
});

test("leading_rule_is_a_located_error", () => {
  // A Markdown file using --- as dividers, with no front matter intended.
  const p = w(tmpDir(), "---\n\nSome text\n---\nMore");
  assert.equal(err(p), `${p}:3: expected "key: value"`);
});

const ERRORS: [string, number | null, string][] = [
  ["---\nmodel: x\nGo", null, "front matter is not closed with ---"],
  ["---\njust words\n---\nGo", 2, 'expected "key: value"'],
  ['---\nmodel: "x\n---\nGo', 2, "bad quoted value"],
  ['---\nmodel: "x" y\n---\nGo', 2, "bad quoted value"],
  ["---\nmax_steps: 3\n---\nGo", 2, 'unknown setting "max_steps"'],
  ["---\nallow-file-access: true\n---\nGo", 2, "allow-file-access must be passed on the command line"],
  ["---\nmodel: a\nmodel: b\n---\nGo", 3, '"model" is set twice'],
  ["---\nmodel:\n---\nGo", 2, '"model" has no value'],
  ['---\nmodel: ""\n---\nGo', 2, '"model" has no value'],
  ["---\nmax-steps: lots\n---\nGo", 2, 'max-steps must be a whole number of at least 1, got "lots"'],
  ["---\nmax-steps: 0\n---\nGo", 2, 'max-steps must be a whole number of at least 1, got "0"'],
  ["---\nheaded: yes\n---\nGo", 2, 'headed must be true or false, got "yes"'],
  ["---\nheaded: True\n---\nGo", 2, 'headed must be true or false, got "True"'],
  ["---\nmodel: x\n---\n  \n", null, "no task text"],
  ["", null, "no task text"],
];

for (const [text, line, message] of ERRORS) {
  test(`errors ${JSON.stringify(text)}`, () => {
    const p = w(tmpDir(), text);
    assert.equal(err(p), `${line ? `${p}:${line}` : p}: ${message}`);
  });
}

test("missing_file", () => {
  const p = path.join(tmpDir(), "nope.md");
  assert.equal(err(p), `${p}: file not found`);
});

test("directory", () => {
  const tmp = tmpDir();
  assert.ok(err(tmp).startsWith(`${tmp}: cannot read: `));
});

test("not_utf8", () => {
  const p = w(tmpDir(), Buffer.from([0xff, 0xfe, 0x00]));
  assert.ok(err(p).startsWith(`${p}: cannot read: `));
});

test("example_template_parses", () => {
  const tf = loadTaskFile(path.join(ROOT, "examples", "task.md"));
  assert.deepEqual(tf.settings, { model: "sonnet", maxSteps: 25 });
  assert.ok(tf.task.startsWith("Open https://example.com/form."));
});

test("expand_files_pass_through_in_order", () => {
  const tmp = tmpDir();
  const a = w(tmp, "A", "a.md");
  const b = w(tmp, "B", "b.txt");
  assert.deepEqual(expandTaskPaths([b, a, "missing.md"]), [b, a, "missing.md"]);
});

test("expand_folder_filters_and_sorts", () => {
  const tasks = path.join(tmpDir(), "tasks");
  for (const name of ["b.md", "a.TXT", "c.Md", ".hidden.md", "auth.json", "notes", "sub/d.md"]) w(tasks, "x", name);
  assert.deepEqual(expandTaskPaths([tasks]), ["a.TXT", "b.md", "c.Md"].map((n) => path.join(tasks, n)));
});

test("expand_folder_keeps_path_as_typed", () => {
  const tmp = tmpDir();
  process.chdir(tmp);
  w(path.join(tmp, "tasks"), "x", "a.md");
  assert.deepEqual(expandTaskPaths(["tasks/"]), ["tasks/a.md"]);
  assert.deepEqual(expandTaskPaths(["tasks"]), ["tasks/a.md"]);
});

test("expand_dedupes_by_resolved_path", () => {
  const tmp = tmpDir();
  process.chdir(tmp);
  w(path.join(tmp, "tasks"), "x", "a.md");
  w(path.join(tmp, "tasks"), "x", "b.md");
  assert.deepEqual(expandTaskPaths(["tasks/a.md", "tasks", "./tasks/b.md"]), ["tasks/a.md", "tasks/b.md"]);
});

test("expand_empty_folder_errors", () => {
  const tasks = path.join(tmpDir(), "tasks");
  w(tasks, "{}", "auth.json");
  assert.throws(() => expandTaskPaths([tasks]), { name: "TaskFileError", message: `${tasks}: no task files (.md or .txt)` });
});

test("expand_unreadable_folder_errors", () => {
  const tasks = path.join(tmpDir(), "tasks");
  fs.mkdirSync(tasks);
  mock.method(fs, "readdirSync", () => {
    throw new Error("denied");
  });
  assert.throws(() => expandTaskPaths([tasks]), { message: `${tasks}: cannot read: denied` });
});

test("expand_keeps_dot_slash_as_typed", () => {
  const tmp = tmpDir();
  process.chdir(tmp);
  w(path.join(tmp, "tasks"), "x", "a.md");
  assert.deepEqual(expandTaskPaths(["./tasks/"]), ["./tasks/a.md"]);
  assert.deepEqual(expandTaskPaths(["./tasks"]), ["./tasks/a.md"]);
});

test("expand_unstattable_path_is_left_for_loading", () => {
  const long = path.join(tmpDir(), "a".repeat(300));
  assert.deepEqual(expandTaskPaths([long]), [long]);
  assert.ok(err(long).startsWith(`${long}: cannot read: `));
});

test("task_paths_keeps_every_folder_error_in_order", () => {
  const tmp = tmpDir();
  process.chdir(tmp);
  w(path.join(tmp, "empty"), "{}", "auth.json");
  w(path.join(tmp, "tasks"), "x", "a.md");
  const out = taskPaths(["empty", "x.md", "nope", "tasks"]);
  assert.deepEqual(out.map((p) => (p instanceof TaskFileError ? p.message : p)), [
    "empty: no task files (.md or .txt)", "x.md", "nope", "tasks/a.md",
  ]);
});

test("settingvalue_messages_match_front_matter", () => {
  const tmp = tmpDir();
  const cases: [string, string, string][] = [
    ["max-steps", "0", "max-steps must be a whole number of at least 1, got \"0\""],
    ["headed", "yes", "headed must be true or false, got \"yes\""],
    ["snapshot", "tree", "snapshot must be full, grep or hybrid, got \"tree\""],
  ];
  for (const [key, raw, message] of cases) {
    assert.equal(err(w(tmp, `---\n${key}: ${raw}\n---\ntask\n`)), `${path.join(tmp, "t.md")}:2: ${message}`);
    assert.throws(
      () => settingValue(key as "max-steps", raw),
      (e: unknown) => e instanceof TaskFileError && e.message === message,
    );
  }
  assert.equal(settingValue("max-steps", "12"), 12);
  assert.equal(settingValue("headed", "true"), true);
  assert.equal(settingValue("snapshot", "grep"), "grep");
  assert.equal(settingValue("model", "m1"), "m1");
  assert.throws(() => settingValue("model", ""), /"model" has no value/);
});

test("network_key_parsed", () => {
  const p = w(tmpDir(), "---\nnetwork: false\n---\nGo\n");
  assert.equal(loadTaskFile(p).settings.network, false);
});

test("network_key_bad_value", () => {
  const p = w(tmpDir(), "---\nnetwork: maybe\n---\nGo\n");
  assert.equal(err(p), `${p}:2: network must be true or false, got "maybe"`);
});

test("setup_file_goes_before_the_task", () => {
  const dir = tmpDir();
  w(dir, "  Log in as qa@example.com\n", "shared/setup.md");
  const tf = loadTaskFile(w(dir, "---\nsetup: shared/setup.md\nmodel: opus\n---\nOpen settings"));
  assert.equal(tf.task, "Setup (do this first, then the task below):\nLog in as qa@example.com\n\nTask:\nOpen settings");
  assert.deepEqual(tf.settings, { model: "opus" });
  assert.equal(tf.setup, path.join(dir, "shared", "setup.md"));
});

test("no_setup_is_null", () => {
  assert.equal(loadTaskFile(w(tmpDir(), "Go")).setup, null);
});

test("missing_or_empty_setup_file_is_an_error", () => {
  const dir = tmpDir();
  const p = w(dir, "---\nsetup: nope.md\n---\nGo");
  assert.equal(err(p), `${p}: setup ${path.join(dir, "nope.md")}: file not found`);
  w(dir, " \n", "empty.md");
  const q = w(dir, "---\nsetup: empty.md\n---\nGo", "q.md");
  assert.equal(err(q), `${q}: setup ${path.join(dir, "empty.md")} is empty`);
});

test("front_matter_twofa_timeout", () => {
  const tmp = tmpDir();
  const file = w(tmp, "---\ntwofa-timeout: 45\n---\nlog in\n");
  assert.equal(loadTaskFile(file).settings.twofaTimeout, 45);
  w(tmp, "---\ntwofa-timeout: 0\n---\nlog in\n");
  assert.match(err(file), /twofa-timeout must be a whole number of at least 1/);
  w(tmp, "---\ntwofa-timeout: 2147483\n---\nlog in\n");
  assert.equal(loadTaskFile(file).settings.twofaTimeout, 2147483);
  w(tmp, "---\ntwofa-timeout: 2147484\n---\nlog in\n");
  assert.match(err(file), /twofa-timeout must be a whole number of at most 2147483, got "2147484"/);
});

test("evidence_keys_parsed", () => {
  const s = loadTaskFile(w(tmpDir(), "---\nvideo: true\nscreenshot: false\n---\nGo\n")).settings;
  assert.equal(s.video, true);
  assert.equal(s.screenshot, false);
});

test("evidence_key_bad_value_and_duplicate", () => {
  const p = w(tmpDir(), "---\nvideo: maybe\n---\nGo\n");
  assert.equal(err(p), `${p}:2: video must be true or false, got "maybe"`);
  const q = w(tmpDir(), "---\nscreenshot: true\nscreenshot: false\n---\nGo\n");
  assert.match(err(q), /"screenshot" is set twice/);
  assert.equal(settingValue("video", "true"), true);
});

test("jev keys", () => {
  const s = loadTaskFile(w(tmpDir(), "---\njev: true\njev-threshold: 0.9\n---\nGo\n")).settings;
  assert.deepEqual({ jev: s.jev, jevThreshold: s.jevThreshold }, { jev: true, jevThreshold: 0.9 });
});

test("jev-threshold invalid", () => {
  for (const v of ["abc", "0", "1.5", "1e-1"]) {
    const p = w(tmpDir(), `---\njev: true\njev-threshold: ${v}\n---\nGo\n`);
    assert.equal(err(p), `${p}:3: jev-threshold must be a number greater than 0 and at most 1, got "${v}"`);
  }
});

test("jev invalid bool", () => {
  const p = w(tmpDir(), "---\njev: yes\n---\nGo\n");
  assert.equal(err(p), `${p}:2: jev must be true or false, got "yes"`);
});

test("settingValue jev", () => {
  assert.equal(settingValue("jev", "true"), true);
});
