# Multi-tab and storage state in exports, with automatic login QA Test Plan

**Goal:** Exports stop needing hand edits for `--state` runs and `tab-*` actions, and Duckwright logs in on its own from an environment file, so a run, batch or plan shares one saved auth state.
**Spec:** docs/superpowers/specs/2026-10-10-multi-tab-state-auth-exports-design.md
**Scope:** Black-box CLI/file scenarios against the spec's Contracts (C1 to C6). Unit and integration tests are covered by the implementation and are not repeated here.

## Environment
- Start: `cd <worktree> && npm install && npm run build`, then use `node dist/bin.js` (called `duckwright` below; or `npx duckwright` after `npm link`). `playwright-cli` and the `claude` CLI must be installed and logged in for scenarios that run a real task (TS-13 to TS-22).
- Local login site (for login scenarios): QA writes a small server `<scratch>/login-site.mjs` (any equivalent works) and starts it with `node <scratch>/login-site.mjs` serving `http://localhost:4100`. It must behave exactly as follows:
  - `GET /login`: HTML form with `#email`, `#password` and `button[type=submit]`.
  - `POST /login`: with `qa@example.com` / `S3cret-QA-pw` it sets a session cookie (session id kept in the server's memory only) and redirects to `/account`. With any other credentials it answers 200 on `/login` (the browser stays at `http://localhost:4100/login`) with an error page that echoes the submitted password value back in the text (for example `Wrong password: <value>`).
  - `GET /account`: shows `Sign out` when the cookie holds a live session, otherwise `Please log in`.
  - `GET /hang`: accepts the request and never answers (used by TS-36).
  - Request log: every request is printed to the server's stdout as `<METHOD> <PATH>` (for example `POST /login`), one per line; QA redirects it to `<work>/site.log`.
  - Sessions live in memory, so restarting the server invalidates every earlier cookie (used by TS-22).
- Failure shims (used by TS-14, TS-33 and TS-34): `<scratch>/shim/playwright-cli` is a shell script placed first on `PATH`. It skips the leading `-s=<session>` argument, and when the sub-command equals `$FAIL_CMD` and this is the `$FAIL_NTH`-th call (default 1) of that sub-command since the shim's counter file `$SHIM_COUNT` was emptied, it prints `boom: <its full argv>` to stderr and exits 1; otherwise it runs the real `playwright-cli` with the same argv. `<scratch>/shim/claude` is a script that appends its full argv and stdin to `$CLAUDE_LOG`, then runs the real `claude` with the same argv and stdin.
- Accounts / auth: `export QA_USER=qa@example.com; export QA_PASS='S3cret-QA-pw'`.
- BASE (baseline for byte-identical checks, TS-12 and TS-32): `git -C <worktree> worktree add <scratch>/base main && cd <scratch>/base && npm install && npm run build`; `duckwright-base` below is `node <scratch>/base/dist/bin.js`. The branch worktree is never switched.
- Reset: run each scenario in a fresh empty directory `<work>` (`rm -rf <work> && mkdir <work> && cd <work>`), which removes `runs/`, `.duckwright/` and `environments/`.

## Test data
- **ENV-SCRIPT** `environments/local.md`:
  ```
  ---
  login:
    method: script
    url: http://localhost:4100/login
    username-env: QA_USER
    password-env: QA_PASS
    username-selector: "#email"
    password-selector: "#password"
    submit-selector: "button[type=submit]"
    check-url: http://localhost:4100/account
    check-text: Sign out
  ---
  # Local
  A small test site on port 4100.
  ```
- **ENV-AGENT** `environments/agentlocal.md`, in this line order: 1 `---`, 2 `login:`, 3 `  method: agent`, 4 `  task: Open http://localhost:4100/login and sign in`, 5 `  username-env: QA_USER`, 6 `  password-env: QA_PASS`, 7 `  check-url: http://localhost:4100/account`, 8 `  check-text: Sign out`, 9 `---`; body `# AgentLocal` and one text line.
- **ENV-PLAIN** `environments/plain.md`: `# Plain` and one body line, no front matter.
- **TASKS** folder `tasks/` with `a.md`, `b.md`, `c.md`, each a one-line task such as `Open http://localhost:4100/account and confirm the page says Sign out`, each with `env: environments/local.md`.
- **HIST-STATE-FILE**: a `runs/<id>/` of a successful run made with `--state auth.json` and `--env` omitted (copy a real one, or edit a real `history.json`), so its `history.json` has `"state": {"path": "auth.json", "source": "file"}` after `env`/`task_file`.
- **HIST-STATE-LOGIN**: `history.json` with `"state": {"path": ".duckwright/auth/local.json", "source": "login"}`.
- **HIST-TABS**: a successful history whose recorded actions, in order, are: `goto` (ok), `tab-new` with `args ["http://localhost:4100/account"]` (ok), `click` (ok), `tab-select` `args [0]` (ok), `fill` (ok), `tab-new` with no args (ok), `tab-close` with no args (ok), `tab-close` `args [0]` (ok).
- **HIST-PLAIN**: a successful history with neither `state` nor tab actions (an older run).
- **HIST-API**: a successful history with network capture, at least one captured `fetch`/`xhr` call, plus `state` as in HIST-STATE-FILE.
- Variants of HIST-TABS named where used.

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C4, C5, C6 | TS-1, TS-2, TS-3, TS-4, TS-5, TS-6, TS-23 |
| SC2 | C5 | TS-7, TS-8, TS-9, TS-10, TS-11, TS-12 |
| SC3 | C1 | TS-13, TS-14, TS-15, TS-16, TS-17 |
| SC4 | C2, C3 | TS-18, TS-19, TS-20, TS-26, TS-27, TS-33, TS-34, TS-35, TS-36, TS-37, TS-38 |
| SC5 | C2, C3 | TS-21, TS-22, TS-24, TS-25, TS-39, TS-40 |
| SC6 | C1, C3, C4, C5 | TS-24, TS-26, TS-27, TS-28, TS-33 |

## Scenarios

### TS-1: Export of a manual `--state` run has `test.use`
**Contract:** C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** HIST-STATE-FILE.
**Steps:**
1. `duckwright export runs/<id>`
2. Read `runs/<id>/duckwright.spec.ts`.
**Expected:**
- Exit code `0`.
- After the header and a blank line the spec contains exactly:
  ```
  // The run started from the storage state in auth.json (--state).
  // Set DUCKWRIGHT_STORAGE_STATE to use another file; in CI, supply one.
  test.use({ storageState: process.env.DUCKWRIGHT_STORAGE_STATE || "auth.json" });
  ```
- No `// TODO(duckwright)` line; no warning about editing by hand or about cookies on stderr.

### TS-2: Export of an auto-login run has `test.use` with `(auto-login)`
**Contract:** C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** HIST-STATE-LOGIN.
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- Exit `0`; spec contains
  ```
  // The run started from the storage state in .duckwright/auth/local.json (auto-login).
  // Set DUCKWRIGHT_STORAGE_STATE to use another file; in CI, supply one.
  test.use({ storageState: process.env.DUCKWRIGHT_STORAGE_STATE || ".duckwright/auth/local.json" });
  ```

### TS-3: `test.use` placement with TOTP and tab helpers
**Contract:** C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3
**Preconditions:** HIST-TABS edited to add `"state": {"path": "auth.json", "source": "file"}` and one `twofa` action with result `ok` and `args` `["#code"]` (the way history records a TOTP step; the export then emits the TOTP helper).
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- The TOTP helper and the `selectTab`/`closeTab` helpers appear before the `test.use` comment block, and the `test.use` block appears before the first `test(`.

### TS-4: Export of an API spec from a state run
**Contract:** C6 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** HIST-API.
**Steps:**
1. `duckwright export --api runs/<id>`
**Expected:**
- Exit `0`; `runs/<id>/duckwright.api.spec.ts` contains the same three-line `test.use` block as TS-1 after the header.
- The file does not contain `// For a run that used --state, add test.use(...)`.

### TS-5: API spec without state has no `test.use` and no `--state` line
**Contract:** C6 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2
**Preconditions:** HIST-API with the `state` field removed.
**Steps:**
1. `duckwright export --api runs/<id>`
**Expected:**
- Exit `0`; no `test.use` and no `--state` line in the file.

### TS-6: Spec path with a newline is commented safely
**Contract:** C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3
**Preconditions:** HIST-STATE-FILE with `state.path` set to `"a\nb.json"` (JSON escape).
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- The first comment line reads `// The run started from a storage state (--state).` (path omitted from the comment), and the code line contains `"a\nb.json"` as a JSON string; the spec is a single valid statement (no line break inside a comment).

### TS-7: Tab export signature and `tab-new` lines
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1
**Preconditions:** HIST-TABS.
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- Exit `0`. The callback is `async ({ page: firstPage }) => {` and its first body line is `  let page = firstPage;`.
- The first `tab-new` renders `  page = await page.context().newPage();` followed by `  await page.goto("http://localhost:4100/account");`.
- The second `tab-new` (no URL) renders only `  page = await page.context().newPage();` with no `goto` after it.

### TS-8: `tab-select` and `tab-close` lines and helpers
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1
**Preconditions:** HIST-TABS.
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- Lines `  page = await selectTab(page, 0);`, `  page = await closeTab(page);` and `  page = await closeTab(page, 0);` appear in that order relative to their steps.
- The spec defines `selectTab` and `closeTab` exactly as in C5 (bodies character for character), once each.
- No `// TODO(duckwright)` line and no warning containing `run used tab-` in the file or on stderr.

### TS-9: Only used helpers are emitted
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2
**Preconditions:** HIST-TABS reduced to `goto`, `tab-new`, `tab-select` `[0]` (no `tab-close`).
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- `selectTab` is defined; `closeTab` is not defined anywhere in the file.

### TS-10: Exported tab spec is valid and helpers are byte-exact
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P3
**Preconditions:** the exported spec from TS-8, copied into a scratch Playwright project where `@playwright/test` is installed (if it is not, run step 2 only).
**Steps:**
1. `npx playwright test --list duckwright.spec.ts` in the scratch project (lists tests without running them or opening a browser).
2. Compare the `selectTab` and `closeTab` definitions in the spec with the C5 text.
**Expected:**
- 1: exit `0`; the output lists the spec's test (the file parses as TypeScript).
- 2: both definitions are identical to the C5 text, character for character.
- Running the exported spec against a browser is the user's manual e2e and is not part of this plan.

### TS-11: Bad tab index in history fails the export
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2
**Preconditions:** HIST-TABS where the successful `tab-select` has `args ["x"]`, in step 4.
**Steps:**
1. `duckwright export runs/<id>`
**Expected:**
- Exit `1`; stderr contains `tab-select in step 4 has no valid tab index (expected a whole number, got "x")`.
- Variant A: the `tab-select` has no `args`: message ends `got null`.
- Variant B: a `tab-close` with `args [1.5]` in step 8: stderr contains `tab-close in step 8 has no valid tab index (expected a whole number, got 1.5)`.

### TS-12: Failed tab actions are skipped; runs without tab or state export unchanged
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2
**Preconditions:** (a) HIST-TABS with every `tab-*` result set to a failure; (b) HIST-PLAIN.
**Steps:**
1. Export (a).
2. Export (b), and export the same history with `duckwright-base` (Environment: BASE) and compare the two files with `cmp`.
**Expected:**
- (a) exit `0`; callback is the old `async ({ page }) => {` form, no `let page = firstPage;`, no helpers, no tab lines.
- (b) the two files are byte-identical.

### TS-13: Valid script `login:` block is accepted
**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** ENV-SCRIPT; login site running; `QA_USER`/`QA_PASS` set; no `.duckwright/`.
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --env environments/local.md --debug`
2. Read `runs/<id>/debug.log`.
**Expected:**
- Preflight passes (no `environment file invalid` message; exit is not `2`). The prompt text in `runs/<id>/debug.log` contains `# Local` and `A small test site on port 4100.` and does not contain `login:`, `username-env` or `---`.

### TS-14: Valid agent `login:` block is accepted and the login agent gets the fixed paragraph
**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** ENV-AGENT; login site running; `QA_USER`/`QA_PASS` set; no `.duckwright/`; the `claude` shim from Environment first on `PATH` with `CLAUDE_LOG=<work>/claude.log`.
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --env environments/agentlocal.md`
2. Read `<work>/claude.log`.
**Expected:**
- No `environment file invalid` message; exit is not `2`.
- `claude.log` contains the login agent's prompt: the text `Open http://localhost:4100/login and sign in` followed by `Type {{username}} where the username or email goes and {{password}} where the password goes; Duckwright replaces them with the real values. Never type real credentials. When you are logged in, finish with done success.`
- `claude.log` contains neither `S3cret-QA-pw` nor `username-env`.
- The login agent writes no `debug.log`, `history.json` or spec (only one `runs/<id>/` exists, the task's own run).

### TS-15: Each C1 error exits 2 with the exact message
**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-SCRIPT as base. One broken copy per row, saved as `environments/bad.md`; PATH below is the path as resolved for `--env`.
**Steps:** for each row run `duckwright -p "x" --env environments/bad.md`; expected stderr is the message and exit `2`, no run folder created.
| Edit to ENV-SCRIPT | Expected message |
| --- | --- |
| delete the closing `---` | `environment file invalid: PATH: front matter is not closed with ---` |
| line 3 becomes `just text` | `environment file invalid: PATH:3: expected "key: value"` |
| add `other: 1` as a new line 12 (before the closing `---`) | `environment file invalid: PATH:12: unknown key "other" (only login is allowed)` |
| line 3 `method: "script` | `environment file invalid: PATH:3: bad quoted value` |
| add indented `  colour: red` as a new line 12 | `environment file invalid: PATH:12: login: unknown key "colour"` |
| add a second indented `  url: http://localhost:4100/login` as a new line 12 | `environment file invalid: PATH:12: login: "url" is set twice` |
| line 4 becomes `url:` | `environment file invalid: PATH:4: login: "url" has no value` |
| delete the `method` line | `environment file invalid: PATH: login: method is required` |
| `method: ldap` (line 3) | `environment file invalid: PATH:3: login: method must be agent or script, got "ldap"` |
| delete `submit-selector` line | `environment file invalid: PATH: login: submit-selector is required for method script` |
| ENV-AGENT with an indented `  url: http://localhost:4100/login` inserted as new line 7 | `environment file invalid: PATH:7: login: url is not used by method agent` |
| `username-env: 1BAD` (line 5) | `environment file invalid: PATH:5: login: username-env must be an environment variable name (letters, digits and _, not starting with a digit), got "1BAD"` |
| `url: ftp://x/login` (line 4) | `environment file invalid: PATH:4: login: url must be an http or https URL, got "ftp://x/login"` |
| delete `check-text` line | `environment file invalid: PATH: login: check-url and check-text must be set together` |
(Line numbers follow ENV-SCRIPT: 1 `---`, 2 `login:`, 3 `method`, 4 `url`, 5 `username-env`, 6 `password-env`, 7 `username-selector`, 8 `password-selector`, 9 `submit-selector`, 10 `check-url`, 11 `check-text`, 12 closing `---`. "Delete the closing `---`" removes line 12. N is the 1-based line of the offending line.)

### TS-16: Invalid env file inside a batch and the TUI/web
**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2
**Preconditions:** TASKS where `b.md` has `env: environments/bad.md` with the `method: ldap` fault.
**Steps:**
1. `duckwright -p -f tasks`.
2. `duckwright --web`, then start a task with that environment from the web page (or `POST` as the page does).
**Expected:**
- 1: exit `2`, stderr line is prefixed with the task file (`tasks/b.md`) and contains the TS-15 message; no task runs.
- 2: the start request returns HTTP `409` with the same message.

### TS-17: Front matter edge cases
**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P3
**Preconditions:** (a) ENV-PLAIN with a body that starts with `---` on line 2 (not line 1); (b) ENV-SCRIPT with a trailing space after both `---`; (c) ENV-SCRIPT with the body deleted; (d) ENV-SCRIPT padded with body text to exactly 16384 bytes in total; (e) the same padded to 16385 bytes.
**Steps:**
1. Run `duckwright -p "x" --env <file>` for each.
**Expected:**
- (a) no front matter parsing; behaves as today (no error). (b) accepted. (c) exit `2`, stderr `environment file is empty: ` followed by the file path. (d) accepted, no error. (e) exit `2`, stderr `environment file too large: ` + the file path + ` is 16385 bytes (limit 16384)`.

### TS-18: Batch with one login env logs in once
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1
**Preconditions:** ENV-SCRIPT, TASKS, login site running, `QA_USER`/`QA_PASS` set, no `.duckwright/`.
**Steps:**
1. `duckwright -p -f tasks`
2. Inspect login-site request log; read each `runs/*/history.json`.
**Expected:**
- stdout, before the first `[1/3]` line: `Login: local: logging in (script), no saved state` then `Login: local: saved state .duckwright/auth/local.json  Cost: $0.0000`.
- The site log shows exactly one `POST /login`.
- All three `history.json` contain `"state": {"path": ".duckwright/auth/local.json", "source": "login"}` right after `env`/`task_file`.
- `.duckwright/auth/local.json` exists.

### TS-19: Single run, agent method
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-AGENT, login site, no `.duckwright/`.
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account and confirm it says Sign out" --env environments/agentlocal.md`
**Expected:**
- stdout shows `Login: agentlocal: logging in (agent), no saved state` and then `Login: agentlocal: saved state .duckwright/auth/agentlocal.json  Cost: $` followed by four decimals (non-zero).
- The run passes; the login agent wrote no `history.json`/`duckwright.spec.ts` of its own (only one `runs/<id>/`).
- `.duckwright/auth/agentlocal.login/` does not exist after success.

### TS-20: Different login environments log in once each
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P3
**Preconditions:** two task files, one with `env: environments/local.md`, one with `env: environments/agentlocal.md`.
**Steps:**
1. `duckwright -p -f tasks`
**Expected:**
- Two `Login:` sequences in first-seen order (local, then agentlocal), both before the `[1/2]` line; each task's `history.json` points to its own state path.

### TS-21: Cached state is reused; expired state is replaced
**Contract:** C2, C3 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1
**Preconditions:** TS-18 already ran in `<work>` (valid cache).
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --env environments/local.md` (no `QA_USER`/`QA_PASS` exported: `unset QA_USER QA_PASS`).
2. Edit `.duckwright/auth/local.json`: set every cookie's `expires` to `1`. Re-export the variables. Repeat the command.
3. Replace the file content with `{"foo":1}`. Repeat.
4. Delete the file's contents (empty file). Repeat.
**Expected:**
- 1: stdout `Login: local: using saved state .duckwright/auth/local.json`; no login request on the site; exit `0`.
- 2: `Login: local: logging in (script), saved state expired`, then `Login: local: saved state .duckwright/auth/local.json  Cost: $0.0000`; cookie expiries in the file are fresh.
- 3 and 4: `Login: local: logging in (script), saved state unreadable`.

### TS-22: Check failure replaces the cache
**Contract:** C2, C3 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** valid cache; the site's session invalidated server-side (restart the login site so old cookies are rejected and `/account` shows `Please log in`).
**Steps:**
1. Run the TS-21 step 1 command with the variables exported.
**Expected:**
- `Login: local: logging in (script), saved state failed the check` then the saved-state line; the run passes.

### TS-23: Explicit `--state` bypasses login
**Contract:** C3, C4 · **Criteria:** SC1, SC5 · **Type:** CLI · **Priority:** P1
**Preconditions:** ENV-SCRIPT; a valid `auth.json` in `<work>`; `QA_USER`/`QA_PASS` unset; no `.duckwright/`.
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --env environments/local.md --state auth.json`
2. Repeat with the task-file form: task file with `state: auth.json` and `env: environments/local.md`.
**Expected:**
- No `Login:` line; no `.duckwright/` folder created; no request to `/login`; exit `0`.
- `history.json` has `"state": {"path": "auth.json", "source": "file"}`.
- With a missing file (`--state nope.json`): preflight `state file not found: nope.json`, exit `2` (unchanged).

### TS-24: Auto-login folder, permissions and git-ignore
**Contract:** C2 · **Criteria:** SC5, SC6 · **Type:** File · **Priority:** P2
**Preconditions:** TS-18 done in a `git init` directory.
**Steps:**
1. `stat -c '%a %n' .duckwright .duckwright/auth .duckwright/auth/local.json`
2. `cat .duckwright/.gitignore`; `git status --short`.
3. Change `.duckwright/.gitignore` to contain `custom`, expire the cache (TS-21 step 2) and rerun.
**Expected:**
- 1: `700`, `700`, `600`. No `local.json.tmp` file remains.
- 2: content `*` followed by a newline; `git status` does not list `.duckwright`.
- 3: the `.gitignore` still contains `custom` (not overwritten).

### TS-25: Cache folder not writable
**Contract:** C2, C3 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P3
**Preconditions:** `<work>/.duckwright` is a regular file (`touch .duckwright`), no cached state.
**Steps:**
1. Export `QA_USER=qa@example.com` and `QA_PASS='S3cret-QA-pw'` (both set), then run the TS-13 command step 1 (with `--debug`; login site running).
**Expected:**
- Exit `1`; stderr `login failed: local: cannot write ` followed by the path and a message. No task runs.

### TS-26: Login failure reasons in print mode
**Contract:** C3 · **Criteria:** SC4, SC6 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-SCRIPT, no cache.
**Steps:**
1. `unset QA_PASS`; run the TS-13 command.
2. Export `QA_PASS=wrong`; run again.
3. Edit `submit-selector` to `#nope`; export the right password; run again.
4. Edit `check-text` to `Welcome back`; restore selector; run again.
5. Run a batch (`-f tasks`) with the failing setup of step 2.
**Expected:**
- 1: stderr `login failed: local: environment variable QA_PASS is not set`, exit `1`.
- 2: after submit the site stays on `/login`; with the check present stderr is `login failed: local: check failed: "Sign out" not found at http://localhost:4100/account`, exit `1`.
- 3: stderr starts `login failed: local: click submit failed: `; the message does not contain `S3cret-QA-pw`.
- 4: stderr `login failed: local: check failed: "Welcome back" not found at http://localhost:4100/account`.
- Each case: no `runs/` folder, no `.duckwright/auth/local.json`, no batch summary in step 5, and no stray browser session left (`playwright-cli list` shows none named `duckwright-login-*`).

### TS-27: Login failure in the web UI and agent failure
**Contract:** C3 · **Criteria:** SC4 · **Type:** UI · **Priority:** P3
**Preconditions:** ENV-SCRIPT with `QA_PASS` unset; `duckwright --web`.
**Steps:**
1. In the web UI start two tasks with environment `local`.
2. Export `QA_PASS` correctly (restart the server), start a task again.
3. CLI: ENV-AGENT with a login task `Say done failure immediately`, run `-p`.
**Expected:**
- 1: both runs end `fail` with answer `login failed: local: environment variable QA_PASS is not set`, each with a `history.json` with zero steps.
- 2: the new run logs in and passes (a failed login is not memoized).
- 3: stderr `login failed: agentlocal: login agent did not finish: ` followed by the agent's answer, exit `1`; `.duckwright/auth/agentlocal.login/` is kept.

### TS-28: No credential values anywhere (script and agent)
**Contract:** C1, C3, C4, C5 · **Criteria:** SC6 · **Type:** File · **Priority:** P1
**Preconditions:** run TS-18 and TS-19 with `--debug` and `--screenshot`, then export every run.
**Steps:**
1. `grep -r "S3cret-QA-pw" . ` over `<work>` (excluding nothing), including `runs/`, `.duckwright/`, exported specs and captured stdout/stderr of the runs.
2. `grep -rl "{{password}}" runs .duckwright`.
3. Re-run with a deliberately wrong password `LEAK-ME-123` where the site echoes the submitted value in an error page, then grep for `LEAK-ME-123`.
**Expected:**
- 1: the password appears in no file under `runs/`, in no spec, in no `debug.log`, in no stdout/stderr, and not in `history.json`; the username may appear in pages.
- 2: placeholders may appear in the agent login's work folder only; where text of the password would be, `[REDACTED]` appears.
- 3: `LEAK-ME-123` does not appear in `.duckwright/auth/*.login/` or in the stderr message.
- The state file `.duckwright/auth/local.json` itself holds cookies (expected, mode `600`).

### TS-33: Every script-login step failure names its step
**Contract:** C3 · **Criteria:** SC4, SC6 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-SCRIPT; login site running; `QA_USER`/`QA_PASS` set; no `.duckwright/`; the `playwright-cli` shim first on `PATH`, `SHIM_COUNT` emptied before each case.
**Steps:** for each row set the variables, run `duckwright -p "x" --env environments/local.md`.
| `FAIL_CMD` / `FAIL_NTH` | Expected stderr starts with |
| --- | --- |
| `open` / 1 | `login failed: local: open failed: boom` |
| `goto` / 1 | `login failed: local: goto failed: boom` |
| `fill` / 1 | `login failed: local: fill username failed: boom` |
| `fill` / 2 | `login failed: local: fill password failed: boom` |
| `state-save` / 1 | `login failed: local: state-save failed: boom` |
**Expected:**
- Each row: exit `1`; no task runs (no `runs/`); no `[1/` line; no batch summary.
- Row `fill` / 2: the message does not contain `S3cret-QA-pw` (the shim echoes its argv, so the password value appears as `[REDACTED]`).
- Row `state-save`: neither `.duckwright/auth/local.json` nor `.duckwright/auth/local.json.tmp` exists.
- Each row: `playwright-cli list` shows no session named `duckwright-login-*` afterwards (the session is always closed).

### TS-34: Agent login failures
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-AGENT; login site running; `QA_USER`/`QA_PASS` set; no `.duckwright/`; the `playwright-cli` shim first on `PATH`.
**Steps:**
1. `FAIL_CMD=state-save FAIL_NTH=1`; run `duckwright -p "x" --env environments/agentlocal.md`.
2. Unset the shim variables; set `QA_PASS=wrong`; run the same command again.
**Expected:**
- 1: exit `1`; stderr starts `login failed: agentlocal: playwright error: ` and contains `boom`; no task runs; no `.duckwright/auth/agentlocal.json`.
- 2: the check at `http://localhost:4100/account` finds no `Sign out`; exit `1`; stderr starts `login failed: agentlocal: ` (either `check failed: "Sign out" not found at http://localhost:4100/account` or `login agent did not finish: `); it contains neither `wrong` nor `S3cret-QA-pw`; `.duckwright/auth/agentlocal.login/` is kept.

### TS-35: Script login with an unreachable login URL
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-SCRIPT with `url:` changed to `http://localhost:4199/login` (nothing listens on 4199); no `.duckwright/`; `QA_USER`/`QA_PASS` set.
**Steps:**
1. `duckwright -p "x" --env environments/local.md`
**Expected:**
- Exit `1`; stderr starts `login failed: local: goto failed: `; no `runs/` folder; no `.duckwright/auth/local.json`.

### TS-36: Interrupt during login exits 130
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-SCRIPT with `url:` changed to `http://localhost:4100/hang`; login site running; `QA_USER`/`QA_PASS` set; no `.duckwright/`.
**Steps:**
1. Start `duckwright -p "x" --env environments/local.md` in the background with stdout to a file.
2. When the file contains `Login: local: logging in (script), no saved state`, send `SIGINT` to the process.
3. Wait for exit; run `playwright-cli list`.
**Expected:**
- Exit code `130`; no `runs/` folder; no `.duckwright/auth/local.json`; `playwright-cli list` shows no session named `duckwright-login-*`; no `Login: local: saved state` line.

### TS-37: Explore uses the shared login
**Contract:** C3 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P3
**Preconditions:** ENV-SCRIPT; login site running; no `.duckwright/`.
**Steps:**
1. With `QA_PASS` unset: `duckwright explore http://localhost:4100/account --env environments/local.md`.
2. Export `QA_USER`/`QA_PASS`; run the same command again.
**Expected:**
- 1: no `Login:` line is printed; the output reports the run as failed with `login failed: local: environment variable QA_PASS is not set`; no browser step ran.
- 2: no `Login:` line is printed; `site.log` has exactly one `POST /login`; `.duckwright/auth/local.json` exists; the explore run does not fail with a login message.

### TS-38: TUI uses the shared login
**Contract:** C3 · **Criteria:** SC4 · **Type:** UI · **Priority:** P3
**Preconditions:** ENV-SCRIPT; login site running; no `.duckwright/`.
**Steps:**
1. With `QA_PASS` unset, run `duckwright` (TUI), choose environment `local`, enter the task `Open http://localhost:4100/account` and start it.
2. Quit; export `QA_USER`/`QA_PASS`; run `duckwright` again, choose `local`, start the same task twice in a row.
**Expected:**
- 1: no `Login:` line; the run ends `fail` with the answer `login failed: local: environment variable QA_PASS is not set`; its `history.json` has zero steps.
- 2: `site.log` has exactly one `POST /login`; both runs have `"state": {"path": ".duckwright/auth/local.json", "source": "login"}` in `history.json`.

### TS-39: State from the global config also bypasses login
**Contract:** C3 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-SCRIPT; a valid `auth.json` in `<work>`; `QA_USER`/`QA_PASS` unset; no `.duckwright/`; `XDG_CONFIG_HOME=<work>/xdg` with `<work>/xdg/duckwright/duckwright.conf` containing the single line `state: auth.json` (resolved from the config's folder: place `auth.json` in `<work>/xdg/duckwright/`).
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --env environments/local.md`
**Expected:**
- No `Login:` line; no `.duckwright/` folder; no `POST /login` in `site.log`; exit `0`.
- `history.json` has `"state"` with `"source": "file"` and the `path` of the config's `auth.json`.

### TS-40: Cookie expiry margin of 60 seconds
**Contract:** C2 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** TS-18 already ran in `<work>` (valid cache); login site running; `QA_USER`/`QA_PASS` set.
**Steps:**
1. Edit `.duckwright/auth/local.json`: set every cookie's `expires` to now + 30 seconds (epoch seconds). Run the TS-21 step 1 command immediately.
2. Edit it again: set every cookie's `expires` to now + 600 seconds. Run the same command.
3. Edit it again: set one cookie's `expires` to `-1` (session cookie). Run the same command.
**Expected:**
- 1: `Login: local: logging in (script), saved state expired` (30 s is inside the 60 s margin).
- 2: `Login: local: using saved state .duckwright/auth/local.json`.
- 3: `Login: local: using saved state .duckwright/auth/local.json`.
- The exact boundary (`expires` = now + 60 s) cannot be hit reliably by hand and is left to the unit tests.

## Regression

### TS-29: Environment without `login:` behaves as before
**Contract:** C1, C3 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2
**Preconditions:** ENV-PLAIN.
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --env environments/plain.md`
**Expected:**
- No `Login:` line, no `.duckwright/` folder, `history.json` has `env` and no `state` key; run behaves as before the change.

### TS-30: Malformed `state` in history
**Contract:** C4 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2
**Preconditions:** HIST-STATE-FILE with `"state": "auth.json"`; then with `"state": {"source": "file"}`.
**Steps:**
1. `duckwright export runs/<id>` for each.
**Expected:**
- Exit `2`; stderr `not a duckwright history: ` + the history file path + `: 'state' must be an object with a string 'path'`.

### TS-31: Run folder `state` field position and absolute path
**Contract:** C4 · **Criteria:** SC1 · **Type:** File · **Priority:** P3
**Preconditions:** a state file outside the working directory, e.g. `/tmp/qa-auth.json`.
**Steps:**
1. `duckwright -p "Open http://localhost:4100/account" --state /tmp/qa-auth.json`
**Expected:**
- `history.json` `state.path` is `/tmp/qa-auth.json` (absolute) with `source` `file`; inside the working directory the path is relative with `/` separators.

### TS-32: Unrelated exports and README
**Contract:** C5, C6 · **Criteria:** SC1, SC2 · **Type:** File · **Priority:** P3
**Preconditions:** the built branch.
**Steps:**
1. Export a history with `expect`, `request` and `twofa` steps and no state or tabs.
2. Read `README.md`, `examples/environments/staging.md`, `.gitignore`.
**Expected:**
- 1: output byte-identical (`cmp`) to what `duckwright-base export` writes for a copy of the same history.
- 2: README no longer says to edit state or tab exports by hand, and no longer mentions `// TODO(duckwright)`; roadmap item "Multi-tab and storage state in exports" is `[x]` and a checked automatic-login line exists; the sample starts with a `login:` block using `method: script` with `check-url`/`check-text`; `.gitignore` contains `.duckwright/`.

## Out of scope
- Unit and integration tests (run as checks during implementation)
- A separate `duckwright login` command, flags to force or skip login
- Performing the login inside the exported spec
- 2FA changes beyond the existing `twofa` action
- Multiple accounts per environment
- TUI/web layout changes, login progress or cost display
- E2E runs against real sites, and locking between separate Duckwright processes
