import assert from "node:assert/strict";
import { test } from "node:test";

import { RUN_USAGE, UsageError, parseExportArgs, parseRunArgs } from "../src/args.ts";
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
    tui: false, maxParallel: null, network: true, twofaTimeout: 300,
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
    tui: false, maxParallel: null, network: true, twofaTimeout: 300,
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
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["runs/x"])), { run: "runs/x", output: null, api: false });
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["runs/x", "-o", "a.ts"])), { run: "runs/x", output: "a.ts", api: false });
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["--output=a.ts", "runs/x"])), { run: "runs/x", output: "a.ts", api: false });
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

test("tui flag and max-parallel", () => {
  assert.equal(parse("--tui").tui, true);
  assert.equal(parse("--tui").maxParallel, null);
  assert.equal(parse("--tui", "--max-parallel", "2").maxParallel, 2);
  assert.equal(parse("--max-parallel=4").maxParallel, 4);
});

test("max-parallel rejects bad values", () => {
  assert.throws(() => parse("--tui", "--max-parallel", "0"), usage("argument --max-parallel: must be at least 1"));
  assert.throws(() => parse("--tui", "--max-parallel", "x"), usage("argument --max-parallel: invalid int value: 'x'"));
  assert.throws(() => parse("--tui", "--max-parallel"), usage("argument --max-parallel: expected one argument"));
});

test("help lists the tui flags", () => {
  const text = (parseRunArgs(["--help"], "/s") as { text: string }).text;
  assert.ok(text.includes("[--tui] [--max-parallel N]"));
  assert.ok(text.includes("open the interactive workspace"));
  assert.ok(text.includes("with --tui: most runs at once (default 3)"));
});

test("past_flag_values", () => {
  assert.equal(parse("--tui", "--past", "0").past, 0);
  assert.equal(parse("--tui", "--past", "5").past, 5);
  assert.equal(parse("--tui", "--past=7").past, 7);
  const bare = parse("--tui");
  assert.equal("past" in bare, false);
  assert.equal("theme" in bare, false);
  assert.throws(() => parse("--tui", "--past", "-1"), usage("argument --past: must be at least 0"));
  assert.throws(() => parse("--tui", "--past", "x"), usage("argument --past: invalid int value: 'x'"));
  assert.throws(() => parse("--tui", "--past"), usage("argument --past: expected one argument"));
});

test("theme_flag_values", () => {
  for (const t of ["auto", "dark", "light"]) assert.equal(parse("--tui", "--theme", t).theme, t);
  assert.equal(parse("--tui", "--theme=light").theme, "light");
  assert.throws(
    () => parse("--tui", "--theme", "blue"),
    usage("argument --theme: invalid choice: 'blue' (choose from 'auto', 'dark', 'light')"),
  );
});

test("help_lists_past_and_theme", () => {
  const text = (parseRunArgs(["--help"], "/s") as { text: string }).text;
  assert.ok(text.includes("[--tui] [--max-parallel N] [--past N] [--theme {auto,dark,light}]"));
  assert.ok(text.includes("with --tui: past runs to show (default 20, 0 = none)"));
  assert.ok(text.includes("with --tui: auto, dark or light (default auto)"));
});

test("network_default_on", () => {
  assert.equal(parse("t").network, true);
});

test("no_network", () => {
  assert.equal(parse("t", "--no-network").network, false);
});

test("network_last_wins", () => {
  assert.equal(parse("t", "--no-network", "--network").network, true);
  assert.equal(parse("t", "--network", "--no-network").network, false);
});

test("network_task_file_overridden", () => {
  assert.equal(args(parseRunArgs(["t", "--network"], "/s", { network: false })).network, true);
  assert.equal(args(parseRunArgs(["t"], "/s", { network: false })).network, false);
});

test("network_explicit_value_error", () => {
  assert.throws(() => parse("t", "--network=x"), usage("argument --network/--no-network: ignored explicit argument 'x'"));
});

test("help_mentions_network", () => {
  const p = parseRunArgs(["--help"], "/s");
  assert.equal(p.kind, "help");
  const text = (p as { text: string }).text;
  const entry = "  --network, --no-network\n                        record the API calls the page makes each step,\n"
    + "                        redacted, under runs/<id>/network (default on)\n";
  const at = text.indexOf(entry);
  assert.ok(at > text.indexOf("  --export, --no-export\n"));
  assert.ok(at < text.indexOf("  --snapshot-hybrid"));
  assert.ok(RUN_USAGE.includes("[--export | --no-export] [--network | --no-network]"));
});

test("export_api_flag", () => {
  assert.deepEqual(args<ExportArgs>(parseExportArgs(["--api", "runs/a"])), { run: "runs/a", output: null, api: true });
  assert.equal(args<ExportArgs>(parseExportArgs(["runs/a", "--api"])).api, true);
  assert.throws(() => parseExportArgs(["--api=1", "a"]), usage("argument --api: ignored explicit argument '1'"));
});

test("export_help_mentions_api", () => {
  const p = parseExportArgs(["-h"]);
  assert.match(p.kind === "help" ? p.text : "", /--api/);
});

test("twofa_timeout_default_and_flag", () => {
  assert.equal(parse("t").twofaTimeout, 300);
  assert.equal(parse("t", "--twofa-timeout", "60").twofaTimeout, 60);
  assert.equal(parse("t", "--twofa-timeout=90").twofaTimeout, 90);
});

test("twofa_timeout_must_be_a_positive_int", () => {
  assert.throws(() => parse("t", "--twofa-timeout", "0"), /argument --twofa-timeout: must be at least 1/);
  assert.throws(() => parse("t", "--twofa-timeout", "soon"), /argument --twofa-timeout: invalid int value: 'soon'/);
  assert.throws(() => parse("t", "--twofa-timeout"), /argument --twofa-timeout: expected one argument/);
});
