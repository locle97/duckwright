// The command line, parsed the way the Python version's argparse parser did: a greedy
// -f/--file, negatable booleans, mutually exclusive snapshot flags, and argparse's messages.
import { API_SPEC_NAME, SPEC_NAME } from "./export.ts";
import type { SnapshotMode } from "./observe.ts";
import { THEME_NAMES } from "./tui/theme.ts";
import type { ThemeName } from "./tui/theme.ts";
import type { TaskSettings } from "./taskfile.ts";

export interface RunArgs {
  task: string | null;
  file: string[] | null;
  maxSteps: number;
  model: string;
  headed: boolean;
  skill: string;
  session: string;
  state: string | null;
  allowFileAccess: boolean;
  export: boolean;
  network: boolean;
  snapshot: SnapshotMode;
  print: boolean;
  maxParallel: number | null;
  /** A plan file to plan, or a planned folder to open. */
  plan: string | null;
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
  + "                  [--state FILE] [--allow-file-access]\n"
  + "                  [--export | --no-export] [--network | --no-network]\n"
  + "                  [--snapshot-hybrid | --snapshot-full | --snapshot-grep]\n"
  + "                  [--max-parallel N] [--past N] [--theme {auto,dark,light}]\n"
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
  --allow-file-access   allow file:// URLs and UNRESTRICTED local file access
                        in the browser. A hijacked agent could read any file
                        you can (e.g. ~/.ssh) and leak it; only use with
                        trusted pages and trusted tasks
  --export, --no-export
                        after a successful run, write a Playwright test to
                        runs/<id>/${SPEC_NAME}
  --network, --no-network
                        record the API calls the page makes each step,
                        redacted, under runs/<id>/network (default on)
  --snapshot-hybrid     default: paste page snapshots of up to 5,000
                        characters into the prompt, and let Claude grep larger
                        ones from the saved file
  --snapshot-full       always paste the page snapshot (up to 40k characters)
                        into the prompt
  --snapshot-grep       never paste the page snapshot; Claude always greps the
                        saved file
  --max-parallel N      TUI: most runs at once (default 3)
  --past N              TUI: past runs to show (default 20, 0 = none)
  --theme NAME          TUI: auto, dark or light (default auto)

With no -p, duckwright opens the interactive TUI and starts any task or task
files given. Run a task file and exit: duckwright -p -f tasks/login.md. To
turn an earlier run into a test: duckwright export runs/<id>. Plan a test
plan: duckwright plan docs/qa-plan.md
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
    "--session": "--session", "--state": "--state",
    "--headed": "--headed/--no-headed", "--no-headed": "--headed/--no-headed",
    "--export": "--export/--no-export", "--no-export": "--export/--no-export",
    "--network": "--network/--no-network", "--no-network": "--network/--no-network",
    "--allow-file-access": "--allow-file-access",
    "--snapshot-hybrid": "--snapshot-hybrid", "--snapshot-full": "--snapshot-full",
    "--snapshot-grep": "--snapshot-grep", "-p": "-p/--print", "--print": "-p/--print", "--max-parallel": "--max-parallel",
    "--past": "--past", "--theme": "--theme", "--plan": "--plan",
  },
  shortWithValue: ["-f"],
};

const VALUE_OPTIONS: readonly string[] = ["--max-steps", "--model", "--skill", "--session", "--state", "--max-parallel", "--past", "--theme", "--plan"];

// Python's int(): optional sign, digits with single underscores between them, spaces around.
const PY_INT = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

/** Built-in defaults < task-file `settings` < flags in `argv`. */
export function parseRunArgs(argv: string[], defaultSkill: string, settings: TaskSettings = {}): Parsed<RunArgs> {
  const fail = (msg: string): never => {
    throw new UsageError(msg, RUN_USAGE, "duckwright");
  };
  const args: RunArgs = {
    task: null, file: null, maxSteps: 25, model: "sonnet", headed: false, skill: defaultSkill,
    session: "duckwright", state: null, allowFileAccess: false, export: false, snapshot: "hybrid", network: true,
    print: false, maxParallel: null, plan: null,
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
      if (!files.length) fail("argument -f/--file: expected at least one argument");
      args.file = [...(args.file ?? []), ...files];
      continue;
    }
    if (VALUE_OPTIONS.includes(name)) {
      let v = inline;
      if (v === null) {
        if (!isValue(argv[i + 1], RUN_SPEC)) fail(`argument ${display}: expected one argument`);
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
      } else if (name === "--plan") args.plan = v!;
      else if (name === "--model") args.model = v!;
      else if (name === "--skill") args.skill = v!;
      else if (name === "--session") args.session = v!;
      else args.state = v!;
      continue;
    }
    if (inline !== null) fail(`argument ${display}: ignored explicit argument '${inline}'`);
    if (name === "-h" || name === "--help") return { kind: "help", text: RUN_HELP };
    if (name === "--version") return { kind: "version" };
    if (name === "--headed" || name === "--no-headed") args.headed = name === "--headed";
    else if (name === "--export" || name === "--no-export") args.export = name === "--export";
    else if (name === "--network" || name === "--no-network") args.network = name === "--network";
    else if (name === "--allow-file-access") args.allowFileAccess = true;
    else if (name === "-p" || name === "--print") args.print = true;
    else {
      if (snapshotFlag !== null && snapshotFlag !== name) fail(`argument ${name}: not allowed with argument ${snapshotFlag}`);
      snapshotFlag = name;
      args.snapshot = SNAPSHOT_FLAGS[name];
    }
  }
  if (extras.length) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return { kind: "args", args };
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
