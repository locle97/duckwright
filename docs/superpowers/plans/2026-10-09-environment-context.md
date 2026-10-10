# Environment Context Implementation Plan

**Goal:** Let a run carry a per-environment context file (`environments/<name>.md`, chosen with `--env`, a task file's `env:`, or the config's `env`) whose text goes verbatim into an `<environment>` section of every step prompt, with the choice recorded in `history.json` and selectable in the TUI and web UI.
**Architecture:** A new `src/environment.ts` owns classification (name vs path), resolution, validation/loading and listing. The value flows like every other run setting (config < task file < CLI < UI overrides) into `RunArgs.env`; `preflight` validates it, `startRun` loads it and hands the text to the `Agent`, which passes it to `buildPrompt` each step. The manager exposes the listing and the effective label to the TUI/web pickers; plan mode writes `env:` into generated task files.
**Tech Stack:** TypeScript (Node >= 22.18, native type stripping), `node:test`, Ink (TUI), React + Vite (web).
**Spec:** `docs/superpowers/specs/2026-10-09-environment-context-design.md`

## Global Constraints

- With no environment chosen, prompts, history and every existing behavior are byte-for-byte unchanged.
- `environments/` under the process's current working directory (`process.cwd()`; the manager uses its `cwd` option, default `process.cwd()`).
- A value is a **path** if it contains `/` (or `path.sep`) or ends with `.md` (case-insensitive). Otherwise it is a **name** and must match `^[A-Za-z0-9_-][A-Za-z0-9._-]*$`. The reserved value `none` means "no environment".
- Precedence: CLI > task file > config; TUI/web overrides on top (global override < per-task override). `--env` on a batch overrides every file's `env:` (D6).
- Size limit 16384 bytes measured on the raw file; empty/whitespace-only is an error; text used verbatim apart from CRLF→LF, BOM dropped, outer whitespace trimmed; not `neutralise`d.
- `history.json` records `env: { name, path }` only when an environment is used; never the contents.
- No `${VAR}` expansion or secret handling.
- Tests use temp dirs (`test/helpers.ts` `tmpDir`) and injected deps; no network, no browser, no e2e.
- `npm test` runs `npm run typecheck` first, so every task must leave both `tsc` projects green (update test fixtures whose types change in the same task).

## Review Focus

1. Name/path classification edge cases (`.`, `..`, `.hidden`, `a.MD`, `dir/x`, a listed file `x.MD.md`) — pinned in Task 1 `env_classify` and `env_list_filters_and_sorts`.
2. Nothing changes without an env: prompt identical, no `env` key in history — pinned in Task 2 `prompt_without_environment_unchanged` and Task 5 `history_json_env_absent_without_env`.
3. `--env none` cancelling a task-file/config env, and `--env` overriding every batch file — pinned in Task 4 `args_env_none_is_null` and Task 6 `cli_env_precedence_batch_and_none`.
4. Manager `cwd` differing from `process.cwd()`: the picker lists `<cwd>/environments`, and preflight/run receive the same file — pinned in Task 8 `manager_env_names_resolve_against_manager_cwd`.
5. Plan-mode path values written relative to the planned folder, never re-read as a name — pinned in Task 7 `write_plan_env_path_relative_to_folder`.

---

### Task 1: `src/environment.ts` (classify, resolve, load, list)

**Files:**
- Create: `src/environment.ts`
- Test: `test/environment.test.ts`

**Contracts:** C2

**Interfaces:**
- Consumes: `resolvePath` (`src/paths.ts`), `compareCodePoints` (`src/text.ts`)
- Produces:
  - `export const ENV_DIR = "environments"; export const ENV_MAX_BYTES = 16384; export const ENV_NONE = "none";`
  - `export class EnvError extends Error` (`name = "EnvError"`)
  - `export function isEnvPath(value: string): boolean` — contains `/` or `path.sep`, or `/\.md$/i`
  - `export function isEnvName(value: string): boolean` — `!isEnvPath(value) && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)` (so a stem like `x.MD` is never a name)
  - `export function resolveEnv(value: string, cwd = process.cwd()): { name: string; path: string }` — path: `resolvePath(path.resolve(cwd, value))`; name: `resolvePath(path.join(cwd, ENV_DIR, value + ".md"))`; anything else throws `EnvError("invalid environment: '<v>'")`. `name` = `envLabel(value)`.
  - `export function envLabel(value: string | null): string | null` — `null` → `null`; path → basename with a trailing `.md` (any case) removed; name → itself
  - `export function loadEnvironment(value: string, cwd = process.cwd()): { name: string; path: string; text: string }`
  - `export function listEnvironments(cwd = process.cwd()): string[]`

**Checks:** `node --test --test-timeout=60000 test/environment.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/environment.test.ts` (each in a fresh `tmpDir()` passed as `cwd`):
  - `env_classify`: `isEnvPath` true for `"dir/x"`, `"a.MD"`, `"a.md"`, `"/abs/x"`; false for `"staging"`, `"a.b"`. `isEnvName` true for `"staging"`, `"qa_1-x.y"`, `"none"`; false for `"."`, `".."`, `".hidden"`, `"a b"`, `""`, `"dir/x"`, `"a.MD"`.
  - `env_resolve_and_label`: `resolveEnv("staging", tmp)` → `{ name: "staging", path: <tmp>/environments/staging.md }`; `resolveEnv("x/prod.MD", tmp)` → `{ name: "prod", path: <tmp>/x/prod.MD }`; `envLabel("../envs/eu-west")` → `"eu-west"`; `envLabel(null)` → `null`; `resolveEnv("a b", tmp)` throws `EnvError` with message `invalid environment: 'a b'`.
  - `env_load_errors` (exact messages, `<p>` = absolute resolved path): missing → `environment file not found: <p>`; a directory `environments/dir.md/` → `environment file cannot be read: <p>: not a file`; bytes `[0xff, 0xfe, 0x41]` → `environment file cannot be read: <p>: not valid UTF-8`; 16385 × `"a"` → `environment file too large: <p> is 16385 bytes (limit 16384)`; `" \n\t\n"` → `environment file is empty: <p>`. All thrown as `EnvError`.
  - `env_load_limit_and_normalise`: exactly 16384 × `"a"` loads; `"﻿\r\n  Base URL: x\r\nAccounts: y  \r\n\r\n"` loads as `text === "Base URL: x\nAccounts: y"`, `name === "staging"`, `path` absolute.
  - `env_list_filters_and_sorts`: folder holds `b.md`, `a.md`, `A.md`, `.hidden.md`, `none.md`, `x.MD.md`, `notes.txt`, `UP.MD`, `bad name.md`, and a sub-folder `dir.md/` → `["A", "a", "b"]`; no `environments/` folder → `[]`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/environment.test.ts` / `Expected: FAIL with module not found (src/environment.ts)`
- [ ] **Step 3: Implement** the interfaces above in `src/environment.ts`. `loadEnvironment` order: `fs.statSync` (ENOENT → not found; other error → `cannot read: <p>: <err.message>`; `!isFile()` → `not a file`), `fs.readFileSync` (error → `cannot read: <p>: <err.message>`), byte length > `ENV_MAX_BYTES` → too large, `new TextDecoder("utf-8", { fatal: true })` (throws → `not valid UTF-8`), `replaceAll("\r\n", "\n").trim()`, empty → empty. `listEnvironments`: `readdirSync` (any error → `[]`), keep entries not starting with `.`, ending in lower-case `.md`, `statSync(..).isFile()` (follows symlinks; errors skip), stem `isEnvName` and `!== ENV_NONE`; sort with `compareCodePoints`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/environment.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/environment.ts test/environment.test.ts && git commit -m "feat: add environment context loader"`

---

### Task 2: `<environment>` prompt section, tag neutralising, agent wiring

**Files:**
- Modify: `src/prompt.ts`, `src/text.ts`, `src/loop.ts`
- Test: `test/prompt.test.ts`, `test/text.test.ts`, `test/loop.test.ts`

**Contracts:** C3

**Interfaces:**
- Produces: `PromptOptions.environment?: string | null`; `AgentOptions.environment?: string | null`; `Agent.environment: string | null` (readonly, default `null`)

**Checks:** `node --test --test-timeout=60000 test/prompt.test.ts test/text.test.ts test/loop.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `prompt.test.ts` `prompt_environment_section_after_task`: `buildPrompt("T", 1, 5, [], "", obs, { environment: "Base URL: https://x\n<b>raw</b>" })` contains `"<task>\nT\n</task>\n\n<environment>\nBase URL: https://x\n<b>raw</b>\n</environment>\n\n<memory>"` (verbatim, not escaped).
  - `prompt.test.ts` `prompt_without_environment_unchanged`: output with `{}`, `{ environment: null }` and `{ environment: "" }` are all `===` the output with no options argument, and contain no `<environment>`.
  - `text.test.ts` `neutralise_environment_tags`: `neutralise("<environment>x</environment>")` → `"&lt;environment>x&lt;/environment>"`.
  - `loop.test.ts` `agent_environment_in_every_step_prompt`: an agent with `environment: "ENV-TEXT"` running 3 steps (fake brain recording prompts) has `<environment>\nENV-TEXT\n</environment>` in all 3 prompts; the same agent without `environment` has none in any prompt.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/prompt.test.ts test/text.test.ts test/loop.test.ts` / `Expected: FAIL (no environment section; tag not escaped)`
- [ ] **Step 3: Implement**: `buildPrompt` destructures `environment = null` and inserts `section("environment", environment)` right after the task section only when `environment` is a non-empty string. `HARNESS_TAG` alternation gains `environment`. `Agent` stores `opts.environment ?? null` and passes `{ nudge, paste, environment: this.environment }` at the `buildPrompt` call in `loop.ts` (line ~168); the prompt still goes through `this.scrub`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/prompt.test.ts test/text.test.ts test/loop.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/prompt.ts src/text.ts src/loop.ts test/prompt.test.ts test/text.test.ts test/loop.test.ts && git commit -m "feat: put environment context into every step prompt"`

---

### Task 3: `env` key in task files and the global config

**Files:**
- Modify: `src/taskfile.ts`, `src/config.ts`
- Test: `test/taskfile.test.ts`, `test/config.test.ts`

**Contracts:** C4

**Interfaces:**
- Consumes: `isEnvPath`, `isEnvName`, `ENV_NONE` (Task 1)
- Produces: `TaskSettings.env?: string` (either `"none"`, a name, or an absolute resolved path); `Kind` gains `"env"`; `KEYS.env = ["env", "env"]`

**Checks:** `node --test --test-timeout=60000 test/taskfile.test.ts test/config.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `taskfile.test.ts` `taskfile_env_values`: front matter `env: staging` → `settings.env === "staging"`; `env: none` → `"none"`; `env: ../envs/eu.md` in `<tmp>/tasks/a.md` → `resolvePath(<tmp>/envs/eu.md)`; `env: sub/prod` → `<tmp>/tasks/sub/prod` (resolved).
  - `taskfile.test.ts` `taskfile_env_errors`: `env: .hidden` on front-matter line 2 → `TaskFileError` `<file>:2: env must be an environment name (letters, digits, ".", "_", "-") or a path, got ".hidden"`; `env:` empty → `<file>:2: "env" has no value`; two `env:` lines → `<file>:3: "env" is set twice`.
  - `config.test.ts` `config_env_key`: `duckwright.conf` with `env: staging` → `{ env: "staging" }`; `env: envs/qa.md` → resolved from the config's folder; `env: a b` → `TaskFileError` with `<file>:1: env must be an environment name (letters, digits, ".", "_", "-") or a path, got "a b"`; `DEFAULT_CONFIG` includes `"# snapshot: hybrid\n# env: staging\n"` and `"# Relative paths (skill, state, env) are resolved from the folder holding this file."`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/taskfile.test.ts test/config.test.ts` / `Expected: FAIL with unknown setting "env"`
- [ ] **Step 3: Implement** a `kind === "env"` branch in `convert`: `ENV_NONE` → `"none"`; `isEnvPath(v)` → same code as the `"path"` branch (message `env is not a usable path: <reason>`); `isEnvName(v)` → `v`; else `LineError('env must be an environment name (letters, digits, ".", "_", "-") or a path, got "<v>"')`. Add `env` to `TaskSettings` and `KEYS`. In `DEFAULT_CONFIG` add `# env: staging` after `# snapshot: hybrid` and change the comment to `(skill, state, env)`; update the `loadConfig` doc comment likewise. Update any existing test that asserts the whole `DEFAULT_CONFIG`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/taskfile.test.ts test/config.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/taskfile.ts src/config.ts test/taskfile.test.ts test/config.test.ts && git commit -m "feat: env key in task files and config"`

---

### Task 4: `--env` option and `RunArgs.env`

**Files:**
- Modify: `src/args.ts`
- Test: `test/args.test.ts`; fixture updates in `test/runs/run.test.ts` (line ~23) and `test/twofa.leak.test.ts` (line ~76), which build full `RunArgs` literals

**Contracts:** C1 (option parsing, usage, help, usage errors)

**Interfaces:**
- Consumes: `isEnvPath`, `isEnvName`, `ENV_NONE` (Task 1); `TaskSettings.env` (Task 3)
- Produces: `RunArgs.env: string | null` — never `"none"` after `parseRunArgs` (default `null`)

**Checks:** `node --test --test-timeout=60000 test/args.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/args.test.ts` (add `env: null` to the two default-args fixtures at lines ~19 and ~34):
  - `args_env_values`: `--env staging` → `env === "staging"`; `--env=staging` → `"staging"`; `--env envs/x.md` → `"envs/x.md"`; settings `{ env: "qa" }` with no flag → `"qa"`; settings `{ env: "qa" }` with `--env prod` → `"prod"`.
  - `args_env_none_is_null`: `--env none` → `null`; settings `{ env: "none" }` → `null`; settings `{ env: "qa" }` with `--env none` → `null`.
  - `args_env_errors`: `--env` at the end → `UsageError` `argument --env: expected one argument`; `--env .x` → `argument --env: invalid environment: '.x' (use a name of letters, digits, '.', '_' and '-', or a path to a .md file)`; `--env=` → same message with `''`.
  - `args_env_usage_and_help`: `RUN_USAGE` contains `"                  [--state FILE] [--env ENV] [--allow-file-access]\n"`; `RUN_HELP` contains, right after the `--state FILE` entry's two lines:
    ```
      --env ENV             environment context: the text of environments/ENV.md
                            (or of the .md file at path ENV) is put into every
                            step's prompt; none = no environment
    ```
    Update any test asserting the whole `RUN_USAGE`/`RUN_HELP`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/args.test.ts` / `Expected: FAIL (unrecognized arguments: --env)`
- [ ] **Step 3: Implement**: `env: null` in the defaults before `...settings`; `"--env": "--env"` in `RUN_SPEC.names`; `"--env"` in `VALUE_OPTIONS`; branch `name === "--env"` validating `v === ENV_NONE || isEnvPath(v) || isEnvName(v)` else `fail(...)` with the message above; after the loop, `if (args.env === ENV_NONE) args.env = null`. Add `env: null` to the `RunArgs` fixtures in `test/runs/run.test.ts` and `test/twofa.leak.test.ts`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/args.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/args.ts test/args.test.ts test/runs/run.test.ts test/twofa.leak.test.ts && git commit -m "feat: --env option"`

---

### Task 5: Load the environment at run start and record it in `history.json`

**Files:**
- Modify: `src/runs/run.ts`, `src/export.ts`
- Test: `test/runs/run.test.ts`

**Contracts:** C9, C2 (run-start failure)

**Interfaces:**
- Consumes: `loadEnvironment`, `EnvError` (Task 1); `RunArgs.env` (Task 4); `AgentOptions.environment` (Task 2)
- Produces: `historyJson(task, success, answer, steps, costUsd, history, taskFile = null, video = null, env: { name: string; path: string } | null = null): HistoryData`; `HistoryData.env?: { name: string; path: string }`

**Checks:** `node --test --test-timeout=60000 test/runs/run.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/runs/run.test.ts` (process `chdir` into a tmp dir holding `environments/staging.md` = `"Base: https://s\n"`; restore cwd after):
  - `run_passes_environment_text_to_agent`: args `env: "staging"` → the fake `createAgent` receives `environment === "Base: https://s"`; args `env: null` → `environment === null`.
  - `history_json_env_present_on_success_and_failure`: passing run with `env: "staging"` → `history.json` has `env: { name: "staging", path: <abs>/environments/staging.md }`, `Object.keys(h)` has `"env"` right after `"task_file"`, and the serialized file does not contain `"https://s"`; a run whose agent throws also writes `env`.
  - `history_json_env_absent_without_env`: `historyJson("t", true, "a", 1, 0, [])` has no `env` key and equals the call with an explicit `null` env.
  - `run_start_env_failure_fails_run`: args `env: "gone"` (no file) → outcome `exitCode === 1`, `error === "environment file not found: <abs>/environments/gone.md"`, `createAgent` never called, and `history.json` written without `env`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/runs/run.test.ts` / `Expected: FAIL (environment undefined; no env key)`
- [ ] **Step 3: Implement**: in `execute`, declare `let envRecord: { name: string; path: string } | null = null` before the `try`; first statement inside it: `const env = args.env ? loadEnvironment(args.env) : null; if (env) envRecord = { name: env.name, path: env.path };`; pass `environment: env?.text ?? null` to `createAgent`; pass `envRecord` as the new last argument to both `historyJson` calls. In the catch, add `else if (e instanceof EnvError) message = e.message;` before the generic `errorText`. `historyJson` spreads `...(env !== null ? { env } : {})` immediately after `task_file`. Add the optional field to `HistoryData` in `src/export.ts` (export ignores it).
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/runs/run.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/run.ts src/export.ts test/runs/run.test.ts && git commit -m "feat: load environment at run start and record it in history"`

---

### Task 6: CLI preflight and precedence

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Contracts:** C1 (file errors, exit codes), C2, C4 (precedence)

**Interfaces:**
- Consumes: `loadEnvironment`, `EnvError` (Task 1); `RunArgs.env` (Task 4)
- Produces: `preflight(deps, skill, state, env: string | null = null): string | null` (module-private)

**Checks:** `node --test --test-timeout=60000 test/cli.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts` (the `env()` helper already `chdir`s into `tmp`; write `environments/*.md` there; fake `createAgent` records `opts.environment`):
  - `cli_env_reaches_agent`: `main(["-p", ...argv, "--env", "staging"])` with `environments/staging.md` = `"STAGING"` → agent got `"STAGING"`, exit 0, history `env.name === "staging"`. Without `--env` → `environment === null` and history has no `env` key.
  - `cli_env_preflight_errors`: each exits 2 with the exact stderr line and never calls `createAgent`: `environment file not found: <tmp>/environments/nope.md`; `environment file too large: <p> is 16385 bytes (limit 16384)`; `environment file is empty: <p>`; `environment file cannot be read: <p>: not a file` (directory); `--env .x` → stderr has the usage then `duckwright: error: argument --env: invalid environment: '.x' (use a name of letters, digits, '.', '_' and '-', or a path to a .md file)`.
  - `cli_env_precedence_batch_and_none`: config (via `loadConfig` dep) `{ env: "cfg" }`, task file `a.md` with `env: file`, task file `b.md` without `env` (all three env files exist): `-p -f a.md b.md` → a gets `FILE`, b gets `CFG`; adding `--env cli` → both get `CLI` (D6); `--env none` → both get `null`; task file `env: none` with config `cfg` → `null`.
  - `cli_env_batch_errors_prefixed`: `-p -f a.md b.md` where both name missing envs → exit 2, stderr lines `a.md: environment file not found: …` and `b.md: environment file not found: …`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/cli.test.ts` / `Expected: FAIL (env never checked; agent environment undefined)`
- [ ] **Step 3: Implement**: `preflight` gains the `env` parameter; after the state check and before `which("claude")`: `if (env) try { loadEnvironment(env) } catch (e) { if (e instanceof EnvError) return e.message; throw e; }`. `preflightArgs` passes `args.env`. Precedence needs no other change (`parseRunArgs(argv, …, {...defaults, ...tf.settings})` already gives CLI > file > config).
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/cli.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/cli.ts test/cli.test.ts && git commit -m "feat: preflight the environment file"`

---

### Task 7: Plan mode writes `env:` into generated task files

**Files:**
- Modify: `src/plan.ts`, `src/cli.ts` (`planMain`)
- Test: `test/plan.test.ts`, `test/cli.test.ts`

**Contracts:** C10

**Interfaces:**
- Consumes: `isEnvName`, `resolveEnv` (Task 1); `RunArgs.env` (Task 4)
- Produces: `taskFileText(s: Scenario, source: string, setup: string | null, env: string | null = null): string`; `writePlan(doc: PlanDoc, planFile: string, root = "tasks", env: string | null = null): LoadedPlan` — `env` is a name, a path (relative to `process.cwd()` or absolute), or `null`

**Checks:** `node --test --test-timeout=60000 test/plan.test.ts test/cli.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `plan.test.ts` `task_file_text_env`: with setup and `env "staging"` the front matter is exactly `---`, `# From plan.md, scenario S1`, `setup: shared/setup.md`, `env: staging`, `---`; with `setup null` it is `---`, `# From …`, `env: staging`, `---`; with `env` omitted the text equals today's output.
  - `plan.test.ts` `write_plan_env_path_relative_to_folder`: in a tmp cwd, `writePlan(DOC, "qa.md", "tasks", "envs/eu.md")` writes `env: ../../envs/eu.md` into every task file, nothing into `shared/setup.md`, and `loadTaskFile(task).settings.env === resolvePath(<tmp>/envs/eu.md)`; `writePlan(DOC, "qa.md", "tasks", <tmp>/tasks/qa/envfile)` (absolute, no `.md`, inside the folder about to be created; the file need not exist) writes `env: ./envfile`; a name `"staging"` is written as `env: staging`.
  - `cli.test.ts` `cli_plan_writes_env`: `main(["-p", "--plan", "qa.md", "--env", "staging"])` with a fake `planner` → every written task file contains `\nenv: staging\n`; without `--env` none does.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/plan.test.ts test/cli.test.ts` / `Expected: FAIL (no env line)`
- [ ] **Step 3: Implement**: `taskFileText` adds `env: <env>` after the optional `setup:` line when `env !== null`. `writePlan` computes the value once after `freshFolder`: `null` → `null`; `isEnvName(env)` → `env`; else `rel = path.relative(resolvePath(folder), resolveEnv(env).path)`, prefixed with `./` when `rel` contains neither `/` nor `path.sep` and does not end in `.md` (so it is never re-read as a name). `planMain` calls `writePlan(r.doc, plan, "tasks", args.env)`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/plan.test.ts test/cli.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/plan.ts src/cli.ts test/plan.test.ts test/cli.test.ts && git commit -m "feat: plan mode writes env into task files"`

---

### Task 8: Manager overrides, effective label, environment listing, plan env

**Files:**
- Modify: `src/runs/manager.ts`
- Test: `test/runs/manager.test.ts`, `test/runs/manager-plan.test.ts`; fixture updates for the new `Effective.env` / `Globals.environments` fields in `test/tui/fake-manager.ts`, `test/tui/keys.test.ts`, `test/tui/state.test.ts`, `test/tui/form.test.ts` (`EFF`), and any other literal `Effective`/`Globals` that `npm run typecheck` flags

**Contracts:** C5 (state shape: `globals.environments`, `effective.env`, `inherited.env`, `globals.base.env`), C6 (data side)

**Interfaces:**
- Consumes: `envLabel`, `isEnvName`, `isEnvPath`, `resolveEnv`, `listEnvironments`, `ENV_NONE` (Task 1); `writePlan(..., env)` (Task 7)
- Produces:
  - `Overrides.env?: string | null` (a name, or `null` = none)
  - `Effective.env: string | null` (label, D14)
  - `Globals.environments: string[]`
  - Started/preflighted `RunArgs.env`: a name is replaced by its absolute path `<manager cwd>/environments/<name>.md`; a path or `null` is kept

**Checks:** `node --test --test-timeout=60000 test/runs/manager.test.ts test/runs/manager-plan.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `manager.test.ts` `manager_globals_environments_and_env_label`: manager with `cwd: tmp` (≠ `process.cwd()`), `tmp/environments/{qa,staging}.md`, `argv ["--env", "staging"]` → `globals()` deep-equals `{ base: { …, env: "staging" }, overrides: {}, environments: ["qa", "staging"] }`; adding `tmp/environments/zz.md` afterwards shows up in the next `globals()` call. Update the existing deep-equal at line ~101 to include `env: null` and `environments: []`.
  - `manager.test.ts` `manager_env_overrides_effective_and_inherited`: file task with `env: qa`; before any override `effective.env === "qa"`; `setGlobals({ env: "staging" })` (globals sit above file settings) → `effective.env === "staging"` and `inherited.env === "staging"`; `setOverrides(id, { env: null })` → `effective.env === null`, `inherited.env === "staging"`; `setGlobals({})` and `setOverrides(id, {})` → `effective.env === "qa"`.
  - `manager.test.ts` `manager_env_names_resolve_against_manager_cwd`: `cwd: tmp`; global override `{ env: "qa" }` → the `RunArgs` given to the injected `preflight` and to `startRun` have `env === resolvePath(<tmp>/environments/qa.md)`; a path value from argv (`--env /abs/x.md`) is passed unchanged; `effective.env` is still `"qa"`.
  - `manager.test.ts` `manager_env_preflight_failure_is_task_error`: injected `preflight` returning `"environment file not found: /x"` → `start` returns `{ ok: false }`, task `error` is that message and a toast with it is emitted (existing path; asserts it carries through).
  - `manager-plan.test.ts` `plan_writes_env_from_global_override_else_argv`: planner fake; `argv ["--env", "cfg"]` → generated task files contain `env: cfg`; after `setGlobals({ env: "qa" })` a new plan writes `env: qa`; after `setGlobals({ env: null })` a new plan writes no `env:` line.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/runs/manager.test.ts test/runs/manager-plan.test.ts` / `Expected: FAIL (no env in Effective/Globals)`
- [ ] **Step 3: Implement**:
  - `effectiveOf` adds `env: envLabel(a.env)`.
  - `globals()` returns `environments: listEnvironments(this.#cwd())` where `#cwd()` is `this.#o.cwd ?? process.cwd()` (reuse it in `#specOf` and `#fileName`).
  - `#argsFor`: in the override loop `if (o.env !== undefined) args.env = o.env === ENV_NONE ? null : o.env;` then, after the loop, `if (args.env !== null && isEnvName(args.env)) args.env = resolveEnv(args.env, this.#cwd()).path;`.
  - `#startPlanning`: raw env = `this.#globals.env !== undefined ? this.#globals.env : parseRunArgs(argv, defaultSkill, settings).args.env`; if it is a path, make it absolute with `resolveEnv(env, this.#cwd()).path`; pass it as `writePlan(doc, plan.source, root, env)`.
  - Update the type fixtures listed under **Files** (add `env: null` to every `Effective` literal, `environments: []` to every `Globals` literal).
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/runs/manager.test.ts test/runs/manager-plan.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/manager.ts test/runs/manager.test.ts test/runs/manager-plan.test.ts test/tui/fake-manager.ts test/tui/keys.test.ts test/tui/state.test.ts test/tui/form.test.ts && git commit -m "feat: environment overrides and listing in the run manager"` (add any other fixture file typecheck required, by explicit path)

---

### Task 9: Web API accepts `env` overrides

**Files:**
- Modify: `src/web/api.ts`
- Test: `test/web/api.test.ts`

**Contracts:** C5

**Interfaces:**
- Consumes: `isEnvName`, `ENV_NONE` (Task 1); `Overrides.env`, `Globals.environments` (Task 8)
- Produces: `parseOverrides` returns `env` per C5

**Checks:** `node --test --test-timeout=60000 test/web/api.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/web/api.test.ts`:
  - `parse_overrides_env`: `{ env: "staging" }` → `{ env: "staging" }`; `{ env: null }` → `{ env: null }`; `{ env: "none" }` → `{ env: null }`; `{}` → `{}` (no `env` key); each of `{ env: 3 }`, `{ env: "a/b.md" }`, `{ env: "x.md" }`, `{ env: ".x" }`, `{ env: "" }` → `"env must be an environment name or null"`.
  - `put_globals_env_round_trip`: `PUT /api/globals` `{ env: "qa" }` → `200 {"ok": true}` and the fake manager's `setGlobals` got `{ env: "qa" }`; `PUT /api/tasks/1/overrides` `{ env: "a/b" }` → `400 {"ok": false, "error": "env must be an environment name or null"}`; `GET /api/state` body `globals.environments` equals the fake manager's list.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/web/api.test.ts` / `Expected: FAIL (env dropped)`
- [ ] **Step 3: Implement** in `parseOverrides`: when `raw.env !== undefined`: `null` or `ENV_NONE` → `o.env = null`; a string with `isEnvName` → `o.env = raw.env`; otherwise return the error string.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/web/api.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/web/api.ts test/web/api.test.ts && git commit -m "feat: env in web API overrides"`

---

### Task 10: TUI environment picker and display

**Files:**
- Modify: `src/tui/form.ts`, `src/tui/keys.ts`, `src/tui/optionsPane.ts`, `src/tui/app.ts` (the `openForm` call at line ~305), `src/tui/detail.ts`
- Test: `test/tui/form.test.ts`, `test/tui/app.test.ts`

**Contracts:** C6 (TUI)

**Interfaces:**
- Consumes: `Effective.env`, `Overrides.env`, `Globals.environments` (Task 8); `isEnvName`, `ENV_NONE` (Task 1)
- Produces: `FieldKey` gains `"env"` (label `environment`, last in `ORDER`, so `FIELD_COUNT === 7`); `FormState.environments: readonly string[]`; `openForm(taskId, effective, overrides, focus = 0, environments: readonly string[] = []): FormState`

**Checks:** `node --test --test-timeout=60000 test/tui/form.test.ts test/tui/app.test.ts test/tui/keys.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `form.test.ts` `form_env_field_open`: `openForm(null, { ...EFF, env: null }, {}, 0, ["qa", "staging"])` → last field `{ key: "env", label: "environment", raw: "none", overridden: false, effective: "none" }`; with `overrides { env: null }` → `raw "none"`, `overridden true`; with `overrides { env: "qa" }` → `raw "qa"`, `overridden true`. Update the existing key/label/raw lists in `form_open_prefills_effective_and_overrides` and `form_evidence_fields` to end with `"env"` / `"environment"` / `"none"`.
  - `form.test.ts` `form_env_cycles_and_resets`: effective env `"eu"` (not listed), environments `["qa", "staging"]`, focus on env: `space` → `"none"`, `right` → `"qa"`, `left` → `"staging"`, `space` → `"eu"` (current value first, then `none`, then names, wrapping), typing `"x"` and `backspace` leave `raw` unchanged; `ctrl+r` → `raw "eu"`, `overridden false`. `formResult` after cycling to `"none"` → `{ ok: true, overrides: { env: null } }`; after cycling to `"qa"` → `{ env: "qa" }`; after ctrl+r → no `env` key.
  - `app.test.ts` `options_pane_and_detail_show_environment`: with `FakeManager.globalsValue = { base: { …, env: "staging" }, overrides: {}, environments: ["staging"] }` the options pane frame has a row `environment` with `staging`; an idle task with `effective.env null` shows `environment  none` in the detail pane (label padded like the other settings rows).
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/tui/form.test.ts test/tui/app.test.ts` / `Expected: FAIL (no env field)`
- [ ] **Step 3: Implement**:
  - `form.ts`: `openForm` builds the env field from `effective.env ?? "none"` and `overrides.env` (`null` → `"none"`) and stores `environments` on the state; `validate("env", raw)` returns `null` when `raw === "none" || isEnvName(raw)` else `"environment must be a name or none"` (never calls `settingValue`). In `formKey`, for `env`: toggle keys (left, right, space all advance, like `snapshot`) step through `choices = ["none", ...f.environments]` with `cur.effective` (the value shown when the form opened) prepended when absent, so the cycle is stable while `raw` changes; other input returns `f` unchanged; ctrl+r keeps the shared reset path. `formResult` maps env as `raw === "none" ? null : raw` instead of `settingValue`.
  - TUI cycle has **no** explicit `inherit` entry: inherit is ctrl+r, as for every other field (C6). The web select carries the explicit `inherit (…)` choice (Task 11).
  - Callers pass the list: `keys.ts` (three `openForm` calls: per-task `o`, global `O`, options-pane `⏎`/`O`) and `optionsPane.ts` and `app.ts` pass `c.s.globals?.environments ?? []` / `g.environments` / `s.globals.environments`.
  - `detail.ts`: `SETTINGS` gains `["env", "environment"]`; the value is `String(t.effective[key] ?? "none")`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/tui/form.test.ts test/tui/app.test.ts test/tui/keys.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/form.ts src/tui/keys.ts src/tui/optionsPane.ts src/tui/app.ts src/tui/detail.ts test/tui/form.test.ts test/tui/app.test.ts && git commit -m "feat: environment picker in the TUI"`

---

### Task 11: Web UI environment chip and select

**Files:**
- Create: `web/src/environment.ts` (pure helpers; no Node imports, it ships in the browser bundle)
- Modify: `web/src/OptionsStrip.tsx`, `web/src/dialogs/OptionsDialog.tsx`
- Test: `test/web/ui-environment.test.ts`

**Contracts:** C6 (web), C5 (client side)

**Interfaces:**
- Consumes: `Overrides.env`, `Effective.env`, `Globals.environments` (Task 8)
- Produces:
  - `envValue(env: string | null): string` — `env ?? "none"`
  - `envDraft(o: { env?: string | null }): string` — `""` when absent, `"none"` for `null`, else the name
  - `envBody(draft: string): { env?: string | null }` — `""` → `{}`, `"none"` → `{ env: null }`, else `{ env: draft }`
  - `envOptions(inherited: string | null, environments: readonly string[], draft: string): { value: string; label: string }[]` — `{ value: "", label: "inherit (<inherited ?? none>)" }`, `{ value: "none", label: "none" }`, each listed name, plus `draft` appended when it is a name not in the list

**Checks:** `node --test --test-timeout=60000 test/web/ui-environment.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing test** `test/web/ui-environment.test.ts`: `envValue(null) === "none"`, `envValue("qa") === "qa"`; `envDraft({}) === ""`, `envDraft({ env: null }) === "none"`, `envDraft({ env: "qa" }) === "qa"`; `envBody("")` → `{}`, `envBody("none")` → `{ env: null }`, `envBody("qa")` → `{ env: "qa" }`; `envOptions(null, [], "")` → `[{ value: "", label: "inherit (none)" }, { value: "none", label: "none" }]`; `envOptions("staging", ["qa", "staging"], "old")` → inherit `(staging)`, `none`, `qa`, `staging`, `old`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/web/ui-environment.test.ts` / `Expected: FAIL with module not found`
- [ ] **Step 3: Implement** the helpers. `OptionsStrip`: add `chip("env", envValue(eff.env), o.env !== undefined)` after `screenshot`. `OptionsDialog`: `Draft.env: string` initialised with `envDraft(overrides)`; "Reset all" sets `env: ""`; a `.field` with `<label htmlFor="opt-env">environment</label>` and `<select id="opt-env">` rendering `envOptions(inherited.env, g?.environments ?? [], draft.env)` (`inherited` is `task.inherited` for a task, `g.base` for globals); `save` adds `Object.assign(o, envBody(draft.env))`. Server errors already show via `setError`.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/web/ui-environment.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add web/src/environment.ts web/src/OptionsStrip.tsx web/src/dialogs/OptionsDialog.tsx test/web/ui-environment.test.ts && git commit -m "feat: environment picker in the web UI"`

---

### Task 12: System prompt, README, example, roadmap

**Files:**
- Modify: `prompts/system.md`, `README.md`
- Create: `examples/environments/staging.md`
- Test: `test/prompt.test.ts` (system prompt wording)

**Contracts:** C7, C8

**Interfaces:** None

**Checks:** `node --test --test-timeout=60000 test/prompt.test.ts`, `npm test`

- [ ] **Step 1: Write the failing test** in `test/prompt.test.ts` `system_prompt_mentions_environment`: `prompts/system.md` (via `ROOT`) contains `"the task, the environment context when the run has one, your memory notes, the open tabs, and the current page's accessibility snapshot"` and the `## Environment context` section text from C7 verbatim; `examples/environments/staging.md` exists, is under 2048 bytes, and has the headings `Base URL`, `Test accounts`, `Seeded data`, `Feature flags`, `Known quirks`, `Off-limits`.
- [ ] **Step 2: Run it**: `Run: node --test --test-timeout=60000 test/prompt.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**:
  - `prompts/system.md`: the first-paragraph list change and the new section after the intro, both verbatim from C7.
  - `examples/environments/staging.md`: a commented sample with the six headings; credentials referenced only by env-var name and a `--state` file; no real secrets.
  - `README.md`: Usage table row after `--state`: `` | `--env` | none | Environment context: the text of `environments/ENV.md` (or of the `.md` file at path ENV) is put into every step's prompt; `none` = no environment (see [Environment context](#environment-context)) | ``; add `[--env ENV]` after `[--state FILE]` in the Usage code block; task-file key table row after `setup`: `` | `env` | an environment name, `none`, or a path to its file (see [Environment context](#environment-context)) | ``; task-file bullet "Relative `skill`, `state`, `setup` and `env` paths …"; Global config bullet "Relative `skill`, `state` and `env` paths …"; new `### Environment context` section between `### Two-factor verification` and `### Task files` covering every C8 point (folder and naming, `--env`/`env:`/config and precedence incl. batch D6, `none`, 16 KB limit and the four preflight messages, every-step `<environment>` placement after `<task>`, history `env` record, TUI/web picker, plan mode `env:`, never put raw secrets in it; reference them by name, like `--state`); roadmap `- [ ] **Environment context**` → `- [x] **Environment context**`, text otherwise unchanged.
- [ ] **Step 4: Run it**: `Run: node --test --test-timeout=60000 test/prompt.test.ts && npm test` / `Expected: PASS (full suite and both typechecks)`
- [ ] **Step 5: Commit**: `git add prompts/system.md README.md examples/environments/staging.md test/prompt.test.ts && git commit -m "docs: environment context docs, example and system prompt"`

## Manual e2e

- [ ] A real run against a live site (`duckwright -p --env staging "…"` with `claude` and `playwright-cli` installed) to confirm the agent actually uses the environment context. Not part of the run's verification.
