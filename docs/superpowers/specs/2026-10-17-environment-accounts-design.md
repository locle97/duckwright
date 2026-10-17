# Environment accounts and autopilot login design

Status: approved design, 2026-10-17.

## Intent

Duckwright should run tasks that need a logged-in user with nobody at the keyboard. Today a logged-in run needs one of these:

- an `auth.json` saved by hand and passed with `--state`, which expires;
- a password in a shell variable that the environment file only mentions in prose;
- the single global `DUCKWRIGHT_TOTP_SECRET`, which covers one account across every environment.

All three need a person, and none of them scales to several environments with several roles each.

After this change each environment (for example Local or Dev) owns a list of named accounts with their credentials. A task says in its text which account(s) it acts as, and the agent finds the login page and logs in by itself, 2FA included. You manage environments and accounts in a new page of the web UI.

Example:

- Local: admin A, user B
- Dev: admin C, admin D, user E

The task "As admin C, create an invoice for Acme, then log in as user E and check it appears in their list" runs end to end on Dev without anyone touching it.

## Goals

1. Per-environment accounts, each with a username, a password and an optional TOTP secret, stored locally and never committed.
2. The agent logs in by itself as the account(s) the task names, using placeholders, so it never sees a password or TOTP secret.
3. A login is fresh in every run. A task may use more than one account, switching by logging out and back in within the same browser.
4. A web UI page to create and edit environments and their accounts.
5. Secrets never reach anything a run keeps or sends (prompts, `history.json`, `events.jsonl`, `network/`, `debug.log`, page snapshots, printed lines, exported tests), extending what the 2FA scrubber already does for codes.
6. An exported test replays the login, reading each secret from an environment variable, so it runs in CI.

## Non-goals

- **Encryption at rest.** The database is plaintext on disk, like `auth.json` today. The owner chose this.
- **Caching logged-in sessions between runs.** Every run logs in fresh. The owner chose this so the login itself is tested and a task can switch accounts.
- **Parallel sessions per account** (two accounts logged in at once in separate browser contexts). Switching means logging out and in, in one browser. This keeps the exported test a single `page`, the only shape export supports today.
- **A TUI page** for environments and accounts. Web UI only. The owner chose this, since typing passwords and pasting TOTP secrets suits a browser form. The TUI keeps its current `environment` selector.
- **Moving the environment context into the database.** The context stays the human-readable `environments/<name>.md` file, committable and reviewable.
- **Moving the explore sitemap into the database.** This was discussed as a later improvement. Environments on different hosts already get separate sitemaps, since the sitemap is keyed by host. It is a separate project.
- **Running Duckwright itself from CI without the database** (for example accounts from environment variables). Only exported tests read environment variables. This can come later.
- **Accounts in `duckwright explore`.** Explore keeps its current "do not log in unless the environment context gives you a test account" rule. It gets no `<accounts>` section, no substitution and no TOTP by account. This is the planned follow-up. The owner agreed to leave it out of this project.
- **SMS, email and passkey 2FA without a person.** These keep working as today: the run pauses and asks.

## Anti-goals

The design has failed, even if it works, if any of these happen:

- A password or TOTP secret appears in a prompt, `history.json`, `events.jsonl`, `debug.log`, `network/`, a page snapshot Duckwright keeps, a printed step line, or an exported spec.
- The database can be committed by a plain `git add .` in a project that never edited its `.gitignore`.
- A page can trick the agent into typing a stored password into a site other than the environment's own. Page content is untrusted, as the README says.
- The web UI hands a stored password or TOTP secret back to the browser.
- Existing setups break: `environments/<name>.md`, `--env`, `env:` front matter, `--state`, `DUCKWRIGHT_TOTP_SECRET` and the `twofa` action all keep working unchanged when no accounts are configured.

## Constraints

- **Node `>=22.18`, CI on 22 and 24, minimal dependencies.** Use the built-in `node:sqlite` (`DatabaseSync`). It works without a flag on 22.18+ and was checked on 22.22, but it prints an `ExperimentalWarning`. Duckwright must suppress that one warning, for `node:sqlite` only, so it never shows in `-p` output or the TUI. Add no native dependency.
- **Committed `.duckwright/`.** The skills commit `.duckwright/testing-map.md`, `.duckwright/facts/` and `.duckwright/probes/`, so the folder itself is not ignored. Secrets go in a subfolder that ignores itself (see Storage).
- **Current-directory relative.** Like `environments/` and `runs/`, the database lives relative to the directory Duckwright runs from.
- **The harness owns the loop.** The agent still emits structured actions only. Substitution, origin checks and scrubbing happen in the harness.
- The web server stays on `127.0.0.1` behind its per-launch token.

## Decisions

### Storage

- Database: `.duckwright/local/duckwright.db` (SQLite, WAL mode, so the web server and `-p` runs in other processes can read and write at once).
- On first create, Duckwright writes `.duckwright/local/.gitignore` containing `*`, so nothing in the folder is ever staged, whatever the project's root `.gitignore` says. Duckwright never writes secrets anywhere else.
- Plaintext columns. No encryption.
- A `schema_version` (for example `PRAGMA user_version`) and forward-only migrations, so later features such as a run index or sitemap can add tables.

What is stored:

- **Environment settings**, keyed by the environment name (the same name `--env` and `env:` use, which is `envLabel` for a path):
  - **base URL**: required once an environment has accounts;
  - **login origins**: optional extra origins where typing a secret is allowed, such as an SSO host.
- **Accounts**, per environment:
  - **id**: a slug, lowercase letters, digits and `-`, unique within the environment, for example `admin-c`. Used in placeholders and environment variable names.
  - **label**: a free display name, for example "Admin C".
  - **role**: optional short description, for example "admin, can manage billing". Shown to the agent.
  - **username**: not a secret. Shown to the agent, kept in history and written literally into exports, because pages show it after login and scrubbing it would mangle what the agent reads.
  - **password**: a secret.
  - **TOTP secret**: optional secret, base32 or `otpauth://` URI, validated with the existing `parseSecret` on save.

The environment's context stays in `environments/<name>.md`. An environment exists if it has a `.md` file. The web page creates that file when you add an environment. The database rows hang off the name. Deleting an environment in the web UI removes its database rows and, only after a confirm, the `.md` file.

### How a task names accounts

- **In the task text, in plain words.** For example "As admin C, …". The agent matches the words against the environment's account list, which the prompt shows it (see Agent side).
- **Optional front matter `accounts: admin-c, user-e`.** It pins the accounts and is checked before the run starts: an id the environment doesn't have stops the run with exit `2`, before the browser opens. `duckwright check` reports the same error, reading the database if it exists. A missing database is a warning in `check`, the same way a missing `state:` file is today.
  - *(Builder's call, made in design.)* Pinning also narrows the run. Only the pinned accounts appear in the `<accounts>` prompt section, and a placeholder for any other id is refused. Scrubbing still covers every account in the environment.
  - *(Builder's call, made in design.)* Front matter `accounts:` in a run whose effective environment, after `--env`, config and `env:`, is none is exit `2`. `check` verifies `accounts:` against the file's `env:`. With no `env:` in the file, it warns that the accounts can't be verified there.
  - *(Builder's call, made in design.)* An environment that has accounts but no base URL is exit `2` at preflight. The web UI won't save an account to such an environment.
- **Without front matter** the harness can't check prose before the run. An unknown id in a placeholder fails that action with an error the agent sees, and the agent can finish with `done failure`.

### Agent side

**The prompt** gets an `<accounts>` section when the run's environment has accounts. Each line holds the id, label, role, username and whether it has TOTP, plus fixed rules:

- To log in, use `{{<id>.username}}` and `{{<id>.password}}` as `fill` or `type` arguments. Never type a password any other way, and never ask for one.
- For a TOTP prompt, use `twofa totp <ref> <id>`.
- To switch accounts, log out first.
- Never type a placeholder into a field that is not a login field.

The section is fenced like the environment section. Secrets are never in it.

**Placeholders.** In `fill` and `type` arguments, a whole-argument or embedded `{{<id>.username}}` or `{{<id>.password}}` is replaced by the stored value just before the command is sent to `playwright-cli`. The decision recorded in `history.json` keeps the placeholder as the agent wrote it.

**Origin guard.** A placeholder for a password is substituted only when the current page's origin equals the base URL's origin or one of the login origins. Otherwise the action fails with an error naming the origin, and nothing is typed. The harness reads the active tab's URL. How it gets it is the builder's call; the observation already has the tabs. Username placeholders are allowed anywhere, since usernames are not secret.

**TOTP.** The `twofa totp` action gains an optional account argument: `twofa totp <ref> <id>`.
- With it, the code comes from that account's TOTP secret. Without a stored secret the action fails with a clear error and does not ask a person.
- Without it, behaviour is unchanged: `DUCKWRIGHT_TOTP_SECRET`, else ask a person.
- *(Builder's call, made in design.)* The origin guard applies to `twofa totp <ref> <id>` too. A code from a stored account secret is typed only on the base URL's origin or a login origin, because it is as usable to a phishing page as a password.
- `sms`, `email` and `passkey` are unchanged.

**Fresh login.** Nothing is saved between runs. `--state` keeps working exactly as before, for anyone who still wants it.

### Scrubbing

At run start, every password and TOTP secret of the run's environment is added to the run's `Scrubber`, through `addSecret`, which also covers otpauth forms. Every value, not just the accounts the task names. Each generated code is added through `addCode`. This reuses all the existing scrub points in `loop.ts` and `scrubTree` over `page/` and `network/`.

In the Playwright code that `playwright-cli` prints for a substituted `fill`, the stored value is replaced by a marker that keeps the placeholder, for example `[SECRET admin-c.password]`, rather than the generic `[REDACTED]`. That way export can map it back. The general network and debug scrub can keep `[REDACTED]`.

*(Builder's call, made in design.)* playwright-cli's own `.playwright-cli/` folder sits outside the run folder. A password should not appear there, since password fields don't echo their value into snapshots, but a wrong-field typo could put it there. Duckwright handles the folder in two ways:
- At run end, it runs `scrubTree` over `.playwright-cli/` with the run's scrubber.
- It creates a `.playwright-cli/.gitignore` containing `*` if one is missing.

Passwords travel as argv to the local `playwright-cli` child process. That is accepted: it is a local tool, and the same is true of `fill` today.

Short values: the 2FA scrubber skips codes under 4 characters to avoid mangling text. Passwords are scrubbed whatever their length. The web UI warns when a password is under 8 characters, since short values may mangle unrelated text.

### Export

- A `fill` that carries a password marker exports as a fill from an environment variable, named `DW_<ENV>_<ID>_PASSWORD`: upper case, with non-alphanumerics turned into `_`. For example `DW_DEV_ADMIN_C_PASSWORD`.
- *(Builder's call, made in design.)* Environment variable names must be unique. The web API rejects an account whose `DW_<ENV>_<ID>` name collides with another account's, across all environments.
- A username exports as its literal value.
- `twofa totp <ref> <id>` exports as `totp(process.env.DW_<ENV>_<ID>_TOTP)`. The existing `TOTP_HELPER` is generalised to take the secret as an argument. A `twofa totp` without an account keeps exporting as today, from `DUCKWRIGHT_TOTP_SECRET`.
- The export prints the list of environment variables the test needs.
- The `duckwright-playwright` skill gets the same convention in its references.

### Web UI

A new **Environments** page, alongside the existing task, plan and history views.

- **List:** every environment found in `environments/`, each with its account count and whether it has a base URL.
- **Create:** a name and an optional starting context. This writes `environments/<name>.md` and the base URL row.
- **Edit an environment:** base URL, login origins, and the context text (saved to the `.md` file, keeping the 16 KB limit and the UTF-8 rules of `loadEnvironment`).
- **Accounts:** add, edit and remove accounts: id, label, role, username, password, TOTP secret.
  - Passwords and TOTP secrets are **write-only**: the API never returns them. It returns only "password set" and "TOTP set".
  - Editing shows empty secret fields, which mean "keep". There is an explicit "clear" for the TOTP secret.
- The existing `environment` selects in the Options dialogs pick up new environments without restarting the server.

API routes go into the existing route table in `src/web/api.ts`, with the same validation style and the same "never show internal error text" rule.

## Left to the builder

- Table layout and SQL.
- How the `ExperimentalWarning` filter is installed.
- The exact placeholder grammar and escaping. Whatever is chosen, an argument with no `{{` must be untouched.
- The exact wording of the prompt rules.
- How the active tab's URL is read for the origin guard.
- The marker format in recorded code.
- Page layout and components on the web page, following the existing shadcn-style UI.
- Whether the account form shows a live 6-digit TOTP preview to confirm a pasted secret.
- How `--env PATH` (an environment file outside `environments/`) maps to database rows. The suggestion is to use its label like everything else.
- Tests: unit tests for substitution, the origin guard, scrubbing and export; API tests against the fake manager; and the existing web smoke test extended to the new page.
