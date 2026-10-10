# Environment context: design

Date: 2026-10-09 · Branch: `duckor/environment-context-roadmap` · Roadmap item: **Environment context**

## Summary

Today every task file repeats the same facts about the environment under test (base URL, which test account to use and where its credentials come from, seeded data, feature flags, quirks, what must not be touched). This change adds a per-environment context file, `environments/<name>.md`, chosen with `--env <name>`, a task file's `env:` key, or the global config's `env` key (CLI > task file > config). Its text is checked at preflight (exists, readable UTF-8, not empty, at most 16 KB) and then put verbatim into an `<environment>` section of **every** step prompt, right after `<task>`. The run's `history.json` records which environment was used (name and path, never the contents). The TUI and web UI get an environment picker in the options (global and per task), listing `environments/*.md`, and show the effective environment. Plan mode writes `env:` into the task files it generates when the plan was made with an environment. Docs, an example environment file and the roadmap tick complete it. With no environment chosen, prompts, history and every existing behavior are byte-for-byte unchanged.

## Decisions

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Environment folder | `environments/` under the process's current working directory (`process.cwd()`; the manager uses its `cwd` option, default `process.cwd()`). From brief assumption. |
| D2 | Name vs path | A value is a **path** if it contains `/` (or `\` on Windows, i.e. `path.sep`) or ends with `.md` (case-insensitive). Otherwise it is a **name** and must match `^[A-Za-z0-9_-][A-Za-z0-9._-]*$` (brief's `[A-Za-z0-9._-]`, plus: may not start with `.`, so `.`/`..`/hidden names are rejected). A name resolves to `<cwd>/environments/<name>.md`. |
| D3 | Path resolution | CLI path: relative to cwd. Task-file path: relative to the task file's folder (like `state`). Config path: relative to the config's folder (like `state`). `~` expansion as for other `path` keys. A name is always resolved against cwd, wherever it was written. |
| D4 | Disabling | The reserved value `none` (CLI, task file, config, UI, API) means "no environment" at that level, so `--env none` cancels a config/task-file env, and a task file `env: none` cancels the config's. Consequently an environment file named `none.md` can only be selected by path. |
| D5 | Precedence | CLI > task file > config, exactly like other settings (`parseRunArgs(argv, skill, {...config, ...fileSettings})`). TUI/web overrides sit on top as for model etc. (global override < per-task override). |
| D6 | Batch + `--env` (brief assumption conflict) | The brief assumes "a `--env` on a batch applies to all files unless a file sets its own `env:`", which contradicts SC2 (CLI > task file). **SC2 wins**: `--env` on a batch applies to every file, overriding each file's `env:`. To use per-file environments, omit `--env`. |
| D7 | Size limit | 16384 bytes (16 KB) of file content, measured on the raw file before decoding. From brief assumption. |
| D8 | Empty file | A file that is empty or only whitespace is a preflight error (same treatment as an empty `setup:` file). |
| D9 | Prompt placement | Every step's prompt (not only the first), as `<environment>…</environment>` immediately after `<task>`. From brief assumption. |
| D10 | Verbatim text | The file text is used as-is apart from: CRLF → LF, a leading BOM dropped (fatal UTF-8 decoder, as for task files), and outer whitespace trimmed. It is not `neutralise`d (it is the user's trusted file, like the task text). The whole prompt still passes through the existing 2FA scrubber (`Agent.scrub`). |
| D11 | Spoofing | `environment` is added to `HARNESS_TAG` in `src/text.ts`, so page text containing `<environment>` is neutralised like `<task>`. |
| D12 | When the file is read | Preflight reads and validates the file (exit 2 / task error on failure). `startRun` reads it again when the run starts; a failure there (file deleted in between) fails that run with exit 1 and the same message, like other start errors. No caching. |
| D13 | What is recorded | `history.json` gets a top-level `env: { "name", "path" }` (absolute path) only when an environment is used; key absent otherwise. Contents never recorded. No new event fields (YAGNI). |
| D14 | Environment label | `name` = the name for a name value, or the file's basename without its `.md` extension for a path value. |
| D15 | Listing for pickers | Non-hidden regular files directly in `<cwd>/environments/` whose name ends in `.md` (lower case) and whose stem is a valid name (D2) and not `none`; stems sorted with `compareCodePoints`. Missing folder → empty list. Re-read on every `globals()` call (cheap readdir, no watcher). |
| D16 | UI selector default | The picker's default is "inherit", which shows the inherited value, i.e. `none` when no flag/file/config sets an env (brief: default "none"). Choices: inherit, `none`, then each listed name. |
| D17 | UI scope | The picker exists in the global options and per-task options (both TUI form and web dialog), because they share one `Overrides` type and form. Global applies to every task's next run, per-task to one task. |
| D18 | Override validation | API/UI overrides accept only a name (D2) or `null`/`"none"`; existence is checked at preflight when the task starts (error toast + task error), not when the option is saved. |
| D19 | Plan mode | When a plan is planned with an effective env (CLI `--env` for `-p --plan`; in the TUI/web, the global env override if set, else the argv/config env), every generated task file gets `env: <value>` in its front matter after `setup:`: the name for a name, or for a path the path relative to the planned folder. The shared setup file gets nothing. Opening an existing planned folder changes nothing. |
| D20 | Secrets | No `${VAR}` expansion or secret handling; docs tell users to reference secrets by name (env var, `--state` file), never paste them. From brief. |
| D21 | Non-markdown | A path value need not end in `.md`; its content is used verbatim regardless. Only listing (D15) is restricted to `.md`. |
| D22 | Usage error | A CLI `--env` value that is neither a path nor a valid name is a usage error (exit 2). A bad config/task-file value is a `TaskFileError` with file and line (exit 2). |
| D23 | Plan-mode env when opening a planned folder via `--plan` with `--env` | `--env` then just applies to the runs (normal precedence); nothing is written to the files. |

## Architecture / Components

### New: `src/environment.ts`
One purpose: turn an env value into a resolved file and validated text. No runtime deps beyond `node:fs`/`node:path`.

- `ENV_DIR = "environments"`, `ENV_MAX_BYTES = 16384`, `ENV_NONE = "none"`.
- `isEnvPath(value): boolean` (D2), `isEnvName(value): boolean` (D2 regex).
- `resolveEnv(value, cwd = process.cwd()): { name: string; path: string }` (D2, D3, D14). `path` is absolute (`resolvePath`).
- `envLabel(value: string | null): string | null` (D14; `null` → `null`).
- `loadEnvironment(value, cwd?): { name; path; text }`; throws `EnvError` (extends `Error`) with the exact messages in Error handling.
- `listEnvironments(cwd = process.cwd()): string[]` (D15).

### Changed
- `src/taskfile.ts`: `TaskSettings.env?: string`; new `Kind` `"env"`; `KEYS.env = ["env", "env"]`. `convert` for `"env"`: `none` → `"none"`; a path (D2) → resolved like `"path"` against `baseDir`; a valid name → kept; otherwise `LineError('env must be an environment name (letters, digits, ".", "_", "-") or a path, got "<v>"')`. Config gets the key automatically through `RUN_KEYS`.
- `src/config.ts`: `DEFAULT_CONFIG` gains `# env: staging` after `# snapshot: hybrid`; the "Relative paths (skill, state)" comment becomes "(skill, state, env)".
- `src/args.ts`: `RunArgs.env: string | null` (default `null`; never `"none"` after parsing: `"none"` from settings or flag becomes `null`). `--env` in `RUN_SPEC.names` and `VALUE_OPTIONS`; validation per D22. `RUN_USAGE` and `RUN_HELP` updated (exact text in C1).
- `src/cli.ts`: `preflight` gains the env check (after the state check, before `which`), using `loadEnvironment`; `planMain` passes `args.env` to `writePlan`.
- `src/prompt.ts`: `PromptOptions.environment?: string | null`; `buildPrompt` inserts `section("environment", environment)` right after the task section when non-empty.
- `src/text.ts`: `HARNESS_TAG` gains `environment` (D11).
- `src/loop.ts`: `AgentOptions.environment?: string | null`, stored on the agent and passed to `buildPrompt` every step.
- `src/runs/run.ts`: in `execute`, inside the existing `try`, `const env = args.env ? loadEnvironment(args.env) : null` before creating the agent; passes `environment: env?.text ?? null` to `createAgent`; `historyJson(...)` gets a trailing `env: { name; path } | null = null` parameter and emits `env` after `task_file` only when non-null. Both history writes (success and failure) pass it.
- `src/export.ts`: `HistoryData.env?: { name: string; path: string }` (type only; export ignores it).
- `src/plan.ts`: `taskFileText(s, source, setup, env: string | null = null)` adds `env: <env>` after the `setup:` line; `writePlan(doc, planFile, root = "tasks", env: string | null = null)` computes the value per D19 and passes it.
- `src/runs/manager.ts`:
  - `Overrides.env?: string | null`; `Effective.env: string | null` (the label, D14); `effectiveOf` uses `envLabel(args.env)`.
  - `Globals.environments: string[]` = `listEnvironments(cwd)`.
  - `#argsFor` applies `o.env` when `!== undefined`.
  - `#startPlanning` computes the plan env (D19) and passes it to `writePlan`.
- `src/web/api.ts`: `parseOverrides` accepts `env` per C5.
- TUI: `src/tui/form.ts` (`FieldKey` + `"env"`, label `environment`, last in `ORDER`; `FormState.environments: string[]`; `openForm(taskId, effective, overrides, focus = 0, environments: readonly string[] = [])`; toggle keys cycle through the choices; text typing ignored; ctrl+r resets to inherit; `formResult` maps `none` → `null`); callers in `src/tui/keys.ts` and `src/tui/optionsPane.ts` pass `s.globals?.environments ?? []`; `src/tui/detail.ts` `SETTINGS` gains `["env", "environment"]` (value `none` when null).
- Web: `web/src/OptionsStrip.tsx` adds chip `env: <label|none>`; `web/src/dialogs/OptionsDialog.tsx` adds a select `opt-env`.
- `prompts/system.md`: environment wording (C7).
- Docs: `README.md`, new `examples/environments/staging.md` (C8).

## Contracts

### C1: `--env` option (CLI)

- **Surface:** `duckwright [--env ENV] ...` (run, `-p`, `-f` batches, TUI, `--web`, `plan`).
- **Input:** `ENV`, one value: `none`, a name matching `^[A-Za-z0-9_-][A-Za-z0-9._-]*$` (→ `<cwd>/environments/ENV.md`), or a path (contains a path separator or ends `.md`, case-insensitive; relative to cwd). Optional; default: from task file, else config, else no environment. Also accepted as `--env=ENV`.
- **Usage text:** `RUN_USAGE` line `"                  [--state FILE] [--allow-file-access]\n"` becomes `"                  [--state FILE] [--env ENV] [--allow-file-access]\n"`. `RUN_HELP` gets, after the `--state FILE` entry:
  ```
    --env ENV             environment context: the text of environments/ENV.md
                          (or of the .md file at path ENV) is put into every
                          step's prompt; none = no environment
  ```
- **Output:** no output of its own; the run proceeds with the environment (C3, C4).
- **Errors (exit 2, before anything runs):**
  - no value: `duckwright: error: argument --env: expected one argument` (after usage).
  - invalid value: `duckwright: error: argument --env: invalid environment: '<v>' (use a name of letters, digits, '.', '_' and '-', or a path to a .md file)` (after usage).
  - file problems: the preflight messages of C2 on stderr (batch: prefixed `<task file>: `, all collected, as existing preflight errors).
- **Criteria:** SC1, SC2, SC3

### C2: Environment file (File)

- **Surface:** `environments/<name>.md`, or any file given by path.
- **Input:** UTF-8 text (BOM allowed), at most 16384 bytes, not empty after trimming. Free-form markdown; suggested headings in the example (C8).
- **Output:** text used verbatim per D10 in C3.
- **Errors (preflight; `-p` exits 2; TUI/web: task error + error toast, run not started; at run start: run fails, exit 1, same message):**
  - missing: `environment file not found: <abs path>`
  - not a regular file, permission denied, invalid UTF-8: `environment file cannot be read: <abs path>: <reason>` where reason is the OS error message, or `not a file`, or `not valid UTF-8`.
  - too big: `environment file too large: <abs path> is <n> bytes (limit 16384)`
  - empty: `environment file is empty: <abs path>`
- **Criteria:** SC1, SC3

### C3: Step prompt `<environment>` section (Library / prompt format)

- **Surface:** `buildPrompt(task, step, maxSteps, history, memory, obs, { window, nudge, paste, environment })` and the prompt text sent to `claude -p`.
- **Input:** `environment?: string | null` (default `null`).
- **Output:** when `environment` is a non-empty string, the prompt is `Step N/M`, `<task>…</task>`, then
  ```
  <environment>
  <text>
  </environment>
  ```
  then `<memory>`, `<tabs>`, … as today, sections separated by a blank line. With `null`/absent/empty: output identical to today's. Present in every step 1..N of a run. Scrubbed by the run's 2FA scrubber like the rest of the prompt.
- **Errors:** none.
- **Criteria:** SC1

### C4: Task-file and config key `env` (File)

- **Surface:** task-file front matter `env: <value>`; `duckwright.conf` line `env: <value>`.
- **Input:** `none`, a name (D2), or a path (task file: relative to its folder; config: relative to the config's folder; `~` expanded). Quoting and comment rules as other keys.
- **Output:** the run's environment, under CLI precedence (CLI > task file > config).
- **Errors (exit 2 before anything runs; TUI add box shows the error):** `<file>:<line>: env must be an environment name (letters, digits, ".", "_", "-") or a path, got "<v>"`; `<file>:<line>: "env" has no value`; `<file>:<line>: "env" is set twice`; path errors `<file>:<line>: env is not a usable path: <reason>`.
- **Criteria:** SC2

### C5: Overrides `env` in the web API (API)

- **Surface:** `PUT /api/globals` and `PUT /api/tasks/:id/overrides`, body field `env`; `GET /api/state` (and the event-stream snapshot) `globals.environments` and `effective.env`/`inherited.env`/`globals.base.env`.
- **Input:** `env` optional: absent = inherit; `null` or `"none"` = no environment (stored as `null`); a string name matching D2.
- **Output:** `200 {"ok": true}`; afterwards `globals.overrides.env` (or the task's `overrides.env`) is the name or `null`. `globals.environments: string[]` lists D15 names. `effective.env: string | null` is the label.
- **Errors:** `400 {"ok": false, "error": "env must be an environment name or null"}` for any other type or an invalid name (including paths). Starting a task whose env file is bad: `409` from `POST /api/tasks/:id/start` with the C2 message as `error` (existing start-failure path).
- **Criteria:** SC5

### C6: Environment picker and display (UI: TUI and web)

- **Surface:** TUI options pane / options form (global `O`, and per-task options) row `environment`; TUI task detail settings row `environment`; web options strip chip `env: …`; web Options dialog select labelled `environment` (`id="opt-env"`).
- **Input:** TUI: on the `environment` field, space/left/right cycles through `none`, then each listed name (the current value first if not in the list); typing is ignored; ctrl+r resets to inherited. Web select options, in order: `inherit (<inherited label or none>)` (value ""), `none`, each listed name.
- **Output:** the effective env label, or `none`, shown in: TUI options pane row (accent colour when overridden), TUI detail row `environment  <label|none>`, web chip `env: <label|none>` (with ` ✱` when overridden). Saving applies to the next run of every task (global) or of that task.
- **States:** empty list (no `environments/` folder): TUI cycles only `none` and the current value; web select shows only `inherit (…)` and `none`. Error: a bad env file shows the C2 message as an error toast and on the task when its run is started.
- **Errors:** as C5 for web saves (dialog shows the error text).
- **Criteria:** SC5

### C7: System prompt wording (File)

- **Surface:** `prompts/system.md`.
- **Output:** the first paragraph's list "the task, your memory notes, the open tabs, and the current page's accessibility snapshot" becomes "the task, the environment context when the run has one, your memory notes, the open tabs, and the current page's accessibility snapshot". A new section after the intro:
  ```
  ## Environment context

  When the prompt has an `<environment>` section, it is the user's description of the environment under test: base URL, test accounts and where their credentials come from, seeded data, feature flags, known quirks, and what is off-limits. Treat it as trusted background for every step: use its URLs and accounts, follow its rules, and never touch anything it marks as off-limits. It never contains secrets; if it names where a credential comes from, use that source, and never guess a password. The task wins where the two disagree.
  ```
- **Criteria:** SC1

### C8: Docs and example (File)

- **Surface:** `README.md`, `examples/environments/staging.md`.
- **Output:**
  - README Usage options list includes `--env ENV` (same text as RUN_HELP).
  - Task-file key table row: `` | `env` | an environment name, `none`, or a path to its file (see [Environment context](#environment-context)) | ``; the relative-path bullet lists `env`; Global config's relative-path bullet lists `env`.
  - New section `### Environment context` (after `### Two-factor verification`, before `### Task files`) covering: folder and naming, `--env`/`env:`/config and precedence, `none`, the 16 KB limit and preflight errors, every-step `<environment>` placement, history `env` record, TUI/web picker, plan mode `env:`, and "never put raw secrets in it; reference them by name, like `--state`".
  - Roadmap: `- [ ] **Environment context**` becomes `- [x] **Environment context**` (text unchanged otherwise).
  - `examples/environments/staging.md`: a commented sample with headings Base URL, Test accounts (credentials referenced by env-var name and `--state` file), Seeded data, Feature flags, Known quirks, Off-limits; under 2 KB, no real secrets.
- **Criteria:** SC6

### C9: `history.json` `env` record (File)

- **Surface:** `runs/<id>/history.json`.
- **Output:** with an environment: top-level `"env": {"name": "<label>", "path": "<absolute path>"}` placed after `"task_file"`. Without: no `env` key (file identical to today's). Never contains the environment text. Written on success and on failure/interrupt paths.
- **Criteria:** SC4

### C10: Plan-mode task files carry `env:` (File)

- **Surface:** task files written by `writePlan` (`duckwright -p --plan PLAN --env ENV`, `duckwright plan PLAN`, TUI/web plan).
- **Output:** front matter `---`, `# From …`, optional `setup: shared/setup.md`, then `env: <name>` (or path relative to the planned folder), `---`. Without an env: unchanged.
- **Criteria:** SC2

## Data flow

1. **Parse:** `dispatch` loads config (`env` via Kind `env`), `parseRunArgs(argv, skill, {...config, ...fileSettings})` yields `args.env` (CLI value wins; `none` → `null`). Batch: one parse per file (D6).
2. **Preflight:** `preflight` → if `args.env`, `loadEnvironment(args.env)`; an `EnvError` message is the preflight error (exit 2 in CLI; task error/toast in manager).
3. **Run start:** `startRun.execute` → `loadEnvironment(args.env)` → `{name, path, text}` → `createAgent({..., environment: text})`.
4. **Each step:** `Agent` → `buildPrompt(..., { environment })` → `<environment>` after `<task>` → `Agent.scrub` → `Brain`.
5. **Finish:** `historyJson(..., env {name, path})` → `history.json`.
6. **UI:** `manager.globals()` → `{ base, overrides, environments }` → TUI form/web dialog → `setGlobals`/`setOverrides({env})` → `#argsFor` applies it → next `start` preflights and runs with it.
7. **Plan:** planner result → `writePlan(doc, source, root, env)` → `taskFileText` writes `env:`; later loads go through step 1.

## Error handling

| Failure | Behavior |
| --- | --- |
| `--env` without value / invalid value | Usage error, exit 2 (C1). |
| Invalid `env:` in task file or config | `TaskFileError` `<file>:<line>: …`, exit 2 (C4); TUI add shows the error. |
| Env file missing | Preflight: `environment file not found: <path>`, exit 2 / task error + toast (C2). |
| Env file unreadable (permission, directory, invalid UTF-8) | `environment file cannot be read: <path>: <reason>`, same handling (C2). |
| Env file > 16384 bytes | `environment file too large: <path> is <n> bytes (limit 16384)` (C2). |
| Env file empty/whitespace | `environment file is empty: <path>` (C2). |
| File removed/changed between preflight and run start | Run fails at start with the C2 message, exit 1, `history.json` written with `env` omitted (env never resolved). |
| Batch: some files' envs bad | All preflight errors printed `<task file>: <message>`, exit 2, nothing runs (existing batch behavior). |
| Web override with bad `env` | `400 env must be an environment name or null` (C5). |
| `environments/` missing or unreadable when listing | Empty list; no error. |

## Testing

Check commands: `npm test` (typecheck + `node --test "test/**/*.test.ts"`) and `npm run typecheck`. Tests use temp dirs (`test/helpers.ts` `tmpDir`) and injected deps; no network, no browser, no e2e.

- `test/environment.test.ts` (new): name/path classification (incl. `.`/`..`, `a.MD`, `dir/x`), resolution against a given cwd, label, every `loadEnvironment` error message (missing, directory, invalid UTF-8, 16384 OK / 16385 too large, empty), CRLF/BOM/trim, `listEnvironments` filtering and sorting, missing folder.
- `test/args.test.ts`: `--env`, `--env=`, missing value, invalid value message, `none` → null, settings default overridden by flag, help/usage text.
- `test/taskfile.test.ts` / `test/config.test.ts`: `env:` name, `none`, relative path resolved from the file's/config's folder, invalid value message with line; `DEFAULT_CONFIG` contains `# env: staging`.
- `test/prompt.test.ts`: section present after `<task>` and before `<memory>`; absent and output unchanged when null/empty; verbatim text.
- `test/text.test.ts`: `neutralise` escapes `<environment>` and `</environment>`.
- `test/loop.test.ts`: every step's prompt (fake brain) contains the environment; none without it.
- `test/runs/run.test.ts`: history `env` present with name/path and no contents; absent without env; present on failure path; run-start load failure fails the run with the message.
- `test/cli.test.ts`: `-p --env staging` with `environments/staging.md` in a temp cwd reaches the agent (fake `createAgent` captures `environment`); precedence CLI > task file > config including batch (D6) and `none`; each C2 error exits 2 with the message; no `--env` → `environment` null and output unchanged; `-p --plan` with `--env` writes `env:` into task files.
- `test/plan.test.ts`: `taskFileText` with/without env, path made relative to the planned folder.
- `test/runs/manager.test.ts`: `globals().environments`, global and per-task `env` overrides in effective/inherited and in started args, `null` override cancels a file env, preflight failure surfaces as task error/toast. `test/runs/manager-plan.test.ts`: plan env (global override, else argv/config) written into generated task files.
- `test/web/api.test.ts`: `parseOverrides` env accepted/rejected with exact message; `PUT /api/globals` round-trip in `/api/state`.
- `test/tui/form.test.ts`, `test/tui/app.test.ts`: form cycles env choices, ctrl+r reset, `formResult` maps `none` → null; options pane and detail render the `environment` row. `test/tui/fake-manager.ts` gains `environments` in its `Globals`.
- Existing tests keep passing unchanged except where they assert the full `RUN_USAGE`/`RUN_HELP`, `DEFAULT_CONFIG`, `Effective`/`Globals` shapes or the form field count, which are updated to the new exact values.

| SC | Contracts | Proved by |
| --- | --- | --- |
| SC1 `--env staging` text in every step prompt; absent without | C1, C2, C3, C7 | Checks: environment, args, prompt, loop, cli tests; QA scenarios |
| SC2 task file / config `env` with CLI > file > config | C1, C4, C10 | Checks: taskfile, config, cli (incl. batch), plan tests; QA scenarios |
| SC3 missing/unreadable/oversized → exit 2 with clear message | C1, C2 | Checks: environment and cli tests; QA scenarios |
| SC4 history records name/path, never contents | C9 | Checks: run tests; QA scenario inspecting `history.json` |
| SC5 TUI and web select and show env | C5, C6 | Checks: manager, web api, tui tests; QA scenarios in TUI and web UI |
| SC6 README, example, roadmap tick | C7, C8 | Review of the diff |

### Manual e2e

A real run against a live site (`duckwright -p --env staging "…"` with `claude` and `playwright-cli` installed) to confirm the agent actually uses the environment context. Not part of the run's verification.

## Out of scope

- Resolving `${ENV_VAR}` placeholders or any secret handling beyond the documented convention.
- Multiple environments per run, inheritance between env files, non-markdown parsing.
- Auto-exporting env info into generated specs (`duckwright.spec.ts`).
- Showing the environment in run headers/timelines or adding it to `run:start` events (cut, YAGNI; `history.json` is the record).
- Watching `environments/` for changes; creating/editing environment files from the TUI/web.
