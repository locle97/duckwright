# Environment Accounts and Autopilot Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each environment hold named accounts (username, password, optional TOTP secret) in a local, self-ignoring SQLite database. The agent logs in as the account(s) a task names, through placeholders the harness fills, so no secret ever reaches the model, the run record or an exported test. Accounts are managed on a new web UI page.

**Architecture:**
- A new `src/accounts/` module owns the database (`store.ts`), placeholder parsing and substitution (`placeholders.ts`), and the per-run view of an environment's accounts (`runAccounts.ts`).
- The run wiring threads a `RunAccounts` into:
  - the prompt (`<accounts>` section);
  - `execute()` (substitution in `fill`/`type` with an origin guard, and `twofa totp <ref> <id>`);
  - the run's `Scrubber`, where every password scrubs to a named marker such as `[SECRET admin-c.password]`.
- Export maps those markers to `process.env.DW_<ENV>_<ID>_PASSWORD`.
- The web server gets an `environments` context with CRUD routes. The browser gets an Environments dialog.

**Tech Stack:** TypeScript on Node ≥22.18, `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict`, React + Vite web UI.

**Spec:** `docs/superpowers/specs/2026-10-17-environment-accounts-design.md`

## Global Constraints

- **Node and dependencies:** Node `>=22.18`, CI on 22 and 24. No new runtime or native dependency. Use the built-in `node:sqlite`.
- **No warning output:** the `node:sqlite` `ExperimentalWarning` never reaches stderr. Suppress that warning only.
- **Database location:** `.duckwright/local/duckwright.db`, relative to the current directory. On create, write `.duckwright/local/.gitignore` containing `*`. WAL mode. Schema version in `PRAGMA user_version`.
- **Read-only runs:** a run or `check` never creates `.duckwright/local/`. Only a write from the web API creates it.
- **Plaintext:** no encryption.
- **Account id:** matches `/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/`.
- **Placeholders:** `{{<id>.username}}` and `{{<id>.password}}`. An argument with no `{{` is never changed. A password placeholder must be the whole argument. A username placeholder may be embedded.
- **Environment variable names:** `DW_` + `(<env>_<id>)` upper-cased, with every non-`[A-Z0-9]` character turned into `_`, then `_PASSWORD` or `_TOTP`. Names must be unique across all environments.
- **Origin guard:** a password and a TOTP code by account are typed only when the current tab's origin equals the base URL's origin or a login origin.
- **Secrets are write-only:** passwords and TOTP secrets never leave the server through the API.
- **Usernames are not secret:** they are shown to the agent and exported literally.
- **Explore is untouched:** explore runs get no accounts.
- **Backward compatible:** with no database, or an environment with no accounts, every existing behaviour is unchanged (`--env`, `env:`, `--state`, `DUCKWRIGHT_TOTP_SECRET`, `twofa totp <ref>`).

## Review Focus

1. **A password placeholder when the current tab has no http(s) origin**, such as before the first `goto` or on `about:blank`: refused with an origin error, and nothing typed. Test in Task 2.
2. **A page that echoes the password back**, such as "Wrong password: hunter2" in the snapshot or a network body: the prompt, `history.json` and `page/` show only `[SECRET <id>.password]`. Test in Task 5.
3. **One account's password is a prefix of another's** (`abc12345` and `abc123456`): each value is replaced by its own marker, never a mix. Test in Task 3.
4. **A fresh clone with no `.duckwright/local/`**: plain runs, `--env` runs and `duckwright check` work and create nothing. Tests in Tasks 1 and 4.
5. **Web form secret fields:** an empty string means "keep", `null` clears the TOTP secret, and an empty password on a *new* account is a 400. Test in Task 7.

---

### Task 1: Account store

**Files:**
- Create: `src/accounts/sqlite.ts`, `src/accounts/store.ts`
- Test: `test/accounts/store.test.ts`, `test/accounts/sqlite.test.ts`

**Interfaces:**
- Produces, in `src/accounts/sqlite.ts`:
  - `openDatabase(file: string): DatabaseSync`. Loads `node:sqlite` through `createRequire`, with a one-shot `process.emitWarning` filter that drops only an `ExperimentalWarning` whose message mentions SQLite.
- Produces, in `src/accounts/store.ts`:
  - `DB_DIR = ".duckwright/local"`, `DB_FILE = "duckwright.db"`
  - `class AccountError extends Error`
  - `interface EnvSettings { name: string; baseUrl: string | null; loginOrigins: string[] }`
  - `interface Account { env: string; id: string; label: string; role: string; username: string; password: string; totpSecret: string | null }`
  - `type AccountSummary = Omit<Account, "password" | "totpSecret"> & { hasPassword: boolean; hasTotp: boolean }`
  - `interface AccountInput { env: string; id: string; label: string; role: string; username: string; password?: string; totpSecret?: string | null }`. A missing `password` or `totpSecret` means "keep"; `totpSecret: null` means clear.
  - `envVarBase(env: string, id: string): string`, for example `envVarBase("dev", "admin-c") === "DW_DEV_ADMIN_C"`
  - `class AccountStore` with these members:
    - `static open(cwd: string, opts: { create: boolean }): AccountStore | null`. Returns null when the file is missing and `create` is false.
    - `close(): void`
    - `envSettings(env: string): EnvSettings`. Defaults are `baseUrl: null` and `loginOrigins: []`.
    - `setEnvSettings(s: EnvSettings): void`
    - `accounts(env: string): Account[]`
    - `summaries(env: string): AccountSummary[]`
    - `saveAccount(a: AccountInput): void`
    - `removeAccount(env: string, id: string): boolean`
    - `removeEnv(env: string): void`

- [ ] **Step 1: Write failing tests** in `test/accounts/store.test.ts`, using `tmpDir()` from `test/helpers.ts`:
  - `open_without_create_returns_null_and_creates_nothing`: `AccountStore.open(dir, { create: false }) === null` and `!fs.existsSync(path.join(dir, ".duckwright"))`.
  - `create_writes_self_ignoring_folder`: after `open(dir, { create: true })`, `.duckwright/local/.gitignore` reads `"*\n"`, and `PRAGMA user_version` is `1`.
  - `save_and_read_account_round_trip`:
    - Call `setEnvSettings({ name: "dev", baseUrl: "https://dev.example.com", loginOrigins: [] })`.
    - Call `saveAccount({ env: "dev", id: "admin-c", label: "Admin C", role: "admin", username: "c@example.com", password: "pw-123456", totpSecret: "JBSWY3DPEHPK3PXP" })`.
    - `accounts("dev")[0]` deep-equals that input.
    - `summaries("dev")[0]` has `hasPassword: true` and `hasTotp: true`, and no `password` or `totpSecret` key.
  - `save_keeps_secrets_when_omitted_and_clears_totp_on_null`: a second `saveAccount` without `password`/`totpSecret` keeps both values. One with `totpSecret: null` gives `totpSecret: null`.
  - Rejections, each throwing `AccountError`:
    - `new_account_needs_password`
    - `bad_id_rejected`, for ids `"Admin"`, `"-a"` and `"a_b"`
    - `bad_totp_rejected`, for `"not base32!"`
    - `account_needs_base_url`: `saveAccount` before `setEnvSettings` with a base URL.
    - `base_url_must_be_http`: `"ftp://x"`.
    - `env_var_collision_rejected`: env `dev-1` with id `a` exists, then env `dev` with id `1-a` is saved.
  - `remove_env_drops_rows`: after `removeEnv("dev")`, `accounts("dev")` is `[]` and `envSettings("dev").baseUrl` is `null`.
  - `env_var_base_folds_punctuation`: `envVarBase("stage.eu", "user-e") === "DW_STAGE_EU_USER_E"`.
- [ ] **Step 2: Write the failing test** `test/accounts/sqlite.test.ts`: `no_experimental_warning_on_stderr`. It spawns `process.execPath` with a script that imports `src/accounts/sqlite.ts` and opens `:memory:`, then asserts stderr does not match `/ExperimentalWarning/`.
- [ ] **Step 3: Run** `node --test test/accounts/` and confirm it fails with module-not-found.
- [ ] **Step 4: Implement** `sqlite.ts` and `store.ts`.
  - Schema v1:
    - `environments(name TEXT PRIMARY KEY, base_url TEXT, login_origins TEXT NOT NULL DEFAULT '[]')`
    - `accounts(env TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', username TEXT NOT NULL, password TEXT NOT NULL, totp_secret TEXT, PRIMARY KEY(env, id))`
  - On open, set `PRAGMA journal_mode = WAL` and `busy_timeout = 5000`.
  - Migrations run in a list indexed by `user_version`.
  - Validate the TOTP secret with `parseSecret` from `src/totp.ts`.
  - Login origins must each parse as an http(s) origin. Store them normalised with `new URL(x).origin`.
- [ ] **Step 5: Run** `node --test test/accounts/` and confirm it passes. Then run `npm run typecheck`.
- [ ] **Step 6: Commit** with `feat(accounts): local SQLite account store`.

### Task 2: Placeholders and the origin guard

**Files:**
- Create: `src/accounts/placeholders.ts`
- Test: `test/accounts/placeholders.test.ts`

**Interfaces:**
- Produces:
  - `PLACEHOLDER = /\{\{([a-z0-9-]+)\.(username|password)\}\}/g`
  - `interface Ref { id: string; field: "username" | "password" }`
  - `findRefs(arg: string): Ref[]`
  - `interface Resolver { get(id: string): { username: string; password: string } | null; allowedOrigins: readonly string[] }`
  - `substitute(args: string[], r: Resolver | null, origin: string | null): { args: string[]; used: Ref[] } | { error: string }`

- [ ] **Step 1: Write failing tests:**
  - `arg_without_braces_untouched`: the same array contents come back and `used` is `[]`.
  - `username_embedded`: `"{{a.username}}@x"` gives `"alice@x"`.
  - `password_whole_arg`: with `origin` `"https://dev.example.com"` allowed, `"{{a.password}}"` gives `"pw"`.
  - `password_embedded_rejected`: `"x{{a.password}}"` gives an error matching `/whole argument/`.
  - `password_wrong_origin_rejected`: origin `"https://evil.test"` gives an error that includes `"https://evil.test"`.
  - `password_null_origin_rejected`: origin `null` gives an error matching `/no page origin/`.
  - `unknown_id`: the error matches `/no account 'zz'/`.
  - `no_accounts_in_run`: a `null` resolver with a placeholder gives an error matching `/no accounts/`.
  - `username_any_origin_ok`: a username placeholder is accepted on any origin, including `null`.
- [ ] **Step 2: Run** `node --test test/accounts/placeholders.test.ts` and confirm it fails.
- [ ] **Step 3: Implement** `substitute`. Error strings start with `error: ` so they can be used directly as action results.
- [ ] **Step 4: Run** the test and confirm it passes.
- [ ] **Step 5: Commit** with `feat(accounts): placeholder substitution with origin guard`.

### Task 3: Per-run accounts and named-secret scrubbing

**Files:**
- Create: `src/accounts/runAccounts.ts`
- Modify: `src/scrub.ts`, adding named secrets
- Modify: `src/twofa.ts`, adding a TOTP-from-secret method
- Test: `test/accounts/runAccounts.test.ts`, `test/scrub.test.ts`, `test/twofa.test.ts`

**Interfaces:**
- Consumes: `AccountStore`, `Account`, `EnvSettings` (Task 1); `Resolver` (Task 2).
- Produces:
  - In `src/scrub.ts`:
    - `secretMarker(id: string): string`, which returns `` `[SECRET ${id}.password]` ``.
    - `Scrubber.addNamedSecret(value: string, marker: string): void`. Named secrets have no minimum length. Replacement is longest first across all secrets and named secrets.
  - In `src/twofa.ts`: `TwoFactor.totpFor(secret: string): Promise<string>`. It counts an attempt, generates the code with `parseSecret`/`totpAt` and `addCode`s it.
  - In `src/accounts/runAccounts.ts`:
    - `class RunAccounts implements Resolver` with:
      - `readonly env: string`
      - `readonly allowedOrigins: string[]`
      - `get(id)`
      - `totpSecret(id: string): string | null`
      - `has(id: string): boolean`
      - `promptText(): string`
      - `seed(s: Scrubber): void`
    - `loadRunAccounts(cwd: string, env: string, pinned: string[] | null): RunAccounts | null`. Returns null when there is no database or the environment has no accounts. It throws `AccountError` when the environment has accounts but no base URL, or a pinned id is missing.

- [ ] **Step 1: Write failing tests:**
  - `named_secret_scrubs_to_marker`: `addNamedSecret("hunter2", secretMarker("a"))`, then scrubbing `"fill('hunter2')"` gives `"fill('[SECRET a.password]')"`.
  - `prefix_passwords_each_get_own_marker`: `"abc12345"` for `a` and `"abc123456"` for `b`. Scrubbing `"abc123456 abc12345"` gives `"[SECRET b.password] [SECRET a.password]"`.
  - `totpFor_generates_and_scrubs`: `totpFor("JBSWY3DPEHPK3PXP")` with a fixed `now` equals `totpAt(parseSecret(...), now)`. The scrubber masks it.
  - `load_returns_null_without_db`
  - `load_pins_narrow`: with three accounts and `pinned: ["admin-c"]`, `has("user-e") === false`, and `promptText()` lists only `admin-c`.
  - `load_unknown_pin_throws`: the message matches `/environment 'dev' has no account 'zz'/`.
  - `load_without_base_url_throws`
  - `seed_adds_every_account_secret`: even with pins, the scrubber masks unpinned accounts' passwords and TOTP secrets.
  - `prompt_text_has_no_secrets`: `promptText()` contains each id, label, role, username and `"TOTP"` for accounts with a secret. It never contains the password or TOTP secret. It contains the rules about placeholders, `twofa totp <ref> <id>`, logging out before switching, and never typing a placeholder into a non-login field.
- [ ] **Step 2: Run** `node --test test/accounts/runAccounts.test.ts test/scrub.test.ts test/twofa.test.ts` and confirm it fails.
- [ ] **Step 3: Implement.**
  - `seed` calls `addNamedSecret(password, secretMarker(id))` for every account in the environment, plus `addSecret(totpSecret)`.
  - `allowedOrigins` holds the base URL's origin plus the login origins.
- [ ] **Step 4: Run** the tests and confirm they pass.
- [ ] **Step 5: Commit** with `feat(accounts): per-run account view and named secret scrubbing`.

### Task 4: `accounts:` front matter, preflight and `check`

**Files:**
- Modify: `src/taskfile.ts` (new `accounts` key and kind)
- Modify: `src/args.ts` (`RunArgs.accounts`)
- Modify: `src/cli.ts:155-180` (`preflight`)
- Modify: `src/check.ts`
- Test: `test/taskfile.test.ts`, `test/cli.test.ts`, `test/check.test.ts`

**Interfaces:**
- Consumes: `loadRunAccounts`, `AccountError` (Tasks 1 and 3).
- Produces:
  - `TaskSettings.accounts?: string[]`, and `RunArgs.accounts: string[] | null` (default `null`). These flow through the existing `...settings` spread.
  - Front matter is `accounts: admin-c, user-e`: comma-separated ids, each matching the account id regex.
  - `accountsProblem(args: RunArgs, cwd: string): string | null` in `src/accounts/runAccounts.ts`, used by `preflight`.

- [ ] **Step 1: Write failing tests:**
  - `accounts_key_parses_list`: `accounts: admin-c, user-e` gives `["admin-c", "user-e"]`.
  - `accounts_key_rejects_bad_id`: the `LineError` mentions `accounts`.
  - `preflight_accounts_without_env_exit_2`: in `test/cli.test.ts`, a task file with `accounts: a` and no environment exits `2` with stderr matching `/accounts: needs an environment/`.
  - `preflight_unknown_account_exit_2`: there is a database with env `dev`, and the task has `env: dev` and `accounts: zz`.
  - `preflight_env_accounts_no_base_url_exit_2`
  - `check_accounts_verified_against_env`: `checkTasks` reports an error for an unknown id when the file has `env: dev`.
  - `check_accounts_without_env_warns`
  - `check_missing_db_warns`
  - `check_creates_nothing`: no `.duckwright` folder is created.
- [ ] **Step 2: Run** the three test files and confirm they fail.
- [ ] **Step 3: Implement.**
  - `accountsProblem` uses `envLabel(args.env)` as the environment name.
  - A pinned `accounts` with `args.env` null or `none` returns the error above.
  - Otherwise it calls `loadRunAccounts` and maps an `AccountError` to its message.
- [ ] **Step 4: Run** the tests and confirm they pass.
- [ ] **Step 5: Commit** with `feat(accounts): accounts front matter, preflight and check`.

### Task 5: Agent wiring: prompt, substitution, TOTP by account, scrubbing

**Files:**
- Modify: `src/actions.ts` (`execute`, `rejection`, `runTwofa`)
- Modify: `src/twofa.ts` (`checkTwofaArgs` accepts an optional third arg)
- Modify: `src/prompt.ts` (`PromptOptions.accounts`)
- Modify: `src/loop.ts` (`AgentOptions.accounts`)
- Modify: `src/runs/run.ts:190-235` (load and seed, and `.playwright-cli/` scrub at the end)
- Test: `test/actions.test.ts`, `test/twofa.test.ts`, `test/prompt.test.ts`, `test/loop.test.ts`, `test/twofa.leak.test.ts`

**Interfaces:**
- Consumes:
  - `substitute`, `findRefs` (Task 2)
  - `RunAccounts`, `loadRunAccounts`, `secretMarker` (Task 3)
  - `currentOrigin(tabs)` from `src/network.ts`
- Produces:
  - `execute(..., guard?, accounts?: { run: RunAccounts; origin: string | null } | null)`, added as the last parameter.
  - `buildPrompt` option `accounts?: string | null`, rendered as `section("accounts", text)` right after the environment section.
  - `AgentOptions.accounts?: RunAccounts`.

- [ ] **Step 1: Write failing tests:**
  - `fill_substitutes_password_on_allowed_origin`: the fake `pw` receives `"pw"`. The returned `codes` entry has gone through the run's scrubber, so `history.json` code holds `[SECRET a.password]`.
  - `fill_refused_on_other_origin_types_nothing`: no `pw.run` call is made, and the result starts with `error:`.
  - `type_substitutes_like_fill`
  - `placeholder_in_click_args_rejected`: placeholders are only for `fill`/`type`. The result matches `/only in fill or type/`.
  - `twofa_totp_by_account`: `twofa totp e5 admin-c` fills the code from `totpFor`. It is refused on a disallowed origin. With no stored TOTP it gives `error: account 'admin-c' has no TOTP secret`, and the human is not asked.
  - `twofa_totp_without_account_unchanged`: the existing tests still pass.
  - `check_twofa_args_third_must_be_id`: `["totp", "e5", "Bad!"]` is an error.
  - `prompt_has_accounts_section_after_environment`
  - `loop_echoed_password_scrubbed` (Review Focus 2): the fake page snapshot contains `"hunter2"`, and the prompt passed to the brain, `history.json` and `page/snapshot.yml` contain only `[SECRET a.password]`.
  - `run_without_accounts_creates_nothing` (Review Focus 4)
  - `run_end_scrubs_playwright_cli_dir`: a file under `.playwright-cli/` that contains the password is rewritten with the marker, and `.playwright-cli/.gitignore` is created with `*` when it is missing.
- [ ] **Step 2: Run** the listed tests and confirm they fail.
- [ ] **Step 3: Implement.**
  - In `run.ts`:
    - Call `loadRunAccounts(process.cwd(), env.name, args.accounts)`, but only for non-explore specs.
    - Call `seed(twofa.scrubber)` and pass `accounts` to the agent.
    - In `finally`, when the run had accounts, call `scrubTree(path.resolve(".playwright-cli"), twofa.scrubber)` and create the `.gitignore` if it is missing.
  - In `loop.ts`, pass `{ run, origin: currentOrigin(obs.tabs) }` to `execute` and `run.promptText()` to `buildPrompt`.
- [ ] **Step 4: Run** `npm test` and confirm it passes.
- [ ] **Step 5: Commit** with `feat(accounts): agent logs in with account placeholders`.

### Task 6: Export of account logins

**Files:**
- Modify: `src/export.ts` (`TOTP_HELPER`, the `twofa` branch, the generic code path near line 245, and `renderSpec`'s warnings)
- Test: `test/export.test.ts`, plus a new fixture `test/fixtures/export/account-login/` (with `history.json` and `expected.spec.ts`)

**Interfaces:**
- Consumes: `envVarBase` (Task 1), `secretMarker` (Task 3), and `HistoryData.env?.name`.
- Produces:
  - `TOTP_HELPER` becomes `function totp(secret = process.env.DUCKWRIGHT_TOTP_SECRET, name = 'DUCKWRIGHT_TOTP_SECRET')`. It throws `set ${name} to run this test` when there is no secret.
  - `renderSpec` pushes one warning: `this test reads these environment variables: DW_DEV_ADMIN_C_PASSWORD, ...` (sorted).

- [ ] **Step 1: Write failing tests:**
  - `password_marker_exports_env_var`: a quoted `'[SECRET admin-c.password]'` in recorded code becomes `process.env.DW_DEV_ADMIN_C_PASSWORD`.
  - `twofa_totp_account_exports_named_secret`: it becomes `totp(process.env.DW_DEV_ADMIN_C_TOTP, 'DW_DEV_ADMIN_C_TOTP')`.
  - `twofa_totp_without_account_unchanged`: still `totp()`.
  - `marker_without_env_throws_export_error`: `history.env` is missing, the exit code is `1`, and the message matches `/no environment/`.
  - `env_var_warning_listed`
  - `fixture_account_login_matches_expected`
- [ ] **Step 2: Run** `node --test test/export.test.ts` and confirm it fails.
- [ ] **Step 3: Implement** with one helper, `replaceSecretMarkers(code: string, env: string | null, needed: Set<string>): string`, in `src/export.ts`. It is used by the generic code path.
- [ ] **Step 4: Run** the test and confirm it passes.
- [ ] **Step 5: Commit** with `feat(export): replay account logins from environment variables`.

### Task 7: Web API for environments and accounts

**Files:**
- Create: `src/web/environments.ts`
- Modify: `src/environment.ts` (add `saveEnvironmentText`)
- Modify: `src/web/api.ts` (`ApiContext.environments` and routes)
- Modify: `src/web/index.ts` (wire the context)
- Test: `test/web/environments.test.ts`, `test/web/api.test.ts`, `test/environment.test.ts`

**Interfaces:**
- Consumes: `AccountStore`, `AccountError`, `AccountSummary`, `EnvSettings` (Task 1); `listEnvironments`, `loadEnvironment`, `isEnvName`, `ENV_NONE`.
- Produces:
  - `saveEnvironmentText(name: string, text: string, cwd?: string): void` in `environment.ts`. It throws `EnvError` when the text is empty or over `ENV_MAX_BYTES`.
  - `interface EnvironmentView { name: string; baseUrl: string | null; loginOrigins: string[]; accounts: AccountSummary[] }`
  - `interface EnvironmentsLike` with:
    - `list(): EnvironmentView[]`
    - `get(name): (EnvironmentView & { context: string }) | null`
    - `create(name: string, context: string): void`
    - `update(name, s: { baseUrl: string | null; loginOrigins: string[]; context?: string }): void`
    - `remove(name: string, deleteFile: boolean): void`
    - `saveAccount(a: AccountInput): void`
    - `removeAccount(env: string, id: string): boolean`

    Errors are `AccountError` or `EnvError`.
  - `createEnvironments(cwd: string): EnvironmentsLike`. It opens the store with `{ create: true }` only on a write.
  - Routes. `NAME` is `[A-Za-z0-9_-][A-Za-z0-9._-]*`, and `none` is a 400.
    - `GET /api/environments` returns `{ ok, items }`.
    - `POST /api/environments` takes `{ name, context }`. It returns 409 if the file exists.
    - `GET /api/environments/:name` returns `{ ok, environment }`, or 404.
    - `PUT /api/environments/:name`
    - `DELETE /api/environments/:name?file=1`
    - `PUT /api/environments/:name/accounts/:id` takes `{ label, role, username, password?, totpSecret? }`.
    - `DELETE /api/environments/:name/accounts/:id`
  - An `AccountError` or `EnvError` maps to 400 with its own message. Anything else stays 500 `internal error`.

- [ ] **Step 1: Write failing tests:**
  - `list_never_returns_secrets`: `JSON.stringify(response)` contains neither the password nor the TOTP secret.
  - `put_account_empty_password_keeps` (Review Focus 5): `password: ""` keeps the stored one.
  - `put_account_null_totp_clears`
  - `put_new_account_empty_password_400`
  - `create_writes_md_and_conflicts_on_existing`
  - `create_rejects_none_name`
  - `remove_with_file_flag_deletes_md_only_then`
  - `context_over_16kb_400`
  - `globals_environments_lists_new_env`: after `create`, `manager.globals().environments` includes it, because `listEnvironments` is read per call.
- [ ] **Step 2: Run** `node --test test/web/ test/environment.test.ts` and confirm it fails.
- [ ] **Step 3: Implement.** The API normalises `password: ""` and `totpSecret: ""` to "keep" (omitted) before calling `saveAccount`.
- [ ] **Step 4: Run** the tests and confirm they pass.
- [ ] **Step 5: Commit** with `feat(web): environments and accounts API`.

### Task 8: Environments page in the web UI

**Files:**
- Create: `web/src/dialogs/EnvironmentsDialog.tsx`
- Modify: `web/src/environment.ts` (pure form helpers)
- Modify: `web/src/App.tsx`, `web/src/Header.tsx`, `web/src/keys.ts` (open with the `v` key and an "Environments" header button)
- Modify: `web/src/dialogs/HelpDialog.tsx`
- Test: `test/web/ui-environment.test.ts`, `test/web/keys.test.ts`, `test/web/ui.smoke.test.ts`

**Interfaces:**
- Consumes: the Task 7 routes through `api` in `web/src/api.ts`.
- Produces, in `web/src/environment.ts`:
  - `interface AccountDraft { id: string; label: string; role: string; username: string; password: string; totpSecret: string; clearTotp: boolean }`
  - `accountBody(d: AccountDraft): Record<string, unknown>`. It omits `password` and `totpSecret` when they are empty, and sends `totpSecret: null` when `clearTotp` is set.
  - `shortPasswordWarning(pw: string): string | null`, which warns under 8 characters.

- [ ] **Step 1: Write failing tests:**
  - `account_body_omits_empty_secrets`
  - `account_body_clear_totp_sends_null`
  - `short_password_warns_under_8`
  - `key_v_opens_environments`
  - A smoke test, `environments_page_create_and_add_account`: open the page with `v`, create `dev` with a base URL, and add an account. The row shows "password set". Reopening the account shows empty secret fields.
- [ ] **Step 2: Run** `node --test test/web/ui-environment.test.ts test/web/keys.test.ts` and confirm it fails.
- [ ] **Step 3: Implement** the dialog with the existing `Modal`, `Button` and form styles from `web/src/ui.tsx`:
  - a list of environments;
  - a per-environment form with the base URL, login origins (one per line) and the context textarea;
  - an accounts table with add, edit and remove, using password inputs, a TOTP "clear" checkbox, and toasts on errors.
- [ ] **Step 4: Run** `npm test`, then `DUCKWRIGHT_UI_SMOKE=1 node --test test/web/ui.smoke.test.ts`, and confirm both pass.
- [ ] **Step 5: Commit** with `feat(web): environments and accounts page`.

### Task 9: Documentation

**Files:**
- Modify: `README.md`. Add a new "Accounts" section under Environment context. Update the 2FA section for `twofa totp <ref> <id>`, the export section for `DW_*` variables, and the Features list.
- Modify: `examples/environments/staging.md`. Point to the accounts page instead of the env var prose.
- Modify: `skills/duckwright-playwright/` references, to cover the `DW_<ENV>_<ID>_PASSWORD`/`_TOTP` convention and the `[SECRET id.password]` marker in history.
- Modify: `skills/duckwright-tasks/` references, to name accounts by id in task text and optionally in `accounts:`.

- [ ] **Step 1: Update** the files above. Every rule stated must match the Global Constraints.
- [ ] **Step 2: Run** `npm test`, since `test/skill-check.test.ts` and `test/packaging.test.ts` cover the skills, and confirm it passes.
- [ ] **Step 3: Commit** with `docs: environment accounts and autopilot login`.
