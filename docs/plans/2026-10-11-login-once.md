# Login once, reuse everywhere

Status: proposal (arena synthesis). Scope: log in to a site once, 2FA included, and share that login
across every task, parallel slot, plan scenario and process until it expires.

## Problem

- `--state FILE` already loads a saved login, but a person makes the file by hand, nothing notices when
  it expires, and nothing rebuilds it.
- Plan mode puts the login in `shared/setup.md`, which `withSetup()` prepends to every task. N scenarios
  mean N logins and N 2FA prompts, run concurrently.

## Decision

State file, produced by Duckwright and consumed through the existing `stateLoad`. A shared or persistent
browser profile was rejected: Chromium locks the profile folder, tasks lose isolation (network capture,
video, element refs are per session), and exported `@playwright/test` specs need a state file anyway.
A profile is fine for *performing* a login, not for *sharing* one.

Base: the minimal design (login is an ordinary task, one hook in `execute()`), with the pieces below
grafted in from the other two designs.

## Design

### Surface (login belongs to the environment)
Logins are defined **per environment and per account**, inside the environment file
(`environments/<env>.md`), where the credentials already live. Secrets in that file are accepted (it is
already pasted into the prompt today).

```md
## Login

check: /settings            # optional: a page only a logged-in user can see
logged-out: /login|/sso     # optional: URL regex meaning "not logged in" (default: path of the login page)
state-ttl: 720              # optional minutes; default 720, 0 = never stale

### admin
Open /login, sign in as admin@example.com / s3cret, complete 2FA with the twofa action.

### viewer
Open /login, sign in as viewer@example.com / s3cret. No 2FA.

### sso-user
check: https://app.example.com/home      # an account may override the section-level keys
Sign in through the company SSO as sso@example.com / s3cret.
```

- A `## Login` section holds `###` account blocks. The text under an account is the login task the agent
  runs; `key: value` lines at the top of the section or of an account are settings (account wins).
- Select the account with `account: admin` in task front matter / global config, or `--account admin`.
  If the environment has exactly one account it is the default; with several and none chosen, preflight
  fails (exit 2) and lists them. `account: none` skips login for that task.
- Saved login path: `.duckwright/state/<env>/<account>.json`. Different environments or accounts never
  share a file, so a staging admin never leaks into prod or into a viewer task. A change to the account
  block's text or settings changes a recorded hash in `<file>.meta.json` and forces a re-login.
- Parsing lives in `src/environment.ts` (`parseLogin(text) -> {settings, accounts}`); it is tolerant:
  an environment without `## Login` behaves exactly as today.
- Tasks that load a saved login do not need the passwords, so the `## Login` section is **stripped from
  the environment text given to ordinary task runs** (the login run gets it). Smaller prompt, and the
  model only sees the credentials during the login. (`## Test accounts` prose is untouched.)
- Without an environment, or for sites outside environments, keep the generic escape hatches:
  `login: path` (a task file that logs in) and `state: FILE` (bring your own). `login` + `state` or
  `account` + `login` together is an error (exit 2).
- Other keys: `--relogin` (CLI only), `--state-ttl MIN`.
- `duckwright login [--env E] [--account A] [--manual]`: run that login now. `--manual` opens a headed
  browser for passkey/SMS/captcha and the person confirms. `duckwright login --list` shows each
  environment/account, file age and probe result.

### Flow
`ensureState()` in new `src/login.ts` (keyed by environment + account, or by the `login:` file), called once at the top of `execute()` in `src/runs/run.ts`, so
print, batch, TUI, web and plan all get it.
1. Static freshness: file exists, mtime within TTL, not `--relogin`.
2. Probe (no model call, ~1-2 s): after `stateLoad`, `goto check`, read the final URL. Expired if it
   matches `logged-out` or origin/path differs. Skipped when no `check` is configured.
3. If missing/stale/expired: single-flight login. In-process a promise map keyed by state path;
   across processes an atomic `<state>.lock` directory (stale after 10 min or dead pid). The login
   run is an ordinary sub-run that gets the waiting task's `humanFor`, so a 2FA prompt appears as today.
4. Re-login is seeded with the previous state (`stateLoad(old)` first) so "trust this device" cookies
   often skip 2FA.
5. The login run's task is the account block (with the environment text as context). A login only counts if the agent finished `done success` **and** the probe passes in the same
   browser. Then `pw.stateSave(tmp)` (before `close()`, in `loop.ts`), chmod 0600, rename. A half-done
   login never becomes the cached state.
6. Failure: every waiting task fails at once with the same `LoginError`, so a bad password is tried once.
7. Probe says expired at task start: invalidate, one re-login, then run the task (no model step has
   run, so retry costs only the probe).
8. Backstop for mid-run expiry: a line in `prompts/system.md` tells the agent to finish with
   `done failure` / `LOGIN_EXPIRED...` when it sees a login page despite a loaded session. The harness
   then deletes the state only if its mtime is unchanged since this run loaded it. Not retried
   automatically in v1.
9. No TTY, no TOTP secret, and no valid state (print/batch): fail fast once, before any task spends
   money, with `run duckwright login FILE` (exit 2). In batch, ensure once up front.

### Secrets
- State dir 0700, files 0600 via tmp+rename, a self-written `.duckwright/.gitignore` of `*`.
- Login run forces screenshot/video off (state files and the environment file hold secrets: keep `.duckwright/` out of git, and commit `environments/` only if it holds test-only credentials) and `exportTest: false` (its `fill` code holds the password).
- Seed the run `Scrubber` with cookie/localStorage values of 16+ characters so tokens cannot leak into
  network bodies, snapshots or debug logs. `history.json` records only the state path.

### Plan mode
The plan is run against one environment (`env:`). The planner picks an `account:` per scenario from the
environment's accounts (default account when unspecified) and keeps login steps out of `setup`; no
`shared/login.md` is needed. One login per distinct account is shared by all of that account's
scenarios, so a plan with admin and viewer scenarios logs in twice, not N times. Old plans work unchanged.

### Export
`history.json` records the state path; `export.ts` (and `exportApi.ts`) emit
`test.use({ storageState: '<path>' })` and drop `COOKIES_NOTE`. This also covers plain `--state` runs and
ticks the roadmap item "storage state in exports". Login runs are never exported.

### Files
`src/login.ts` (new), `src/environment.ts` (`parseLogin`, strip login section), `src/pw.ts` (`stateSave`, `goto`, `currentUrl`), `src/loop.ts` (probe hook,
`saveState`), `src/runs/run.ts`, `src/args.ts`, `src/taskfile.ts`, `src/config.ts`, `src/cli.ts`
(preflight, `login` subcommand, batch up-front ensure), `src/plan.ts` + `prompts/planner.md`,
`prompts/system.md`, `src/export.ts`, `src/exportApi.ts`, `README.md`.

### Tests
Fake `Runner`/`createAgent` seams. Core `test/login.test.ts`: 5 concurrent `ensureState` give exactly
one login run; fresh / stale / `--relogin`; failure fans out with no state file left; stale lock;
file mode; probe expired then one re-login; login not saved when the probe fails. Plus `pw`, `loop`
(save before close, only on success), `run` (`LOGIN_EXPIRED` mtime guard), args/taskfile/config, plan,
export, cli (non-TTY missing state gives exit 2), and a scrub-leak test. Optional e2e with a fixture
server (cookie login, TOTP page, session TTL).

### Phasing
1. Environment `## Login` accounts, `account:`/`--account`, single-flight, `stateSave`, TTL, `--relogin`, export `storageState` (about 1.5 days).
2. Probe, seeded re-login, `LOGIN_EXPIRED` backstop, fail-fast, scrubber seeding.
3. `duckwright login [--manual]` with a TUI/web confirm dialog; plan-mode `login` split.

## Rejected / deferred
- Separate profile files outside the environment file (login and credentials belong with the environment) (`auth/<name>.md`, `auth list|rm`, meta file): heavier (6-9 days) for
  what a login task file plus optional `check:` already gives.
- `{{env:NAME}}` harness-side secret fill: keeps passwords out of the model entirely; deferred because plaintext secrets in the environment file are accepted. Stripping the login section from task runs gets most of the benefit.
- `per-slot` logins for IdPs that revoke on token reuse: documented workaround is `--max-parallel 1`.
- Mid-run URL-based expiry detection (a logout test would trip it), auto-retry of a failed task,
  encryption at rest, generated Playwright `globalSetup`, shared browser/CDP/profile clones.
- Open question: whether `playwright-cli state-save` includes IndexedDB (Firebase Auth, some MSAL).
  If not, those sites still need their login in `setup:`; a `store: profile` fallback is the escape hatch.

## Arena record
Three candidates: named auth profiles (c1), shared browser/profile vs state files (c2, rerun on opus
after the fable seat failed on credits), minimal login task (c3). All converged on a state file, a
single-flight broker with a lock, atomic 0600 writes and `storageState` in exports. No separate
cross-judge was run; the base was picked on the rubric (one login incl. 2FA, expiry, secrets, size and
fit, export).
