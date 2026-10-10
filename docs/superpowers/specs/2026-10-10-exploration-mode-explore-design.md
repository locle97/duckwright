# Exploration mode (`duckwright explore <url>`)

## Summary

Add a `duckwright explore <url>` subcommand. It runs the existing agent loop (`startRun` → `Agent`) with a built-in exploration task instead of a user task: the agent wanders the site on the same host, avoids destructive actions, and finishes with a JSON list of the flows it tried, each marked `ok`, `dead-end` or `broken`. Independently of the agent, the harness collects failed requests from the existing network capture and console errors from a new per-step `playwright-cli console error` capture (on only for explore runs). After the run, Duckwright builds a report from the run's `history.json`, prints it as markdown, and saves `explore.md` and `explore.json` in the run folder. With `--write-tasks` it also writes one runnable task file per working flow under a fresh `tasks/explore-<host>/` folder. Exploration runs never write a regression-test export. The goal is a cheap first sweep of a site that finds obvious breakage and seeds a task suite.

## Decisions

| Topic | Decision |
| --- | --- |
| Subcommand parsing | `dispatch` in `src/cli.ts` checks `argv[0] === "explore"` (like `export`/`init`/`plan`) and calls `exploreMain(deps, argv.slice(1))`. `duckwright -- explore` still runs a task named "explore". (brief assumption) |
| Option parsing | New `parseExploreArgs` in `src/args.ts`: it removes `--write-tasks` (only before a `--`), then reuses `parseRunArgs` for every other option, re-throwing its `UsageError` with the explore usage and prog `duckwright explore`. The single positional is the URL. |
| URL check | `new URL(url)` must parse and its protocol must be `http:` or `https:`. Anything else is a usage error (exit 2). |
| Step budget | Default 40. The explore code passes `maxSteps: 40` as a setting above the config, so the config's `max-steps` does not change it; only `--max-steps` does. |
| `-p` / `--print` | Accepted and ignored: explore always runs print-style, never the TUI, even on a terminal. |
| Rejected options | `-f/--file`, `--plan`, `--web`, `--port`, `--max-parallel`, `--past`, `--theme` are usage errors with explore (messages in C1). |
| Exploration prompt | A TypeScript constant built by `exploreTask(url)` in `src/explore/task.ts` (exact text in C3), passed as the run's task. No new file under `prompts/`. |
| Same-host rule | Enforced by the prompt only. The harness does not block other hosts (a domain allow-list is a separate roadmap item). |
| Agent `expect` rule | The exploration task tells the agent it needs no `expect` checks; the harness enforces nothing new. |
| Flow status | Judged by the agent only (`ok`, `dead-end`, `broken`). No harness-side dead-end detection. |
| Answer format | `done success` with `args[1]` holding one JSON object `{"flows":[...]}`; field names `title`, `start_url`, `steps`, `expected`, `status`, `notes`. |
| Answer parsing | Strip surrounding ``` fences, take the text from the first `{` to the last `}`, `JSON.parse`. A missing object, invalid JSON or no `flows` array makes the answer unreadable: reported, never fatal. |
| Invalid flow items | A flow is kept when `title` is a non-empty string, `start_url` resolves (against the explore URL) to an http(s) URL, and `status` is one of the three values. `steps` defaults to `[]` (non-strings dropped), `expected` and `notes` default to `""`. Other items are dropped and counted (`dropped_flows`). |
| Console capture command | `playwright-cli console error` after each step that ran actions (same place as network capture), enabled only for explore runs via a new `consoleErrors` agent option. (brief assumption) |
| Console output parsing | Strip `### Result`; stop at the next `### ` heading; drop blank lines, lines starting with whitespace (stack-trace continuations), and lines starting with `Total messages` or `Returning `. Each remaining line is one message, clipped to 500 code points; at most 50 per step. |
| Console de-duplication | Not at capture time (the command may report the same message on every step). The report groups by exact message text and lists the steps that saw it. |
| Console capture failure | A non-zero exit or thrown error adds a run warning `console capture failed at step N: <message>`; never changes the outcome. |
| Console redaction | Each message: `flat` → `redactText` → every `https?://\S+` substring through `redactUrl` → the run's 2FA scrubber. |
| Failed request rule | A captured network entry with `status >= 400` or `status === null`, except when `statusText` matches `/abort|cancel/i` (aborted). Grouped by `method + url + status`, listing the steps. |
| Network off | With `--no-network`, the report says requests were not checked; `network_checked: false` in JSON. |
| Report source | Built from the run's `history.json` (read with `loadHistory`), so it works for failed, max-steps and interrupted runs too. |
| Report location | `<run dir>/explore.md` and `<run dir>/explore.json`; the markdown is also printed to stdout. |
| Exit code | The run's exit code (0, 1, 130), not the number of findings. Usage and preflight errors are 2. A report or task-file write failure turns exit 0 into 1, and leaves 1/130 unchanged. (brief assumption) |
| Test export | `RunSpec` gains `exportTest?: boolean` (default `true`); explore sets `false`, so the outcome's export is `{ kind: "off" }` and no `Test:` line is printed. |
| Task files: which flows | Only flows with `status: "ok"`. |
| Task files: folder | `tasks/explore-<slugify(url.host)>` (host includes the port, so `localhost:3000` → `explore-localhost-3000`; empty slug → `explore-site`), relative to the current directory, with `-2`, `-3` on a clash, using the existing `freshFolder` from `src/plan.ts` (exported). Never touches an existing folder. (brief assumption) |
| Task files: name | `NN-<slugify(title) or "flow">.md`, `NN` zero-padded to `max(2, digits of count)`, in answer order. |
| Task files: front matter | A comment line naming the source, and `max-steps: 25`. No `env:` line; the README tells users to pass `--env` when running them. (brief assumption for max-steps) |
| Untrusted text in task files | Every agent-provided field is passed through `flat` (one line) before writing. |
| Run folder label | Unchanged: a random two-word label (task given on the command line). |
| History change | Each step in `history.json` gains `console_errors: string[]` when the step captured at least one message; absent otherwise. Non-explore runs never have it. |
| Code layout | New `src/console.ts`, `src/explore/task.ts`, `src/explore/report.ts`, `src/explore/tasks.ts`; changes in `src/args.ts`, `src/cli.ts`, `src/loop.ts`, `src/prompt.ts`, `src/export.ts`, `src/runs/run.ts`, `src/plan.ts`, `README.md`. |
| TUI / batch | `exploreMain` calls `startRun` directly; `tuiMain`, `webMain`, `runOne`, `runBatch` are not changed. |

## Architecture / Components

### `src/console.ts` (new)

- `parseConsoleErrors(stdout: string): string[]`: the parsing rule from Decisions (uses `stripResult` from `network.ts`, `sliceCodePoints`/`codePointLength` from `text.ts`). Limits: `CONSOLE_MESSAGE_MAX = 500`, `CONSOLE_STEP_MAX = 50`.
- `redactConsole(text: string): string`: `flat`, `redactText`, then URL substrings through `redactUrl`.
- `captureConsoleErrors(pw: PlaywrightCLI): Promise<{ messages: string[]; error: string | null }>`: runs `pw.run("console", ["error"])`; exit 0 → parsed and redacted messages; otherwise `error` is the stderr (or stdout) trimmed and clipped to 300 code points. Re-throws `AbortedError`; any other throw becomes `error`.

### `src/loop.ts` (modified)

- `AgentOptions.consoleErrors?: boolean` (default `false`), stored as `readonly consoleErrors`.
- In `loop()`, after the network capture block of a step that ran actions, when `consoleErrors` is on: call `captureConsoleErrors(this.pw)`; scrub each message with `this.scrub`; set `rec.consoleErrors` when non-empty; on `error`, push `console capture failed at step ${step}: ${this.scrub(error)}` to `this.evidence.warnings`. Brain-error steps are not captured.

### `src/prompt.ts`, `src/export.ts`, `src/runs/run.ts` (modified)

- `StepRecord.consoleErrors?: string[]`; `HistoryStep.console_errors?: string[]`.
- `historyJson` adds `console_errors` when `r.consoleErrors?.length`.
- `RunSpec` gains `exportTest?: boolean` (default true) and `consoleErrors?: boolean` (default false). `execute` passes `consoleErrors` to `createAgent`; `finish` skips `exportRun` and uses `{ kind: "off" }` when `exportTest === false`.

### `src/explore/task.ts` (new)

- `EXPLORE_MAX_STEPS = 40`.
- `exploreTask(url: string): string`: the exact text in C3, with `<URL>` and `<HOST>` filled from `new URL(url)` (`href` and `host`).

### `src/explore/report.ts` (new)

- Types `Flow`, `FailedRequest`, `ConsoleError`, `ExploreReport` (shape = C4).
- `parseFlows(answer: string, base: string): { flows: Flow[]; dropped: number; error: string | null }`.
- `failedRequests(data: HistoryData): FailedRequest[]`, `consoleErrors(data: HistoryData): ConsoleError[]`.
- `buildExploreReport(data: HistoryData, o: { url: string; runDir: string; network: boolean }): ExploreReport`.
- `renderExploreMarkdown(r: ExploreReport): string` (format C5).
- `writeExploreReport(runDir: string, r: ExploreReport): { md: string; json: string }`: writes both files (JSON with 2-space indent and trailing newline).

### `src/explore/tasks.ts` (new)

- `exploreTaskText(flow: Flow, url: string, runDir: string): string` (format C6).
- `writeExploreTasks(flows: Flow[], url: string, runDir: string, root = "tasks"): { folder: string; files: string[] } | null`: `null` when no flow has `status: "ok"` (no folder created); otherwise creates the fresh folder and writes the files.

### `src/plan.ts` (modified)

- `freshFolder` becomes exported; behavior unchanged.

### `src/args.ts` (modified)

- `ExploreArgs = { url: string; writeTasks: boolean; run: RunArgs }`.
- `EXPLORE_USAGE`, `EXPLORE_HELP` (exact text in C1).
- `parseExploreArgs(argv: string[], defaultSkill: string, settings: TaskSettings): Parsed<ExploreArgs>`: help/version handling, `--write-tasks` handling, `parseRunArgs`, then the explore-specific checks of C1 in the order listed there.

### `src/cli.ts` (modified)

- `dispatch`: `if (argv[0] === "explore") return exploreMain(deps, argv.slice(1));` next to `export`/`init`.
- `exploreMain`: load config (same `TaskFileError` handling as `dispatch`), `parseExploreArgs` with settings `{ ...runSettings(config), maxSteps: EXPLORE_MAX_STEPS }`, `secretProblem`, `preflightArgs`, then `startRun({ task: exploreTask(url), taskFile: null, args, exportTest: false, consoleErrors: true }, …same deps as runOne…)`, `attachPlain`, `printOutcome`, then the report and `--write-tasks` steps of the Data flow.
- The README note about the `export`/`init` first argument also names `explore`.

### `README.md` (modified)

- Usage block gains `duckwright explore URL [--write-tasks] [options]`.
- New `### Exploration mode` section after Plan mode: what it does, the 40-step default, the same-host and no-destructive-actions rules (prompt-enforced), the report files and sections, `--write-tasks` and how to run the result (`duckwright -p -f tasks/explore-<host>/`, add `--env`/`--state` as needed), no test export, exit codes, and that console capture is on only for explore runs.
- Output section: `explore.md`, `explore.json`, and `console_errors` in `history.json`.
- Roadmap: the Exploration mode item becomes `- [x]`.

## Contracts

### C1: `duckwright explore` command (CLI)

- **Surface:** `duckwright explore URL [--write-tasks] [run options]`
- **Input:**
  - `URL` (string, required): an absolute `http://` or `https://` URL.
  - `--write-tasks` (flag, optional, default off): also write task files for working flows (C6).
  - Run options, same meaning and validation as the main command: `--max-steps N` (default **40** for explore), `--model`, `--headed/--no-headed`, `--skill`, `--session`, `--state`, `--env`, `--allow-file-access`, `--network/--no-network`, `--video/--no-video`, `--screenshot/--no-screenshot`, `--twofa-timeout`, `--jev/--no-jev`, `--jev-threshold`, `--debug/--no-debug`, `--snapshot-hybrid|--snapshot-full|--snapshot-grep`, `-p/--print` (no effect).
  - `-h/--help`: prints `EXPLORE_HELP` to stdout, exit 0. `--version`: prints `duckwright <version>`, exit 0.
- **Help text (`EXPLORE_HELP`)**, exactly:

```text
usage: duckwright explore [-h] [--write-tasks] [run options] url

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
```

  `EXPLORE_USAGE` is its first line.
- **Output (stdout, in order):** a step line per step (as `-p`); `printOutcome` lines (`Result:`, `Answer:`, `Steps: … Cost: …`, `History:`, optional `Video:`; no `Test:` line); a blank line; the report markdown (C5); `Report: <run dir>/explore.md`; `Data: <run dir>/explore.json`; then with `--write-tasks` the C6 lines. Warnings go to stderr as `warning: <message>`.
- **Exit codes:** the run's code: `0` agent finished with `done success`, `1` `done failure` / max steps / brain failures / playwright error, `130` interrupted. A report or task-file write failure makes `0` into `1`.
- **Errors:** each usage error prints `EXPLORE_USAGE`, then `duckwright explore: error: <message>` on stderr, exit 2. Checks, in order:
  - no URL → `give a URL to explore`
  - URL does not parse or is not http(s) → `not an http(s) URL: <url>`
  - a second positional → `unrecognized arguments: <extra ...>` (from `parseRunArgs`)
  - `-f/--file` → `explore takes a URL, not --file`
  - `--plan` → `--plan cannot be used with explore`
  - `--web` → `--web cannot be used with explore`
  - `--port`, `--max-parallel`, `--past`, `--theme` → `<flag> does not apply to explore` (flag as `--port`, `--max-parallel`, `--past`, `--theme`)
  - `--write-tasks=<v>` → `argument --write-tasks: ignored explicit argument '<v>'`
  - any `parseRunArgs` error (bad `--max-steps`, unknown option…) → its own message.
  - Not usage errors, exit 2 with one stderr line: an invalid config file (its `TaskFileError` message), an invalid TOTP secret (`secretProblem` message), preflight failures (`preflightArgs` messages, e.g. `claude CLI not found on PATH (install Claude Code)`).
  - Run could not create its folder → `printOutcome` prints the error to stderr, no report, exit 1.
  - `history.json` unreadable after the run → stderr `explore: cannot read history: <message>`, no report, exit per write-failure rule.
  - Report write fails → stderr `explore: cannot write report: <message>` (the markdown is still printed), exit per write-failure rule.
- **Criteria:** SC1, SC5, SC6

### C2: `history.json` `console_errors` (File)

- **Surface:** each `history[]` step of a run's `history.json`.
- **Output:** `console_errors: string[]`: the redacted, scrubbed console error messages `playwright-cli console error` reported after that step's actions, in output order. Present only on explore runs and only when non-empty. All other keys unchanged.
- **Errors:** capture failure → no key on that step; run warning `console capture failed at step N: <message>`.
- **Criteria:** SC2

### C3: Exploration task (the prompt given to the agent)

- **Surface:** the `task` field of the run (`history.json` `task`, the `<task>` prompt section).
- **Output:** exactly this text, with `<URL>` = `new URL(url).href` and `<HOST>` = `new URL(url).host`:

```text
Explore the website at <URL> like a curious first-time visitor. There is no fixed goal: find the site's main user flows and check whether they work.

Rules:
- Start with goto <URL>.
- Stay on the host <HOST>. Do not open links to other hosts; mention them in a flow's notes instead.
- Follow navigation menus, links, buttons and forms. Try each distinct flow once and do not revisit pages you have already checked.
- Never do anything destructive or irreversible: do not delete, pay, buy, order, send messages, invite people, change passwords or settings, sign out, or submit a form that creates or changes real data. Search and filter forms are fine to submit.
- Do not log in or sign up unless the environment context gives you a test account for it.
- You do not need expect checks in this task.
- Judge each flow: "ok" when it reaches the page or result it promises; "dead-end" when it leads nowhere useful (no way forward, an empty page, a link back to the same page, a form that does nothing); "broken" when it shows an error (a 404 or 500 page, an error message, a control that fails).
- Watch the step budget shown as Step N/M. When you are within 3 steps of the limit, or have explored enough, finish.

Finish with done success, and set args[1] to one JSON object and nothing else, like:
{"flows":[{"title":"Search products","start_url":"https://shop.example/","steps":["Type 'mug' into the search box","Press Enter"],"expected":"A results list with at least one product","status":"ok","notes":""}]}
Each flow has: title (a short name), start_url (the full URL where the flow starts), steps (what a person does, in order, in plain words), expected (what shows the flow worked, or should have), status ("ok", "dead-end" or "broken"), and notes (what went wrong, or ""). List every flow you tried. Use done failure only if the site cannot be opened at all.
```

- **Criteria:** SC1, SC3

### C4: `explore.json` (File)

- **Surface:** `<run dir>/explore.json`, UTF-8, `JSON.stringify(report, null, 2) + "\n"`.
- **Output:** one object with exactly these keys:
  - `version`: `1`
  - `url`: string, the URL as given
  - `run_dir`: string, the run folder path as `startRun` returned it
  - `success`: boolean, `history.json` `success`
  - `steps`: number, `history.json` `steps`
  - `cost_usd`: number, `history.json` `cost_usd`
  - `network_checked`: boolean, `false` with `--no-network`
  - `failed_requests`: array of `{ method: string, url: string, status: number | null, status_text: string, steps: number[] }`, in first-seen order; `steps` ascending, unique
  - `console_errors`: array of `{ message: string, steps: number[] }`, in first-seen order
  - `answer_error`: string or `null`: `null` when the answer was read; otherwise one of `no JSON object in the answer`, `invalid JSON: <JSON.parse message>`, `no "flows" list in the answer`
  - `dropped_flows`: number of flow items left out as invalid
  - `broken_flows`: array of Flow with status `dead-end` or `broken`, in answer order
  - `working_flows`: array of Flow with status `ok`, in answer order
  - Flow = `{ title: string, start_url: string (absolute, resolved against url), steps: string[], expected: string, status: "ok" | "dead-end" | "broken", notes: string }`
- **Errors:** see C1 (write failure).
- **Criteria:** SC1, SC2, SC3

### C5: `explore.md` and the printed report (File / CLI)

- **Surface:** `<run dir>/explore.md` and the same text on stdout.
- **Output:** exactly this structure (`<n>` = item count; every untrusted value passed through `flat`):

```markdown
# Exploration report: <url>

Run: <run_dir>  Steps: <steps>  Cost: $<cost_usd as fixed4>  Result: <success|failure>

## Broken links and failed requests (<n>)

- <METHOD> <url> → <status> <status_text>  (steps 3, 5)
- <METHOD> <url> → no response: <status_text>  (step 2)

## Console errors (<n>)

- <message>  (steps 1, 2)

## Dead ends and broken flows (<n>)

### <title> (<status>)

- Start: <start_url>
- Steps: 1. <step>; 2. <step>
- Expected: <expected>
- Notes: <notes>

## Flows that worked (<n>)

### <title>

- Start: <start_url>
- Steps: 1. <step>; 2. <step>
- Expected: <expected>
```

  Rules: `(step N)` for one step, `(steps N, M)` for several. An empty section has the single line `None.`. With network off, the first section's count is `-` and its body is `Network capture was off (--no-network), so requests were not checked.`. When `answer_error` is set, a paragraph `The agent's answer could not be read as a flow list: <answer_error>.` goes right after the title-block line, and both flow sections say `None.`. When `dropped_flows > 0`, the line `<n> flow(s) in the answer were unreadable and left out.` goes right after the title-block line (after the `answer_error` paragraph if both apply; in practice they are exclusive). `Steps:` lines are omitted when a flow has no steps, `Notes:` when notes is empty, `Expected:` when expected is empty.
- **Criteria:** SC1, SC2, SC3

### C6: `--write-tasks` task files (File / CLI)

- **Surface:** folder `tasks/explore-<host slug>[-N]/` under the current directory, files `NN-<slug>.md`, and stdout lines.
- **Output:** for each flow with status `ok`, in answer order, a file:

```text
---
# From duckwright explore <url> (run <run_dir>)
max-steps: 25
---
# <title>

Open <start_url>.

Steps:
1. <step>
2. <step>

Check that: <expected>
```

  `Steps:` block omitted when there are no steps; when `expected` is empty the last line is `Check that: the flow finishes without an error page.`. Each file loads with `loadTaskFile` with settings `{ maxSteps: 25 }`. Stdout after the report:
  - with working flows: `Tasks: <n> task file(s) in <folder>/`, then `  <path>` per file, then `Run them with: duckwright -p -f <folder>/`
  - with none (including an unreadable answer): `Tasks: no working flows, no task files written`
- **Errors:** a write failure → stderr `explore: cannot write task files: <message>`, exit per write-failure rule. An existing folder is never modified (a `-2`, `-3` … folder is made instead).
- **Criteria:** SC4

### Surfaces that must not change

The main command's options, help text, TUI, web UI, batch runs, `duckwright export`, `plan`, `init`, and `history.json` of non-explore runs (no `console_errors` key; `exportRun` still runs after a successful non-explore run).

## Data flow

1. `main` → `dispatch` sees `argv[0] === "explore"` → `exploreMain(deps, rest)`.
2. Load config; `parseExploreArgs(rest, defaultSkill, { ...runSettings(config), maxSteps: 40 })` → `{ url, writeTasks, run }` or help/version/usage error.
3. `secretProblem(env)`, `preflightArgs(deps, run)`; on a problem print it, exit 2.
4. `startRun({ task: exploreTask(url), taskFile: null, args: run, exportTest: false, consoleErrors: true }, deps)`; `attachPlain` prints step lines.
5. Each step: observe → decide → act → network capture (if on) → console capture → `step:end`. Messages land in `StepRecord.consoleErrors`.
6. Run ends; `history.json` written (with `console_errors`); no export. `printOutcome`.
7. If `historyPath` is null → return the run's code. Else `loadHistory(historyPath)` → `buildExploreReport(data, { url, runDir: workdir, network: run.network })`: `failedRequests` and `consoleErrors` from the steps, `parseFlows(data.answer, url)` for flows.
8. `renderExploreMarkdown` → print; `writeExploreReport` → print `Report:` and `Data:` lines.
9. If `writeTasks`: `writeExploreTasks(report.working_flows, url, workdir)` → print C6 lines.
10. Return the run's exit code, adjusted by the write-failure rule.

## Error handling

| Failure | Behavior |
| --- | --- |
| No URL, bad URL, conflicting option, bad option value | Usage error per C1, exit 2, nothing runs |
| Invalid config / TOTP secret / preflight | One stderr line, exit 2 |
| `playwright-cli console error` fails or throws | Warning `console capture failed at step N: <message>`; step has no `console_errors`; outcome unchanged |
| Capture aborted (Ctrl-C) | `AbortedError` propagates as today → exit 130, report still built from `history.json` |
| Network capture off | Report says requests were not checked |
| Agent answer not JSON / no `flows` / run ended without `done` | `answer_error` set; harness findings still reported; exit = run's code |
| Individual flow invalid | Dropped, counted in `dropped_flows` |
| Run folder not created | `printOutcome` error, exit 1, no report |
| `history.json` unreadable | `explore: cannot read history: <message>`, exit 0→1 |
| Report write fails | Markdown still printed; `explore: cannot write report: <message>`, exit 0→1 |
| Task folder/file write fails | `explore: cannot write task files: <message>`, exit 0→1 |
| No working flows with `--write-tasks` | `Tasks: no working flows, no task files written`, no folder, exit = run's code |

## Testing

All tests use `node:test` with the existing fakes (fake runner / fake `createAgent`, temp dirs with `process.chdir`), no browser. Check command: `npm test` (typecheck + all tests; the 1467 baseline tests must still pass).

- `test/console.test.ts`: parsing (result header, next `###` section, blank/continuation/`Total messages`/`Returning` lines dropped, 500-code-point clip, 50-per-step cap); redaction (Bearer token, secret query key in a URL); capture success, non-zero exit → `error`, thrown error → `error`, `AbortedError` re-thrown.
- `test/loop.test.ts` additions: with `consoleErrors: true` the fake pw receives `console error` after each acting step and `rec.consoleErrors` holds scrubbed messages; failure adds the warning; with the option off, no `console` call is made.
- `test/runs/` or `test/cli.test.ts` additions for `run.ts`: `historyJson` writes `console_errors` only when non-empty; `exportTest: false` → `export.kind === "off"` and no spec file after a successful run; default still exports.
- `test/explore/task.test.ts`: `exploreTask` contains the URL, host, the JSON example and the three status words; equals the C3 text for a fixed URL.
- `test/explore/report.test.ts`: `parseFlows` (plain JSON, fenced JSON, text around JSON, invalid JSON, no `flows`, "max steps reached", relative `start_url` resolved, non-http `start_url` dropped, bad status dropped, defaults); `failedRequests` (404, 500, null status, aborted and cancelled excluded, 2xx/3xx excluded, grouping and step lists); `consoleErrors` grouping; `buildExploreReport` JSON shape equals C4; markdown for full, empty, network-off, unreadable-answer and dropped-flow cases equals C5.
- `test/explore/tasks.test.ts`: only `ok` flows written; names and padding; text equals C6; each file passes `loadTaskFile` with `maxSteps: 25`; empty `expected` fallback; `flat` applied to multi-line fields; existing folder → `-2`; no working flows → `null` and no folder.
- `test/args.test.ts` additions: `parseExploreArgs` help, version, URL, `--write-tasks` (incl. after `--` treated as positional), each C1 error message, default `maxSteps` 40 over a config `maxSteps`, `--max-steps 10` wins.
- `test/cli.test.ts` additions: `explore` end to end with a fake agent whose answer is a flow list → stdout has the report, `Report:`/`Data:` lines, files exist, no `duckwright.spec.ts`, exit 0; unreadable answer → report with `answer_error`, exit per run; failed agent → exit 1 with report; `--write-tasks` writes the folder and prints the run line; no working flows message; usage errors exit 2 with `duckwright explore: error:`; `duckwright -- explore` still runs a task; explore never calls `loadTui`.

| Criterion | Contracts | Proved by |
| --- | --- | --- |
| SC1 | C1, C3, C4, C5 | `test/cli.test.ts` explore tests, `test/args.test.ts` (40 default), `test/explore/*.test.ts`; QA scenarios |
| SC2 | C2, C4, C5 | `test/console.test.ts`, `test/loop.test.ts`, `test/explore/report.test.ts` (unreadable answer still lists findings, duplicates grouped, aborted filtered); QA scenarios |
| SC3 | C3, C4, C5 | `test/explore/report.test.ts` (classification, unreadable answer non-fatal), `test/cli.test.ts`; QA scenarios |
| SC4 | C6 | `test/explore/tasks.test.ts`, `test/cli.test.ts`; QA scenarios |
| SC5 | C1 | `test/args.test.ts`, `test/cli.test.ts`; QA scenarios |
| SC6 | C1 | run.ts `exportTest` test, `test/cli.test.ts` (no spec file, no `Test:` line); QA scenarios |
| SC7 | (README) | Review of README usage, Exploration mode section and roadmap tick; `npm test` passes |

### Manual e2e

Not part of the run's verification. For the user: run `duckwright explore https://<a site you own>` with real `claude` and `playwright-cli`, confirm the `playwright-cli console error` output format matches the parser (adjust the fixture if a newer playwright-cli prints a different layout), and run the written tasks with `duckwright -p -f tasks/explore-<host>/`.

## Out of scope

- Harness-side dead-end detection (the agent judges flow status).
- Task files for dead-end or broken flows.
- Crawling without the agent, an HTML report, TUI/web integration, MCP.
- Reusing any uncommitted draft from the user's checkout; built fresh from HEAD.
- Harness-enforced same-host restriction or destructive-action blocking (prompt only).
- Console capture for non-explore runs, and a flag to turn it on elsewhere.
- Writing `env:` or `state:` into generated task files.
- A custom run-folder label for explore runs.
