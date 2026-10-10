# Multi-tab and storage state in exports, with automatic login from the environment

Date: 2026-10-10. Brief: `.duckor/flow/20261010-151344-multi-tab-state-auth-exports/brief.md`.

## 1. Summary

Two kinds of runs still produce specs that need hand edits: runs that started from a storage state (`--state FILE`), and runs that used `tab-new` / `tab-select` / `tab-close`. This change makes `duckwright export` (and the automatic export after a run) emit `test.use({ storageState })` for state runs and real multi-page code for tab commands, so both cases export cleanly. It also removes the manual login step: an environment file (`environments/<env>.md`) may now start with a front-matter `login:` block that tells Duckwright how to log in (a deterministic `script` that fills selectors, or a login `agent` task). When `--env` names such an environment and no state is given, Duckwright logs in once before the first task of a run, batch or plan, saves the state to a git-ignored cache (`.duckwright/auth/<env>.json`), loads it into every task, and reuses it until it expires or fails a check. Credentials are always read from environment variables named in the file and never reach prompts, `history.json`, logs or exports.

## 2. Decisions

| # | Topic | Decision |
|---|-------|----------|
| D1 | Where `login:` lives (brief assumption) | YAML-style front matter at the top of the environment markdown file: line 1 is exactly `---` (trailing spaces allowed), closed by the next line that is exactly `---`. Only the key `login` is allowed at top level. Everything after the closing `---` is the environment text, as today. A file whose line 1 is not `---` has no front matter and behaves exactly as today. |
| D2 | Block syntax | `login:` alone on its line, followed by indented `key: value` lines (any leading whitespace). Values use the task-file rules: optional single or double quotes, ` #` starts a comment outside quotes. One level only; no lists or nesting. Blank and `#` lines are skipped. |
| D3 | Methods | `method: script` (keys `url`, `username-selector`, `password-selector`, `submit-selector`) or `method: agent` (key `task`). Both require `username-env` and `password-env`. Both accept the optional pair `check-url` + `check-text`. |
| D4 | Credentials | Only environment-variable names are written in the file (`username-env`, `password-env`). Values are read from the process environment (`CliDeps.env`) at login time, never at parse time. |
| D5 | Missing credential variables | Checked when a login actually has to run, not at preflight, so a valid cached state works without the variables. Missing or empty → login fails (exit 1 in print mode). |
| D6 | Agent-login credentials (no secret in the prompt) | The login agent is told to type the literal placeholders `{{username}}` and `{{password}}`. The harness replaces them in the text argument of `fill` and `type` actions just before calling playwright-cli. Both values are added to that run's scrubber, so results, recorded code, snapshots on disk and error messages show `[REDACTED]`. |
| D7 | Login agent setup (brief assumption) | Same model, max steps, snapshot mode, skill, headed and Jev settings as the run that triggered it; a fresh playwright-cli session named `duckwright-login-<label>`; the environment text is in its prompt as for any run; `twofa` works as in any run. It writes no `history.json`, no export, no `debug.log`. Its work folder is `.duckwright/auth/<label>.login/`, emptied before each login and removed after a successful one (kept, scrubbed, after a failure). |
| D8 | Script login steps | In a fresh session `duckwright-login-<label>`: `open about:blank` (`--headed` when the run is headed), `goto <url>`, `fill <username-selector> <username>`, `fill <password-selector> <password>`, `click <submit-selector>`, then the optional check (D10), then `state-save <tmp>`, then `close` (always). Selectors are passed to playwright-cli as given (it accepts CSS selectors and Playwright locators). |
| D9 | Cache location (brief assumption) | `<cwd>/.duckwright/auth/<label>.json`, where `<label>` is the environment's label (`envLabel`) with every character outside `[A-Za-z0-9._-]` replaced by `_`. Folders are created with mode `0o700`, the state file with `0o600`. When Duckwright creates `.duckwright/`, it also writes `.duckwright/.gitignore` containing `*` (only if that file is absent), so the cache is git-ignored in any repository. This repo's `.gitignore` also gets `.duckwright/`. |
| D10 | Validity (brief assumption) | A cached file is usable when (a) it parses as a JSON object with a `cookies` array, (b) no cookie has a numeric `expires > 0` with `expires * 1000 <= now + 60000`, and (c) when `check-url` is set, the check passes: a fresh session `duckwright-check-<label>` loads the state, goes to `check-url`, takes a snapshot, and the snapshot text contains `check-text` (case-sensitive substring). The check is available to both methods (not only agent). After a fresh login, (c) runs in the login session before `state-save`, and a failure there fails the login. |
| D11 | How often the check runs | (a) and (b) run on every `ensure`. (c) runs at most once per state file per Duckwright process: a state file this process produced or already checked (same path and mtime) is not checked again. |
| D12 | One login per run/batch/plan | One `AuthBroker` per Duckwright process, shared by every run it starts (print mode, TUI, web, explore). `ensure(env)` is keyed by cache path; concurrent callers await the same in-flight promise. A failed login is not memoized: the next `ensure` tries again. |
| D13 | When auto-login applies | Only when the effective environment has a `login:` block and the effective `state` is null. Any state setting (command line, task file, global config, TUI/web option) counts as explicit and skips auto-login entirely (no cache read, no login). |
| D14 | Print-mode ordering (brief assumption: failed login fails before any task, exit 1) | Print mode (single task, single file, batch) resolves login up front: for each distinct environment among the runs that need auto-login, in first-seen order, `ensure` runs before the first task. A failure prints one stderr line and exits 1; no task runs, no batch summary is printed. Interrupted → 130. |
| D15 | TUI / web / explore | No up-front step. Each run calls `ensure` inside its own start, before `run:start`; the first one logs in, the others wait. A failed login fails that run (status `fail`, answer = the login message) and writes its `history.json` with zero steps, as other pre-start failures do today. |
| D16 | Login cost | Printed on the print-mode login line; not added to any run's cost and not shown in the TUI/web. |
| D17 | History record | `history.json` gains `"state": {"path": string, "source": "file" \| "login"}` right after `env`, present only when the run loaded a state. `path` is relative to the run's working directory (POSIX `/` separators) when the file is inside it, otherwise absolute. Never the file content. |
| D18 | Export path for `storageState` (brief assumption, adjusted) | The brief assumed "relative to the spec where possible". Playwright passes `storageState` straight to `browser.newContext`, which resolves it against the test runner's working directory, not the spec file, and spec-relative tricks (`__dirname`, `import.meta.url`) break in either CJS or ESM projects. So the spec uses the recorded `state.path` (relative to the directory Duckwright ran in, which is normally the project root where `npx playwright test` runs) and lets CI override it: `process.env.DUCKWRIGHT_STORAGE_STATE \|\| "<path>"`. |
| D19 | Manual and auto state exports | Identical code for `source: "file"` and `source: "login"`; only the comment above differs (see C5). |
| D20 | `expect` / `request` exports (brief assumption) | Their rendering is unchanged. The `COOKIES_NOTE` warning is no longer emitted when the history has `state` (the `test.use` line covers it); it stays for runs without a state. The API spec header loses its `--state` line. |
| D21 | Multi-tab code shape | Only when at least one `tab-*` action succeeded: the test callback takes `{ page: firstPage }` and starts with `let page = firstPage;`, so every recorded line (which uses `page`) acts on the current tab without rewriting. Tab helpers `selectTab` and `closeTab` are emitted after the header only when used. Runs with no successful tab action export byte-for-byte as today. |
| D22 | Tab indexes | 0-based indexes into `page.context().pages()` (creation order), matching playwright-cli's tab list; this also covers tabs opened by the page (popups). |
| D23 | Which tab is current after `tab-close` | Matches playwright-cli: closing the current tab makes the tab now at the same index current (or the last one if it was last); closing another tab keeps the current one. Closing the last remaining tab throws in the spec. |
| D24 | Bad tab arguments in history | A successful `tab-select` without a whole-number index, or a `tab-close` whose optional index is not a whole number, fails the export (ExportError, exit 1). Failed tab actions are skipped silently, as today. |
| D25 | Password scrubbing in normal runs | When a run's state came from auto-login and the password variable is set, its value is also added to that run's scrubber, as defence in depth. The username is not (pages legitimately show it). |
| D26 | Env file front matter vs. body size | The 16384-byte limit applies to the whole file. The body after front matter must still be non-empty (existing `environment file is empty` rule). |
| D27 | No new command, no new flags | No `duckwright login`, no `--no-login`. To skip auto-login, pass `--state FILE`, or use an environment file without `login:`. |

## 3. Architecture / Components

### `src/environment.ts` (modified)

- `loadEnvironment` splits off front matter before trimming, parses it, and returns `{ name, path, text, login: LoginConfig | null }`. `text` is the body only, so the `login:` block never reaches a prompt.
- New exported types:

```ts
export type LoginConfig =
  | { method: "script"; url: string; usernameSelector: string; passwordSelector: string; submitSelector: string;
      usernameEnv: string; passwordEnv: string; check: LoginCheck | null }
  | { method: "agent"; task: string; usernameEnv: string; passwordEnv: string; check: LoginCheck | null };
export interface LoginCheck { url: string; text: string }
```

- Parse errors are `EnvError`s, so the existing preflight (`cli.ts preflight`) turns them into exit 2 and the TUI/web into a task error, with no new wiring.
- Reuses the task-file value rules (quotes, comments). The plan may export the existing private `value()` helper from `src/taskfile.ts` rather than copy it.

### `src/auth.ts` (new)

One purpose: produce a usable storage-state file for an environment with `login:`.

- `AUTH_DIR = ".duckwright/auth"`, `authLabel(envName)`, `cachePath(envName, cwd)`.
- `stateProblem(file, now): string | null`: checks D10 (a) and (b); returns `"missing"`, `"unreadable"`, `"expired"` or null.
- `scriptLogin(...)`, `agentLogin(...)`: D8 / D7, both ending in `finishLogin(pw, check, tmpFile)` = optional check, then `state-save`.
- `checkState(...)`: D10 (c) for a cached file.
- `class AuthBroker` with `ensure(env, opts): Promise<{ path: string; reused: boolean; costUsd: number }>`, implementing D11 and D12. Writes to `<file>.tmp` and renames onto the cache path; ensures `.duckwright/.gitignore` (D9).
- `class LoginError extends Error` carrying the reason; messages in C3.
- Depends on `PlaywrightCLI`, `Agent` (through the injected `createAgent`), `Brain`/`HybridBrain` construction shared with `runs/run.ts` (the plan may extract a small helper for that), `createTwoFactor`/`Scrubber`.

### `src/pw.ts` (modified)

- `stateSave(path)`: `playwright-cli -s=<session> state-save <path>`, throws `PlaywrightError` on non-zero exit.

### `src/actions.ts` and `src/loop.ts` (modified)

- `execute(...)` takes an optional `fillValues: Record<string, string>`; for `fill` and `type`, every occurrence of each key (`{{username}}`, `{{password}}`) in the text argument is replaced with its value before playwright-cli runs. The action as recorded in the step keeps the placeholder.
- `AgentOptions` gains `fillValues?` and `beforeClose?: (result: RunResult) => Promise<void>`, called in `Agent.run` after a successful loop and before the browser closes (used by the agent login to run the check and `state-save` in the same session). A throw from `beforeClose` propagates.

### `src/runs/run.ts` (modified)

- `RunDeps` gains `auth?: AuthBroker`. In `execute`, after loading the environment: state = explicit `args.state` (source `file`), else, when `env.login` and `deps.auth`, `await deps.auth.ensure(...)` (source `login`), else none. A `LoginError` becomes the run's failure message (`login failed: <env>: <reason>`).
- `historyJson` gains the `state` record (D17).
- D25 password scrubbing.

### `src/cli.ts` (modified)

- `CliDeps` gains `auth: AuthBroker` (default: one new broker per process). Passed into every `startRun` (print, TUI/web manager, explore).
- Print mode: before `runOne` (single) and before the loop in `runBatch`, the up-front login step of D14, printing the C3 lines.

### `src/export.ts` and `src/exportApi.ts` (modified)

- `HistoryData` gains `state?: { path: string; source: "file" | "login" }`; `shapeError` validates it.
- `renderSpec`: `test.use` block (C5), multi-page rendering (D21–D24); removes `// TODO(duckwright)` lines and the "edit the test by hand" warnings.
- `renderApiSpec`: same `test.use` block; header line about `--state` removed.

### Docs and samples

- `README.md`: new "Automatic login" subsection under Environment context (C1 to C3), `--state` row mentions auto-login, export notes rewritten (no "edit by hand" for state or tabs), exit-code table mentions invalid `login:` (2) and failed login (1), roadmap item "Multi-tab and storage state in exports" checked, plus a checked roadmap line for automatic login.
- `examples/environments/staging.md`: starts with a `login:` front matter example (script method, `check-url`/`check-text`), comment moved below it, "Test accounts" no longer says `--state auth.json`.
- `.gitignore`: add `.duckwright/`.

## 4. Contracts

### C1: Environment file `login:` front matter (File)

- **Surface:** `environments/<name>.md` (or any `--env` path), read by `--env`, task-file `env:`, config `env:`, TUI/web environment option.
- **Input:** example:

  ```markdown
  ---
  login:
    method: script
    url: https://staging.example.com/login
    username-env: STAGING_USER
    password-env: STAGING_PASSWORD
    username-selector: "#email"
    password-selector: "#password"
    submit-selector: "button[type=submit]"
    check-url: https://staging.example.com/account
    check-text: Sign out
  ---
  # Staging
  ...
  ```

  | Key | Methods | Required | Value |
  |-----|---------|----------|-------|
  | `method` | both | yes | `script` or `agent` |
  | `username-env`, `password-env` | both | yes | env-var name matching `^[A-Za-z_][A-Za-z0-9_]*$` |
  | `url` | script | yes | absolute `http:` or `https:` URL |
  | `username-selector`, `password-selector`, `submit-selector` | script | yes | non-empty selector or locator string |
  | `task` | agent | yes | non-empty login instructions, one line |
  | `check-url` | both | no, but only together with `check-text` | absolute `http:`/`https:` URL |
  | `check-text` | both | no, but only together with `check-url` | non-empty text |

  For `agent`, the instructions sent to the login agent are `task` followed by this fixed paragraph: `Type {{username}} where the username or email goes and {{password}} where the password goes; Duckwright replaces them with the real values. Never type real credentials. When you are logged in, finish with done success.`
- **Output:** a parsed `LoginConfig`; the environment text given to prompts is the body after the closing `---`.
- **Errors:** each is an `EnvError`; on the command line preflight prints it and exits `2` (in a batch prefixed with the task file, as today); in the TUI/web the task errors (web start returns 409). `PATH` is the resolved file path, `N` the 1-based line number in the file.
  - `environment file invalid: PATH: front matter is not closed with ---`
  - `environment file invalid: PATH:N: expected "key: value"`
  - `environment file invalid: PATH:N: unknown key "KEY" (only login is allowed)`
  - `environment file invalid: PATH:N: bad quoted value`
  - `environment file invalid: PATH:N: login: unknown key "KEY"`
  - `environment file invalid: PATH:N: login: "KEY" is set twice`
  - `environment file invalid: PATH:N: login: "KEY" has no value`
  - `environment file invalid: PATH: login: method is required`
  - `environment file invalid: PATH:N: login: method must be agent or script, got "VALUE"`
  - `environment file invalid: PATH: login: KEY is required for method METHOD`
  - `environment file invalid: PATH:N: login: KEY is not used by method METHOD`
  - `environment file invalid: PATH:N: login: KEY must be an environment variable name (letters, digits and _, not starting with a digit), got "VALUE"`
  - `environment file invalid: PATH:N: login: KEY must be an http or https URL, got "VALUE"`
  - `environment file invalid: PATH: login: check-url and check-text must be set together`
  - Existing messages (not found, too large, not UTF-8, empty body) unchanged.
- **Criteria:** SC3, SC6

### C2: Auth state cache (File)

- **Surface:** `<cwd>/.duckwright/auth/<label>.json`, `<cwd>/.duckwright/.gitignore`.
- **Input:** written only by auto-login; read by every run that uses auto-login.
- **Output:** a Playwright storage-state JSON (whatever `playwright-cli state-save` writes: `cookies`, `origins`), mode `0o600`; folders `0o700`; `.duckwright/.gitignore` = `*\n`, created only if absent. Replaced atomically (write `<label>.json.tmp`, rename).
- **Errors:** a cache that is missing, unreadable, not an object with a `cookies` array, expired (D10 b) or failing the check (D10 c) is silently replaced by a fresh login; the print-mode line says why (C3). A cache folder that cannot be created or written fails the login: reason `cannot write PATH: MESSAGE`.
- **Criteria:** SC4, SC5, SC6

### C3: Automatic login when running (CLI)

- **Surface:** `duckwright -p "<task>" --env ENV`, `duckwright -p -f FILE|FOLDER [--env ENV]` (task-file `env:` counts), `duckwright` TUI, `duckwright --web`, `duckwright explore URL --env ENV`.
- **Who:** applies only when the effective environment has `login:` and the effective state is null (D13).
- **Input:** the environment's `login:` block; the env vars it names; the run's model, max steps, snapshot, skill, headed and Jev settings.
- **Output (print mode, stdout, before the first `[1/N]` line or the single run's output):**
  - Cache usable: `Login: ENV: using saved state PATH`
  - Login needed: `Login: ENV: logging in (METHOD), REASON` where REASON is `no saved state`, `saved state unreadable`, `saved state expired`, or `saved state failed the check`; then on success `Login: ENV: saved state PATH  Cost: $X.XXXX` (cost 4 decimals, `0.0000` for script).
  - `ENV` is the environment label, `PATH` the cache path relative to cwd.
  - Every task then starts with that state loaded (`state-load` before step 1), and its `history.json` has `"state": {"path": PATH, "source": "login"}`.
  - A batch whose tasks share an environment logs in at most once; tasks with different login environments each get one login, in first-seen order.
- **Output (TUI/web/explore):** no extra lines; runs start once the shared login finishes.
- **Errors:**
  - Print mode, login fails → stderr `login failed: ENV: REASON`, exit `1`, no task runs. Interrupted during login → exit `130`.
  - TUI/web/explore → that run ends `fail` with answer `login failed: ENV: REASON`.
  - REASON values:
    - `environment variable NAME is not set`
    - script: `STEP failed: MESSAGE` with STEP one of `open`, `goto`, `fill username`, `fill password`, `click submit`, `state-save`; MESSAGE is playwright-cli's stderr (or stdout), scrubbed
    - agent: `login agent did not finish: ANSWER` (done failure, step limit or repeated failures; ANSWER scrubbed), or `playwright error: MESSAGE`
    - check: `check failed: "TEXT" not found at URL`
    - cache write: `cannot write PATH: MESSAGE`
- **Criteria:** SC4, SC5, SC6

### C4: `history.json` `state` field (File)

- **Surface:** `runs/<id>/history.json`.
- **Output:** `"state": {"path": "<path>", "source": "file" | "login"}` immediately after `env` (or after `task_file` when there is no `env`). Absent when no state was loaded. `path` per D17.
- **Errors:** `duckwright export` on a history whose `state` is present but not an object with a string `path` → `not a duckwright history: FILE: 'state' must be an object with a string 'path'`, exit `2`.
- **Criteria:** SC1, SC6

### C5: Exported UI spec (File)

- **Surface:** `duckwright export RUN [-o FILE]` and the automatic export, writing `duckwright.spec.ts`.
- **Output, state:** when the history has `state`, after the header (and the TOTP helper, and the tab helpers, when present) and a blank line:

  ```ts
  // The run started from the storage state in .duckwright/auth/staging.json (auto-login).
  // Set DUCKWRIGHT_STORAGE_STATE to use another file; in CI, supply one.
  test.use({ storageState: process.env.DUCKWRIGHT_STORAGE_STATE || ".duckwright/auth/staging.json" });
  ```

  For `source: "file"` the first comment line ends with `(--state)` instead of `(auto-login)`. The path in code is `JSON.stringify(state.path)`; in the comment it is the same JSON string without the quotes only if it contains no newline, otherwise the comment omits the path (`The run started from a storage state (...)`). No `COOKIES_NOTE` warning in this case.
- **Output, tabs:** when at least one `tab-*` action has result `ok`:
  - callback signature `async ({ page: firstPage }) => {` and first body line `  let page = firstPage;`
  - `tab-new` → `  page = await page.context().newPage();`, then `  await page.goto(<JSON url>);` when `args[0]` is a non-empty string
  - `tab-select N` → `  page = await selectTab(page, N);`
  - `tab-close` → `  page = await closeTab(page);`; `tab-close N` → `  page = await closeTab(page, N);`
  - helpers emitted after the header when used (plain JavaScript, also valid TypeScript, like the TOTP helper):

  ```js
  async function selectTab(current, index) {
    const page = current.context().pages()[index];
    if (!page) throw new Error(`no tab ${index}`);
    await page.bringToFront();
    return page;
  }
  async function closeTab(current, index) {
    const pages = current.context().pages();
    const i = index === undefined ? pages.indexOf(current) : index;
    const target = pages[i];
    if (!target) throw new Error(`no tab ${index}`);
    await target.close();
    if (target !== current) return current;
    const rest = current.context().pages();
    if (rest.length === 0) throw new Error('closed the last tab');
    const next = rest[Math.min(i, rest.length - 1)];
    await next.bringToFront();
    return next;
  }
  ```

  - No `// TODO(duckwright)` line and no `run used tab-…` warning, ever.
  - A run with no successful tab action and no `state` exports byte-for-byte as before.
- **Errors (exit 1, ExportError):**
  - `tab-select in step N has no valid tab index (expected a whole number, got VALUE)` where VALUE is `JSON.stringify(args[0] ?? null)`
  - `tab-close in step N has no valid tab index (expected a whole number, got VALUE)`
  - All existing export errors unchanged.
- **Criteria:** SC1, SC2, SC6

### C6: Exported API spec (File)

- **Surface:** `duckwright export --api RUN`, writing `duckwright.api.spec.ts`.
- **Output:** header without the line `// For a run that used --state, add test.use(...)`; when the history has `state`, the same `test.use` block as C5 after the header. Everything else unchanged.
- **Errors:** unchanged.
- **Criteria:** SC1

## 5. Data flow

1. **Parse.** `loadEnvironment(value)` reads the file, splits front matter (D1), parses `login:` (D2/D3), returns body text + `LoginConfig | null`. Preflight calls it, so errors exit 2 before anything runs.
2. **Decide.** For each run: explicit `args.state` → state `{path, source: "file"}`, no login. Else if `env.login` → auto-login. Else no state.
3. **Ensure (print mode first, up front; otherwise inside each run).** `AuthBroker.ensure(env, opts)`:
   1. If an in-flight promise exists for the cache path, await it.
   2. `stateProblem(cache)`; if null and (no check, or already checked this process at this mtime, or `checkState` passes) → reuse.
   3. Else read the two env vars (missing → LoginError); create `.duckwright/auth/` and `.duckwright/.gitignore`; run `scriptLogin` or `agentLogin` in session `duckwright-login-<label>`; each ends with check (if configured) then `state-save <cache>.tmp`; rename to `<cache>`; chmod `0o600`; remember path+mtime as checked.
4. **Run.** `startRun` passes the state path to the Agent (`state-load` before step 1, unchanged), adds the password to the run's scrubber (D25), and writes `state` into `history.json` (C4).
5. **Export.** `renderSpec` / `renderApiSpec` read `state` and emit `test.use` (C5/C6); `renderSpec` walks actions, tracking whether any tab action succeeded, emits tab lines and helpers, and switches the signature (D21).

Agent login detail: the login `Agent` gets `fillValues = {"{{username}}": user, "{{password}}": pass}`, a twofa object whose scrubber has both values added, and `beforeClose` = `finishLogin`. `execute` substitutes values in `fill`/`type` text right before calling playwright-cli; recorded code, results and the page folder are scrubbed by the existing twofa scrubber paths.

## 6. Error handling

| Failure | Behavior | Contract |
|---------|----------|----------|
| Invalid front matter / `login:` block | EnvError; preflight exit 2; TUI/web task error (409) | C1 |
| Env var named by `username-env`/`password-env` unset or empty when a login must run | Login fails: `environment variable NAME is not set`; print exit 1 before any task | C3 |
| playwright-cli step fails during script login | `STEP failed: MESSAGE` (scrubbed); session closed | C3 |
| Login agent ends without success | `login agent did not finish: ANSWER` (scrubbed); work folder kept | C3 |
| Check text missing after fresh login | `check failed: "TEXT" not found at URL`; no state saved | C3 |
| Cached state missing/unreadable/expired/fails check | Fresh login; print line names the reason | C2, C3 |
| Cache folder/file cannot be written | `cannot write PATH: MESSAGE` | C2, C3 |
| Ctrl-C during login | Login aborted, browser closed, exit 130 (print) / run `stop` (TUI) | C3 |
| Login fails in TUI/web while other runs wait on it | All waiting runs fail with the same message; the next run retries | C3 |
| `history.json` `state` malformed | Export exit 2 | C4 |
| Successful `tab-select`/`tab-close` with a non-integer index | Export exit 1 | C5 |
| Explicit `--state FILE` missing | Unchanged: preflight `state file not found: FILE`, exit 2 | (existing) |

## 7. Testing

Check command: `npm test` (typecheck plus `node --test` over `test/**/*.test.ts`). All tests use fake runners and fake agents; none drive a real browser or site. The existing `test/e2e.test.ts` is not part of this change's verification.

Unit and integration tests to add or update:

- `test/environment.test.ts`: no front matter → unchanged result and `login: null`; valid script and agent blocks parse to the exact `LoginConfig`; body excludes front matter; every C1 error message with its line number; `check-url` without `check-text`; front matter does not count as body (empty body still errors).
- `test/auth.test.ts` (new): `stateProblem` for missing, bad JSON, no `cookies`, expired cookie, session cookie (`-1`) usable, 60 s margin; `cachePath` label sanitising; `.gitignore` created once and not overwritten; file mode `0o600`; script login issues the exact playwright-cli argv sequence of D8 (fake runner) and the password appears only in the `fill` argv, never in errors (stderr echoing it is scrubbed); check pass/fail; broker: two concurrent `ensure` calls → one login; second call reuses without re-running the check (D11); expired cache → new login; failed login not memoized; missing env var reason.
- `test/actions.test.ts`: `fillValues` substitution in `fill` and `type` only, not in other commands; the recorded action keeps the placeholder.
- `test/loop.test.ts`: `beforeClose` runs after success before `close`, not after failure.
- `test/pw.test.ts`: `stateSave` argv and error.
- `test/runs/*` / `test/cli.test.ts`: `history.json` `state` for `--state` (source `file`) and auto-login (source `login`); explicit `--state` with a `login:` env never calls the broker; print-mode batch of 3 tasks with one login env → exactly one login and every agent receives the same `state` path; C3 stdout lines; login failure → stderr line, exit 1, no agent created; password value absent from `history.json`, debug log and prompts given to the fake brain.
- `test/export.test.ts`: `test.use` block for `file` and `login` sources (exact text); no `COOKIES_NOTE` with state; multi-tab rendering for `tab-new` with and without URL, `tab-select`, `tab-close` with and without index (exact lines and helpers, only the helpers used); no TODO line and no tab warning; byte-identical output for a run without tabs or state; bad index errors; malformed `state` error. A test that runs the generated tab helpers against a fake context object (as the TOTP helper is run today) to prove `closeTab`/`selectTab` pick the right page.
- `test/exportApi.test.ts`: header without the `--state` line; `test.use` block when state present.

| Criterion | Contracts | Proved by |
|-----------|-----------|-----------|
| SC1 | C4, C5, C6 | `npm test` (export and exportApi tests); QA scenarios exporting `--state` and auto-login histories |
| SC2 | C5 | `npm test` (export tests, helper execution test); QA scenarios exporting tab histories |
| SC3 | C1 | `npm test` (environment tests, cli preflight exit 2); QA scenarios with valid and invalid env files |
| SC4 | C2, C3 | `npm test` (broker concurrency test, cli batch test); QA scenario: batch with a fake login env |
| SC5 | C2, C3 | `npm test` (stateProblem, check, explicit `--state` bypass); QA scenarios for cached/expired/explicit |
| SC6 | C1, C3, C4, C5 | `npm test` (scrubbing and absence assertions); review of every new write path |

### Manual e2e

For the user, not part of the run: point an environment's `login:` block at a real staging site (once with `script`, once with `agent`), run a batch, check one login line, then run `npx playwright test` on an exported spec from the project root with and without `DUCKWRIGHT_STORAGE_STATE`, and on a spec that used `tab-new`/`tab-select`/`tab-close`.

## 8. Out of scope

- A separate `duckwright login` command, and flags to force or skip login.
- Performing the login inside the exported spec (CI supplies the state file, optionally via `DUCKWRIGHT_STORAGE_STATE`).
- 2FA changes beyond what the existing `twofa` action already does during an agent login.
- Multiple accounts per environment (one login per environment).
- TUI/web layout changes (no login progress view; no login cost display).
- E2E runs against real sites.
- Sharing one login across separate Duckwright processes beyond what the cache file gives (no locking between processes).
- Waiting heuristics for the script method beyond the optional check (without `check-url`, the state is saved right after the submit click returns).
- Translating popup-specific behavior (a tab opened by a click) beyond indexing it through `context().pages()`.
