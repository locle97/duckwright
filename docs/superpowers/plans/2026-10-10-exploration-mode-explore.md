# Exploration mode (`duckwright explore <url>`) Implementation Plan

**Goal:** Add a `duckwright explore <url>` subcommand that runs the agent with a built-in exploration task and reports flows, failed requests and console errors.
**Architecture:** `exploreMain` in `src/cli.ts` reuses `startRun` with a fixed task, `exportTest: false` and `consoleErrors: true`. The agent captures `playwright-cli console error` per step into `history.json`; after the run `src/explore/*` builds `explore.md`/`explore.json` from `history.json` and optionally writes task files.
**Tech Stack:** TypeScript, node:test, existing fakes (fake runner / fake `createAgent`), no browser.
**Spec:** /root/.config/superpowers/worktrees/duckwright/exploration-mode-explore/docs/superpowers/specs/2026-10-10-exploration-mode-explore-design.md (called "the spec" below; C1-C6 are its contracts and its text is the source of every exact string, so copy strings from it into tests, not from this plan).

## Global Constraints
- `npm test` (typecheck + all tests) must pass at the end of every task; the 1467 baseline tests must still pass.
- The main command's options, help, TUI, web UI, batch runs, `export`, `plan`, `init`, and `history.json` of non-explore runs are unchanged (no `console_errors` key; `exportRun` still runs after a successful non-explore run).
- `tuiMain`, `webMain`, `runOne`, `runBatch` are not changed; explore never calls `loadTui`.
- Same-host and no-destructive-actions rules are prompt-only; no harness enforcement.
- Every agent-provided or captured untrusted value is passed through `flat` before it goes into markdown or task files.
- No e2e tests; no real `claude` or `playwright-cli`.

## Review Focus
1. `console error` output parsing (header, next `###` section, continuation lines, `Total messages`/`Returning `, clip 500, cap 50): Task 1.
2. Non-explore runs must be byte-identical: no `console` call, no `console_errors`, export still runs: Task 2.
3. Unreadable or partial agent answer must never be fatal and must still list harness findings: Task 4 and Task 7.
4. `--write-tasks` only after `--` is a positional; default `maxSteps` 40 beats config but loses to `--max-steps`: Task 6.
5. Write-failure exit rule (0 becomes 1; 1/130 unchanged) and never touching an existing task folder: Tasks 5 and 7.

---

### Task 1: Console error capture

**Files:**
- Create: `src/console.ts`
- Test: `test/console.test.ts`

**Contracts:** C2 (capture half)

**Interfaces:**
- Consumes: `stripResult` (`src/network.ts`), `sliceCodePoints`/`codePointLength`/`flat` (`src/text.ts`), `redactText`/`redactUrl` (`src/redact.ts`), `PlaywrightCLI.run(cmd, args): Promise<ProcResult>` (`src/pw.ts`), `AbortedError` (`src/proc.ts`).
- Produces: `CONSOLE_MESSAGE_MAX = 500`, `CONSOLE_STEP_MAX = 50`, `parseConsoleErrors(stdout: string): string[]`, `redactConsole(text: string): string`, `captureConsoleErrors(pw: PlaywrightCLI): Promise<{ messages: string[]; error: string | null }>`.

**Checks:** `node --test test/console.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/console.test.ts`: parse (a) `### Result` header stripped; (b) stops at next `### ` heading; (c) blank lines, lines starting with whitespace, `Total messages...` and `Returning ...` lines dropped; (d) a 600-code-point message clipped to 500 code points (use an astral char to prove code points); (e) 60 lines give 50. Redaction: `Authorization: Bearer abc123` loses the token; a message containing `https://x.test/a?token=SECRET` has the query secret redacted via `redactUrl`. Capture with a fake pw whose `run` is called with `("console", ["error"])`: exit 0 returns redacted messages and `error: null`; non-zero exit returns `error` = trimmed stderr (or stdout when stderr empty) clipped to 300 code points; a thrown `Error` becomes `error`; a thrown `AbortedError` is re-thrown.
- [ ] **Step 2: Run it**: `Run: node --test test/console.test.ts` / `Expected: FAIL` (module not found).
- [ ] **Step 3: Implement** `src/console.ts` per the spec's "Console output parsing", "Console redaction" and "Console capture failure" rows. `redactConsole` = `flat` then `redactText` then `replace(/https?:\/\/\S+/g, redactUrl)`.
- [ ] **Step 4: Run it**: `Run: node --test test/console.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/console.ts test/console.test.ts && git commit -m "feat: capture console errors"`

### Task 2: Agent console capture, history key, exportTest

**Files:**
- Modify: `src/loop.ts`, `src/prompt.ts`, `src/runs/run.ts`
- Test: `test/loop.test.ts` (agent console capture), `test/runs/run.test.ts` (`historyJson` and `startRun`/`exportTest`; it already imports both from `src/runs/run.ts`)

**Contracts:** C2

**Interfaces:**
- Consumes: `captureConsoleErrors` (Task 1).
- Produces: `AgentOptions.consoleErrors?: boolean` and `Agent.consoleErrors`; `StepRecord.consoleErrors?: string[]`; `HistoryStep.console_errors?: string[]` (in `src/export.ts`); `RunSpec.exportTest?: boolean` (default true) and `RunSpec.consoleErrors?: boolean` (default false).

**Checks:** `node --test test/loop.test.ts test/runs/run.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests.** loop: with `consoleErrors: true` the fake pw receives `console error` after each step that ran actions, after the network capture, and `rec.consoleErrors` holds messages scrubbed with the 2FA scrubber; a failing capture pushes warning `console capture failed at step N: <message>` and leaves `rec.consoleErrors` unset; brain-error steps make no call; with the option off no `console` call is made. history: `historyJson` writes `console_errors` only when non-empty, and no key otherwise. run: `exportTest: false` after a successful run gives `export.kind === "off"` and no spec file; default still writes the spec; `consoleErrors: true` reaches `createAgent` options.
- [ ] **Step 2: Run it**: `Run: node --test test/loop.test.ts test/runs/run.test.ts` / `Expected: FAIL` (options unknown, key missing).
- [ ] **Step 3: Implement** per the spec's "`src/loop.ts`" and "`src/prompt.ts`, `src/export.ts`, `src/runs/run.ts`" sections. In `finish`, `exportTest === false` is checked before the success check so the result is `{ kind: "off" }` even on success; on failure keep the existing `skipped`.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/loop.ts src/prompt.ts src/export.ts src/runs/run.ts test/loop.test.ts test/runs/run.test.ts && git commit -m "feat: per-step console errors and exportTest option"` (stage only files actually changed).

### Task 3: Exploration task prompt, exported freshFolder

**Files:**
- Create: `src/explore/task.ts`
- Modify: `src/plan.ts` (add `export` to `freshFolder`)
- Test: `test/explore/task.test.ts`

**Contracts:** C3

**Interfaces:**
- Produces: `EXPLORE_MAX_STEPS = 40`, `exploreTask(url: string): string`; exported `freshFolder(root: string, slug: string): string`.

**Checks:** `node --test test/explore/task.test.ts test/plan.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing test**: `exploreTask("https://shop.example/a?x=1")` equals the C3 text with `<URL>` = `https://shop.example/a?x=1` and `<HOST>` = `shop.example`, pasted in full from the spec into the test as a fixed string; a second case with port (`http://localhost:3000`) gives host `localhost:3000` and href `http://localhost:3000/`; contains `ok`, `dead-end`, `broken`.
- [ ] **Step 2: Run it**: `Run: node --test test/explore/task.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** `exploreTask` as a template literal in `src/explore/task.ts`; export `freshFolder` in `src/plan.ts` with no behavior change.
- [ ] **Step 4: Run it**: `Run: node --test test/explore/task.test.ts test/plan.test.ts` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/explore/task.ts src/plan.ts test/explore/task.test.ts && git commit -m "feat: exploration task prompt"`

### Task 4: Explore report

**Files:**
- Create: `src/explore/report.ts`
- Test: `test/explore/report.test.ts`

**Contracts:** C4, C5

**Interfaces:**
- Consumes: `HistoryData` (`src/export.ts`; `HistoryStep.network`, `.console_errors`), `flat`, `fixed4` (`src/text.ts`).
- Produces: types `Flow`, `FailedRequest`, `ConsoleError`, `ExploreReport` (keys exactly as C4, snake_case); `parseFlows(answer: string, base: string): { flows: Flow[]; dropped: number; error: string | null }`; `failedRequests(data: HistoryData): FailedRequest[]`; `consoleErrors(data: HistoryData): ConsoleError[]`; `buildExploreReport(data: HistoryData, o: { url: string; runDir: string; network: boolean }): ExploreReport`; `renderExploreMarkdown(r: ExploreReport): string`; `writeExploreReport(runDir: string, r: ExploreReport): { md: string; json: string }` (paths of `explore.md`, `explore.json`).

**Checks:** `node --test test/explore/report.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**, using hand-built `HistoryData`:
  - `parseFlows`: plain JSON; fenced (```json) JSON; prose around the object; invalid JSON gives `error` `invalid JSON: <message>`; no `{` gives `no JSON object in the answer`; object without `flows` array gives `no "flows" list in the answer`; answer `max steps reached` gives `no JSON object in the answer`; relative `start_url` `/pricing` resolved against base; `ftp://` or unparsable `start_url` dropped; bad status dropped; missing steps/expected/notes defaults (`[]`, `""`, `""`); non-string steps dropped; empty title dropped; `dropped` counts.
  - `failedRequests`: 404, 500, `status: null` kept; `statusText` `net::ERR_ABORTED` and `Cancelled` excluded (also null status with those); 200/301 excluded; same method+url+status across steps grouped with ascending unique steps; first-seen order.
  - `consoleErrors`: same message in steps 1 and 2 grouped as `steps: [1, 2]`.
  - `buildExploreReport` JSON has exactly the C4 keys in C4 order, `network_checked: false` when `network: false` (and `failed_requests` then `[]`), flows split into `working_flows` and `broken_flows`.
  - Markdown equals C5 exactly for: full report; all-empty (`None.` in each section); network off (count `-` and the exact body sentence); unreadable answer (paragraph, both flow sections `None.`); dropped flows (`<n> flow(s) in the answer were unreadable and left out.`); `(step N)` vs `(steps N, M)`; `no response: <status_text>` form for null status; omitted `Steps:`/`Notes:`/`Expected:` lines; a multi-line title or message flattened.
  - `writeExploreReport` writes both files in a temp dir, JSON `JSON.stringify(r, null, 2) + "\n"`.
- [ ] **Step 2: Run it**: `Run: node --test test/explore/report.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** per the spec's "Answer parsing", "Invalid flow items", "Failed request rule" rows and C4/C5. Dropped counting: each item of `flows` that fails validation, including non-objects, counts once.
- [ ] **Step 4: Run it**: `Run: node --test test/explore/report.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/explore/report.ts test/explore/report.test.ts && git commit -m "feat: explore report"`

### Task 5: Task files for working flows

**Files:**
- Create: `src/explore/tasks.ts`
- Test: `test/explore/tasks.test.ts`

**Contracts:** C6

**Interfaces:**
- Consumes: `Flow` (Task 4), `freshFolder` (Task 3), `slugify` (`src/rundir.ts`), `flat`, `loadTaskFile` (`src/taskfile.ts`).
- Produces: `exploreTaskText(flow: Flow, url: string, runDir: string): string`; `writeExploreTasks(flows: Flow[], url: string, runDir: string, root = "tasks"): { folder: string; files: string[] } | null`.

**Checks:** `node --test test/explore/tasks.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (temp dir as `root`): only `ok` flows written; names `01-search-products.md`, padding to `max(2, digits of count)` (e.g. 100 flows give `001-`), empty slug gives `flow`; text equals C6 (with steps; without steps no `Steps:` block; empty `expected` gives `Check that: the flow finishes without an error page.`); every file passes `loadTaskFile` with settings `{ maxSteps: 25 }` and its parsed settings contain `maxSteps: 25`; multi-line title/step/expected/start_url are flattened; folder is `explore-<slugify(host)>` (`localhost:3000` gives `explore-localhost-3000`, empty slug gives `explore-site`); a pre-existing folder yields `-2` and is untouched; no ok flows gives `null` and no folder.
- [ ] **Step 2: Run it**: `Run: node --test test/explore/tasks.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** per C6. If `loadTaskFile` rejects the comment line in front matter, change only the comment form so it loads, and keep the source/run info in it; note it in the commit message.
- [ ] **Step 4: Run it**: `Run: node --test test/explore/tasks.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/explore/tasks.ts test/explore/tasks.test.ts && git commit -m "feat: explore task files"`

### Task 6: Argument parsing

**Files:**
- Modify: `src/args.ts`
- Test: `test/args.test.ts`

**Contracts:** C1 (parsing and usage errors)

**Interfaces:**
- Consumes: `parseRunArgs`, `UsageError`, `Parsed`, `TaskSettings`.
- Produces: `ExploreArgs = { url: string; writeTasks: boolean; run: RunArgs }`; `EXPLORE_USAGE` (first line of help); `EXPLORE_HELP` (exact C1 text); `parseExploreArgs(argv: string[], defaultSkill: string, settings: TaskSettings): Parsed<ExploreArgs>`.

**Checks:** `node --test test/args.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (the caller passes `settings` already holding `maxSteps: 40`; `parseExploreArgs` itself applies no 40): `-h`/`--help` returns `{kind:"help", text: EXPLORE_HELP}` with the exact C1 text; `--version` returns version; URL and `--write-tasks` anywhere before `--`; after `--` it is a positional (so `explore -- --write-tasks` hits the not-an-http(s)-URL error and `explore URL -- --write-tasks` hits `unrecognized arguments: --write-tasks`); with settings `{maxSteps: 40}` `run.maxSteps` is 40; `--max-steps 10` wins; `-p` accepted. Each error throws `UsageError` with usage `EXPLORE_USAGE`, prog `duckwright explore`, in the C1 order. Put the URL first in every case (so `-f X` cannot swallow it): no URL (`give a URL to explore`; also `explore --web` gives this, not the --web message), `file:///x` and `not a url` (`not an http(s) URL: <url>`), two positionals (`unrecognized arguments: <extra>`), `-f x` (`explore takes a URL, not --file`), `--plan x`, `--web`, `--port 1`, `--max-parallel 2`, `--past 1`, `--theme dark` (`<flag> does not apply to explore`), `--write-tasks=1` (`argument --write-tasks: ignored explicit argument '1'`), bad `--max-steps abc` (its own parseRunArgs message `argument --max-steps: invalid int value: 'abc'`), unknown option `--bogus` (`unrecognized arguments: --bogus`). Order-pinning two-violation cases, each asserting the first message: `explore file:///x --web` (bad URL, not --web); `explore URL extra --web` (unrecognized arguments: extra); `explore --web` (no URL); `explore URL --web --max-steps abc` (`--web cannot be used with explore`); `explore URL --port abc` (`--port does not apply to explore`, not the int error); `explore URL --write-tasks=1 --max-steps abc` (the --write-tasks message); `explore URL --max-steps abc` (the max-steps message, last).
- [ ] **Step 2: Run it**: `Run: node --test test/args.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** `parseExploreArgs` in `src/args.ts` with this exact algorithm. First give `parseRunArgs` an optional fourth parameter `scan?: { firstError: UsageError | null; extras: string[] }`. Without it, behavior is unchanged. With it, `fail` records the first `UsageError` into `scan.firstError` (prog `duckwright explore`, usage `EXPLORE_USAGE`) and returns instead of throwing, so parsing continues, and the final `unrecognized arguments` check is skipped and the extras are copied to `scan.extras`; change `fail`'s type to `(msg: string) => void` and keep the existing `!` assertions compiling. Then `parseExploreArgs`: (1) split `argv` at the first `--`; before it remove every exact `--write-tasks` token (set `writeTasks`) and every `--write-tasks=<v>` token (remember the first `<v>`); (2) call `parseRunArgs(restWithoutThoseTokens, defaultSkill, settings, scan)`; if the result is `help` return `{kind:"help", text: EXPLORE_HELP}`, if `version` return it (if `scan.firstError` is set at that point throw it instead); (3) the URL is `args.task`; then throw, first match wins, each as `UsageError(msg, EXPLORE_USAGE, "duckwright explore")`: no URL -> `give a URL to explore`; URL fails `new URL()` or protocol is not http/https -> `not an http(s) URL: <url>`; `scan.extras` non-empty -> `unrecognized arguments: <extras joined by space>`; then the rejected flags in C1 order -f/--file, --plan, --web, --port, --max-parallel, --past, --theme, detected by scanning the tokens before the first `--` for an exact match or a `<flag>=` prefix (not by inspecting `args`, since config settings may preset those fields), giving the C1 messages; then the `--write-tasks=<v>` message; then `scan.firstError` if set (bad `--max-steps`, unknown value errors); (4) return `{kind:"args", args:{ url, writeTasks, run: args }}`. Because deferred parse errors never abort the scan, `task` and `extras` are always known when the URL and extras checks run.
- [ ] **Step 4: Run it**: `Run: node --test test/args.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/args.ts test/args.test.ts && git commit -m "feat: parse explore arguments"`

### Task 7: `exploreMain` and dispatch

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Contracts:** C1, C2, C4, C5, C6 (end to end)

**Interfaces:**
- Consumes: everything above; `loadHistory`, `startRun`, `attachPlain`, `printOutcome`, `secretProblem`, `preflightArgs`, `runSettings`.
- Produces: `dispatch` branch `argv[0] === "explore"`; `exploreMain(deps: CliDeps, argv: string[]): Promise<number>`.

**Checks:** `node --test test/cli.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** with the existing cli test fakes and a temp cwd:
  - Success: fake agent returns `done success` answer `{"flows":[...]}` with network entries (a 404) and a step with `consoleErrors`; stdout has `Result:` ... no `Test:` line, blank line, report markdown, `Report: <dir>/explore.md`, `Data: <dir>/explore.json`; both files exist and equal the printed markdown/JSON; no `duckwright.spec.ts`; exit 0; the agent was created with `maxSteps` 40 and `consoleErrors: true`; a config with `max-steps` does not change 40; `--max-steps 10` does.
  - Unreadable answer: report has the `answer_error` paragraph and still lists harness findings; exit is the run's code.
  - Failed agent (`done failure`) and a thrown agent error: exit 1, report still built from `history.json`; interrupted gives 130.
  - Run folder not created: error from `printOutcome`, no report, exit 1.
  - `history.json` unreadable (agent fake deletes it): stderr `explore: cannot read history: <message>`, exit 1 when the run code was 0.
  - Report write failure (make `explore.md` a directory): markdown still printed, stderr `explore: cannot write report: <message>`, exit 0 becomes 1; run code 1 stays 1.
  - `--write-tasks`: folder written, stdout `Tasks: <n> task file(s) in <folder>/`, `  <path>` lines, `Run them with: duckwright -p -f <folder>/`; no working flows (and unreadable answer) prints `Tasks: no working flows, no task files written` and creates no folder; task write failure (make `tasks` a file) prints `explore: cannot write task files: <message>`, 0 becomes 1.
  - Usage errors exit 2 with `EXPLORE_USAGE` then `duckwright explore: error: <message>`; invalid config file, invalid TOTP secret, and preflight failure (no `claude`) give one stderr line and exit 2 without starting a run; `--help` prints `EXPLORE_HELP`, exit 0; `--version` prints `duckwright <version>`.
  - `duckwright -- explore` still runs a task named `explore`; `explore` never calls `loadTui`, even with `isTTY` true.
- [ ] **Step 2: Run it**: `Run: node --test test/cli.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** `exploreMain` following the spec's "Data flow" steps 2-10 and "`src/cli.ts`" section; add the dispatch line next to `export`/`init` before config loading. The 40-step default lives here: build the settings passed to `parseExploreArgs` as the loaded config settings with `maxSteps: 40` forced over them, so a config `max-steps` is ignored and `--max-steps` wins. Write-failure rule: a boolean `writeFailed` converts a 0 code to 1. Print `Report:`/`Data:` only when the write succeeded. Do not change `RUN_HELP`; the README note is Task 8.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/cli.ts test/cli.test.ts && git commit -m "feat: duckwright explore command"`

### Task 8: README

**Files:**
- Modify: `README.md`

**Contracts:** None (SC7)

**Interfaces:** None

**Checks:** `npm test`

- [ ] **Step 1: Edit** per the spec's "README.md (modified)" section: usage line `duckwright explore URL [--write-tasks] [options]`, new `### Exploration mode` section after Plan mode (items listed in the spec), Output section additions (`explore.md`, `explore.json`, `console_errors`), the `export`/`init` first-argument note naming `explore`, and the Roadmap item ticked `- [x]`. If a packaging/README test asserts content, keep it passing.
- [ ] **Step 2: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 3: Commit**: `git add README.md && git commit -m "docs: document exploration mode"`

## Manual e2e
- [ ] Run `duckwright explore https://<a site you own>` with real `claude` and `playwright-cli`; confirm the `playwright-cli console error` output format matches `parseConsoleErrors` (adjust the fixture if a newer playwright-cli prints a different layout).
- [ ] Run the written tasks with `duckwright -p -f tasks/explore-<host>/`.
