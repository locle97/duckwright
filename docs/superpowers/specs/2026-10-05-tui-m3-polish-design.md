# TUI M3: polish (`events.jsonl`, past runs, `/` filter, themes, `NO_COLOR`) design

Status: draft for review, 2026-10-05. Parent: [2026-10-04-tui-design.md](2026-10-04-tui-design.md) (M1 and M2 are implemented).

## Summary

M3 finishes the `duckwright --tui` workspace. Every run (plain, batch `-f` and TUI) appends its `RunEvent`s to `runs/<id>/events.jsonl`, the base for a future `duckwright watch`. The TUI opens with the newest past runs from `runs/` in the sidebar as finished, read-only tasks that can be run again with `⏎`. `/` filters the sidebar. Colours come from a theme (`--theme auto|dark|light`, hex palettes on truecolor terminals) and `NO_COLOR` turns them off. Mouse support, listed under M3 in the parent spec, is dropped.

```bash
duckwright --tui                      # newest 20 past runs in the sidebar, theme from COLORFGBG
duckwright --tui --past 0             # no past runs
duckwright --tui --theme light        # light palette
NO_COLOR=1 duckwright --tui           # no colours at all
```

## Decisions

| Topic | Decision |
| --- | --- |
| Mouse | Not built, and there is no `--mouse` flag. |
| `events.jsonl` format | One `JSON.stringify(event)` per line, `\n`-terminated, every `RunEvent` as emitted (with `at`), in emit order, ending with `run:end`. |
| Sink write | `fs.appendFileSync` from a `RunEvents` subscriber that `startRun` adds right after `makeRunDir`, before anything is emitted. If `makeRunDir` fails there is no folder and no sink. |
| Sink failure | The first failed append disables the sink for that run (no retries, so a broken disk costs one syscall) and calls `RunDeps.onWarning` once with `could not write <file>: <error message>`. The `RunOutcome` is never touched. |
| Warning delivery | Plain and batch mode print `warning: could not write <file>: <message>` on stderr; stdout is unchanged. The TUI shows it as an error toast (via `RunManager.notify`). |
| New flag storage | `RunArgs` gains optional `past?: number` and `theme?: ThemeName`, set only when the flag is given, so existing `RunArgs` literals and `deepEqual` tests stay valid. |
| `--past N` | Whole number ≥ 0 (same `PY_INT` rule as `--max-parallel`), default `20`, `0` = off. Errors: `argument --past: invalid int value: '<v>'`, `argument --past: must be at least 0`; without `--tui`: `--past needs --tui` (exit `2`). |
| `--theme` | `auto` (default), `dark` or `light`. Errors: `argument --theme: invalid choice: '<v>' (choose from 'auto', 'dark', 'light')`; without `--tui`: `--theme needs --tui` (exit `2`). |
| Past-run discovery | Only folders under `runs/` whose name matches `^\d{8}-\d{6}-` are considered (other entries are ignored, not counted). Sorted by name descending (timestamp-first, so newest first) and read until N have loaded or the folders run out; shown oldest first. |
| Valid past run | Needs a readable, parseable `history.json` with string `task`, boolean `success`, string `answer`, number `steps`, number `cost_usd`, array `history` of steps shaped as `historyJson` writes them, and `task_file` string, null or missing (missing = null). Anything else is skipped and counted. A folder still being written by another process (no `history.json` yet) is skipped the same way. |
| Skipped toast | When at least one considered folder was skipped: one info toast at startup, `skipped <k> unreadable run folder(s) in runs/` (`folder` when k = 1). |
| Past-run timeline source | `events.jsonl` when every line is a JSON object with a known `type` and numeric `at` and the last event is `run:end`; otherwise events synthesised from `history.json`. Both paths produce a `RunEvent[]`, so the UI replays one format. |
| Past-run state | From the `run:end` outcome when `events.jsonl` is used; else from `history.json`: `success` → passed, `answer === "interrupted"` → stopped, otherwise failed. |
| Synthesised events | `run:start` (task, `maxSteps` = `max(1, steps)`, `model: ""`, `snapshot: "hybrid"`, `headed: false`, `session: ""`, workdir); per history step `step:start`, `decision` (cost `0`), one `action:result` per action (`result` = `results[i] ?? ""`, `code`), `step:end` (cost `0`, `durationMs` `0`); then `run:end` with the outcome below. Every `at` is `history.json`'s mtime. Step costs and durations therefore read `0` for runs without `events.jsonl`; the run's total cost is still right (next row). |
| Synthesised outcome | `{ status, exitCode: 0/1/130, success, answer, steps, costUsd: cost_usd, historyPath, export: { kind: "off" }, warnings: [], error: status === "pass" ? null : answer }`. |
| Past run cost shown | After replay the `RunView.cost` is set to `outcome.costUsd`. |
| Task kind of a past run | A file task when `task_file` is set, the file exists (resolved against the current folder) and `loadTaskFile` succeeds (its front matter, minus `session`, becomes `fileSettings`, its text the task text); otherwise a typed task with `history.task` as text. |
| One row per folder | Each past folder is its own task, even if two ran the same file. File past tasks count for `@` duplicate detection (`already added: <path>`). |
| Re-running a past task | `⏎` calls `manager.start` as for any finished task: current workspace flags, the file's current front matter, and any overrides set with `o`. The original run's model etc. are not reused (`history.json` does not record them). |
| Past runs and totals | Past runs are not `RunRecord`s, so they never enter `summary()` or the exit code. The header skips past runs' cost and does not count tasks whose only run is a past one. Once re-run, a task counts like any other. |
| Past tasks visually | Name drawn in the `muted` role in the sidebar; the run header shows `past run <folder id>` instead of the step counter. No controls act on them (they are never live). |
| Replay crash guard | If replaying a past run's events throws in the reducer, that run's view keeps no steps and only the outcome (end banner). |
| Filter match | Case-insensitive substring (`toLowerCase`) of the query in the task's `name` or `text`. Empty query = no filter. |
| Filter editing | Cursor always at the end. Keys: printable characters append, `backspace` deletes the last character, `ctrl+u` clears. `⏎` keeps the query (empty clears it) and returns to `list`; `esc` clears it and returns to `list`. `ctrl+c` keeps its usual meaning. |
| Filter in list mode | `/` (list and detail) opens the editor prefilled with the current query. `esc` in `list` with an active filter clears it (otherwise as today). |
| Selection under filter | `selected` stays an index into `tasks`. When the query changes, a hidden selection moves to the first visible task. `↑↓ j/k pgup/pgdn g/G` move among visible tasks. `selectTask` (a newly added task) to a hidden task clears the filter. `selectedTask` returns `null` when the selection is hidden (no visible tasks), so no key acts on a hidden task. |
| Filter display | Sidebar title becomes `TASKS /<query> <visible>/<total>`. Footer while editing: `/<query>▌` then `⏎ keep · esc clear`. Footer in list/detail with a filter: prefix `filter "<query>" · ` and an `esc clear filter` hint (list only). `/ filter` is in the help overlay, not the footer. The header is unchanged. |
| Theme roles | `muted`, `accent`, `border`, `error`, `idle`, `running`, `paused`, `passed`, `failed`, `stopped`, `warn`, `done`. `stopping` uses `stopped`; step icons use `passed` (ok), `warn`, `failed` (brain), `done`. Plain text keeps the terminal's default colour, as today. |
| `auto` | Light when `COLORFGBG`'s last `;`-separated field is an integer equal to 7 or in 9..15; dark otherwise (unset, unparsable, 0–6, 8, > 15). |
| Truecolor | `COLORTERM` (case-insensitive) is `truecolor` or `24bit` → hex palette, else the 16-colour palette. |
| `NO_COLOR` | Set and non-empty → every role is `undefined` (no `color`/`borderColor` props), whatever `--theme` says. Bold, inverse and dim stay. Focused panes use Ink `borderStyle: "bold"` instead of the accent colour (unfocused stay `round`). `@` mentions are drawn without colour. |
| Theme delivery | `resolveTheme(name, env)` in `theme.ts` is pure; `src/tui/themeContext.ts` holds a React context whose default is the dark 16-colour theme, so components rendered without a provider (existing app tests) look as today. The existing `ROLE`, `TASK_ICON` and `STEP_ICON` exports stay, equal to the dark 16-colour values. |
| Where the theme is resolved | `cli.ts` passes `theme: args.theme ?? "auto"`; `tui/index.ts` resolves it against `process.env` (injectable `env` option for tests). |
| README roadmap | The roadmap has no M3 entries (the TUI item is already ticked), so only the options table and the Interactive TUI section change. |

## Palettes

| Role | dark, 16 | light, 16 | dark, truecolor | light, truecolor |
| --- | --- | --- | --- | --- |
| muted | `gray` | `gray` | `#808080` | `#6c6c6c` |
| accent | `cyan` | `blue` | `#5fd7ff` | `#005f87` |
| border | `gray` | `gray` | `#585858` | `#a8a8a8` |
| error | `red` | `red` | `#ff5f5f` | `#d70000` |
| idle | `gray` | `gray` | `#808080` | `#6c6c6c` |
| running | `yellow` | `magenta` | `#ffd75f` | `#af8700` |
| paused | `blue` | `blue` | `#5f87ff` | `#005fd7` |
| passed | `green` | `green` | `#5fd75f` | `#008700` |
| failed | `red` | `red` | `#ff5f5f` | `#d70000` |
| stopped | `#ff8700` | `#af5f00` | `#ff8700` | `#d75f00` |
| warn | `yellow` | `magenta` | `#ffd75f` | `#af8700` |
| done | `cyan` | `blue` | `#5fd7ff` | `#005f87` |

The dark 16-colour column is exactly today's `theme.ts`. In 16-colour mode the one hex value (`stopped`) is down-sampled by Ink's colour library, as it is today.

## Architecture / Components

| File | Change |
| --- | --- |
| `src/runs/sink.ts` (new) | `jsonlSink(file: string, onFail: (message: string) => void): (e: RunEvent) => void`. Appends one line per event; on the first throw calls `onFail` once and ignores later events. No UI. |
| `src/runs/run.ts` | `RunDeps.onWarning?: (message: string) => void`. After `makeRunDir`, `events.subscribe(jsonlSink(path.join(workdir, "events.jsonl"), (m) => deps.onWarning?.(m)))`. Nothing else changes. |
| `src/runs/past.ts` (new) | `loadPastRuns(o: { runsDir: string; limit: number; cwd?: string; fs?: injectable readdir/readFile/stat/exists }) → { runs: PastRun[]; skipped: number }` and the helpers `readEventsJsonl`, `eventsFromHistory`, `outcomeFromHistory`. `PastRun { id, workdir, text, source: TaskSource, fileSettings: TaskSettings, events: RunEvent[], outcome: RunOutcome }`. No UI. |
| `src/runs/manager.ts` | `ManagerOptions.past?: PastRun[]`: the constructor adds one task per past run, oldest first, before any session task (no event emitted; the UI reads `list()` at mount). `Task.past: PastRun \| null`; its state comes from `past.outcome.status` until a session run exists. `TaskSnapshot.past?: { runId: string; events: RunEvent[] }` (optional, so `FakeManager` snapshots stay valid); `runId` is the latest session run's id, else the past folder id. `runCount` counts session runs only. New `notify(level, message)` emits a `toast` (not on `ManagerLike`). |
| `src/args.ts` | Parse `--past N` and `--theme NAME` (value options, also `--past=N`), add them to `RUN_USAGE` (`[--tui] [--max-parallel N] [--past N] [--theme {auto,dark,light}]`) and `RUN_HELP` (`--past N            with --tui: past runs to show (default 20, 0 = none)`, `--theme NAME          with --tui: auto, dark or light (default auto)`). |
| `src/cli.ts` | Plain and batch `startRun` deps get `onWarning: (m) => deps.stderr(\`warning: ${m}\`)`. `tuiMain`: `CliDeps.loadPastRuns(limit)` (default: `loadPastRuns({ runsDir: "runs", limit })`, skipped when the limit is 0) before building the manager; passes `past` to `RunManager`, `onWarning: (m) => manager.notify("error", m)` to `startRun`, and `{ manager, theme, notices }` to `startTui` (`notices` holds the skipped toast text). `--past`/`--theme` without `--tui` are usage errors, checked next to `--max-parallel`. `TuiModule.startTui` gains optional `theme` and `notices`. |
| `src/tui/theme.ts` | `ThemeName`, `ColorRole`, `Theme { color: boolean; role: Record<ColorRole, string \| undefined>; taskIcon(state); stepIcon(kind) }`, the four palettes, `isLightBackground(colorfgbg)`, `resolveTheme(name, env)`, `DEFAULT_THEME`. Pure. |
| `src/tui/themeContext.ts` (new) | `ThemeContext` (`createContext(DEFAULT_THEME)`) and `useTheme()`. |
| `src/tui/filter.ts` (new) | Pure: `matches(task, query)`, `visibleIndexes(tasks, query)`, `filterKey(query, key) → string \| null` (the edit rules above). |
| `src/tui/state.ts` | `ViewState.filter: string` (`""` = none) and `filterDraft: string \| null` (non-null while editing); mode `filter`; actions `openFilter`, `filterEdit { query }`, `filterKeep`, `filterClear`; selection rules above; `selectedTask` honours the filter. `initialState` replays each task's `past.events` into a `RunView` with `past: true`, `follow: false`, `selected` = last step, nothing expanded, `cost` = outcome cost. `headerCounts` skips `past` run views and tasks whose `runCount` is 0 and that have `past`. |
| `src/tui/keys.ts` | `/` binding in `SHARED` (help only); `esc clear filter` in `LIST_ONLY` when a filter is active; `filter` mode keymap via `filterKey`; `hints` for `filter` mode and the filter prefix. |
| `src/tui/sidebar.ts`, `footer.ts`, `header.ts`, `detail.ts`, `timeline.ts`, `addBox.ts`, the overlays | Read colours from `useTheme()` instead of the constants; borders follow the `NO_COLOR` rule; the sidebar renders visible tasks only (scrolling by visible position) with the filter title; past names muted; the run header shows `past run <id>`. |
| `src/tui/app.ts`, `index.ts` | `AppProps.theme?: Theme` and `notices?: string[]` (info toasts at mount); `App` wraps the tree in `ThemeContext.Provider`. `startTui` takes `theme?: ThemeName`, `notices?`, `env?` and resolves the theme. |
| `README.md` | Options table rows for `--past` and `--theme`; in *Interactive TUI*: past runs, `/` filter, themes and `NO_COLOR`; a note under the run-folder description that each run writes `events.jsonl` (one JSON event per line). |

`src/events.ts` is unchanged. `src/runs/` stays free of UI code; only `src/tui/` imports Ink or React.

## Data flow

1. **Any run:** `startRun` → `makeRunDir` → sink subscribed → `execute` emits `run:start` … `run:end`; each event is appended to `events.jsonl` synchronously as it is emitted. On a write error, `onWarning` fires once and the run goes on.
2. **TUI startup:** `cli.ts` parses flags → `loadPastRuns` scans `runs/` newest first, validates `history.json`, picks the event source, builds `PastRun`s → `RunManager({ past })` creates the past tasks → `startTui({ manager, theme, notices })` resolves the theme from `env`, mounts `App` with `ThemeContext.Provider` → `initialState(now, manager.list())` replays past events into run views and queues notice toasts.
3. **Selecting a past task:** the detail pane shows its replayed timeline and end banner (sanitised like any run text). **`⏎`** → `manager.start(id)` → a new run whose events arrive as usual; the task's `runId` moves to the new run, which then counts in header, summary and exit code.
4. **Filter:** `/` → mode `filter`, `filterDraft` = current query → each key → `filterKey` → `filterEdit` updates `filterDraft` and the live view (the sidebar filters by the draft while editing) and snaps the selection → `⏎` copies the draft to `filter`, `esc` empties both → mode `list`.

## Error handling

| Failure | Behaviour |
| --- | --- |
| `events.jsonl` append fails (permissions, disk full, folder removed) | Sink disabled for that run; one warning (stderr in plain/batch, error toast in the TUI); outcome, stdout, exit code and `history.json` unchanged. |
| `runs/` missing or unreadable | No past runs, no toast. |
| Past folder without readable/valid `history.json` | Skipped, counted in the startup toast. |
| `events.jsonl` missing, malformed, or without a final `run:end` | Timeline synthesised from `history.json`; not counted as skipped. |
| `task_file` missing or its front matter now invalid | Past task becomes a typed task with the recorded text. |
| Replay of past events throws in the reducer | That run view keeps only its outcome (end banner). |
| Re-run of a past task fails preflight | As for any task: red `!`, toast, state unchanged. |
| Invalid `--past` / `--theme`, or either without `--tui` | Usage error, exit `2`, messages in *Decisions*. |
| Unparsable `COLORFGBG` | Dark. |

## Testing

All through `npm test` (typecheck plus `node --test`) and `npm run typecheck`. No e2e. Existing tests are not edited.

- `test/runs/sink.test.ts`: one line per event, in order, parseable back to the same objects; a sink on an unwritable path calls `onFail` once over many events and never throws.
- `test/runs/run.test.ts` (new cases, fake agent): `events.jsonl` holds one JSON line per emitted event, in emit order, the last being `run:end`; with the sink forced to fail (the fake `createAgent`, which receives `workdir` before any event is emitted, creates `<workdir>/events.jsonl` as a directory, so every append fails with `EISDIR`) the `RunOutcome` deep-equals the outcome of the same fake run with a working sink, and `onWarning` is called once.
- `test/runs/past.test.ts` (temp `runs/` folders): newest N by name, returned oldest first; `limit` 0 returns nothing; non-matching names ignored; missing/invalid `history.json` skipped and counted; state mapping (success → pass, `interrupted` → stop, other → fail, and `run:end` outcome when `events.jsonl` is used); `events.jsonl` preferred when complete, `history.json` synthesis when malformed or missing `run:end`; file vs typed source (existing file, missing file, bad front matter).
- `test/runs/manager.test.ts` (new cases): past tasks listed first, oldest first, with the mapped state and `past` snapshot; `summary()` and its exit code ignore past runs (past failed + no session runs → no lines, exit `0`); `start` on a past task calls `startRun` with the original text and task file; `notify` emits a toast.
- `test/tui/state.test.ts`, `keys.test.ts` (new cases): `/` opens filter mode from list and detail; typing narrows visible tasks (name or text, case-insensitive); `backspace`, `ctrl+u`; `⏎` keeps and returns to list; `esc` clears; empty `⏎` clears; selection snaps to a visible task, moves among visible tasks only, `selectedTask` is `null` with nothing visible; `selectTask` to a hidden task clears the filter; `esc` in list clears an active filter; footer hints in filter mode and with an active filter; past replay builds run views, header excludes past cost and past-only tasks.
- `test/tui/theme.test.ts` (new cases): `resolveTheme` for `dark`, `light`, `auto` with `COLORFGBG` `15;0` (dark), `0;15` (light), `0;7`, `0;8`, `default;0`, unset; `COLORTERM` `truecolor`/`24bit` give the hex palettes, anything else the 16-colour ones; `NO_COLOR=1` gives every role `undefined` and `color: false` for every theme name; `NO_COLOR=""` keeps colours; `DEFAULT_THEME` equals the old constants.
- `test/tui/app.test.ts` (new cases, `ink-testing-library`): a past task renders its timeline and end banner; `/` filter narrows the rendered sidebar; with a `NO_COLOR` theme the frame contains no colour escape sequences.
- `test/args.test.ts`, `test/cli.test.ts` (new cases): `--past` values (`0`, `5`, `-1`, `x`), `--theme` values (`auto`, `dark`, `light`, `blue`), each rejected without `--tui` (exit `2`); `--tui` passes the theme and notices to `startTui` and the past runs to the manager (fake `loadTui` and `loadPastRuns`); plain mode with a failing sink prints `warning: could not write …` on stderr with stdout unchanged.

| Brief success criterion | Covered by |
| --- | --- |
| `startRun` writes one line per event ending with `run:end`; failing sink keeps `RunOutcome` | `run.test.ts`, `sink.test.ts` |
| Past runs newest-N, states, malformed skipped, excluded from summary/exit, `⏎` re-runs | `past.test.ts`, `manager.test.ts`, `state.test.ts` |
| `/` filter open, typing, `⏎`, `esc`, selection, hints | `state.test.ts`, `keys.test.ts` |
| Themes dark/light/auto, truecolor vs 16, `NO_COLOR` | `theme.test.ts`, `app.test.ts` |
| `--past`/`--theme` validation and rejection without `--tui` | `args.test.ts`, `cli.test.ts` |

### Manual e2e

- Run `duckwright --tui` in a light and a dark terminal, with `COLORTERM=truecolor` and without, and with `NO_COLOR=1`; check legibility.
- Run a real task, quit, reopen: the run is in the sidebar with its timeline; `⏎` runs it again.

## Out of scope

- Mouse support (deferred).
- A `duckwright watch` command (`events.jsonl` is only its base).
- Persisting the task list across TUI sessions beyond what `runs/` records.
- Fuzzy or regex filters; a cursor inside the filter query.
- User-defined themes or theme config files.
- Recording run settings (model, max steps) for past runs, or reusing them on re-run.
- Rotating or truncating `events.jsonl`.
