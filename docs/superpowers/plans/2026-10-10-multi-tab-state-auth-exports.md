# Multi-tab and storage state in exports, with automatic login Implementation Plan

**Goal:** Make `duckwright export` emit `test.use({ storageState })` and real multi-page code, and log in once per environment from a `login:` front-matter block, caching the state.
**Architecture:** Export work is confined to `src/export.ts`/`src/exportApi.ts` plus a `state` record in `history.json`. Auto-login is a new `src/auth.ts` (`AuthBroker`, one per process) fed by a parsed `LoginConfig` from `src/environment.ts`, called by `startRun` (and up front in print mode from `src/cli.ts`). Agent login reuses `Agent` with placeholder substitution in `execute`.
**Tech Stack:** TypeScript (Node >= 22.18, type stripping), `node --test`, playwright-cli via `PlaywrightCLI`.
**Spec:** docs/superpowers/specs/2026-10-10-multi-tab-state-auth-exports-design.md

Narrow check form: `node --test test/<file>.test.ts`. Full check (last step of every task from Task 4 on, and the end of Task 10): `npm test` and `npm run typecheck`.

## Global Constraints
- Credentials are read only from the env vars named in the file (`CliDeps.env`/`RunDeps.env`) at login time, never at parse time; they never reach prompts, `history.json`, logs, debug logs or exports.
- Cache: `<cwd>/.duckwright/auth/<label>.json` (label = `envLabel` with chars outside `[A-Za-z0-9._-]` replaced by `_`); folders `0o700`, state file `0o600`; `.duckwright/.gitignore` = `*\n` only if absent; write `<file>.tmp` then rename.
- Auto-login only when the effective environment has `login:` and effective `state` is null (any explicit state skips it entirely).
- No new command, no new flags. No e2e/browser/live-site tests; tests use fake runners and fake agents.
- A run with no successful tab action and no `state` exports byte-for-byte as before.
- Never push, never `--no-verify`.

## Review Focus
1. Password leakage: password absent from `history.json`, debug log, brain prompts, error messages, recorded code (Task 8 test).
2. Concurrency: two simultaneous `ensure` calls produce one login; a failed login is not memoized (Task 6 test).
3. Explicit `--state` with a `login:` env never touches the broker (Task 8 test).
4. Tab helper semantics (`closeTab` current-tab choice, closing the last tab) run against a fake context (Task 3 test).
5. Front-matter edge cases: `login: foo` inline value, unclosed front matter, empty body after front matter, correct line numbers counted from the file's line 1 (Task 1 test).

---

### Task 1: Environment front matter and `login:` parsing

**Files:**
- Modify: `src/environment.ts`, `src/taskfile.ts` (export `value` and `LineError` unchanged in behaviour)
- Test: `test/environment.test.ts`

**Contracts:** C1

**Interfaces:**
- Consumes: `value(raw: string): string` and `class LineError extends Error` from `src/taskfile.ts` (now exported).
- Produces: `type LoginConfig`, `interface LoginCheck` exactly as in the spec section 3; `loadEnvironment(value, cwd?)` returns `{ name: string; path: string; text: string; login: LoginConfig | null }`.

**Checks:** `node --test test/environment.test.ts`, `node --test test/taskfile.test.ts`

- [ ] **Step 1: Write the failing tests** in `test/environment.test.ts` (use existing temp-dir helpers). Cases: no front matter (line 1 not `---`) gives the same `text` as today and `login: null`; line 1 `---   ` (trailing spaces) opens front matter; the C1 script example parses to `{ method: "script", url, usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button[type=submit]", usernameEnv: "STAGING_USER", passwordEnv: "STAGING_PASSWORD", check: { url: "https://staging.example.com/account", text: "Sign out" } }`; an agent block parses to `{ method: "agent", task, usernameEnv, passwordEnv, check: null }`; `text` is only the body (no `---`, no `login:`); quotes, ` #` comments, blank and `#` lines inside the block are handled per task-file rules; CRLF input works. One test per C1 error with its exact message and line number N counted from line 1 of the file (PATH = resolved file path): not closed; indented/unindented line without colon (`expected "key: value"`); top-level key other than `login` (`unknown key "KEY" (only login is allowed)`); `bad quoted value`; unknown login key; duplicate key; key with no value; missing method; bad method (`got "VALUE"`); missing required key per method (`KEY is required for method METHOD`); key from the other method (`KEY is not used by method METHOD`); bad env-var name; `url`/`check-url` not http(s); only one of `check-url`/`check-text`. Inline value: a line `login: foo` fails with `environment file invalid: PATH:N: login: must be followed by indented "key: value" lines`. Front matter only with empty body still gives `environment file is empty`; the 16384-byte limit counts the whole file.
- [ ] **Step 2: Run it**: `Run: node --test test/environment.test.ts` / `Expected: FAIL` (no `login` property, no parsing).
- [ ] **Step 3: Implement** in `src/environment.ts`: split lines of the decoded, CRLF-normalised file; if line 1 matches `/^---[ \t]*$/` find the next line that is exactly `---` (else the "not closed" error); parse lines between with a small state machine (`login:` at column 0 opens the block; indented lines are `key: value` using `value()`; wrap `LineError` into `EnvError` with `PATH:N:`); validate per D3/C1 (env-var regex `^[A-Za-z_][A-Za-z0-9_]*$`, URLs via `new URL` with protocol http/https); body = remaining lines joined, trimmed, empty -> existing error. Export `LineError`/`value` from `src/taskfile.ts` without changing them.
- [ ] **Step 4: Run it**: `Run: node --test test/environment.test.ts test/taskfile.test.ts` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/environment.ts src/taskfile.ts test/environment.test.ts && git commit -m "feat: parse login front matter in environment files"`

### Task 2: Exported `test.use` for state runs (UI and API specs) and `state` in history shape

**Files:**
- Modify: `src/export.ts`, `src/exportApi.ts`
- Test: `test/export.test.ts`, `test/exportApi.test.ts`

**Contracts:** C4 (export side), C5 (state), C6

**Interfaces:**
- Consumes: none.
- Produces: `HistoryData.state?: { path: string; source: "file" | "login" }`; exported `function stateBlock(state: { path: string; source: "file" | "login" }): string` (the three comment/code lines of C5 each ending `\n`, no trailing blank line) used by both renderers; `API_HEADER` without the `--state` line.

**Checks:** `node --test test/export.test.ts test/exportApi.test.ts`

- [ ] **Step 1: Write the failing tests.** export: history with `state: {path: ".duckwright/auth/staging.json", source: "login"}` renders, after header (and after TOTP helper when present) and a blank line, exactly the C5 three lines with `(auto-login)`; `source: "file"` gives `(--state)`; path containing a newline omits the path in the comment (`The run started from a storage state (...)`) but `JSON.stringify` still in code; `COOKIES_NOTE` absent with state when a `request` setup exists, still present without state; byte-identical output for a no-state, no-tab history (compare with existing fixture expectations). `loadHistory` with `state: "x"` or `state: {path: 1}` throws ExportError exit 2 with `not a duckwright history: FILE: 'state' must be an object with a string 'path'`. exportApi: header has no `--state` line; `test.use` block present after header when state set, absent otherwise.
- [ ] **Step 2: Run it**: `Run: node --test test/export.test.ts test/exportApi.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** `stateBlock`, the `shapeError` check, `renderSpec`/`renderApiSpec` insertion (block then blank line, before `test(`), COOKIES_NOTE guard `data.state === undefined`, header edit.
- [ ] **Step 4: Run it**: same command / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/export.ts src/exportApi.ts test/export.test.ts test/exportApi.test.ts && git commit -m "feat: export storageState for runs that loaded a state"`

### Task 3: Multi-tab export

**Files:**
- Modify: `src/export.ts`
- Test: `test/export.test.ts`

**Contracts:** C5 (tabs)

**Interfaces:**
- Consumes: `stateBlock` and the header assembly order from Task 2 (header, TOTP, tab helpers, blank line, state block).
- Produces: exported constants `SELECT_TAB_HELPER`, `CLOSE_TAB_HELPER` (exact text from C5); tab index rule: `args[0]` is valid when it is a JS integer >= 0 or a string matching `/^[0-9]+$/` (both forms are accepted); the emitted code always uses the decimal integer literal (`selectTab(page, 2)`, never quoted).

**Checks:** `node --test test/export.test.ts`

- [ ] **Step 1: Write the failing tests.** Histories with successful tab actions: `tab-new` with url -> lines `  page = await page.context().newPage();` then `  await page.goto("<url>");`; `tab-new` without args -> only the first; `tab-select` with `"1"` and with number `1` both emit `  page = await selectTab(page, 1);`; `tab-close` and `tab-close` with `"0"` emit `closeTab(page)` / `closeTab(page, 0)`; callback is `async ({ page: firstPage }) => {` followed by `  let page = firstPage;`; only the helpers used are emitted; no `TODO(duckwright)` line and no `run used tab-` warning; a failed (`error:`) tab action is skipped and leaves the export identical to the no-tab output; `tab-select` with no arg, `"x"`, `"-1"`, `1.5`, and `tab-close` with `"abc"` throw ExportError exit 1 with `tab-select in step N has no valid tab index (expected a whole number, got VALUE)` (VALUE = `JSON.stringify(args[0] ?? null)`). Helper execution test: `new Function` the two helper strings (as the TOTP helper test does) with a fake context `{pages: () => [...]}` where fake pages have `context()`, `bringToFront()`, `close()` that mutates the list; assert `selectTab` brings the right page to front and throws `no tab 5`; `closeTab(current)` closing current in the middle returns the page now at the same index, closing the last-indexed returns the new last, closing another tab returns `current`, closing the only tab throws `closed the last tab`.
- [ ] **Step 2: Run it**: `Run: node --test test/export.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** in `renderSpec`: replace the TODO/tabs-warning logic with tab-line emission and a `usesSelect`/`usesClose`/`hasTab` tracker; `tab-new` url pushed only when `args[0]` is a non-empty string; switch the callback signature only when `hasTab`; keep `firstUi` bookkeeping unchanged.
- [ ] **Step 4: Run it**: `Run: node --test test/export.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/export.ts test/export.test.ts && git commit -m "feat: export tab commands as multi-page code"`

### Task 4: `history.json` `state` record for explicit `--state`

**Files:**
- Modify: `src/runs/run.ts`
- Test: `test/runs/run.test.ts`

**Contracts:** C4

**Interfaces:**
- Consumes: `HistoryData.state` (Task 2).
- Produces: `historyJson(task, success, answer, steps, costUsd, history, taskFile?, video?, env?, state?: { path: string; source: "file" | "login" } | null)` placing `state` right after `env` (after `task_file` when no env); exported `statePathForHistory(abs: string, cwd: string): string` (relative POSIX path when inside cwd, else absolute).

**Checks:** `node --test test/runs/run.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests.** Run with `args.state` = a file inside cwd -> `history.json` has `"state": {"path": "<relative, POSIX>", "source": "file"}` in key order `env` then `state`; state outside cwd -> absolute; no state -> key absent; a failing run with state still records it; exporting that history contains `test.use`. `statePathForHistory` unit cases.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/run.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: compute `stateRecord` in `execute` before the agent is built (so the failure path records it too) and pass to both `writeHistory` calls.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/run.ts test/runs/run.test.ts && git commit -m "feat: record loaded state in history.json"`

### Task 5: `stateSave`, placeholder substitution, `beforeClose`

**Files:**
- Modify: `src/pw.ts`, `src/actions.ts`, `src/loop.ts`
- Test: `test/pw.test.ts`, `test/actions.test.ts`, `test/loop.test.ts`

**Contracts:** None (internal)

**Interfaces:**
- Produces: `PlaywrightCLI.stateSave(path: string): Promise<void>` (argv `["playwright-cli","-s=<session>","state-save",path]`, throws `PlaywrightError(stderr || stdout)`); `execute(pw, actions, codes?, hooks?, requests?, call?, twofa?, fillValues?: Record<string,string>)`; `AgentOptions.fillValues?: Record<string,string>` and `AgentOptions.beforeClose?: (result: RunResult) => Promise<void>`.

**Checks:** `node --test test/pw.test.ts test/actions.test.ts test/loop.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests.** pw: `stateSave` argv; non-zero exit throws PlaywrightError with the stderr. actions: with `fillValues {"{{username}}":"u@x.com","{{password}}":"s3cret"}`, `fill` args `["#p","{{password}}"]` reach the runner as `s3cret`, `type` likewise, multiple occurrences in one text are all replaced; `click`/`goto` args containing the placeholder are untouched; the caller's `Action` objects still hold the placeholder (recorded step keeps it); without `fillValues` nothing changes. loop: `beforeClose` is called with the result after a successful `done` and before `close` (assert call order via the fake runner log); not called when the run returns a failure result or throws; a throw from it propagates and the browser still closes.
- [ ] **Step 2: Run it** / `Expected: FAIL`
- [ ] **Step 3: Implement**: substitute into a copied args array only for `fill`/`type` just before `pw.run`; thread `fillValues` from `Agent` into `execute`; in `Agent.run` call `await this.options.beforeClose?.(result)` after `loop()` when `result.success`, inside the `try` so `finally` still closes.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/pw.ts src/actions.ts src/loop.ts test/pw.test.ts test/actions.test.ts test/loop.test.ts && git commit -m "feat: state-save, fill placeholders and beforeClose hook"`

### Task 6: `AuthBroker` with script login

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Contracts:** C2, C3 (script path and shared reasons)

**Interfaces:**
- Consumes: `LoginConfig` (Task 1), `PlaywrightCLI.stateSave` (Task 5), `Scrubber` from `src/scrub.ts`, `envLabel`.
- Produces:
  - `AUTH_DIR`, `authLabel(envName: string): string`, `cachePath(envName: string, cwd: string): string`, `stateProblem(file: string, now: number): "missing" | "unreadable" | "expired" | null`
  - `class LoginError extends Error` (message = REASON only)
  - `interface EnsureOptions { env: { name: string; login: LoginConfig }; cwd?: string; signal: AbortSignal; headed: boolean; run?: LoginRunContext; onReason?: (r: string) => void }` where `LoginRunContext` (used from Task 7) carries what agent login needs and is optional/unused for script.
  - `class AuthBroker { constructor(o: { env: Record<string,string|undefined>; runner?: Runner; now?: () => number; createPw?: (session: string, signal: AbortSignal) => PlaywrightCLI; ... }); ensure(opts: EnsureOptions): Promise<{ path: string; reused: boolean; costUsd: number }> }` (`path` absolute).

**Checks:** `node --test test/auth.test.ts`

- [ ] **Step 1: Write the failing tests** (fake runner records argv; temp cwd). `authLabel`/`cachePath` sanitising (`a b/c` -> `a_b_c`); `stateProblem`: missing, bad JSON, no `cookies` array, cookie with `expires` within 60 s of now, `expires: -1` usable, `expires` just beyond 60 s usable. Script login issues exactly: `open about:blank` (plus `--headed` when headed), `goto <url>`, `fill <usernameSelector> <user>`, `fill <passwordSelector> <pass>`, `click <submitSelector>`, then `state-save <cache>.tmp`, then `close` (also after a failure); fresh session name `duckwright-login-<label>`. The fake `state-save` writes a JSON file; afterwards the cache exists with mode `0o600`, folders `0o700`, `.duckwright/.gitignore` is `*\n` and an existing `.gitignore` is not overwritten, no `.tmp` left. Step failures give `LoginError` messages `fill password failed: <msg>` etc. (STEP in `open|goto|fill username|fill password|click submit|state-save`); a stderr echoing the password shows `[REDACTED]`; the password appears only in the `fill password` argv. Check (`check-url`/`check-text`): after click, `goto check-url`, snapshot (fake runner writes snapshot file) must contain the text, else `check failed: "TEXT" not found at URL` and no cache written; passes -> saved. Missing/empty env var -> `environment variable NAME is not set` (and no runner calls). Unwritable cache dir -> `cannot write PATH: MESSAGE`. Broker: two concurrent `ensure` -> one login (count `open` calls); second `ensure` after success reuses (`reused: true`) with no check re-run for same path+mtime (D11); a valid cache with a check that fails (`checkState`, session `duckwright-check-<label>`) triggers a fresh login with `onReason("saved state failed the check")`; expired cache -> `onReason("saved state expired")`; unreadable -> `saved state unreadable`; missing -> `no saved state`; cache with valid cookies and no variables set is reused without reading env; a failed login is retried by the next `ensure`; aborted signal rejects with `AbortedError`, not `LoginError`.
- [ ] **Step 2: Run it**: `Run: node --test test/auth.test.ts` / `Expected: FAIL` (module missing)
- [ ] **Step 3: Implement** `src/auth.ts`: in-flight `Map<cachePath, Promise>`, `checked: Map<cachePath, mtimeMs>`; `finishLogin(pw, check, tmp)` = optional check then `stateSave`; temp file renamed to cache and chmod `0o600`; scrubber with username/password values applied to every error message.
- [ ] **Step 4: Run it**: same command / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/auth.ts test/auth.test.ts && git commit -m "feat: auth broker with script login and state cache"`

### Task 7: Agent login

**Files:**
- Modify: `src/auth.ts`, `src/runs/run.ts` (extract brain construction into an exported helper `makeBrain(args, deps, workdir, signal, log, scrubber)` used by `execute` and `agentLogin`; behaviour of runs unchanged)
- Test: `test/auth.test.ts`, `test/runs/run.test.ts`

**Contracts:** C3 (agent reasons)

**Interfaces:**
- Consumes: `Agent`/`AgentOptions.fillValues`/`beforeClose` (Task 5), `createTwoFactor` and `Scrubber`, `makeBrain`.
- Produces: `LoginRunContext = { args: RunArgs; deps: Pick<RunDeps, "prompts"|"signal"|"createAgent"|"runner"|"jevTransport"|"humanFor"|"onWarning"> }` (defined in `src/auth.ts`); the agent branch of `ensure`.

**Checks:** `node --test test/auth.test.ts test/runs/run.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** (fake `createAgent` captures its options and runs `beforeClose`). The agent is created with: task = `login.task` + the fixed paragraph from C1 verbatim; `fillValues` for both placeholders; session `duckwright-login-<label>`; work dir `.duckwright/auth/<label>.login/` emptied before and removed after success, kept on failure; same model/maxSteps/snapshot/headed settings as `run.args`; the environment text in `environment`; no `history.json`, no export, no `debug.log` created; the twofa scrubber contains both values (`scrub("pw")` -> `[REDACTED]`). `beforeClose` runs the check then `state-save <cache>.tmp` in that session. Failures: result `success:false` -> `login agent did not finish: ANSWER` (scrubbed); `PlaywrightError` -> `playwright error: MESSAGE`. Cost is returned as `costUsd`. Run-refactor test: existing run tests still pass with `makeBrain`.
- [ ] **Step 2: Run it** / `Expected: FAIL`
- [ ] **Step 3: Implement** `agentLogin` and the extraction.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/auth.ts src/runs/run.ts test/auth.test.ts test/runs/run.test.ts && git commit -m "feat: agent-based login"`

### Task 8: Auto-login inside `startRun`

**Files:**
- Modify: `src/runs/run.ts`
- Test: `test/runs/run.test.ts`

**Contracts:** C3 (TUI/web/explore side), C4 (`source: "login"`)

**Interfaces:**
- Consumes: `AuthBroker.ensure`, `LoginError` (Tasks 6-7), `loadEnvironment().login`.
- Produces: `RunDeps.auth?: AuthBroker`.

**Checks:** `node --test test/runs/run.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests.** Env with `login:` and no state: fake broker `ensure` called once, agent gets `state` = returned path, `history.json` has `source: "login"` and relative path; the password value (set in `deps.env`) is absent from `history.json`, `debug.log` (with `--debug`), and every prompt given to a fake brain/runner, and an agent-emitted result containing it is `[REDACTED]` (D25; username not scrubbed); explicit `args.state` + `login:` env: broker never called, `source: "file"`; env without `login:`: broker never called; no `deps.auth`: no login attempted; `ensure` rejecting with `LoginError("x")` -> outcome `fail`, `answer`/`error` = `login failed: <env>: x`, `history.json` with zero steps written, no `run:start` event emitted; abort during ensure -> exit 130 `interrupted`; the env text passed to the agent never contains the `login:` block.
- [ ] **Step 2: Run it** / `Expected: FAIL`
- [ ] **Step 3: Implement** the decision order of D13 in `execute`: after `loadEnvironment`, `ensure` before `run:start` and before `createAgent`; catch `LoginError` mapping; add password to the run's scrubber (`twofa.scrubber.addSecret`) when source is `login`.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/run.ts test/runs/run.test.ts && git commit -m "feat: log in automatically before a run"`

### Task 9: CLI wiring and print-mode up-front login

**Files:**
- Modify: `src/cli.ts`, `src/bin.ts` (only if `DEFAULT_DEPS` is built there)
- Test: `test/cli.test.ts`

**Contracts:** C3

**Interfaces:**
- Consumes: `AuthBroker`, `LoginError`, `RunDeps.auth`.
- Produces: `CliDeps.auth: AuthBroker` (default one broker per process); function `loginUpFront(deps, runs: RunArgs[]): Promise<number | null>` returning an exit code on failure (1 or 130) or null.

**Checks:** `node --test test/cli.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** (fake broker/agents injected via `CliDeps`). Single task with login env: stdout has `Login: ENV: logging in (script), no saved state` then `Login: ENV: saved state PATH  Cost: $0.0000` before the run output; reuse prints `Login: ENV: using saved state PATH`; expired/unreadable/failed-check reasons print as in C3; batch of 3 tasks sharing one login env: exactly one `ensure` login, no `Login:` line repeated, every agent receives the same `state` path, lines appear before `[1/3]`; two different login envs: two logins in first-seen order; a task with explicit `--state` is excluded; login failure: stderr `login failed: ENV: REASON`, exit 1, no agent created, no `Batch:` summary; abort -> 130; invalid `login:` block -> preflight exit 2 (batch lines prefixed with the task file); TUI manager `startRun` and explore pass `auth` through (assert the broker object identity reaches `startRun` deps).
- [ ] **Step 2: Run it** / `Expected: FAIL`
- [ ] **Step 3: Implement**: add `auth` to `CliDeps` and defaults; spread into `startRun` deps in `runOne`, `interactiveMain`, `exploreMain`; call `loginUpFront` after preflight in the single-task, single-file and `runBatch` paths.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/cli.ts src/bin.ts test/cli.test.ts && git commit -m "feat: shared login in print, TUI, web and explore"`

### Task 10: Docs, sample environment, gitignore

**Files:**
- Modify: `README.md`, `examples/environments/staging.md`, `.gitignore`
- Test: `test/environment.test.ts` (sample parses), `test/packaging.test.ts` if it lists docs (run it)

**Contracts:** C1 (documentation)

**Interfaces:** none.

**Checks:** `node --test test/environment.test.ts test/packaging.test.ts`, `npm test`, `npm run typecheck`

- [ ] **Step 1: Write the failing test**: `loadEnvironment("examples/environments/staging.md", ROOT)` parses with `login.method === "script"` and a non-empty body that does not mention `--state auth.json`.
- [ ] **Step 2: Run it**: `Run: node --test test/environment.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: sample file starts with the C1 script front matter (comment moved below it); README "Automatic login" subsection (C1 keys, C2 cache, C3 lines, D27 how to skip), `--state` row, export notes without "edit by hand" for state/tabs, exit codes (invalid `login:` = 2, failed login = 1), the `login: foo` inline-value error message, roadmap items checked; `.gitignore` adds `.duckwright/`.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add README.md examples/environments/staging.md .gitignore test/environment.test.ts && git commit -m "docs: document automatic login and new export output"`

## Manual e2e
- [ ] Point an environment's `login:` block at a real staging site, once with `script` and once with `agent`; run a batch and confirm a single `Login:` line.
- [ ] Run `npx playwright test` from the project root on an exported auto-login spec, with and without `DUCKWRIGHT_STORAGE_STATE`.
- [ ] Run `npx playwright test` on a spec exported from a run that used `tab-new`/`tab-select`/`tab-close`.
