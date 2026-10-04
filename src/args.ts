// The command line, parsed the way the Python version's argparse parser did: a greedy
// -f/--file, negatable booleans, mutually exclusive snapshot flags, and argparse's messages.
import { SPEC_NAME } from "./export.ts";
import type { SnapshotMode } from "./observe.ts";
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
  snapshot: SnapshotMode;
}

export interface ExportArgs {
  run: string;
  output: string | null;
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

export const RUN_USAGE = "usage: duckwright [-h] [--version] [-f FILE [FILE ...]]\n"
  + "                  [--max-steps MAX_STEPS] [--model MODEL]\n"
  + "                  [--headed | --no-headed] [--skill SKILL] [--session SESSION]\n"
  + "                  [--state FILE] [--allow-file-access]\n"
  + "                  [--export | --no-export]\n"
  + "                  [--snapshot-hybrid | --snapshot-full | --snapshot-grep]\n"
  + "                  [task]";

export const RUN_HELP = `${RUN_USAGE}

Duckwright: browser agent loop on playwright-cli + claude -p

positional arguments:
  task

options:
  -h, --help            show this help message and exit
  --version             show program's version number and exit
  -f FILE [FILE ...], --file FILE [FILE ...]
                        read the task, and optional settings, from a .txt or
                        .md file; several files, or a folder of them, run one
                        after another
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
  --snapshot-hybrid     default: paste page snapshots of up to 5,000
                        characters into the prompt, and let Claude grep larger
                        ones from the saved file
  --snapshot-full       always paste the page snapshot (up to 40k characters)
                        into the prompt
  --snapshot-grep       never paste the page snapshot; Claude always greps the
                        saved file

Run a task file: duckwright -f tasks/login.md. To turn an earlier run into a
test: duckwright export runs/<id>
`;

export const EXPORT_USAGE = "usage: duckwright export [-h] [-o FILE] run";

export const EXPORT_HELP = `${EXPORT_USAGE}

Write a @playwright/test spec from a successful run's history.json

positional arguments:
  run                   run directory or history.json

options:
  -h, --help            show this help message and exit
  -o FILE, --output FILE
                        spec path (default: <run>/${SPEC_NAME})
`;

// argparse treats "-5" and "-" as values, not options, when no option looks like a number.
const isOption = (a: string) => a.startsWith("-") && a !== "-" && !/^-\d+$|^-\d*\.\d+$/.test(a);

const SNAPSHOT_FLAGS: Readonly<Record<string, SnapshotMode>> = {
  "--snapshot-hybrid": "hybrid",
  "--snapshot-full": "full",
  "--snapshot-grep": "grep",
};

const VALUE_OPTIONS = ["--max-steps", "--model", "--skill", "--session", "--state"] as const;

/** Built-in defaults < task-file `settings` < flags in `argv`. */
export function parseRunArgs(argv: string[], defaultSkill: string, settings: TaskSettings = {}): Parsed<RunArgs> {
  const fail = (msg: string): never => {
    throw new UsageError(msg, RUN_USAGE, "duckwright");
  };
  const args: RunArgs = {
    task: null, file: null, maxSteps: 25, model: "sonnet", headed: false, skill: defaultSkill,
    session: "duckwright", state: null, allowFileAccess: false, export: false, snapshot: "hybrid",
    ...settings,
  };
  const extras: string[] = [];
  let snapshotFlag: string | null = null;
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (positional || !isOption(a)) {
      if (args.task === null) args.task = a;
      else extras.push(a);
      continue;
    }
    if (a === "--") {
      positional = true;
      continue;
    }
    if (a === "-h" || a === "--help") return { kind: "help", text: RUN_HELP };
    if (a === "--version") return { kind: "version" };
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq !== -1 ? a.slice(0, eq) : a;
    const inline = name !== a ? a.slice(eq + 1) : null;
    if (name === "-f" || name === "--file") {
      const files = inline !== null ? [inline] : [];
      while (inline === null && i + 1 < argv.length && !isOption(argv[i + 1])) files.push(argv[++i]);
      if (!files.length) fail("argument -f/--file: expected at least one argument");
      args.file = [...(args.file ?? []), ...files];
      continue;
    }
    if ((VALUE_OPTIONS as readonly string[]).includes(name)) {
      let v = inline;
      if (v === null) {
        if (i + 1 >= argv.length || isOption(argv[i + 1])) fail(`argument ${name}: expected one argument`);
        v = argv[++i];
      }
      if (name === "--max-steps") {
        if (!/^\s*[+-]?\d+\s*$/.test(v!)) fail(`argument --max-steps: invalid int value: '${v}'`);
        args.maxSteps = Number.parseInt(v!.trim(), 10);
      } else if (name === "--model") args.model = v!;
      else if (name === "--skill") args.skill = v!;
      else if (name === "--session") args.session = v!;
      else args.state = v!;
      continue;
    }
    if (inline !== null) {
      extras.push(a);
      continue;
    }
    if (a === "--headed" || a === "--no-headed") args.headed = a === "--headed";
    else if (a === "--export" || a === "--no-export") args.export = a === "--export";
    else if (a === "--allow-file-access") args.allowFileAccess = true;
    else if (Object.hasOwn(SNAPSHOT_FLAGS, a)) {
      if (snapshotFlag !== null && snapshotFlag !== a) fail(`argument ${a}: not allowed with argument ${snapshotFlag}`);
      snapshotFlag = a;
      args.snapshot = SNAPSHOT_FLAGS[a];
    } else extras.push(a);
  }
  if (extras.length) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return { kind: "args", args };
}

export function parseExportArgs(argv: string[]): Parsed<ExportArgs> {
  const fail = (msg: string): never => {
    throw new UsageError(msg, EXPORT_USAGE, "duckwright export");
  };
  let run: string | null = null;
  let output: string | null = null;
  const extras: string[] = [];
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (positional || !isOption(a)) {
      if (run === null) run = a;
      else extras.push(a);
    } else if (a === "--") positional = true;
    else if (a === "-h" || a === "--help") return { kind: "help", text: EXPORT_HELP };
    else if (a === "-o" || a === "--output") {
      if (i + 1 >= argv.length || isOption(argv[i + 1])) fail(`argument -o/--output: expected one argument`);
      output = argv[++i];
    } else if (a.startsWith("--output=")) output = a.slice("--output=".length);
    else extras.push(a);
  }
  if (run === null) fail("the following arguments are required: run");
  if (extras.length) fail(`unrecognized arguments: ${extras.join(" ")}`);
  return { kind: "args", args: { run: run!, output } };
}
