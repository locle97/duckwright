# What a Duckwright task can and cannot ask for

Facts about the harness that decide whether a task can run. Each line names where it comes from in the
Duckwright repo, so a maintainer can keep this file in step (`test/skill-check.test.ts` checks the
command and key lists).

## The agent

- Drives **one browser session** per task, fresh every time (`README.md`, Plan mode). Nothing carries
  over between tasks: no cookies, no local storage, no memory. Server-side data does carry over.
- **No shell, no files, no other processes** (`prompts/planner.md`, `prompts/system.md`). It cannot run
  seed scripts, read logs, query a database, read an email inbox, or open a file.
- Allowed commands only (`src/brain.ts` `ALLOWED_COMMANDS`): goto, click, fill, type, press, select,
  check, uncheck, dblclick, hover, drag, tab-new, tab-select, tab-close, go-back, screenshot, expect,
  expect-request, request, twofa, note (explore only), done.
  Not available: `upload` (no file uploads), `dialog-accept` / `dialog-dismiss` (native confirm/alert),
  `reload` (write "Open {{BASE_URL}}/<path> again"), `eval`, `find`, any wait command.
- Picks elements by ref from an **accessibility snapshot** (`prompts/system.md`, Element refs). Name
  elements by visible label or role. CSS selectors and test ids in steps do not help it.
- Gets the env file's text in every step's prompt and treats it as trusted background; **the task wins**
  where they disagree (`prompts/system.md`, Environment context). Do not restate env facts in a task
  differently.
- Checks with `expect`: visible, exact text, contains, input value, checked/unchecked, exact URL.
  Checks API calls with `expect-request`: method, path (no query string), status, optionally one JSON
  field; only calls from its **previous step**; not redacted fields (tokens, passwords); needs network
  capture on (the default; `network: false` breaks it).
- Stops at `max-steps` (default 25). A step holds 1 to 3 actions, and a page-changing action ends a step,
  so plan about 2 steps per numbered task step.

## Signing in

- Best: a **state file** (`state:` front matter, or `--state`), made once by a person with
  `playwright-cli state-save` (README, Authenticated pages). Relative to the task file. A missing file
  fails preflight with exit 2. An expired one lands the agent on the sign-in page.
- **Accounts** (README, Accounts): an environment can hold log-in accounts, set up by a person on the web
  UI's Environments page. The agent is told each account's id, role and username and logs in with
  `{{<id>.username}}` and `{{<id>.password}}` as `fill`/`type` arguments (the password placeholder must be
  the whole argument; it is typed only on the environment's base-URL or login origins). In task text, name
  the account by id ("log in as the `admin` account"); never write a password. Optional front matter
  `accounts: admin, member` offers only those ids (needs `env`); a missing id fails preflight (exit 2).
  An account's TOTP comes from `twofa totp <ref> <id>`. Explore runs get no accounts.
- The agent **cannot read environment variables**. An env file line like "password in the env var X"
  tells the agent where a secret is but gives it no way to get it. A task can only type a password
  that is written in it, so only seed-only throwaway values (the map's `allow-literals`) may appear.
- 2FA: `twofa` with totp, sms, email or passkey. Unattended TOTP needs `DUCKWRIGHT_TOTP_SECRET` set
  for the run (a plan note). SMS, email and passkey need a person at the terminal.

## Setup data

- Through the UI, by default.
- `request` (`src/request.ts`, `prompts/system.md`): only a method and path **already seen** in this run's
  network capture, same origin, no headers, no query string. `duckwright export` refuses a run where a
  `request` comes after any UI action other than `goto`. So `request` setup is only exportable for an
  endpoint the page calls on load. A POST first seen after a click cannot be used for exportable setup.
- `setup:` front matter: a file whose text is put before the task, as
  `Setup (do this first, then the task below):` (`src/taskfile.ts` `withSetup`). It is browser steps too.

## Task file format (`src/taskfile.ts`)

- Optional front matter between `---` lines, flat `key: value`, `#` comments (also after ` #`), quote a
  value to keep a `#`. Unknown keys, duplicate keys and `allow-file-access` are errors (exit 2).
- Keys: max-steps, model, headed, skill, session, state, network, video, screenshot, twofa-timeout,
  snapshot, jev, jev-threshold, debug, setup, env, accounts.
- `skill`, `state`, `setup` and `env` paths resolve from the task file's folder. A **bare env name**
  resolves to `environments/<name>.md` under the **current directory** of the run, so tasks must be run
  from the Duckwright root.
- Do not set `session:`: the TUI gives each run its own anyway, and two `-p` runs of tasks with the same
  fixed session at the same time drive the same browser (README, Usage).
- The body is sent to the agent verbatim, HTML comments included. Notes for people go in front-matter
  comments or `plan.json`, not in the body.

## Environment file (`src/environment.ts`)

- UTF-8, not empty, at most **16384 bytes**. Goes into every step's prompt, so its size costs on every step.
- `duckwright explore` owns the block between `<!-- duckwright:generated:start run=N -->` and
  `<!-- duckwright:generated:end -->` and shrinks it to fit the limit; everything else is kept byte for
  byte. Hand-written text belongs outside it (for example under `## Notes (yours)`).
- Never holds raw secrets (README, Environment context).

## Plan folder (`src/plan.ts`)

- `plan.json`: `{ version: 1, name, source, setup: "shared/setup.md" | null, notes: string[],
  skipped: [{id, title, reason}], tasks: [{file, id, title}] }`. `file` is a plain name inside the
  folder. `duckwright plan <folder>` opens it in the TUI; `duckwright -p -f <folder>` runs the folder's
  root-level `.md`/`.txt` files in name order.
- A folder run picks up **every** root-level `.md` file, so never put a README or notes file there.

## Export (`src/export.ts`)

- A successful run writes `duckwright.spec.ts` from the recorded Playwright code. Tab commands become
  `// TODO(duckwright)`; a `--state` run needs `test.use({ storageState })` added by hand. Anything the
  agent typed, passwords included, ends up in `history.json` and the spec.
