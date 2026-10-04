# Interactive TUI workspace (`duckwright --tui`) design

Status: draft for review, 2026-10-04.

## Goal

`duckwright --tui` opens a terminal workspace where you add tasks (typed, or picked from task files), start them, and watch every run live: each step's goal, actions, results and running cost, with keys to pause, step through, or stop a run. Several runs can go at once, each in its own browser, with its state shown as a coloured dot in a sidebar.

It replaces typing `duckwright "task"` or `duckwright -f ...` for interactive use. The plain command line stays exactly as it is for scripts and CI.

```bash
duckwright --tui                          # empty workspace, default settings
duckwright --tui --model opus --headed    # flags become the workspace defaults
duckwright --tui --max-parallel 2         # at most 2 runs at once (default 3)
```

## Milestones

| Milestone | Scope |
| --- | --- |
| **M1: workspace and live runs** | `--tui`; add a typed task (`a`) or task files (`f`, fuzzy picker); per-task overrides (`o`); start the selected task (`⏎`); parallel runs up to `--max-parallel`, each with its own browser session; live timeline per run; pause / step / stop the selected run; sidebar states; header totals; help overlay; summary table and exit code on quit. |
| **M2: batch conveniences** | Start all or marked tasks (`R`, respecting the limit); browse earlier runs of a task; save a typed task as a task file (`w`); preload with `duckwright --tui -f tasks/ "task"` (added, not started); export the test of a passed run (`x`). |
| **M3: polish (optional)** | Load past runs from `runs/`, light/dark and truecolor themes, `NO_COLOR`, mouse, `/` filter, an `events.jsonl` sink as the base for a future `duckwright watch`. |

This spec details M1. M2 and M3 each get a short spec of their own before their plan.

Out of scope for every milestone: approving each decision before it runs (the *confirm before risky actions* roadmap item), pausing between the actions of one decision, keeping the task list across TUI sessions (each run's `runs/<id>/` folder is the record), and making the TUI the default.

## Research: what we borrow from herdr

[herdr](https://github.com/herdrdev/herdr) is a Rust (ratatui + crossterm) terminal workspace for coding agents. Patterns we copy:

- **One glanceable state per unit of work, in the sidebar.** herdr marks every agent `working`, `blocked`, `done` or `idle`, each with a fixed colour, so you never hunt for the one that needs you. We do the same for tasks and runs.
- **Sidebar list plus detail.** The left list holds items with a state icon; the right side shows the selected item.
- **Semantic palette.** Colours are roles (`text`, `muted`, `surface`, `accent`, plus state colours), so themes and "follow the terminal palette" come for free later.
- **A small, learnable keymap.** herdr teaches "five keys first"; `?` opens an overlay of every active binding. Footer hints are generated from the active keymap so they never lie.
- **Fuzzy pickers and inline inputs** for adding things, with `esc` always backing out.
- **Graceful truncation.** Rows drop optional columns as width shrinks instead of wrapping.
- **Small signals.** A `●` before status text, braille spinner frames while working, short toasts.

## Command line

- `--tui` accepts every run flag (`--max-steps`, `--model`, `--headed`, `--skill`, `--session`, `--state`, `--allow-file-access`, `--export`, `--snapshot-*`); they become the workspace defaults. New: `--max-parallel N`, a whole number of at least 1, default `3`, only valid with `--tui`.
- `--tui` needs an interactive terminal. If stdin or stdout is not a TTY: `--tui needs an interactive terminal`, exit `2`.
- M1: a positional task or `-f` together with `--tui` is `give tasks inside the TUI, not with --tui` (exit `2`). Preloading arrives in M2.
- `--max-parallel` without `--tui` is a usage error.
- Without `--tui`, output, exit codes and `history.json` are unchanged.

## Screen

```
╭─ 🦆 duckwright ─────────────── 2 running · 1 paused · $0.3120 · 00:04:12 ─╮
│ TASKS                   │ todomvc.md  ● running  step 4/25  $0.041  00:41 │
│ ● todomvc.md    $0.041  │ Add three todos and check the count is 3        │
│ ‖ books.md      $0.022  │ ✓ 1  Open todomvc.com              $0.011  4.2s │
│ ● "Check pric…" $0.009  │ ✓ 2  Add "buy milk"                $0.012  5.1s │
│ ✓ quotes.md     $0.070  │ ⠋ 3  Verify item count             thinking…   │
│ ✗ saucedemo.md  $0.210  │   ├ eval  Two items added                       │
│ ■ wiki.md       $0.130  │   └ goal  Add the third item and verify         │
│ ○ tables.md             │                                                 │
├─────────────────────────┴─────────────────────────────────────────────────┤
│ ⏎ run · a add · f files · o options · p pause · s stop · tab focus · ? help│
╰────────────────────────────────────────────────────────────────────────────╯
```

### Header

`🦆 duckwright`, then counts per non-zero state (`2 running · 1 paused · 3 passed · 1 failed`), the total cost of every run started in this workspace (including failed and stopped ones, as batch totals do today), and the time since the TUI opened.

### Sidebar

One row per task, in the order added: state icon, name, cost of its latest run.

| Icon | State | Colour | Meaning |
| --- | --- | --- | --- |
| `○` | idle | muted grey | added, never started |
| `●` | running | yellow | a run is in progress (spinner frames while a step is in flight) |
| `‖` | paused | blue | the run is paused or holding after a single step |
| `✓` | passed | green | the latest run ended `done success` |
| `✗` | failed | red | the latest run ended in failure, max steps, brain failures, or a crash |
| `■` | stopped | orange | the latest run was stopped by the user (shown as `■ stopping` until it has closed) |

- The name is the task file's path relative to the current folder, or the typed task in quotes, cut with `…`.
- A trailing `↻` marks a task with overrides; a red `!` marks a task whose last start failed preflight.
- `↑↓`/`j k` move; the selection drives the detail pane.

### Detail pane

- **Idle task:** the full task text (sanitised), the source (typed, or the file path), and the effective settings, with overridden values highlighted.
- **Task with a run:** the run view of its latest run:
  - A run header: state, `step N/max`, cost, elapsed (and paused time while paused), `brain ✗ k/3` after brain errors.
  - The step timeline: one row per step (status icon, step number, `nextGoal`, step cost, duration); while running the right column shows `snapshot…`, `thinking…` or `acting…`. Icons: spinner (running), `✓` (all actions ok), `!` yellow (an action failed), `✗` red (brain error), `◆` (the `done` step).
  - The running step is expanded (`eval`, `goal`, `memory` when it changed, each action as `cmd args → result` with a spinner on the action in flight). Earlier steps are collapsed; `⏎`/`space` toggle, `e`/`c` expand or collapse all.
  - **Follow mode:** the timeline sticks to the newest step until the user moves up; `G`/`End` jumps back.
  - **End banner:** result, answer, steps, cost, `history.json` path, and `Test: <path>` or `not exported` when export is on.
- Each run keeps its own selection, expansion and follow state, so switching tasks in the sidebar and back does not lose your place.

### Focus and modes

`tab` moves focus between sidebar and detail pane; the focused pane has an accent border. Overlay modes take all keys until closed with `esc` (or completed with `⏎`):

| Mode | Opened by | Purpose |
| --- | --- | --- |
| `list` | default | sidebar focused |
| `detail` | `tab` | timeline focused |
| `input` | `a` | one-line task box at the bottom; `alt+⏎` inserts a newline; `⏎` adds; empty input is ignored |
| `picker` | `f` | fuzzy file picker (below) |
| `form` | `o` | per-task settings form (below) |
| `help` | `?` | every binding of the current mode and the global ones |
| `confirm` | `q` with active runs, `d` | yes / no question |

### Keys

| Key | Where | Action |
| --- | --- | --- |
| `⏎` | list | Start the selected task if it has no active run. On a task with an active run: focus its timeline |
| `a` | list, detail | Add a typed task |
| `f` | list, detail | Add task files |
| `o` | list | Edit the selected task's overrides (only when no run of it is active) |
| `d` | list | Remove the selected task (only when no run of it is active; confirms) |
| `p` | list, detail | Pause the selected task's run (takes effect after the current step) |
| `r` | list, detail | Resume it |
| `n` / `.` | list, detail | While paused: run exactly one more step, then hold. Ignored otherwise |
| `s` | list, detail | Stop the selected task's run cleanly |
| `↑↓` `j/k`, `PgUp/PgDn`, `g/G` | list, detail | Move, page, first/last (`G` re-enables follow in the timeline) |
| `⏎`/`space`, `e`, `c` | detail | Expand/collapse a step, expand all, collapse all |
| `tab` | list, detail | Switch focus |
| `?` | list, detail | Help overlay (in `input`, `picker` and `form`, printable keys are text) |
| `q` | list, detail | Quit; with active runs, confirm "stop N runs and quit?" |
| `ctrl+c` | anywhere | 1st: same as `q`. In the quit confirm: confirm. 3rd: unmount and exit `130` immediately (browsers may be left open, as with today's double Ctrl-C) |

In M1, `⏎` on a finished task starts a new run of it; the sidebar and detail pane show the latest run. (Browsing earlier runs of a task comes in M2.)

The footer shows only the keys that act in the current mode and on the current selection (for example `r resume · n step` only when the selected run is paused).

### File picker

- Lists `.md` and `.txt` files (any case) and folders under the current directory, as relative paths. Skips hidden entries, `node_modules`, `runs` and `.git`. Stops after 5,000 entries and says so.
- Typing filters with fuzzy subsequence matching (fzf-style ranking: consecutive matches, matches at word starts and shorter paths score higher). `↑↓` move, `space` marks several, `⏎` adds the marked entries (or the highlighted one).
- A folder adds its root-level task files exactly as `-f folder/` does today (`taskPaths`). Each file is loaded with `loadTaskFile` when added. Invalid files are not added; each error (`file:line: problem`) is shown as a toast. A file already in the list is not added twice.

### Settings form (`o`)

Fields: model, max steps, headed, export, snapshot mode. Each shows the effective value; editing a field turns it into an override, `ctrl+r` on a field clears its override. Values are validated with the same rules as front matter (for example max steps is a whole number of at least 1); invalid fields show their error inline and the form cannot be saved. `skill`, `session`, `state` and `allow-file-access` are not in the form: they stay workspace-wide.

### Quit

- With no active runs, `q` leaves at once.
- With active runs, confirming stops every run cleanly (each writes `history.json` as `interrupted` and closes its browser) and waits for all of them, showing `■ stopping` on each.
- After the TUI closes, a summary in the style of today's batch summary is printed (its first line counts `passed`, `failed` and `stopped`; the plain `-f` batch output does not change) for every task that ran at least once (its latest run), followed by one row per task. The total counts every run in the session, including earlier runs of a task that was started again:

  ```
  Batch: 2 passed, 1 failed, 1 stopped  Cost: $0.4120
  pass  tasks/a.md         $0.1467  runs/20261004-101500-a/history.json
  fail  tasks/b.md         $0.2121  runs/20261004-101530-b/history.json
  stop  "Check the price"  $0.0532  runs/20261004-101612-brave-otter/history.json
  ```

  With no runs at all, nothing is printed.
- Exit code: `0` if no run was started or every latest run passed; `130` if any run was stopped by quitting; otherwise `1`.

### Layout rules

- At 90 columns or more: sidebar (about 30% width, 24 to 40 columns) and detail side by side.
- 60 to 89: the sidebar shows icon and a short name, no cost.
- Under 60: one pane at a time; `tab` switches.
- Under about 40×8: only `terminal too small` and `q quit`.
- M1 colours are the 16 ANSI colours by role, so the terminal's theme applies.

### Untrusted text

Task text from files, goals, memory, results and answers can carry page or file text. Before display they go through the existing `neutralise`/`flat` helpers plus stripping of C0/C1 control characters and ANSI escape sequences, so nothing can move the cursor or change terminal state.

## Architecture

```
 bin.ts ─ cli.ts ─┬─ plain mode: runOne = startRun + plain reporter + summary
                  └─ --tui:      tui/index.ts ── App (Ink, lazy-loaded)
                                        │ subscribes / calls
                                 src/runs/manager.ts  (RunManager)
                                        │ startRun() × N
                                 src/runs/run.ts → Agent(events, control)
```

`src/events.ts`, `src/control.ts`, `src/runs/` and the loop changes contain no UI code. Only `src/tui/` imports Ink.

### `src/events.ts`

A typed `RunEvent` union and a minimal `RunEvents` hub (`emit`, `subscribe` returning an unsubscribe function; listeners are called synchronously; a throwing listener is caught and does not break the loop). Each run has its own hub. Every event carries `at` (ms timestamp).

| Event | Emitted by | Payload |
| --- | --- | --- |
| `run:start` | `startRun` | task, maxSteps, model, snapshot mode, headed, session, workdir |
| `step:start` | loop | step |
| `phase` | loop | step, `observing` \| `thinking` \| `acting` (shown as `snapshot…`, `thinking…`, `acting…`) |
| `decision` | loop | step, `Decision`, step cost |
| `action:start` | loop (via `execute` callback) | step, index |
| `action:result` | loop (via `execute` callback) | step, index, result, code |
| `brain:error` | loop | step, message, cost, consecutive failures |
| `step:end` | loop | `StepRecord`, step cost, duration ms |
| `control` | `RunControl` | `running` \| `paused` \| `stepping` \| `stopping` |
| `run:end` | `startRun` | the `RunOutcome` (below) |

`execute` in `actions.ts` takes an optional per-action callback; its behaviour is otherwise unchanged.

### `src/control.ts`

`new RunControl(controller: AbortController, events?)`; methods `pause()`, `resume()`, `step()`, `stop()`; `state`. Every state change emits `control`, including the `stepping` → `paused` change made by the gate.

| From | Call | To |
| --- | --- | --- |
| `running` | `pause()` | `paused` (takes effect at the next gate; the current step finishes) |
| `paused` | `resume()` | `running` |
| `paused` | `step()` | `stepping` |
| `stepping` | gate passes | `paused` (one step through, then the next gate waits) |
| `stepping` | `pause()` | `paused` (cancels the pending step if the gate has not passed yet) |
| any but `stopping` | `stop()` | `stopping` |

Anything not listed is a no-op. `gate(signal): Promise<void>` returns at once while `running`, waits while `paused`, passes once in `stepping` and moves to `paused`, and rejects with `AbortedError` if the signal aborts while waiting. `stop()` aborts the controller it was given.

### `src/loop.ts`

- New optional `AgentOptions`: `events?: RunEvents`, `control?: RunControl`.
- At the top of each step, before `observe`: `await control?.gate(signal)`. Pausing never interrupts a browser action and spends nothing.
- Emits the loop events above. Step cost is the cost returned by `decide` (or `BrainError.cost`).
- `onStep` stays, implemented as a subscriber; when no `events` is given the Agent creates its own internal `RunEvents`, so existing callers and tests keep working.
- Order: the gate is awaited first, then `step:start` is emitted, so a paused run shows no empty row for the step that has not begun.

### `src/runs/run.ts`

`startRun(spec: RunSpec, deps: RunDeps): RunHandle`, extracted from today's `runOne`, with no printing of its own.

- `RunSpec`: task, task file (or `null`), resolved `RunArgs` (including the session to use).
- `RunDeps`: prompts, the process `AbortSignal`, and `createAgent` (as `CliDeps` has today), so tests can fake the agent.
- It creates the run folder (`makeRunDir`, which already avoids clashes for runs started in the same second), a per-run `AbortController`, and `AbortSignal.any([processSignal, runController.signal])`, used for Brain, `PlaywrightCLI`, the Agent and the `interrupted` check. It also creates a `RunEvents` and a `RunControl`; emits `run:start`; runs the agent; writes `history.json`; exports when asked; then emits `run:end`.
- `RunHandle`: `{ id, workdir, events, control, done: Promise<RunOutcome> }`. `done` never rejects: an unexpected error from export or `makeRunDir` (which today escapes `runOne` as an uncaught crash) becomes `status: "fail"` with `error`. Plain mode prints it as `error: <name>: <message>`, exit `1`; this is the only plain-mode behaviour change, and only for what is a crash today.
- `RunOutcome`: `{ status: "pass" | "fail" | "stop", exitCode, success, answer, steps, costUsd, historyPath, exportPath | null, exportError | null, warnings: string[], error: string | null }`. The status and exit code mapping is today's: success `0` → `pass`; failure or crash `1` → `fail`; interrupted `130` → `stop`.
- Plain-mode `runOne` becomes: `startRun`, subscribe the plain reporter (`src/report/plain.ts`, today's `stepLine` on `step:end`), await `done`, then print the summary lines (`Result:`/`Answer:`/`Steps:`/`History:`/`Test:`, with warnings and errors on stderr) from the `RunOutcome`. Output is byte-for-byte what it is today; the existing CLI tests prove it. Batch mode keeps calling `runOne`.

### `src/runs/manager.ts`

`RunManager` holds the workspace. It contains no UI code and takes `startRun` and `preflight` as constructor arguments.

- **Tasks.** `TaskItem { id, source: { kind: "typed" } | { kind: "file", path }, text, fileSettings, overrides, error: string | null, runs: RunHandle[] }`. `addTyped(text)`; `addFiles(paths)` expands folders with `taskPaths`, loads files with `loadTaskFile`, skips duplicates by resolved path, and returns the errors; `setOverrides(id, o)`; `remove(id)`.
- **Settings layering**, lowest first: task-file front matter, then flags given on the command line, then the task's overrides. The first two are exactly `parseRunArgs(argv, skill, fileSettings)`, as batch runs do today; overrides are applied on top. `allow-file-access` comes only from the command line.
- **Start.** `start(id)` refuses with a reason if a run of that task is active, if `maxParallel` runs are active (`3 runs active (limit 3)`), or if `preflight` fails (the message is stored in `error`, shown as the red `!` and a toast). Otherwise it takes a session slot and calls `startRun`.
- **Sessions.** A pool of `maxParallel` slots named `<session>-1` … `<session>-N`, where `<session>` is the `--session` value (default `duckwright`). A task file's `session:` key is ignored in the TUI (the slot always wins), so two parallel files can never share a browser. A file's `skill:` and `state:` still apply to that task and are checked by its per-start preflight. A slot is taken at start and released when that run's `done` settles, whatever the outcome. Two TUIs at the same time need different `--session` values, as two CLI runs do today (the README note is updated).
- **Controls.** `pause(id)`, `resume(id)`, `step(id)`, `stop(id)` forward to the `RunControl` of the task's latest run.
- **Derived state.** `taskState(id)` is `idle` with no runs. Otherwise it comes from the latest run: control state `paused` or `stepping` → paused; `stopping` → stopped (shown as stopping); still active → running; ended → the outcome status.
- **Events.** One subscription for the UI: every run event re-emitted with its task id, plus `task:added`, `task:updated`, `task:removed` and `toast`.
- **Quit.** `stopAll(): Promise<void>` stops every active run and waits for every `done`; the manager marks those runs as *stopped by quitting*, which is what drives exit `130` (a run stopped earlier with `s` counts as `stop` in the table but exit `1`). `summary()` returns the table rows, the total cost and the exit code.

### `src/tui/`

| File | Responsibility |
| --- | --- |
| `state.ts` | Pure reducer `(ViewState, ManagerEvent \| UiAction) → ViewState`: task rows, selection, focus, mode, input buffer, picker query and marks, form fields, per-run timeline state (steps, phases, selection, expanded, follow), toasts (auto-expire), header totals. Most UI logic lives here. |
| `keys.ts` | Pure keymap per mode `(key, ViewState) → UiAction \| ManagerCall \| null`, plus `hints(ViewState)` for the footer and help overlay. |
| `picker.ts` | Pure folder walk (with an injectable `readdir`) and fuzzy ranking. |
| `form.ts` | Pure field model and validation for the settings form, reusing the task-file validators. |
| `sanitize.ts` | Strips control characters and escape sequences on top of `neutralise`/`flat`. |
| `theme.ts` | Colour roles → ANSI colours; task and step states → icon and colour. |
| `app.ts`, `header.ts`, `sidebar.ts`, `detail.ts`, `timeline.ts`, `input.ts`, `pickerView.ts`, `formView.ts`, `help.ts`, `confirm.ts`, `toast.ts`, `footer.ts` | Ink components written with `React.createElement` (imported as `h`) in plain `.ts` files, so `node --test` keeps running sources with type stripping and no JSX build step. |
| `index.ts` | `startTui({ manager, deps }) → { done: Promise<void> }`; `done` resolves after quit (and after `stopAll` when confirmed). An error boundary calls `manager.stopAll()` and restores the terminal if rendering throws. |

### CLI wiring

- `args.ts`: `--tui` and `--max-parallel N`, command line only (not task-file keys).
- `CliDeps` gains `isTTY(): boolean` (stdin and stdout are both TTYs) and `loadTui()` (default: a dynamic `import("./tui/index.ts")`, so plain runs never load React). Tests override both and never render Ink.
- `--tui` flow in `cli.ts`: validate the flags; run `preflight` once with the workspace defaults, so a missing `claude` or `playwright-cli` or a bad `--skill` or `--state` fails before the TUI opens (exit `2`); build the `RunManager`; `startTui`; await `done`; print `manager.summary()`; return its exit code.
- Ink's `patchConsole` catches stray `console` output while the TUI is up; `startRun` itself never prints.
- Ink is rendered with `exitOnCtrlC: false`, so Ctrl-C reaches the keymap as a key, not SIGINT. The third press unmounts Ink and calls `process.exit(130)`.
- `cli.ts` enters the alternate screen (`ESC[?1049h`) before rendering and leaves it (`ESC[?1049l`, cursor shown) in a `finally`, whether or not the Ink version in use does this itself.
- `neutralise` and `flat` in `src/prompt.ts` are moved to `src/text.ts` and exported, for `tui/sanitize.ts`.

### Dependencies

- Runtime: `ink` (^8, Node ≥ 22) and `react` (^19.3). Dev: `ink-testing-library`, `@types/react`.
- README: the "No runtime dependencies" badge and bullet change to "the core loop uses only Node's standard library; `--tui` uses Ink". Add `--tui` and `--max-parallel` to the options table, and an "Interactive TUI" section with the five keys to learn first (`a`, `f`, `⏎`, `p`, `q`) and a pointer to `?`. Tick the TUI roadmap item when M1 lands.

## Error handling

- **Brain error:** a red `✗` step row with the message; the run header shows `brain ✗ k/3`; the run continues as today.
- **Playwright error or crash in one run:** its `done` settles to a `RunOutcome` with `error`; the task turns `✗`; the end banner shows the message and the `history.json` path; its session slot is released. Other runs are unaffected.
- **Session already in use** (for example a browser left by a forced exit): the run fails at `open` with today's Playwright error, and the toast suggests `playwright-cli -s=<name> close`.
- **Stop while paused:** the gate rejects with `AbortedError`; the normal interrupted path runs; the task turns `■`.
- **Paused:** nothing runs and nothing is spent; the browser stays open; the run header shows paused time.
- **Bad task file or folder:** each error is a toast; valid files from the same folder are still added.
- **Preflight failure at start:** the task stays `○` with a red `!`; the message shows in the detail pane and as a toast.
- **Render crash:** the error boundary stops all runs, waits for them, restores the terminal, prints the error, then the summary. Every `history.json` is written and every browser closed.
- **Terminal always restored** on quit, crash or forced exit: alternate screen left, cursor shown, raw mode off, by Ink's unmount plus the `finally` in `cli.ts`.

## Testing

- `test/control.test.ts`: every row of the transition table; gate behaviour per state; `step()` while running is a no-op; abort while waiting rejects with `AbortedError`; `control` events.
- `test/loop.test.ts` (extended, fake brain and Playwright): event order for a normal step, a brain-error step and a `done` step; step costs sum to `costUsd`; pause holds before `observe`; stepping runs exactly one step; stop while paused gives `AbortedError`; `onStep` still fires.
- `test/runs/run.test.ts`: `startRun` writes `history.json`, exports, and settles `done` for pass, fail, crash and stop; `run:start` and `run:end` are each emitted once; two concurrent runs keep separate folders, signals, sessions and costs; the process signal still interrupts a run.
- `test/report.test.ts` and the existing `test/cli.test.ts`: plain-mode output, batch output and exit codes are unchanged after the `runOne` refactor.
- `test/runs/manager.test.ts` (fake `startRun` and `preflight`): settings layering; duplicate files skipped; folder errors returned while valid files are added; preflight failure keeps the task idle with `error`; the parallel limit refuses extra starts; slots are taken and released, including after a crash; a second start of an active task is refused; controls forward to the latest run; derived task states; `stopAll` waits for every run; `summary()` rows, total and exit code.
- `test/tui/state.test.ts`, `keys.test.ts`: reducer and every mode's keymap; footer hints per mode and selection; follow mode; the quit confirmation and the Ctrl-C sequence.
- `test/tui/picker.test.ts`: skip rules, the 5,000-entry cap, ranking order, folder expansion.
- `test/tui/form.test.ts`: validation, override and clear.
- `test/tui/sanitize.test.ts`: escape sequences and control characters are removed.
- `test/tui/app.test.ts` (`ink-testing-library` frames, fake manager): empty workspace; adding a typed task; picking files; the settings form; two runs in different states; pausing and stepping the selected run; quitting with active runs; narrow layouts.
- `test/cli.test.ts` (fake `isTTY` and `loadTui`): `--tui` without a TTY exits `2`; `--tui` with a task or `-f` exits `2`; `--max-parallel` validation, and its use without `--tui`; a failed workspace preflight exits `2` before the TUI loads; the summary and exit code after quit.
- `test/packaging.test.ts`: the packed tarball installs, imports `ink` and `react`, and `dist/cli.js`'s dynamic import points at `./tui/index.js`.
