import assert from "node:assert/strict";
import { test } from "node:test";

import { UsageError, parseExportArgs, parseRunArgs } from "../src/args.ts";
import type { ExportArgs, Parsed, RunArgs } from "../src/args.ts";

function args<T>(p: Parsed<T>): T {
  assert.equal(p.kind, "args");
  return (p as { kind: "args"; args: T }).args;
}

const parse = (...a: string[]): RunArgs => args(parseRunArgs(a, "/skill.md"));
const usage = (message: string) => (e: unknown) => e instanceof UsageError && e.message === message;

test("defaults", () => {
  assert.deepEqual(parse("x"), {
    task: "x", file: null, maxSteps: 25, model: "sonnet", headed: false, skill: "/skill.md",
    session: "duckwright", state: null, allowFileAccess: false, export: false, snapshot: "hybrid",
  });
});

test("default_session", () => {
  assert.equal(parse("x").session, "duckwright");
});

test("every option", () => {
  assert.deepEqual(parse(
    "--max-steps", "7", "--model=opus", "--headed", "--skill", "s.md", "--session", "s1",
    "--state", "a.json", "--allow-file-access", "--export", "--snapshot-grep", "go",
  ), {
    task: "go", file: null, maxSteps: 7, model: "opus", headed: true, skill: "s.md",
    session: "s1", state: "a.json", allowFileAccess: true, export: true, snapshot: "grep",
  });
});

test("allow_file_access_help_warns", () => {
  const p = parseRunArgs(["--help"], "/s");
  assert.equal(p.kind, "help");
  const text = (p as { text: string }).text.split(/\s+/).join(" ");
  assert.ok(text.includes("trusted"));
  assert.ok(text.includes("up to 5,000 characters"));
});

test("version", () => {
  assert.deepEqual(parseRunArgs(["x", "--version"], "/s"), { kind: "version" });
});

test("file is greedy until the next option", () => {
  assert.deepEqual(parse("-f", "a.md", "Open the site").file, ["a.md", "Open the site"]);
  assert.equal(parse("-f", "a.md", "Open the site").task, null);
  assert.deepEqual(parse("-f", "a.md", "--headed", "-f", "b.md").file, ["a.md", "b.md"]);
  assert.deepEqual(parse("--file=a.md", "x").file, ["a.md"]);
  assert.equal(parse("--file=a.md", "x").task, "x");
});

test("file needs a value", () => {
  assert.throws(() => parse("-f"), usage("argument -f/--file: expected at least one argument"));
  assert.throws(() => parse("-f", "--headed"), usage("argument -f/--file: expected at least one argument"));
});

test("negatable booleans", () => {
  assert.equal(args(parseRunArgs(["--no-headed", "x"], "/s", { headed: true })).headed, false);
  assert.equal(args(parseRunArgs(["--no-export", "x"], "/s", { export: true })).export, false);
  assert.equal(parse("--headed", "--no-headed", "x").headed, false);
});

test("settings are defaults, flags win", () => {
  assert.equal(args(parseRunArgs(["--model", "opus", "x"], "/s", { model: "haiku", maxSteps: 3 })).model, "opus");
  assert.equal(args(parseRunArgs(["x"], "/s", { maxSteps: 3 })).maxSteps, 3);
  assert.equal(args(parseRunArgs(["x"], "/s", { snapshot: "full" })).snapshot, "full");
  assert.equal(args(parseRunArgs(["--snapshot-grep", "x"], "/s", { snapshot: "full" })).snapshot, "grep");
});

test("max-steps rejects non-integers", () => {
  assert.throws(() => parse("--max-steps", "1e3", "x"), usage("argument --max-steps: invalid int value: '1e3'"));
  assert.throws(() => parse("--max-steps", "", "x"), usage("argument --max-steps: invalid int value: ''"));
  assert.equal(parse("--max-steps", " 7 ", "x").maxSteps, 7);
  assert.equal(parse("--max-steps", "-3", "x").maxSteps, -3);
});

test("value options need a value", () => {
  assert.throws(() => parse("x", "--model"), usage("argument --model: expected one argument"));
  assert.throws(() => parse("--model", "--headed", "x"), usage("argument --model: expected one argument"));
});

test("snapshot flags are mutually exclusive", () => {
  assert.throws(() => parse("--snapshot-full", "--snapshot-grep", "x"),
    usage("argument --snapshot-grep: not allowed with argument --snapshot-full"));
  assert.equal(parse("--snapshot-full", "--snapshot-full", "x").snapshot, "full");
});

test("long options cannot be abbreviated", () => {
  assert.throws(() => parse("--max", "3", "x"), usage("unrecognized arguments: --max x"));
});

test("unknown option and extra positional", () => {
  assert.throws(() => parse("a", "b"), usage("unrecognized arguments: b"));
  assert.throws(() => parse("--nope=1", "a"), usage("unrecognized arguments: --nope=1"));
});

test("double dash makes the rest positional", () => {
  assert.equal(parse("--", "--headed").task, "--headed");
  assert.equal(parse("--", "export").task, "export");
});

test("dash and negative numbers are values", () => {
  assert.equal(parse("-").task, "-");
  assert.equal(parse("-5").task, "-5");
});

test("usage error carries the usage line", () => {
  try {
    parse("--nope");
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof UsageError);
    assert.ok(e.usage.startsWith("usage: duckwright [-h]"));
    assert.equal(e.prog, "duckwright");
  }
});

test("export args", () => {
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["runs/x"])), { run: "runs/x", output: null });
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["runs/x", "-o", "a.ts"])), { run: "runs/x", output: "a.ts" });
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["--output=a.ts", "runs/x"])), { run: "runs/x", output: "a.ts" });
  assert.equal(parseExportArgs(["-h"]).kind, "help");
  assert.throws(() => parseExportArgs([]), usage("the following arguments are required: run"));
  assert.throws(() => parseExportArgs(["a", "b"]), usage("unrecognized arguments: b"));
  assert.throws(() => parseExportArgs(["a", "-o"]), usage("argument -o/--output: expected one argument"));
});

test("dash arguments with a space are values", () => {
  assert.equal(parse("- go to example.com").task, "- go to example.com");
  assert.equal(parse("--model", "-x y", "t").model, "-x y");
  assert.deepEqual(parse("-f", "-my file.md").file, ["-my file.md"]);
  assert.equal(args<ExportArgs>(parseExportArgs(["-my run dir"])).run, "-my run dir");
});

test("short options take an attached value", () => {
  assert.deepEqual(parse("-fa.md").file, ["a.md"]);
  assert.deepEqual(parse("-f=a.md").file, ["a.md"]);
  assert.deepEqual(parse("-fa.md", "b.md").file, ["a.md"]);
  assert.equal(parse("-fa.md", "b.md").task, "b.md");
  assert.equal(args<ExportArgs>(parseExportArgs(["r", "-ofoo"])).output, "foo");
  assert.equal(args<ExportArgs>(parseExportArgs(["r", "-o=foo"])).output, "foo");
});

test("flags reject an explicit value", () => {
  assert.throws(() => parse("--export=yes", "x"), usage("argument --export/--no-export: ignored explicit argument 'yes'"));
  assert.throws(() => parse("--no-headed=1", "x"), usage("argument --headed/--no-headed: ignored explicit argument '1'"));
  assert.throws(() => parse("--allow-file-access=1", "x"), usage("argument --allow-file-access: ignored explicit argument '1'"));
  assert.throws(() => parse("--snapshot-full=1", "x"), usage("argument --snapshot-full: ignored explicit argument '1'"));
  assert.throws(() => parse("--help=x"), usage("argument -h/--help: ignored explicit argument 'x'"));
});

test("max-steps accepts Python int underscores", () => {
  assert.equal(parse("--max-steps", "1_000", "x").maxSteps, 1000);
  assert.throws(() => parse("--max-steps", "1__0", "x"), usage("argument --max-steps: invalid int value: '1__0'"));
});
