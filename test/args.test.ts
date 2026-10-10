import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPLORE_HELP, EXPLORE_USAGE, RUN_HELP, RUN_USAGE, UsageError, parseExploreArgs, parseExportArgs, parseRunArgs } from "../src/args.ts";
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
    session: "duckwright", state: null, allowFileAccess: false, snapshot: "hybrid", env: null,
    print: false, maxParallel: null, plan: null, network: true, video: false, screenshot: false, twofaTimeout: 300, web: false, port: null,
    jev: false, jevThreshold: 0.8, debug: false,
  });
});

test("default_session", () => {
  assert.equal(parse("x").session, "duckwright");
});

test("every option", () => {
  assert.deepEqual(parse(
    "--max-steps", "7", "--model=opus", "--headed", "--skill", "s.md", "--session", "s1",
    "--state", "a.json", "--allow-file-access", "--snapshot-grep", "go",
  ), {
    task: "go", file: null, maxSteps: 7, model: "opus", headed: true, skill: "s.md",
    session: "s1", state: "a.json", allowFileAccess: true, snapshot: "grep", env: null,
    print: false, maxParallel: null, plan: null, network: true, video: false, screenshot: false, twofaTimeout: 300, web: false, port: null, jev: false, jevThreshold: 0.8, debug: false,
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
  assert.throws(() => parse("--no-headed=1", "x"), usage("argument --headed/--no-headed: ignored explicit argument '1'"));
  assert.throws(() => parse("--allow-file-access=1", "x"), usage("argument --allow-file-access: ignored explicit argument '1'"));
  assert.throws(() => parse("--snapshot-full=1", "x"), usage("argument --snapshot-full: ignored explicit argument '1'"));
  assert.throws(() => parse("--help=x"), usage("argument -h/--help: ignored explicit argument 'x'"));
});

test("max-steps accepts Python int underscores", () => {
  assert.equal(parse("--max-steps", "1_000", "x").maxSteps, 1000);
  assert.throws(() => parse("--max-steps", "1__0", "x"), usage("argument --max-steps: invalid int value: '1__0'"));
});

test("print flag and max-parallel", () => {
  assert.equal(parse("t").print, false);
  assert.equal(parse("-p", "t").print, true);
  assert.equal(parse("--print", "t").print, true);
  assert.equal(parse().maxParallel, null);
  assert.equal(parse("--max-parallel", "2").maxParallel, 2);
  assert.equal(parse("--max-parallel=4").maxParallel, 4);
  assert.throws(() => parse("--tui"), usage("unrecognized arguments: --tui"));
  assert.throws(() => parse("-p=x", "t"), usage("argument -p/--print: ignored explicit argument 'x'"));
});

test("max-parallel rejects bad values", () => {
  assert.throws(() => parse("--max-parallel", "0"), usage("argument --max-parallel: must be at least 1"));
  assert.throws(() => parse("--max-parallel", "x"), usage("argument --max-parallel: invalid int value: 'x'"));
  assert.throws(() => parse("--max-parallel"), usage("argument --max-parallel: expected one argument"));
});

test("help lists the print and tui flags", () => {
  const text = (parseRunArgs(["--help"], "/s") as { text: string }).text;
  assert.ok(text.includes("[-p] [-f FILE [FILE ...]]"));
  assert.ok(text.includes("-p, --print           run the task"));
  assert.ok(text.includes("TUI and web UI: most runs at once (default 3)"));
  assert.ok(!text.includes("--tui"));
});

test("past_flag_values", () => {
  assert.equal(parse("--past", "0").past, 0);
  assert.equal(parse("--past", "5").past, 5);
  assert.equal(parse("--past=7").past, 7);
  const bare = parse();
  assert.equal("past" in bare, false);
  assert.equal("theme" in bare, false);
  assert.throws(() => parse("--past", "-1"), usage("argument --past: must be at least 0"));
  assert.throws(() => parse("--past", "x"), usage("argument --past: invalid int value: 'x'"));
  assert.throws(() => parse("--past"), usage("argument --past: expected one argument"));
});

test("theme_flag_values", () => {
  for (const t of ["auto", "dark", "light"]) assert.equal(parse("--theme", t).theme, t);
  assert.equal(parse("--theme=light").theme, "light");
  assert.throws(
    () => parse("--theme", "blue"),
    usage("argument --theme: invalid choice: 'blue' (choose from 'auto', 'dark', 'light')"),
  );
});

test("help_lists_past_and_theme", () => {
  const text = (parseRunArgs(["--help"], "/s") as { text: string }).text;
  assert.ok(text.includes("[--max-parallel N] [--past N] [--theme {auto,dark,light}]"));
  assert.ok(text.includes("TUI and web UI: past runs to show (default 20, 0 = none)"));
  assert.ok(text.includes("TUI and web UI: auto, dark or light (default auto)"));
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
  assert.ok(at > text.indexOf("  --allow-file-access"));
  assert.ok(at < text.indexOf("  --snapshot-hybrid"));
  assert.ok(RUN_USAGE.includes("[--network | --no-network]"));
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

test("plan_option", () => {
  const p = parseRunArgs(["--plan", "docs/qa.md", "--model", "opus"], "s.md");
  assert.ok(p.kind === "args");
  assert.equal(p.args.plan, "docs/qa.md");
  assert.equal(p.args.model, "opus");
  assert.throws(() => parseRunArgs(["--plan"], "s.md"), /argument --plan: expected one argument/);
  assert.ok(RUN_USAGE.includes("[--plan PLAN]"));
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
  assert.equal(parse("t", "--twofa-timeout", "2147483").twofaTimeout, 2147483);
  assert.throws(() => parse("t", "--twofa-timeout", "2147484"), /argument --twofa-timeout: must be at most 2147483/);
  assert.throws(() => parse("t", "--twofa-timeout", "99999999999999"), /argument --twofa-timeout: must be at most 2147483/);
});

test("web flag and port", () => {
  assert.equal(parse("--web").web, true);
  assert.equal(parse("x").web, false);
  assert.equal(parse("--web", "--port", "8080").port, 8080);
  assert.equal(parse("--port=3000").port, 3000);
  assert.equal(parse("x").port, null);
});

test("port rejects bad values", () => {
  assert.throws(() => parse("--port", "0"), usage("argument --port: must be between 1 and 65535"));
  assert.throws(() => parse("--port", "65536"), usage("argument --port: must be between 1 and 65535"));
  assert.throws(() => parse("--port", "x"), usage("argument --port: invalid int value: 'x'"));
  assert.throws(() => parse("--port"), usage("argument --port: expected one argument"));
  assert.throws(() => parse("--web=1"), usage("argument --web: ignored explicit argument '1'"));
});

test("help and usage mention the web options", () => {
  const p = parseRunArgs(["--help"], "/s");
  assert.equal(p.kind, "help");
  const text = (p as { kind: "help"; text: string }).text;
  assert.ok(text.includes("--web"));
  assert.ok(text.includes("--port PORT"));
  assert.ok(RUN_USAGE.includes("[--web] [--port PORT]"));
});

test("evidence_flags_default_off", () => {
  const a = parse();
  assert.equal(a.video, false);
  assert.equal(a.screenshot, false);
});

test("evidence_flags_last_wins", () => {
  const a = parse("--video", "--no-video", "--screenshot");
  assert.equal(a.video, false);
  assert.equal(a.screenshot, true);
  assert.equal(parse("--no-screenshot", "--screenshot").screenshot, true);
});

test("evidence_flags_override_settings", () => {
  assert.equal(args(parseRunArgs(["--no-video"], "/skill.md", { video: true })).video, false);
});

test("evidence_flag_rejects_value", () => {
  assert.throws(() => parse("--video=x"), usage("argument --video/--no-video: ignored explicit argument 'x'"));
  assert.throws(() => parse("--no-screenshot=1"), usage("argument --screenshot/--no-screenshot: ignored explicit argument '1'"));
});

test("evidence_help_lines", () => {
  const p = parseRunArgs(["--help"], "/skill.md");
  assert.equal(p.kind, "help");
  const text = (p as { kind: "help"; text: string }).text;
  assert.ok(RUN_USAGE.includes("[--network | --no-network]\n                  [--video | --no-video] [--screenshot | --no-screenshot]\n"));
  const block = "  --video, --no-video   record one video of the whole run to\n"
    + "                        runs/<id>/video.webm (default off)\n"
    + "  --screenshot, --no-screenshot\n"
    + "                        save a screenshot of the page after every step to\n"
    + "                        runs/<id>/screenshots/ (default off)\n";
  assert.ok(text.includes(block));
  assert.ok(text.indexOf("--network, --no-network") < text.indexOf(block));
});

test("args_env_values", () => {
  assert.equal(parse("--env", "staging", "x").env, "staging");
  assert.equal(parse("--env=staging", "x").env, "staging");
  assert.equal(parse("--env", "envs/x.md", "x").env, "envs/x.md");
  assert.equal(args(parseRunArgs(["x"], "/s", { env: "qa" })).env, "qa");
  assert.equal(args(parseRunArgs(["--env", "prod", "x"], "/s", { env: "qa" })).env, "prod");
});

test("args_env_none_is_null", () => {
  assert.equal(parse("--env", "none", "x").env, null);
  assert.equal(args(parseRunArgs(["x"], "/s", { env: "none" })).env, null);
  assert.equal(args(parseRunArgs(["--env", "none", "x"], "/s", { env: "qa" })).env, null);
});

test("args_env_errors", () => {
  assert.throws(() => parse("x", "--env"), usage("argument --env: expected one argument"));
  const bad = (v: string) => `argument --env: invalid environment: '${v}' (use a name of letters, digits, '.', '_' and '-', or a path to a .md file)`;
  assert.throws(() => parse("--env", ".x", "x"), usage(bad(".x")));
  assert.throws(() => parse("--env=", "x"), usage(bad("")));
});

test("args_env_usage_and_help", () => {
  assert.ok(RUN_USAGE.includes("                  [--state FILE] [--env ENV] [--allow-file-access]\n"));
  assert.ok(RUN_HELP.includes(
    "                        state-load before the task starts\n"
    + "  --env ENV             environment context: the text of environments/ENV.md\n"
    + "                        (or of the .md file at path ENV) is put into every\n"
    + "                        step's prompt; none = no environment\n",
  ));
});

test("jev defaults", () => {
  const a = parse("t");
  assert.equal(a.jev, false);
  assert.equal(a.jevThreshold, 0.8);
});

test("jev and no-jev, later wins", () => {
  assert.equal(parse("--jev", "t").jev, true);
  assert.equal(parse("--jev", "--no-jev", "t").jev, false);
  assert.equal(parse("--no-jev", "--jev", "t").jev, true);
  assert.equal(args(parseRunArgs(["--no-jev", "t"], "/skill.md", { jev: true })).jev, false);
  assert.equal(args(parseRunArgs(["t"], "/skill.md", { jev: true })).jev, true);
});

test("jev-threshold values", () => {
  assert.equal(parse("--jev-threshold", "0.9", "t").jevThreshold, 0.9);
  assert.equal(parse("--jev-threshold=1", "t").jevThreshold, 1);
  assert.equal(parse("--jev-threshold", ".5", "t").jevThreshold, 0.5);
  assert.equal(parse("--jev-threshold", " 0.7 ", "t").jevThreshold, 0.7);
  const a = parse("--jev-threshold", "0.6", "t");
  assert.equal(a.jev, false);
  assert.equal(a.jevThreshold, 0.6);
  assert.equal(args(parseRunArgs(["t"], "/skill.md", { jevThreshold: 0.5 })).jevThreshold, 0.5);
});

test("jev-threshold invalid float", () => {
  for (const v of ["abc", "1e-1", "nan", "inf", "-0.5"]) {
    assert.throws(() => parse("--jev-threshold", v, "t"), usage(`argument --jev-threshold: invalid float value: '${v}'`));
  }
});

test("jev-threshold out of range", () => {
  for (const v of ["0", "0.0", "1.5"]) {
    assert.throws(() => parse("--jev-threshold", v, "t"), usage("argument --jev-threshold: must be greater than 0 and at most 1"));
  }
});

test("jev-threshold missing value", () => {
  assert.throws(() => parse("--jev-threshold"), usage("argument --jev-threshold: expected one argument"));
});

test("jev explicit argument", () => {
  assert.throws(() => parse("--jev=x", "t"), usage("argument --jev/--no-jev: ignored explicit argument 'x'"));
});

test("usage and help mention jev", () => {
  assert.ok(RUN_USAGE.includes("[--twofa-timeout SEC]\n                  [--jev | --no-jev] [--jev-threshold FLOAT]\n"));
  const block = "                        most 2147483)\n"
    + "  --jev, --no-jev       cheaper brain: TypeSafe's Jev picks the command and\n"
    + "                        element on steps it is sure of, Claude decides the\n"
    + "                        rest. Needs TYPESAFE_API_KEY. Sends the task, page\n"
    + "                        snapshots and history to TypeSafe (default off)\n"
    + "  --jev-threshold FLOAT\n"
    + "                        with --jev: the confidence Jev needs for its choice\n"
    + "                        to be used, greater than 0 and at most 1 (default\n"
    + "                        0.8)\n"
    + "  --debug, --no-debug ";
  assert.ok(RUN_HELP.includes(block));
});

test("debug default and flags", () => {
  assert.equal(parse("t").debug, false);
  assert.equal(parse("--debug", "t").debug, true);
  assert.equal(parse("--debug", "--no-debug", "t").debug, false);
  assert.equal(parse("--no-debug", "--debug", "t").debug, true);
  assert.equal(args(parseRunArgs(["--no-debug", "t"], "/skill.md", { debug: true })).debug, false);
  assert.equal(args(parseRunArgs(["t"], "/skill.md", { debug: true })).debug, true);
});

test("debug explicit argument", () => {
  assert.throws(() => parse("--debug=x", "t"), usage("argument --debug/--no-debug: ignored explicit argument 'x'"));
});

test("usage and help mention debug", () => {
  assert.ok(RUN_USAGE.includes("[--jev | --no-jev] [--jev-threshold FLOAT]\n                  [--debug | --no-debug]\n"));
  const block = "                        0.8)\n"
    + "  --debug, --no-debug   log every prompt sent to Claude and Jev, the raw\n"
    + "                        responses, tokens, cost and timing to\n"
    + "                        runs/<id>/debug.log, and with -p also to stderr\n"
    + "                        (default off). The log holds full page snapshots;\n"
    + "                        credentials are redacted\n";
  assert.ok(RUN_HELP.includes(block));
});

const U = "https://example.com/";
const ex = (...a: string[]) => args(parseExploreArgs(a, "/skill.md", { maxSteps: 40 }));
const exErr = (message: string, ...a: string[]) =>
  assert.throws(() => parseExploreArgs(a, "/skill.md", { maxSteps: 40 }), (e: unknown) =>
    e instanceof UsageError && e.message === message && e.usage === EXPLORE_USAGE && e.prog === "duckwright explore");

test("explore: help and version", () => {
  for (const f of ["-h", "--help"]) assert.deepEqual(parseExploreArgs([f], "/s"), { kind: "help", text: EXPLORE_HELP });
  assert.ok(EXPLORE_HELP.startsWith(`${EXPLORE_USAGE}\n`));
  assert.deepEqual(parseExploreArgs(["--version"], "/s"), { kind: "version" });
});

test("explore: url, --write-tasks and run options", () => {
  const a = ex(U, "--write-tasks", "-p", "--model", "opus");
  assert.equal(a.url, U);
  assert.equal(a.writeTasks, true);
  assert.equal(a.run.maxSteps, 40);
  assert.equal(a.run.model, "opus");
  assert.equal(a.run.print, true);
  assert.equal(ex("--write-tasks", U).writeTasks, true);
  assert.equal(ex(U).writeTasks, false);
  assert.equal(ex(U, "--max-steps", "10").run.maxSteps, 10);
  assert.equal(ex("http://a.b").url, "http://a.b");
});

test("explore: after -- everything is positional", () => {
  exErr("not an http(s) URL: --write-tasks", "--", "--write-tasks");
  exErr("unrecognized arguments: --write-tasks", U, "--", "--write-tasks");
});

test("explore: usage errors", () => {
  exErr("give a URL to explore");
  exErr("give a URL to explore", "--web");
  exErr("not an http(s) URL: file:///x", "file:///x");
  exErr("not an http(s) URL: not a url", "not a url");
  exErr("unrecognized arguments: extra", U, "extra");
  exErr("explore takes a URL, not --file", U, "-f", "x");
  exErr("--plan cannot be used with explore", U, "--plan", "x");
  exErr("--web cannot be used with explore", U, "--web");
  for (const [f, v] of [["--port", "1"], ["--max-parallel", "2"], ["--past", "1"], ["--theme", "dark"]]) {
    exErr(`${f} does not apply to explore`, U, f, v);
    exErr(`${f} does not apply to explore`, U, `${f}=${v}`);
  }
  exErr("argument --write-tasks: ignored explicit argument '1'", U, "--write-tasks=1");
  exErr("argument --max-steps: invalid int value: 'abc'", U, "--max-steps", "abc");
  exErr("unrecognized arguments: --bogus", U, "--bogus");
});

test("explore: the first violation wins", () => {
  exErr("not an http(s) URL: file:///x", "file:///x", "--web");
  exErr("unrecognized arguments: extra", U, "extra", "--web");
  exErr("--web cannot be used with explore", U, "--web", "--max-steps", "abc");
  exErr("--port does not apply to explore", U, "--port", "abc");
  exErr("argument --write-tasks: ignored explicit argument '1'", U, "--write-tasks=1", "--max-steps", "abc");
  exErr("argument --max-steps: invalid int value: 'abc'", U, "--max-steps", "abc");
});
