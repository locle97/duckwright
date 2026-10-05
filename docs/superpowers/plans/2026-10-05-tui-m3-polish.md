# TUI M3 polish Implementation Plan

**Goal:** Every run writes `runs/<id>/events.jsonl`; `duckwright --tui` shows past runs from `runs/` as read-only, re-runnable tasks, filters the sidebar with `/`, and draws colours from a theme (`--theme auto|dark|light`, truecolor palettes, `NO_COLOR`).
**Architecture:** `src/runs/` gains a JSONL event sink (wired in `startRun`) and a past-run loader that turns run folders into `PastRun`s with a `RunEvent[]` timeline; `RunManager` holds them as tasks. The TUI replays those events through its existing reducer at mount, adds a pure filter module plus a `filter` mode, and reads colours from a `Theme` delivered by a React context. `cli.ts` parses/validates the two new flags and wires warnings, past runs, theme and notices.
**Tech Stack:** TypeScript (Node ≥ 22.18, `.ts` run directly by `node --test`), Ink 8, React 19, `ink-testing-library`, `node:assert/strict`.
**Spec:** `docs/superpowers/specs/2026-10-05-tui-m3-polish-design.md`

## Global Constraints

- Mouse is not built, and there is no `--mouse` flag.
- `events.jsonl`: one `JSON.stringify(event)` per line, `\n`-terminated, every `RunEvent` as emitted (with `at`), in emit order, ending with `run:end`.
- The first failed append disables the sink for that run (no retries) and calls `RunDeps.onWarning` once with `could not write <file>: <error message>`. The `RunOutcome` is never touched.
- Plain and batch mode print `warning: could not write <file>: <message>` on stderr; stdout is unchanged. The TUI shows it as an error toast (via `RunManager.notify`).
- `RunArgs` gains optional `past?: number` and `theme?: ThemeName`, set only when the flag is given, so existing `RunArgs` literals and `deepEqual` tests stay valid.
- `src/events.ts` is unchanged. `src/runs/` stays free of UI code; only `src/tui/` imports Ink or React.
- Past runs are not `RunRecord`s, so they never enter `summary()` or the exit code.
- Plain text keeps the terminal's default colour, as today. The dark 16-colour palette is exactly today's `theme.ts`; `ROLE`, `TASK_ICON`, `STEP_ICON` stay exported with today's values.
- Existing tests are not edited. All checks run through `npm test` (typecheck plus `node --test`) and `npm run typecheck`. No e2e.

## Review Focus

1. Failing sink: `<workdir>/events.jsonl` created as a directory → `onWarning` called exactly once, and the `RunOutcome` (minus `historyPath`) deep-equals a working-sink run (Task 1, `run_failing_sink_keeps_outcome`).
2. Past-run discovery boundaries: newest N by name returned oldest first, non-matching names not counted, invalid `history.json` counted, `events.jsonl` without final `run:end` falls back to synthesis (Task 2).
3. Past runs must never reach `summary()`/exit code or the header totals until re-run (Task 3 `manager_past_excluded_from_summary`, Task 5 `state_header_skips_past`).
4. Filter selection: hidden selection snaps to first visible; `selectedTask` is `null` when nothing is visible so no key acts on a hidden task (Task 6 `state_filter_selection`, Task 7 `keys_filter_no_visible_task_noop`).
5. `NO_COLOR` set and non-empty wins over `--theme`; `NO_COLOR=""` keeps colours (Task 4 `theme_no_color`).

---

### Task 1: `events.jsonl` sink and `RunDeps.onWarning`

**Files:**
- Create: `src/runs/sink.ts`
- Modify: `src/runs/run.ts`
- Test: `test/runs/sink.test.ts` (new), `test/runs/run.test.ts` (new cases appended)

**Interfaces:**
- Produces: `export function jsonlSink(file: string, onFail: (message: string) => void): (e: RunEvent) => void` in `src/runs/sink.ts`; `RunDeps.onWarning?: (message: string) => void` in `src/runs/run.ts`.

**Checks:** `node --test test/runs/sink.test.ts test/runs/run.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `sink.test.ts` `sink_appends_one_line_per_event`: in a `tmpDir()` (from `test/helpers.ts`), `const s = jsonlSink(file, fail)`; call with three events (`run:start`, `step:start`, `run:end` literals with `at`); file text ends with `"\n"`, `text.trimEnd().split("\n").map(JSON.parse)` deep-equals the three objects in order; `fail` never called.
  - `sink_failure_calls_on_fail_once`: `file` = a path whose parent is a regular file (e.g. `<tmp>/f/events.jsonl` after `writeFileSync(<tmp>/f, "")`); calling the sink 5 times never throws; `onFail` called once with a message that starts with `could not write ${file}: `.
  - `run.test.ts` `run_writes_events_jsonl`: fake agent emits one `step:end` then returns `result(true, [rec()], 0.5)`; also subscribe to `h.events` and collect every event; after `done`, the lines of `<workdir>/events.jsonl` parse to objects deep-equal to the collected events, in order, last `type === "run:end"`.
  - `run_failing_sink_keeps_outcome`: fake `createAgent` does `fs.mkdirSync(path.join(opts.workdir, "events.jsonl"))` before returning the agent; deps get `onWarning: (m) => warnings.push(m)`. Run the same fake agent (without the mkdir) with a working sink. Assert `warnings.length === 1`, `warnings[0]` starts with `could not write ` and contains `events.jsonl`, and the two outcomes deep-equal after dropping `historyPath` from each (`const { historyPath: _, ...rest } = o`); each run has its own folder, so `historyPath` differs.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/sink.test.ts test/runs/run.test.ts` / `Expected: FAIL (sink.ts missing; no events.jsonl written)`
- [ ] **Step 3: Implement** `jsonlSink` with `fs.appendFileSync(file, JSON.stringify(e) + "\n")` inside try/catch; on the first throw set a `dead` flag and call `onFail(\`could not write ${file}: ${err.message}\`)`; later calls return at once. In `startRun`, right after `makeRunDir` succeeds and before `execute`: `events.subscribe(jsonlSink(path.join(workdir, "events.jsonl"), (m) => deps.onWarning?.(m)))`. Nothing else in `run.ts` changes; no sink when `makeRunDir` throws.
- [ ] **Step 4: Run it**: `Run: node --test test/runs/sink.test.ts test/runs/run.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/sink.ts src/runs/run.ts test/runs/sink.test.ts test/runs/run.test.ts && git commit -m "feat(runs): append every run event to events.jsonl"`

---

### Task 2: Past-run loader

**Files:**
- Create: `src/runs/past.ts`
- Test: `test/runs/past.test.ts` (new)

**Interfaces:**
- Consumes: `RunEvent`, `RunOutcome` (`src/events.ts`); `HistoryData`, `HistoryStep` (`src/export.ts`); `loadTaskFile`, `TaskSettings` (`src/taskfile.ts`); `TaskSource` (type-only from `src/runs/manager.ts`).
- Produces:
  ```ts
  export interface PastRun { id: string; workdir: string; text: string; source: TaskSource; fileSettings: TaskSettings; events: RunEvent[]; outcome: RunOutcome }
  export interface PastFs { listDirs(p: string): string[]; readFile(p: string): string; mtimeMs(p: string): number; exists(p: string): boolean }
  export function loadPastRuns(o: { runsDir: string; limit: number; cwd?: string; fs?: PastFs }): { runs: PastRun[]; skipped: number }
  export function readEventsJsonl(text: string): RunEvent[] | null
  export function eventsFromHistory(h: HistoryData, workdir: string, at: number): RunEvent[]
  export function outcomeFromHistory(h: HistoryData, historyPath: string): RunOutcome
  ```

**Checks:** `node --test test/runs/past.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (temp `runs/` folders built with a helper `mkRun(name, history?, eventsText?)` that writes `history.json` via `historyJson(...)` from `src/runs/run.ts`):
  - `past_newest_n_oldest_first`: folders `20261001-100000-a`, `20261002-100000-b`, `20261003-100000-c`, plus `notes`, `x-20261004-100000` (non-matching, ignored) and a regular file `20261005-100000-f`; `limit: 2` → `runs.map(r => r.id)` = `["20261002-100000-b", "20261003-100000-c"]`, `skipped: 0`; `workdir` = `path.join(runsDir, id)`.
  - `past_limit_zero_and_missing_dir`: `limit: 0` → `{ runs: [], skipped: 0 }`; `runsDir` that does not exist → `{ runs: [], skipped: 0 }`.
  - `past_invalid_history_skipped_and_counted`: newest folder has no `history.json`, next has `{` (bad JSON), next has `success: "yes"`, next has a step whose `results` is not an array, oldest valid; `limit: 5` → one run, `skipped: 4`. With `limit: 1` and the newest folder valid, the invalid older folders are not read: `skipped: 0`.
  - `past_state_mapping_from_history`: no `events.jsonl`; `success: true` → `outcome.status "pass"`, `exitCode 0`, `error null`; `success: false, answer: "interrupted"` → `"stop"`, `130`, `error "interrupted"`; `success: false, answer: "boom"` → `"fail"`, `1`, `error "boom"`; every synthesised outcome has `costUsd` = `cost_usd`, `historyPath` = `<workdir>/history.json`, `export: { kind: "off" }`, `warnings: []`, `steps` = `steps`.
  - `past_synthesised_events`: history with `steps: 2`, one step with two actions (`results: ["ok"]` — second result missing, `code` of the second `null`); events types in order `run:start, step:start, decision, action:result, action:result, step:end, run:end`; `run:start` has `maxSteps: 2, model: "", snapshot: "hybrid", headed: false, session: "", workdir`; `decision.cost === 0`; second `action:result.result === ""`, `code === null`; `step:end` `cost 0`, `durationMs 0`, `record.codes` = action codes; every `at` = `fs.statSync(history.json).mtimeMs`. With `steps: 0` → `maxSteps: 1`.
  - `past_prefers_complete_events_jsonl`: valid history with `success: false` plus `events.jsonl` whose `run:end` outcome has `status: "pass"` → `events` deep-equal the file's events and `outcome.status === "pass"`.
  - `past_falls_back_on_bad_events_jsonl`: three cases — a malformed line, an unknown `type`, and no final `run:end` — each gives synthesised events (first event `run:start` with `model: ""`) and `skipped: 0`. Also `readEventsJsonl("")` and a line without numeric `at` → `null`; trailing `"\n"` allowed.
  - `past_task_source`: `task_file` pointing to an existing file with front matter `---\nmodel: opus\nsession: x\n---\nDo the file thing` → `source { kind: "file", path: <task_file as recorded> }`, `text "Do the file thing"`, `fileSettings { model: "opus" }` (no `session`); `task_file` missing on disk → `{ kind: "typed" }`, `text` = `history.task`, `fileSettings {}`; file with unclosed front matter → typed; `task_file` absent from the JSON → typed. Use absolute `task_file` paths, or pass `cwd: tmp` with relative ones.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/past.test.ts` / `Expected: FAIL (module not found)`
- [ ] **Step 3: Implement** in `src/runs/past.ts`:
  - Folder names must match `/^\d{8}-\d{6}-/` and be directories (`listDirs` returns directory names only; a missing/unreadable `runsDir` → `[]`). Sort by name descending; read until `limit` runs have loaded; count every read folder that fails validation in `skipped`; return `runs` reversed (oldest first).
  - Validation of `history.json` (any read/parse/shape failure = skipped): string `task`, boolean `success`, string `answer`, number `steps`, number `cost_usd`, `task_file` string/null/missing (missing → null), array `history` whose entries have number `step`, strings `evaluation_previous_goal`/`memory`/`next_goal`, `actions` array of `{ cmd: string, args: string[], code: string | null | missing }`, `results` string array.
  - `readEventsJsonl`: drop one trailing empty line; every line must `JSON.parse` to an object with `type` in the ten `RunEvent` types and numeric `at`; last must be `run:end`; else `null`.
  - Source: when `task_file` is set and `exists(path.resolve(cwd ?? process.cwd(), task_file))`, try `loadTaskFile(resolved)`; on success the source path is the recorded `task_file`, settings minus `session`; any throw → typed.
  - Default `PastFs` wraps `node:fs` (`readdirSync(..., { withFileTypes: true })`, `readFileSync(.., "utf8")`, `statSync().mtimeMs`, `existsSync`).
- [ ] **Step 4: Run it**: `Run: node --test test/runs/past.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/past.ts test/runs/past.test.ts && git commit -m "feat(runs): load past runs from runs/ folders"`

---

### Task 3: Past tasks and `notify` in `RunManager`

**Files:**
- Modify: `src/runs/manager.ts`
- Test: `test/runs/manager.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `PastRun` (Task 2).
- Produces: `ManagerOptions.past?: PastRun[]`; `TaskSnapshot.past?: { runId: string; events: RunEvent[] }`; `RunManager.notify(level: "info" | "error", message: string): void` (not on `ManagerLike`).

**Checks:** `node --test test/runs/manager.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (build `PastRun` literals inline with a helper `pastRun(id, status, over?)`):
  - `manager_past_tasks_first`: `setup({ past: [p1 (fail), p2 (pass, file source /abs/a.md)] })`, then `addTyped("new")`; `list()` ids `[1, 2, 3]`; task 1 `state "failed"`, `runId` = p1.id, `runCount 0`, `past` deep-equals `{ runId: p1.id, events: p1.events }`; task 2 `state "passed"`, `source { kind: "file", path: "/abs/a.md" }`, name = path relative to `cwd`; task 3 has no `past` key (`"past" in t === false`); no `task:added` event was emitted for past tasks.
  - `manager_past_excluded_from_summary`: one failed past task, no session runs → `summary()` deep-equals `{ lines: [], exitCode: 0 }`.
  - `manager_rerun_past_task`: `start(1)` on a file past task → `fakes[0].spec.task` = past `text`, `spec.taskFile` = source path; after the run starts the snapshot `runId === "run-1"`, `past.runId === "run-1"`, `runCount 1`, state follows the session run; after `finish(outcome("pass"))` the summary has one line for it.
  - `manager_past_file_duplicate`: past file task `/abs/a.md` (write a real task file in `tmpDir()` and use its path) then `add({ mentions: [thatPath], typed: null })` → `duplicates` holds its name, nothing added.
  - `manager_notify_emits_toast`: `notify("error", "x")` → last event deep-equals `{ type: "toast", level: "error", message: "x" }`.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/manager.test.ts` / `Expected: FAIL (past option ignored; notify missing)`
- [ ] **Step 3: Implement**: `Task.past: PastRun | null` (null for session-added tasks). The constructor pushes one task per `o.past` entry in order (ids from `#nextId`, name `#fileName(path)` for file sources else `taskName(text)`, `fileSettings` from the past run, `state = OUTCOME_TO_STATE[past.outcome.status]`), emitting nothing. `#snapshot`: `runId` = latest session run id ?? `past?.id` ?? null; add `past: { runId, events }` only when `task.past` is set, with this comment on that line: `// runId is the latest session run's id after a re-run (else the folder id), like the snapshot's runId; the UI only replays at mount.` `runCount` stays `task.runs.length`. `notify` calls `#emit({ type: "toast", level, message })`. `summary()` needs no change (past tasks have no `runs`).
- [ ] **Step 4: Run it**: `Run: node --test test/runs/manager.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/manager.ts test/runs/manager.test.ts && git commit -m "feat(runs): past runs as manager tasks, and notify"`

---

### Task 4: Themes and theme context

**Files:**
- Modify: `src/tui/theme.ts`
- Create: `src/tui/themeContext.ts`
- Test: `test/tui/theme.test.ts` (new cases appended)

**Interfaces:**
- Produces (in `theme.ts`, pure):
  ```ts
  export type ThemeName = "auto" | "dark" | "light";
  export const THEME_NAMES: readonly ThemeName[] = ["auto", "dark", "light"];
  export type ColorRole = "muted" | "accent" | "border" | "error" | "idle" | "running" | "paused" | "passed" | "failed" | "stopped" | "warn" | "done";
  export interface Theme { color: boolean; role: Record<ColorRole, string | undefined>; taskIcon(state: TaskState): { icon: string; color: string | undefined }; stepIcon(kind: "ok" | "warn" | "brain" | "done"): { icon: string; color: string | undefined } }
  export function isLightBackground(colorfgbg: string | undefined): boolean
  export function resolveTheme(name: ThemeName, env: Record<string, string | undefined>): Theme
  export function paneBorder(theme: Theme, focused: boolean): { borderStyle: "round" | "bold"; borderColor?: string }
  export const DEFAULT_THEME: Theme // dark, 16 colours
  ```
  In `themeContext.ts`: `export const ThemeContext = createContext<Theme>(DEFAULT_THEME)` and `export function useTheme(): Theme`.

**Checks:** `node --test test/tui/theme.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `theme_palettes`: `resolveTheme("dark", {})`, `("light", {})`, `("dark", { COLORTERM: "truecolor" })`, `("light", { COLORTERM: "24bit" })` roles deep-equal the four columns below; `COLORTERM: "TrueColor"` also gives hex; `COLORTERM: "yes"` gives 16-colour; every one has `color: true`.
  - `theme_auto`: `auto` with `COLORFGBG` `"15;0"` → dark palette, `"0;15"` → light, `"0;7"` → light, `"0;8"` → dark, `"default;0"` → dark, unset → dark. `isLightBackground("0;9")` true, `("0;16")` false, `("abc")` false.
  - `theme_no_color`: for each of `auto`, `dark`, `light` with `{ NO_COLOR: "1", COLORTERM: "truecolor" }` → `color: false`, every role `undefined`, `taskIcon("passed")` = `{ icon: "✓", color: undefined }`; `paneBorder(t, true)` = `{ borderStyle: "bold" }`, `paneBorder(t, false)` = `{ borderStyle: "round" }`. `NO_COLOR: ""` keeps colours.
  - `theme_default_matches_constants`: `DEFAULT_THEME.taskIcon(s)` deep-equals `TASK_ICON[s]` for every state, `stepIcon(k)` equals `STEP_ICON[k]`, `role.muted/accent/border/error` equal `ROLE`; `paneBorder(DEFAULT_THEME, true)` = `{ borderStyle: "round", borderColor: "cyan" }`, unfocused `borderColor: "gray"`.
  - Palettes (role: dark16 / light16 / dark-true / light-true): muted `gray`/`gray`/`#808080`/`#6c6c6c`; accent `cyan`/`blue`/`#5fd7ff`/`#005f87`; border `gray`/`gray`/`#585858`/`#a8a8a8`; error `red`/`red`/`#ff5f5f`/`#d70000`; idle `gray`/`gray`/`#808080`/`#6c6c6c`; running `yellow`/`magenta`/`#ffd75f`/`#af8700`; paused `blue`/`blue`/`#5f87ff`/`#005fd7`; passed `green`/`green`/`#5fd75f`/`#008700`; failed `red`/`red`/`#ff5f5f`/`#d70000`; stopped `#ff8700`/`#af5f00`/`#ff8700`/`#d75f00`; warn `yellow`/`magenta`/`#ffd75f`/`#af8700`; done `cyan`/`blue`/`#5fd7ff`/`#005f87`.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/theme.test.ts` / `Expected: FAIL (resolveTheme not exported)`
- [ ] **Step 3: Implement**: `isLightBackground`: last `;`-field, `/^\d+$/`, light when `7` or `9..15`. `resolveTheme`: `NO_COLOR` non-empty → all roles `undefined`, `color: false`; else `auto` resolves via `COLORFGBG`, truecolor when `COLORTERM.toLowerCase()` is `truecolor` or `24bit`. Task icons keep today's glyphs; colour role is the state name, except `stopping` → `stopped`. Step icons: `ok`→`passed`, `warn`→`warn`, `brain`→`failed`, `done`→`done`. `paneBorder`: focused → accent colour with `round`, or `bold` with no colour when `!theme.color`; unfocused → `round` + `border` role. Keep `ROLE`, `TASK_ICON`, `STEP_ICON`, `SPINNER`, `spinnerFrame`, `PHASE_LABEL` unchanged.
- [ ] **Step 4: Run it**: `Run: node --test test/tui/theme.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/theme.ts src/tui/themeContext.ts test/tui/theme.test.ts && git commit -m "feat(tui): dark, light, truecolor and NO_COLOR themes"`

---

### Task 5: Past-run replay, header totals and startup notices in the view state

**Files:**
- Modify: `src/tui/state.ts`
- Test: `test/tui/state.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `TaskSnapshot.past` (Task 3).
- Produces: `RunView.past?: boolean`; `initialState(now: number, tasks?: TaskSnapshot[], notices?: string[]): ViewState`.

**Checks:** `node --test test/tui/state.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (a `pastTask(id, runId, events)` helper sets `past: { runId, events }`, `runId`, `runCount: 0`, `state: "passed"`):
  - `state_replays_past_runs`: events `run:start` (maxSteps 5), two steps each with `step:start`, `decision`, `action:result`, `step:end`, then `run:end` with outcome `costUsd: 0.25`; `initialState(0, [pastTask(1, "20261001-100000-a", events)])` → `runs["20261001-100000-a"]` has 2 steps, `past: true`, `follow: false`, `selected: 1`, `expanded: []`, `cost: 0.25`, `outcome` = that outcome; `selectedRun(s)` is that view.
  - `state_replay_crash_keeps_outcome`: events `run:start`, `step:start {step 1}`, `decision` with `decision: null as never`, `run:end` → view `steps: []`, `outcome` set, `past: true`, `cost` = outcome cost.
  - `state_header_skips_past`: tasks = past task (cost 0.25, state passed, runCount 0) + a session task `task(2, "running", "r2")` whose run view (added via `run:start` manager event and a `decision` with cost 0.1) → `headerCounts(s).counts` deep-equals `{ running: 1 }`, `cost` 0.1. A past task with `runCount: 1` and state `failed` is counted.
  - `state_notices_become_toasts`: `initialState(0, [], ["skipped 2 unreadable run folders in runs/"])` → one toast `level "info"` with that message.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/state.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: in `initialState`, for each task with `past`, fold its events through `reduceManager` as `{ type: "run", taskId, runId: past.runId, event }` inside `try`; on a throw (or no view produced) use a fresh empty `RunView` keyed by `past.runId` whose `outcome` is the last `run:end` outcome in the events (`null` if none). Then set `past: true`, `follow: false`, `selected: max(0, steps.length - 1)`, `expanded: []`, `cost: outcome?.costUsd ?? view.cost`. Queue each notice with `addToast(s, "info", n)`. `headerCounts`: skip run views with `past`, and skip tasks with `past !== undefined && runCount === 0` from `counts`.
- [ ] **Step 4: Run it**: `Run: node --test test/tui/state.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/state.ts test/tui/state.test.ts && git commit -m "feat(tui): replay past runs into run views"`

---

### Task 6: Filter model and filter state

**Files:**
- Create: `src/tui/filter.ts`
- Modify: `src/tui/state.ts`
- Test: `test/tui/filter.test.ts` (new), `test/tui/state.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `KeyPress` (`src/tui/keypress.ts`).
- Produces:
  ```ts
  // filter.ts (pure)
  export function matches(task: { name: string; text: string }, query: string): boolean
  export function visibleIndexes(tasks: { name: string; text: string }[], query: string): number[]
  export function filterKey(query: string, key: KeyPress): string | null
  // state.ts
  ViewState.filter: string; ViewState.filterDraft: string | null; Mode adds "filter"
  UiAction adds { type: "openFilter" } | { type: "filterEdit"; query: string } | { type: "filterKeep" } | { type: "filterClear" }
  export function activeQuery(s: ViewState): string   // filterDraft ?? filter
  export function visibleTasks(s: ViewState): number[] // visibleIndexes(s.tasks, activeQuery(s))
  ```

**Checks:** `node --test test/tui/filter.test.ts test/tui/state.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `filter.test.ts` `filter_matches`: `matches({ name: '"Login"', text: "Login page" }, "LOG")` true; matches on `text` only (`"page"`) true; `"xyz"` false; `""` true. `visibleIndexes` of three tasks with `"b"` returns the matching indexes in order.
  - `filter_key_edits`: `filterKey("ab", key("c"))` = `"abc"`; `key("backspace")` → `"a"`; `filterKey("", key("backspace"))` = `""`; `key("ctrl+u")` → `""`; `key("up")`, `key("return")`, `key("escape")`, `key("alt+x")` → `null`; a paste `{ input: "x\ny", name: null, ... }` → `"abxy"` (control characters dropped; `null` if nothing is left).
  - `state.test.ts` `state_filter_open_edit_keep_clear`: `reduce(mk, { type: "openFilter" })` → `mode "filter"`, `focus "list"`, `filterDraft` = current `filter`; `filterEdit { query: "2" }` → `filterDraft "2"`, `visibleTasks` only task 2; `filterKeep` → `filter "2"`, `filterDraft null`, `mode "list"`; `filterKeep` with draft `""` → `filter ""`; `filterClear` → `filter ""`, `filterDraft null`, `mode "list"`. Initial state has `filter ""`, `filterDraft null`.
  - `state_filter_selection`: tasks `"task 1".."task 12"`; select index 0, `filterEdit { query: "task 1" }` keeps 0 (visible); `filterEdit { query: "2" }` snaps `selected` to the index of `"task 2"`; `select +1` moves to `"task 12"`, `select +1` stays; `selectEdge first/last` go to first/last visible; `filterEdit { query: "zzz" }` → `selectedTask(s) === null` and `selectedRun(s) === null`.
  - `state_select_task_clears_hidden_filter`: filter `"1"` active, `selectTask` to the id of `"task 2"` → `filter ""`, selected that task; `selectTask` to a visible task keeps the filter.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/filter.test.ts test/tui/state.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: `matches` lower-cases both sides (`toLowerCase`). `filterKey`: printable = `name === null && !ctrl && !meta`, append `input` minus chars `< " "` and `"\x7f"`; `backspace` drops the last code point; `ctrl+u` (`ctrl && input === "u"`) clears. In `state.ts`: `selectedTask` returns `null` when `selected` is not in `visibleTasks(s)`; after `filterEdit`, `filterClear`, `filterKeep` and `task:removed`, snap a hidden selection to the first visible index (unchanged when none is visible); `select`/`selectEdge` move by position within `visibleTasks(s)`; `selectTask` to a hidden task sets `filter ""` and `filterDraft null`. The existing `escape` case is unchanged.
- [ ] **Step 4: Run it**: `Run: node --test test/tui/filter.test.ts test/tui/state.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/filter.ts src/tui/state.ts test/tui/filter.test.ts test/tui/state.test.ts && git commit -m "feat(tui): sidebar filter model"`

---

### Task 7: Filter keys and hints

**Files:**
- Modify: `src/tui/keys.ts`
- Test: `test/tui/keys.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `filterKey` (Task 6), the filter `UiAction`s, `activeQuery`.
- Produces: `export function hintPrefix(s: ViewState): string` in `keys.ts` (raw text placed before the hints in the footer).

**Checks:** `node --test test/tui/keys.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `keys_slash_opens_filter`: `press(mk("idle"), "/")` and the same from a detail screen → `[ui({ type: "openFilter" })]`.
  - `keys_filter_mode`: in filter mode with draft `"ab"`: `"c"` → `[ui({ type: "filterEdit", query: "abc" })]`; `"backspace"` → query `"a"`; `"ctrl+u"` → query `""`; `"return"` → `[ui({ type: "filterKeep" })]`; `"escape"` → `[ui({ type: "filterClear" })]`; `"up"` → `[]`; `"ctrl+c"` gives the usual ctrl-C commands (`[{ kind: "quit" }, ui({ type: "ctrlC" })]` with no active runs).
  - `keys_esc_clears_active_filter`: list mode with `filter "x"` → `press(s, "escape")` = `[ui({ type: "filterClear" })]`; without a filter → `[]`.
  - `keys_filter_no_visible_task_noop`: list mode, filter `"zzz"` (no task visible), `"return"`, `"d"`, `"o"`, `"j"` → `[]`.
  - `keys_filter_hints`: filter mode → `hints(s)` = `[{ key: "⏎", label: "keep" }, { key: "esc", label: "clear" }]` and `hintPrefix(s)` = `"/ab▌  "`; list mode with `filter "x"` → `hintPrefix(s)` = `'filter "x" · '` and hints include `{ key: "esc", label: "clear filter" }`; detail mode with a filter → same prefix, no `esc clear filter`; no filter → `hintPrefix(s) === ""` and no `/` hint in the footer; `helpBindings(mk("idle"))` includes `{ key: "/", label: "filter" }`.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/keys.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: add `{ match: char("/"), when: () => true, run: () => [ui({ type: "openFilter" })], hint: { key: "/", label: "filter" }, footer: false }` to `SHARED`; add to `LIST_ONLY` an `escape` binding with `when: (c) => c.s.filter !== ""`, running `filterClear`, hint `{ key: "esc", label: "clear filter" }`, `footer: true`. `keymap` case `"filter"`: `return` → `filterKeep`, `escape` → `filterClear`, else `filterKey(s.filterDraft ?? "", k)`; non-null and different → `filterEdit`, else `[]`. `hints` case `"filter"` returns the two hints. `hintPrefix`: filter mode → `` `/${s.filterDraft ?? ""}▌  ` ``; list/detail with `s.filter !== ""` → `` `filter "${s.filter}" · ` ``; else `""`. `tooSmallKeymap` needs no change.
- [ ] **Step 4: Run it**: `Run: node --test test/tui/keys.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/keys.ts test/tui/keys.test.ts && git commit -m "feat(tui): / filter keys and hints"`

---

### Task 8: Themed components, filtered sidebar, past-run display, `startTui` theme and notices

**Files:**
- Modify: `src/tui/sidebar.ts`, `src/tui/footer.ts`, `src/tui/header.ts`, `src/tui/detail.ts`, `src/tui/timeline.ts`, `src/tui/addBox.ts`, `src/tui/toast.ts`, `src/tui/help.ts`, `src/tui/confirm.ts`, `src/tui/completion.ts`, `src/tui/formView.ts`, `src/tui/dialog.ts`, `src/tui/app.ts`, `src/tui/index.ts`
- Test: `test/tui/app.test.ts` (new cases appended), `test/tui/index.test.ts` (new case appended)

**Interfaces:**
- Consumes: `Theme`, `resolveTheme`, `paneBorder`, `DEFAULT_THEME`, `ThemeName` (Task 4); `ThemeContext`, `useTheme` (Task 4); `visibleTasks`, `activeQuery`, `RunView.past`, `initialState(now, tasks, notices)` (Tasks 5–6); `hintPrefix` (Task 7).
- Produces: `AppProps.theme?: Theme`, `AppProps.notices?: string[]`; `StartTuiOptions.theme?: ThemeName`, `notices?: string[]`, `env?: Record<string, string | undefined>` (default `process.env`); `AddBoxProps.theme?: Theme` (default `DEFAULT_THEME`).

**Checks:** `node --test test/tui/app.test.ts test/tui/index.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** (`FakeManager` snapshots get `past` via `snapshot(id, text, { past, runId, state })`):
  - `app_past_task_shows_timeline`: one past task (runId `20261001-100000-a`, one step with goal `"open the page"`, `run:end` outcome pass, cost 0.25) → `frame()` contains `past run 20261001-100000-a`, `open the page`, `✓ success`, `$0.250`, and no `step 1/`.
  - `app_filter_narrows_sidebar`: tasks `"alpha"`, `"beta"`, `"gamma"`; type `/`, `et` → frame contains `TASKS /et 1/3`, `"beta"`, `/et▌`, and not `"alpha"`; `\r` (return) → footer starts with `filter "et" · `; `\x1b` (escape) → title back to `TASKS`, all three names shown.
  - `app_no_color_theme`: mount with `theme: resolveTheme("dark", { NO_COLOR: "1" })` (add an optional `theme` parameter to the test's `mount` helper) → `raw()` matches no `/\x1b\[(3[0-9]|9[0-7]|38;)/`; the focused sidebar border uses bold box chars (`frame()` contains `┏`) and not `╭` for that pane's top-left. With `DEFAULT_THEME` the focused sidebar is drawn with `╭`.
  - `app_notices_toast`: `notices: ["skipped 1 unreadable run folder in runs/"]` → frame contains that text.
  - `addbox_no_color_mentions`: walking `AddBox({ ..., theme: resolveTheme("dark", { NO_COLOR: "1" }) })` (same visitor as `app_missing_mention_is_red`) finds no element with a `color` prop.
  - `index.test.ts` `start_tui_resolves_theme`: call `startTui` directly with the file's `FakeStdin`/`FakeOut` (its `setup()` takes only a manager) and `theme: "light"`, `env: { NO_COLOR: "1" }`, `notices: ["n1"]`; after `settle()` the joined `stdout.writes` contain `n1` and `┏` (the `NO_COLOR` theme reached the app: focused pane drawn bold). Ink draws no colours under test streams, so the `┏` check is what proves the theme was resolved from `env`. Quit via `handle.quit()` at the end.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/app.test.ts test/tui/index.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**:
  - Every component reads `const theme = useTheme()` and uses `theme.role.*`, `theme.taskIcon(state)`, `theme.stepIcon(kind)` in place of `ROLE`/`TASK_ICON`/`STEP_ICON` (timeline spinner uses `role.running`; outcome banner uses `taskIcon("passed"|"failed"|"stopped").color`). Pane borders (sidebar, detail, add box) spread `paneBorder(theme, focused)`; the header border is `paneBorder(theme, false)`; `Dialog` takes `borderColor` as today and uses `borderStyle: theme.color ? "round" : "bold"` (dialogs count as focused).
  - `AddBox` is called as a plain function by an existing test, so it must not call hooks: it takes `theme?: Theme` (default `DEFAULT_THEME`) and the module-level `COLOR` map becomes a function of the theme; `Workspace` passes `theme`.
  - `Sidebar`: rows = `visibleTasks(s)`; `scrollStart(position of s.selected in visible (0 if hidden), visible.length, size)`; title `TASKS` or, when `activeQuery(s) !== ""`, `` `TASKS /${sanitize(query)} ${visible.length}/${s.tasks.length}` ``; a task with `past` and `runCount === 0` draws its name with `role.muted`.
  - `Footer`: text = `sanitize(hintPrefix(s)) + hints joined as today` (quitting text unchanged).
  - `Detail.runHeader`: when `run.past`, the first part is `` `past run ${run.runId}` `` instead of `step x/y` (cost stays; no elapsed time because the outcome is set).
  - `App`: wraps `CrashGuard` in `ThemeContext.Provider value={p.theme ?? DEFAULT_THEME}`; `CrashGuard` receives `theme` as a prop for its colours; `initialState(Date.now(), manager.list(), p.notices ?? [])`.
  - `startTui`: `const theme = resolveTheme(o.theme ?? "auto", o.env ?? process.env)` and passes `theme` and `notices` to `App`.
- [ ] **Step 4: Run it**: `Run: node --test test/tui/app.test.ts test/tui/index.test.ts && npm test` / `Expected: PASS` (all existing TUI tests still pass with the default theme)
- [ ] **Step 5: Commit**: `git add src/tui/sidebar.ts src/tui/footer.ts src/tui/header.ts src/tui/detail.ts src/tui/timeline.ts src/tui/addBox.ts src/tui/toast.ts src/tui/help.ts src/tui/confirm.ts src/tui/completion.ts src/tui/formView.ts src/tui/dialog.ts src/tui/app.ts src/tui/index.ts test/tui/app.test.ts test/tui/index.test.ts && git commit -m "feat(tui): themed panes, filtered sidebar and past runs"`

---

### Task 9: `--past` and `--theme` flags

**Files:**
- Modify: `src/args.ts`
- Test: `test/args.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `ThemeName`, `THEME_NAMES` (Task 4, `import type` for the type).
- Produces: `RunArgs.past?: number`, `RunArgs.theme?: ThemeName`.

**Checks:** `node --test test/args.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `past_flag_values`: `parse("--tui", "--past", "0").past === 0`; `"5"` → 5; `parse("--tui", "--past=7").past === 7`; `parse("--tui")` has no `past` key (`"past" in args === false`) and no `theme` key; `"-1"` throws `usage("argument --past: must be at least 0")`; `"x"` throws `usage("argument --past: invalid int value: 'x'")`; `parse("--tui", "--past")` throws `usage("argument --past: expected one argument")`.
  - `theme_flag_values`: `auto`, `dark`, `light` parse to themselves (also `--theme=light`); `"blue"` throws `usage("argument --theme: invalid choice: 'blue' (choose from 'auto', 'dark', 'light')")`.
  - `help_lists_past_and_theme`: help text includes `[--tui] [--max-parallel N] [--past N] [--theme {auto,dark,light}]`, `with --tui: past runs to show (default 20, 0 = none)` and `with --tui: auto, dark or light (default auto)`.
- [ ] **Step 2: Run it**: `Run: node --test test/args.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: add `--past` and `--theme` to `RUN_SPEC.names` and `VALUE_OPTIONS`; `--past` uses `PY_INT` and `n < 0` → `must be at least 0`; `--theme` checks membership in `THEME_NAMES`. Usage line: `"                  [--tui] [--max-parallel N] [--past N] [--theme {auto,dark,light}]\n"`. Help rows after `--max-parallel N`, with descriptions starting at column 24 like the others: `  --past N              with --tui: past runs to show (default 20, 0 = none)` and `  --theme NAME          with --tui: auto, dark or light (default auto)`. The defaults object does not gain the keys.
- [ ] **Step 4: Run it**: `Run: node --test test/args.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/args.ts test/args.test.ts && git commit -m "feat(cli): parse --past and --theme"`

---

### Task 10: CLI wiring and README

**Files:**
- Modify: `src/cli.ts`, `README.md`
- Test: `test/cli.test.ts` (new cases appended)

**Interfaces:**
- Consumes: `RunDeps.onWarning` (Task 1); `loadPastRuns`, `PastRun` (Task 2); `ManagerOptions.past`, `RunManager.notify` (Task 3); `ThemeName` (Task 4); `RunArgs.past/theme` (Task 9).
- Produces: `CliDeps.loadPastRuns(limit: number): { runs: PastRun[]; skipped: number }`; `TuiModule.startTui(o: { manager: ManagerLike; theme?: ThemeName; notices?: string[] }): TuiHandle`.

**Checks:** `node --test test/cli.test.ts`, `npm test`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (use the file's `env()`, `agentWith`, `result`; a capturing fake `loadTui` like `fakeTui` that also records the `startTui` options):
  - `past_and_theme_need_tui`: `main([...e.argv, "--past", "3"])` → `2` and stderr contains `--past needs --tui`; `--theme dark` → `--theme needs --tui`; `--past x` with `--tui` → `2` and `argument --past: invalid int value: 'x'`; `--theme blue` → `invalid choice: 'blue'`.
  - `tui_passes_theme_notices_and_past`: fake `loadPastRuns` records its `limit` and returns `{ runs: [aPastRun], skipped: 2 }`; `main(["--tui", "--theme", "light", "--past", "5", "--skill", skill])` → limit `5`; `startTui` got `theme "light"`, `notices ["skipped 2 unreadable run folders in runs/"]`; `manager.list()[0].past?.runId` = the past run's id. With `skipped: 1` the notice is `skipped 1 unreadable run folder in runs/`; with `skipped: 0` `notices` is `[]`. Default call (no flags) → limit `20`, theme `"auto"`; `--past 0` → `loadPastRuns` not called.
  - `tui_sink_warning_becomes_toast`: `createAgent` mkdirs `<workdir>/events.jsonl`; the fake TUI subscribes to the manager before starting the task → a `toast` event `level "error"` whose message starts with `could not write `.
  - `plain_sink_warning_on_stderr`: plain run (`main(e.argv, ...)`) with that `createAgent` returning `result(true)` → exit `0`, exactly one stderr line starting with `warning: could not write ` and containing `events.jsonl`; no stdout line contains `could not write`. Same check for a two-file batch run (`-f a.md b.md`): two warnings on stderr.
- [ ] **Step 2: Run it**: `Run: node --test test/cli.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: `runOne` passes `{ ...deps, onWarning: (m) => deps.stderr(\`warning: ${m}\`) }` to `startRun` (covers plain and batch). In `dispatch`, next to the `--max-parallel` check: `args.past !== undefined` → `usage("--past needs --tui")`, `args.theme !== undefined` → `usage("--theme needs --tui")`. `DEFAULT_DEPS.loadPastRuns = (limit) => loadPastRuns({ runsDir: "runs", limit })`. `tuiMain` after preflight: `const limit = args.past ?? 20`, `const past = limit === 0 ? { runs: [], skipped: 0 } : deps.loadPastRuns(limit)`; `new RunManager({ ..., past: past.runs, startRun: (s) => startRun(s, { prompts, signal, createAgent, onWarning: (m) => manager.notify("error", m) }) })`; notices = `skipped > 0 ? [\`skipped ${k} unreadable run folder${k === 1 ? "" : "s"} in runs/\`] : []`; `tui.startTui({ manager, theme: args.theme ?? "auto", notices })`. README: options-table rows `--past` (default `20`, with `--tui`, newest past runs shown, `0` = none) and `--theme` (default `auto`, `auto`/`dark`/`light`); usage line `duckwright --tui [--max-parallel N] [--past N] [--theme NAME] [options]`; in *Interactive TUI* a short paragraph each on past runs (read-only, `⏎` runs again with current flags), `/` filter (`⏎` keep, `esc` clear), themes (`COLORFGBG`, `COLORTERM=truecolor`) and `NO_COLOR`; under the *Output* run-folder list a bullet: `events.jsonl`: every run event, one JSON object per line. Roadmap untouched.
- [ ] **Step 4: Run it**: `Run: node --test test/cli.test.ts && npm test && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/cli.ts README.md test/cli.test.ts && git commit -m "feat(cli): wire past runs, themes and sink warnings"`

## Manual e2e

- [ ] Run `duckwright --tui` in a light and in a dark terminal, each with `COLORTERM=truecolor` and without, and with `NO_COLOR=1`; check every pane, toast and dialog is legible and the focused pane is visible under `NO_COLOR` (bold border).
- [ ] Run a real task (plain mode), check `runs/<id>/events.jsonl` has one JSON line per event ending with `run:end`.
- [ ] Run a real task in the TUI, quit, reopen: the run is in the sidebar (muted name) with its timeline and `past run <id>` header; `⏎` runs it again and the header totals then count it.
- [ ] Press `/` and type part of a task name: the sidebar narrows, `⏎` keeps the filter, `esc` clears it.
