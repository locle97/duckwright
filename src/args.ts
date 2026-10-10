// The command line, parsed the way the Python version's argparse parser did: a greedy
// -f/--file, negatable booleans, mutually exclusive snapshot flags, and argparse's messages.
import { ENV_NONE, isEnvName, isEnvPath } from "./environment.ts";
import { API_SPEC_NAME, SPEC_NAME } from "./export.ts";
import type { SnapshotMode } from "./observe.ts";
import { THEME_NAMES } from "./tui/theme.ts";
import type { ThemeName } from "./tui/theme.ts";
import { THRESHOLD_RE } from "./taskfile.ts";
import type { TaskSettings } from "./taskfile.ts";
import { MAX_TWOFA_TIMEOUT_SEC } from "./twofa.ts";

export interface RunArgs {
  task: string | null;
  file: string[] | null;
  maxSteps: number;
  model: string;
  headed: boolean;
  skill: string;
  session: string;
  state: string | null;
  /** An environment name or path; null when none (never "none"). */
  env: string | null;
  allowFileAccess: boolean;
  network: boolean;
  video: boolean;
  screenshot: boolean;
  twofaTimeout: number;
  jev: boolean;
  jevThreshold: number;
  debug: boolean;
  snapshot: SnapshotMode;
  print: boolean;
  maxParallel: number | null;
  /** A plan file to plan, or a planned folder to open. */
  plan: string | null;
  /** Serve the web UI instead of opening the TUI. */
  web: boolean;
  /** The web UI's port; null picks a free one. */
  port: number | null;
  past?: number;
  theme?: ThemeName;
}

export interface ExportArgs {
  run: string;
  output: string | null;
  api: boolean;
}

export class UsageError extends Error {
  usage: string;
  prog: string;

  constructor(message: string, usage: string, prog: string) {
    super(message);
    this.name = "UsageError";
    this.usage = usage;
    this.prog = prog;
  }
}

export type Parsed<T> = { kind: "args"; args: T } | { kind: "help"; text: string } | { kind: "version" };

export const RUN_USAGE = "usage: duckwright [-h] [--version] [-p] [-f FILE [FILE ...]] [--plan PLAN]\n"
  + "                  [--max-steps MAX_STEPS] [--model MODEL]\n"
  + "                  [--headed | --no-headed] [--skill SKILL] [--session SESSION]\n"
  + "                  [--state FILE] [--env ENV] [--allow-file-access]\n"
  + "                  [--network | --no-network]\n"
  + "                  [--video | --no-video] [--screenshot | --no-screenshot]\n"
  + "                  [--twofa-timeout SEC]\n"
  + "                  [--jev | --no-jev] [--jev-threshold FLOAT]\n"
  + "                  [--debug | --no-debug]\n"
  + "                  [--snapshot-hybrid | --snapshot-full | --snapshot-grep]\n"
  + "                  [--max-parallel N] [--past N] [--theme {auto,dark,light}]\n"
  + "                  [--web] [--port PORT]\n"
  + "                  [task]";

export const RUN_HELP = `${RUN_USAGE}

Duckwright: browser agent loop on playwright-cli + claude -p

positional arguments:
  task

options:
  -h, --help            show this help message and exit
  --version             show program's version number and exit
  -p, --print           run the task (or task files), print the report and
                        exit, without the TUI: the mode for scripts and CI.
                        Also used when there is no terminal
  -f FILE [FILE ...], --file FILE [FILE ...]
                        read the task, and optional settings, from a .txt or
                        .md file; several files, or a folder of them, run one
                        after another
  --plan PLAN           plan mode: Claude breaks the test plan PLAN into one
                        task file per scenario under tasks/<plan>/, with the
                        shared setup in its own file, and the TUI lists them
                        to review, reorder, edit and run in order. PLAN can
                        also be a planned folder, to open it again. With -p,
                        only write the task files. Same as: duckwright plan
                        PLAN
  --max-steps MAX_STEPS
  --model MODEL
  --headed, --no-headed
  --skill SKILL
  --session SESSION
  --state FILE          storage state JSON (cookies, localStorage) loaded with
                        state-load before the task starts
  --env ENV             environment context: the text of environments/ENV.md
                        (or of the .md file at path ENV) is put into every
                        step's prompt; none = no environment
  --allow-file-access   allow file:// URLs and UNRESTRICTED local file access
                        in the browser. A hijacked agent could read any file
                        you can (e.g. ~/.ssh) and leak it; only use with
                        trusted pages and trusted tasks
  --network, --no-network
                        record the API calls the page makes each step,
                        redacted, under runs/<id>/network (default on)
  --video, --no-video   record one video of the whole run to
                        runs/<id>/video.webm (default off)
  --screenshot, --no-screenshot
                        save a screenshot of the page after every step to
                        runs/<id>/screenshots/ (default off)
  --twofa-timeout SEC   seconds to wait for a person to enter a 2FA code or
                        approve a passkey before the step fails (default 300, at
                        most 2147483)
  --jev, --no-jev       cheaper brain: TypeSafe's Jev picks the command and
                        element on steps it is sure of, Claude decides the
                        rest. Needs TYPESAFE_API_KEY. Sends the task, page
                        snapshots and history to TypeSafe (default off)
  --jev-threshold FLOAT
                        with --jev: the confidence Jev needs for its choice
                        to be used, greater than 0 and at most 1 (default
                        0.8)
  --debug, --no-debug   log every prompt sent to Claude and Jev, the raw
                        responses, tokens, cost and timing to
                        runs/<id>/debug.log, and with -p also to stderr
                        (default off). The log holds full page snapshots;
                        credentials are redacted
  --snapshot-hybrid     default: paste page snapshots of up to 5,000
                        characters into the prompt, and let Claude grep larger
                        ones from the saved file
  --snapshot-full       always paste the page snapshot (up to 40k characters)
                        into the prompt
  --snapshot-grep       never paste the page snapshot; Claude always greps the
                        saved file
  --max-parallel N      TUI and web UI: most runs at once (default 3)
  --past N              TUI and web UI: past runs to show (default 20, 0 = none)
  --theme NAME          TUI and web UI: auto, dark or light (default auto)
  --web                 open the web UI in a browser instead of the TUI: start a
                        local server on 127.0.0.1 (see --port) and print its
                        URL. Cannot be used with -p
  --port PORT           web UI: the port to listen on (default: a free port)

With no -p, duckwright opens the interactive TUI (or the web UI with --web) and starts any task or task
files given. Run a task file and exit: duckwright -p -f tasks/login.md. To
re-export an earlier run's test: duckwright export runs/<id>. Plan a test
plan: duckwright plan docs/qa-plan.md. Write the default global config, if
there is none: duckwright init
`;

export const EXPORT_USAGE = "usage: duckwright export [-h] [--api] [-o FILE] run";

export const EXPORT_HELP = `${EXPORT_USAGE}

Write a @playwright/test spec from a successful run's history.json

positional arguments:
  run                   run directory or history.json

options:
  -h, --help            show this help message and exit
  --api                 write an API spec (request fixture) from the run's
                        captured network calls instead of the UI spec
  -o FILE, --output FILE
                        spec path (default: <run>/${SPEC_NAME}, or
                        <run>/${API_SPEC_NAME} with --api)
`;

interface OptionSpec {
  // Every option string, mapped to the name argparse uses in its messages.
  names: Readonly<Record<string, string>>;
  // Short options that may carry their value attached (`-fa.md`).
  shortWithValue: readonly string[];
}

interface Opt {
  name: string; // the option string as matched, or the whole argument if unknown
  inline: string | null; // a value given with `=` or attached to a short option
  known: boolean;
}

/**
 * argparse's _parse_optional: null when `a` is a value rather than an option. "-", "-5",
 * and an unknown "-..." containing a space are values; "--opt=v" and "-fv" carry one.
 */
function classify(a: string, spec: OptionSpec): Opt | null {
  if (!a.startsWith("-")) return null;
  if (Object.hasOwn(spec.names, a)) return { name: a, inline: null, known: true };
  if (a.length === 1) return null;
  const eq = a.indexOf("=");
  if (eq !== -1 && Object.hasOwn(spec.names, a.slice(0, eq))) {
    return { name: a.slice(0, eq), inline: a.slice(eq + 1), known: true };
  }
  if (!a.startsWith("--") && spec.shortWithValue.includes(a.slice(0, 2))) {
    return { name: a.slice(0, 2), inline: a.slice(2), known: true };
  }
  if (/^-\d+$|^-\d*\.\d+$/.test(a)) return null;
  if (a.includes(" ")) return null;
  return { name: a, inline: null, known: false };
}

/** Whether `a` can be consumed as an option's value. */
const isValue = (a: string | undefined, spec: OptionSpec) => a !== undefined && a !== "--" && classify(a, spec) === null;

const SNAPSHOT_FLAGS: Readonly<Record<string, SnapshotMode>> = {
  "--snapshot-hybrid": "hybrid",
  "--snapshot-full": "full",
  "--snapshot-grep": "grep",
};

const RUN_SPEC: OptionSpec = {
  names: {
    "-h": "-h/--help", "--help": "-h/--help", "--version": "--version",
    "-f": "-f/--file", "--file": "-f/--file",
    "--max-steps": "--max-steps", "--model": "--model", "--skill": "--skill",
    "--session": "--session", "--state": "--state", "--env": "--env",
    "--headed": "--headed/--no-headed", "--no-headed": "--headed/--no-headed",
    "--twofa-timeout": "--twofa-timeout", "--jev": "--jev/--no-jev", "--no-jev": "--jev/--no-jev", "--debug": "--debug/--no-debug", "--no-debug": "--debug/--no-debug",
    "--jev-threshold": "--jev-threshold", "--network": "--network/--no-network", "--no-network": "--network/--no-network",
    "--video": "--video/--no-video", "--no-video": "--video/--no-video",
    "--screenshot": "--screenshot/--no-screenshot", "--no-screenshot": "--screenshot/--no-screenshot",
    "--allow-file-access": "--allow-file-access",
    "--snapshot-hybrid": "--snapshot-hybrid", "--snapshot-full": "--snapshot-full",
    "--snapshot-grep": "--snapshot-grep", "-p": "-p/--print", "--print": "-p/--print", "--max-parallel": "--max-parallel",
    "--past": "--past", "--theme": "--theme", "--plan": "--plan", "--web": "--web", "--port": "--port",
  },
  shortWithValue: ["-f"],
};

const VALUE_OPTIONS: readonly string[] = ["--max-steps", "--model", "--skill", "--session", "--state", "--env", "--max-parallel", "--past", "--theme", "--plan", "--twofa-timeout", "--jev-threshold", "--port"];

// Python's int(): optional sign, digits with single underscores between them, spaces around.
const PY_INT = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

/** Built-in defaults < task-file `settings` < flags in `argv`. */
export function parseRunArgs(
  argv: string[],
  defaultSkill: string,
  settings: TaskSettings = {},
  scan?: { firstError: UsageError | null; extras: string[] },
): Parsed<RunArgs> {
  // With `scan`, errors are recorded (the first one) and parsing goes on, for explore's ordered checks.
  const fail = (msg: string): void => {
    if (!scan) throw new UsageError(msg, RUN_USAGE, "duckwright");
    scan.firstError ??= new UsageError(msg, EXPLORE_USAGE, "duckwright explore");
  };
  const args: RunArgs = {
    task: null, file: null, maxSteps: 25, model: "sonnet", headed: false, skill: defaultSkill,
    session: "duckwright", state: null, env: null, allowFileAccess: false, snapshot: "hybrid", network: true, video: false, screenshot: false,
    print: false, maxParallel: null, web: false, port: null, plan: null, twofaTimeout: 300,
    jev: false, jevThreshold: 0.8, debug: false,
    ...settings,
  };
  const extras: string[] = [];
  let snapshotFlag: string | null = null;
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const opt = positional || a === "--" ? null : classify(a, RUN_SPEC);
    if (a === "--" && !positional) {
      positional = true;
      continue;
    }
    if (opt === null) {
      if (args.task === null) args.task = a;
      else extras.push(a);
      continue;
    }
    if (!opt.known) {
      extras.push(a);
      continue;
    }
    const { name, inline } = opt;
    const display = RUN_SPEC.names[name];
    if (name === "-f" || name === "--file") {
      const files = inline !== null ? [inline] : [];
      while (inline === null && isValue(argv[i + 1], RUN_SPEC)) files.push(argv[++i]);
      if (!files.length) {
        fail("argument -f/--file: expected at least one argument");
        continue;
      }
      args.file = [...(args.file ?? []), ...files];
      continue;
    }
    if (VALUE_OPTIONS.includes(name)) {
      let v = inline;
      if (v === null) {
        if (!isValue(argv[i + 1], RUN_SPEC)) {
          fail(`argument ${display}: expected one argument`);
          continue;
        }
        v = argv[++i];
      }
      if (name === "--max-steps") {
        if (!PY_INT.test(v!)) fail(`argument --max-steps: invalid int value: '${v}'`);
        args.maxSteps = Number.parseInt(v!.trim().replaceAll("_", ""), 10);
      } else if (name === "--max-parallel") {
        if (!PY_INT.test(v!)) fail(`argument --max-parallel: invalid int value: '${v}'`);
        const n = Number.parseInt(v!.trim().replaceAll("_", ""), 10);
        if (n < 1) fail("argument --max-parallel: must be at least 1");
        args.maxParallel = n;
      } else if (name === "--past") {
        if (!PY_INT.test(v!)) fail(`argument --past: invalid int value: '${v}'`);
        const n = Number.parseInt(v!.trim().replaceAll("_", ""), 10);
        if (n < 0) fail("argument --past: must be at least 0");
        args.past = n;
      } else if (name === "--theme") {
        if (!(THEME_NAMES as readonly string[]).includes(v!)) {
          fail(`argument --theme: invalid choice: '${v}' (choose from ${THEME_NAMES.map((t) => `'${t}'`).join(", ")})`);
        }
        args.theme = v as ThemeName;
      } else if (name === "--twofa-timeout") {
        if (!PY_INT.test(v!)) fail(`argument --twofa-timeout: invalid int value: '${v}'`);
        const n = Number.parseInt(v!.trim().replaceAll("_", ""), 10);
        if (n < 1) fail("argument --twofa-timeout: must be at least 1");
        if (n > MAX_TWOFA_TIMEOUT_SEC) fail(`argument --twofa-timeout: must be at most ${MAX_TWOFA_TIMEOUT_SEC}`);
        args.twofaTimeout = n;
      } else if (name === "--jev-threshold") {
        if (!THRESHOLD_RE.test(v!)) fail(`argument --jev-threshold: invalid float value: '${v}'`);
        const n = Number(v!.trim());
        if (!(n > 0 && n <= 1)) fail("argument --jev-threshold: must be greater than 0 and at most 1");
        args.jevThreshold = n;
      } else if (name === "--port") {
        if (!PY_INT.test(v!)) fail(`argument --port: invalid int value: '${v}'`);
        const n = Number.parseInt(v!.trim().replaceAll("_", ""), 10);
        if (n < 1 || n > 65535) fail("argument --port: must be between 1 and 65535");
        args.port = n;
      } else if (name === "--env") {
        if (!(v === ENV_NONE || isEnvPath(v!) || isEnvName(v!))) {
          fail(`argument --env: invalid environment: '${v}' (use a name of letters, digits, '.', '_' and '-', or a path to a .md file)`);
        }
        args.env = v!;
      } else if (name === "--plan") args.plan = v!;
      else if (name === "--model") args.model = v!;
      else if (name === "--skill") args.skill = v!;
      else if (name === "--session") args.session = v!;
      else args.state = v!;
      continue;
    }
    if (inline !== null) {
      fail(`argument ${display}: ignored explicit argument '${inline}'`);
      continue;
    }
    if (name === "-h" || name === "--help") return { kind: "help", text: RUN_HELP };
    if (name === "--version") return { kind: "version" };
    if (name === "--headed" || name === "--no-headed") args.headed = name === "--headed";
    else if (name === "--jev" || name === "--no-jev") args.jev = name === "--jev";
    else if (name === "--debug" || name === "--no-debug") args.debug = name === "--debug";
    else if (name === "--network" || name === "--no-network") args.network = name === "--network";
    else if (name === "--video" || name === "--no-video") args.video = name === "--video";
    else if (name === "--screenshot" || name === "--no-screenshot") args.screenshot = name === "--screenshot";
    else if (name === "--allow-file-access") args.allowFileAccess = true;
    else if (name === "-p" || name === "--print") args.print = true;
    else if (name === "--web") args.web = true;
    else {
      if (snapshotFlag !== null && snapshotFlag !== name) {
        fail(`argument ${name}: not allowed with argument ${snapshotFlag}`);
        continue;
      }
      snapshotFlag = name;
      args.snapshot = SNAPSHOT_FLAGS[name];
    }
  }
  if (args.env === ENV_NONE) args.env = null;
  if (scan) scan.extras = extras;
  else if (extras.length) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return { kind: "args", args };
}

export interface ExploreArgs {
  url: string;
  writeTasks: boolean;
  run: RunArgs;
}

export const EXPLORE_USAGE = "usage: duckwright explore [-h] [--write-tasks] [run options] url";

export const EXPLORE_HELP = `${EXPLORE_USAGE}

Explore a site with no fixed task: the agent follows links, menus and forms on
the same host, avoids destructive actions, and reports the flows it tried.
The harness also records failed requests and console errors. The report is
printed and saved as explore.md and explore.json in the run folder.

positional arguments:
  url                   the http(s) URL to start from

options:
  -h, --help            show this help message and exit
  --write-tasks         write one task file per working flow to
                        tasks/explore-<host>/, runnable with
                        duckwright -p -f tasks/explore-<host>/
  --max-steps MAX_STEPS
                        step budget (default 40)

Other run options (--model, --env, --state, --session, --headed, --network,
--screenshot, --video, --jev, --debug, --snapshot-*) work as for a task.
Exploration runs never export a regression test.
`;

const EXPLORE_REJECTED: readonly (readonly [string[], string])[] = [
  [["-f", "--file"], "explore takes a URL, not --file"],
  [["--plan"], "--plan cannot be used with explore"],
  [["--web"], "--web cannot be used with explore"],
  [["--port"], "--port does not apply to explore"],
  [["--max-parallel"], "--max-parallel does not apply to explore"],
  [["--past"], "--past does not apply to explore"],
  [["--theme"], "--theme does not apply to explore"],
];

/** `settings` should already hold the explore default (maxSteps 40); this applies none. */
export function parseExploreArgs(argv: string[], defaultSkill: string, settings: TaskSettings = {}): Parsed<ExploreArgs> {
  const fail = (msg: string): never => {
    throw new UsageError(msg, EXPLORE_USAGE, "duckwright explore");
  };
  const dd = argv.indexOf("--");
  const before = dd === -1 ? argv : argv.slice(0, dd);
  const after = dd === -1 ? [] : argv.slice(dd);
  let writeTasks = false;
  let writeTasksValue: string | null = null;
  const kept: string[] = [];
  for (const a of before) {
    if (a === "--write-tasks") writeTasks = true;
    else if (a.startsWith("--write-tasks=")) writeTasksValue ??= a.slice("--write-tasks=".length);
    else kept.push(a);
  }
  const scan = { firstError: null as UsageError | null, extras: [] as string[] };
  const parsed = parseRunArgs([...kept, ...after], defaultSkill, settings, scan);
  if (parsed.kind === "help" || parsed.kind === "version") {
    if (scan.firstError) throw scan.firstError;
    return parsed.kind === "help" ? { kind: "help", text: EXPLORE_HELP } : parsed;
  }
  const url = parsed.args.task;
  if (url === null) fail("give a URL to explore");
  let ok = false;
  try {
    const u = new URL(url!);
    ok = u.protocol === "http:" || u.protocol === "https:";
  } catch { /* not a URL */ }
  if (!ok) fail(`not an http(s) URL: ${url}`);
  if (scan.extras.length) fail(`unrecognized arguments: ${scan.extras.join(" ")}`);
  for (const [flags, msg] of EXPLORE_REJECTED) {
    if (kept.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`) || (f === "-f" && a.startsWith("-f"))))) fail(msg);
  }
  if (writeTasksValue !== null) fail(`argument --write-tasks: ignored explicit argument '${writeTasksValue}'`);
  if (scan.firstError) throw scan.firstError;
  return { kind: "args", args: { url: url!, writeTasks, run: parsed.args } };
}

const EXPORT_SPEC: OptionSpec = {
  names: { "-h": "-h/--help", "--help": "-h/--help", "-o": "-o/--output", "--output": "-o/--output", "--api": "--api" },
  shortWithValue: ["-o"],
};

export function parseExportArgs(argv: string[]): Parsed<ExportArgs> {
  const fail = (msg: string): never => {
    throw new UsageError(msg, EXPORT_USAGE, "duckwright export");
  };
  let run: string | null = null;
  let output: string | null = null;
  let api = false;
  const extras: string[] = [];
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" && !positional) {
      positional = true;
      continue;
    }
    const opt = positional ? null : classify(a, EXPORT_SPEC);
    if (opt === null) {
      if (run === null) run = a;
      else extras.push(a);
    } else if (!opt.known) {
      extras.push(a);
    } else if (opt.name === "--api") {
      if (opt.inline !== null) fail(`argument --api: ignored explicit argument '${opt.inline}'`);
      api = true;
    } else if (opt.name === "-o" || opt.name === "--output") {
      if (opt.inline !== null) output = opt.inline;
      else if (isValue(argv[i + 1], EXPORT_SPEC)) output = argv[++i];
      else fail("argument -o/--output: expected one argument");
    } else if (opt.inline !== null) {
      fail(`argument -h/--help: ignored explicit argument '${opt.inline}'`);
    } else {
      return { kind: "help", text: EXPORT_HELP };
    }
  }
  if (run === null) fail("the following arguments are required: run");
  if (extras.length) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return { kind: "args", args: { run: run!, output, api } };
}
