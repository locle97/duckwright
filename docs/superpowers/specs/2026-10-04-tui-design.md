# Interactive TUI (`--tui`) design

Status: draft for review, 2026-10-04.

## Goal

An interactive terminal UI that shows each step's goal, actions, results and the running cost live, with keys to pause, step through, or stop the run. It is the **TUI** item on the README roadmap.

```bash
duckwright "Go to example.com and report the page heading" --tui
duckwright -f tasks/ --tui          # milestone 2
```

## Milestones

| Milestone | Scope |
| --- | --- |
| **M1: single-run TUI** | `--tui` flag, run event stream, `RunControl` (pause / step / stop), live step timeline, end-of-run review screen, help overlay. A batch with `--tui` is a usage error until M2. |
| **M2: batch TUI** | Sidebar of task files with state (queued, running, pass, fail, stop, skip) and cost, batch total in the header; selecting a task shows its timeline. The plain batch summary is printed on exit. Prepares for the *parallel batches* roadmap item. |
| **M3: polish (optional)** | Light/dark and truecolor themes, `NO_COLOR`, mouse (click a step, wheel scroll), `/` filter over steps, open-run-folder key, and an `events.jsonl` sink as the base for a future `duckwright watch`. |

This spec details M1. M2 and M3 each get their own short spec before their plan, reusing the event stream and components defined here.

Out of scope for every milestone: approving each decision before it runs (that is the *confirm before risky actions* roadmap item), pausing between the actions of one decision, and making the TUI the default.

## Research: what we borrow from herdr

[herdr](https://github.com/herdrdev/herdr) is a Rust (ratatui + crossterm) terminal multiplexer for coding agents. Patterns worth copying:

- **One glanceable state per unit of work.** Every agent is `working`, `blocked`, `done` (finished, unseen) or `idle`, each with a fixed colour: yellow working, red blocked, green done/idle, blue unseen, peach interrupted. Duckwright maps this onto runs and steps.
- **Semantic palette.** Colours are roles (`text`, `subtext`, `overlay`, `surface`, `accent`, plus state colours), not raw values; themes and "follow the terminal palette" fall out of that.
- **Small learnable keymap.** "Learn these five first"; `?` opens a help overlay listing every active binding. Hints shown are generated from the active keymap.
- **List and detail.** A sidebar list with state icons and a detail area for the selection (our M2 sidebar). Single-letter filters by state.
- **Graceful truncation.** Rows shed optional fields as width shrinks instead of wrapping.
- **Small signals.** A `●` state dot before status text, braille spinner frames while working, short toast messages.

## Command line

- `--tui` is a command-line flag only, not a task-file key: it is a viewing preference, not part of the task.
- `--tui` needs an interactive terminal. If stdin or stdout is not a TTY: `--tui needs an interactive terminal`, exit `2`, before anything runs.
- M1 only: `--tui` with a batch (two or more task files) is `--tui does not support batches yet`, exit `2`.
- Without `--tui`, output, exit codes and `history.json` are unchanged.

## Screen (M1)

```
╭─ 🦆 duckwright ─────────────────────────────────────────────────────────╮
│ Go to example.com and report the page heading                          │
│ ● running   step 3/25   $0.0412   00:41   sonnet · hybrid · headless   │
╰────────────────────────────────────────────────────────────────────────╯
  ✓ 1  Open example.com                                    $0.011   4.2s
  ✓ 2  Read the heading                                    $0.013   6.0s
▸ ⠋ 3  Verify heading text                                 thinking…
     ├ eval   Page loaded, heading visible
     ├ goal   Verify heading text and finish
     ├ ✓ expect heading "Example Domain"      → ok
     └ ⠋ done success "Example Domain"         running…

 p pause · n step · s stop · ↑↓ select · ⏎ expand · ? help
```

### Header

- The task, cut to fit one or two lines.
- A run-state dot and label: yellow `● running`, blue `‖ paused` (with paused time), peach `■ stopping`, green `✓ success`, red `✗ failure`, peach `■ interrupted`.
- `step N/max`, total cost (`$` with 4 decimals, as the plain output), elapsed time, then `model · snapshot mode · headed|headless`.
- After a brain error: `brain ✗ k/3` in red until the next good step.

### Timeline

- One row per step: status icon, step number, `nextGoal`, step cost, step duration.
  - Icons: braille spinner (running), `✓` (all actions ok), `!` yellow (an action failed, run continues), `✗` red (brain error), `◆` (the step that ran `done`).
  - While running, the right column shows the phase: `snapshot…`, `thinking…`, `acting…`.
- The running step is expanded automatically and shows `eval` (evaluation of the previous goal), `goal`, `memory` (only when it changed), and each action as `cmd args → result`, with a spinner on the action in flight.
- Earlier steps are collapsed; select with `↑/↓` (or `j/k`) and toggle with `⏎`/`space`. `e`/`c` expand or collapse all.
- **Follow mode:** the view sticks to the newest step until the user moves the selection up; `G`/`End` jumps back and re-enables follow. The footer shows `following` / `G follow` accordingly.

### Footer

Only keys that do something right now, generated from the keymap:

| Run state | Footer |
| --- | --- |
| running | `p pause · s stop · ↑↓ select · ⏎ expand · ? help` |
| paused | `r resume · n step · s stop · ↑↓ select · ⏎ expand · ? help` |
| stopping | `ctrl+c force quit` |
| finished | result banner, then `q quit · ↑↓ select · ⏎ expand · ? help` |

### Keys

| Key | Action |
| --- | --- |
| `p` | Pause: the current step finishes, then the run holds before the next snapshot |
| `r` | Resume |
| `n` / `.` | While paused: run exactly one more step, then hold again. Ignored while running (use `p`) |
| `s` | Stop cleanly (same as today's first Ctrl-C) |
| `ctrl+c` | First: stop cleanly. Second: exit at once (as `bin.ts` today) |
| `↑↓` `j/k`, `PgUp/PgDn`, `g/G` | Move the selection, page, jump to first/last (follow) |
| `⏎` / `space`, `e`, `c` | Expand/collapse the selected step, expand all, collapse all |
| `?` | Toggle the help overlay (`esc` closes it) |
| `q` | After the run: quit. During a run: same as `s`, with a one-line "stop the run? q again" confirmation |

### End of run

The footer is replaced by a banner: result, answer, steps, cost, the `history.json` path, and `Test: <path>` / `not exported` when `--export` was given. The timeline stays scrollable. `q` leaves the alternate screen and prints the normal plain summary (`Result:`, `Answer:`, `Steps:`, `History:`, `Test:`) so it remains in the terminal's scrollback.

### Layout rules

- Widths adapt: the cost and duration columns drop first, then the step number.
- Below about 60×12 the header collapses to one line and expanded details are indented less. Below about 40×8 only `terminal too small` and the key hints are shown.
- Colours are the 16 ANSI colours by role (so the terminal's theme applies) in M1. Themes come in M3.

### Untrusted text

Goals, memory, results and the answer can carry page text. Before display they go through the existing `neutralise`/`flat` helpers, plus stripping of C0/C1 control characters and ANSI escape sequences, so a page can never move the cursor or change terminal state.

## Architecture

```
             ┌──────────── src/loop.ts (Agent) ────────────┐
 RunControl ─┤ await control.gate()  ← top of every step   │
 (pause/step │ emit(step:start) → observe → emit(phase)…   │
  /stop)     │ … decide → emit(decision,cost) → execute    │
             │ → emit(action:result)… → emit(step:end)     │
             └───────────────┬─────────────────────────────┘
                             │ RunEvent stream
              ┌──────────────┴──────────────┐
      src/report/plain.ts             src/tui/ (Ink, lazy-loaded)
      (today's step lines)            reducer → view model → components
```

The loop knows nothing about any UI; both renderers subscribe to the same events.

### `src/events.ts`

A typed `RunEvent` union and a minimal `RunEvents` hub (`emit`, `subscribe` returning an unsubscribe function; listeners are called synchronously and a throwing listener does not break the loop). Every event carries `at` (ms timestamp). The loop emits the step-level events; `cli.ts` emits `run:start` and `run:end` because only it knows the model, the history path and the export outcome.

| Event | Payload |
| --- | --- |
| `run:start` | task, maxSteps, model, snapshot mode, headed, workdir (emitted by `cli.ts`) |
| `step:start` | step |
| `phase` | step, `observing` \| `thinking` \| `acting` (shown as `snapshot…`, `thinking…`, `acting…`) |
| `decision` | step, `Decision`, step cost |
| `action:start` | step, index |
| `action:result` | step, index, result, code |
| `brain:error` | step, message, cost, consecutive failures |
| `step:end` | `StepRecord`, step cost, duration ms |
| `control` | `running` \| `paused` \| `stepping` \| `stopping` |
| `run:end` | `RunResult`, or `{ error, answer, exitCode }` for crashes and interruptions; history path; export outcome |

Action-level events need `execute` in `actions.ts` to take an optional per-action callback; its behaviour is otherwise unchanged.

### `src/control.ts`

`RunControl` owns the pause state and the stop request:

- `new RunControl(controller: AbortController, events?)`; methods `pause()`, `resume()`, `step()`, `stop()`; `state`: `running | paused | stepping | stopping`. Each change emits `control`.
- State transitions (anything not listed is a no-op):

  | From | Call | To |
  | --- | --- | --- |
  | `running` | `pause()` | `paused` (takes effect at the next gate; the current step finishes) |
  | `paused` | `resume()` | `running` |
  | `paused` | `step()` | `stepping` |
  | `stepping` | gate passes | `paused` (the gate lets this one step through, then the next gate waits) |
  | `stepping` | `pause()` | `paused` (cancels the pending step if the gate has not passed yet) |
  | any but `stopping` | `stop()` | `stopping` |

- `gate(signal): Promise<void>` returns at once while `running`; while `paused` it waits; in `stepping` it passes once and moves to `paused`. If the signal aborts while waiting, it rejects with `AbortedError`.
- `stop()` aborts the controller it was given. That controller is the TUI-side controller described under *CLI wiring*, whose signal is combined with the SIGINT signal, so stopping reuses today's shutdown path: the running child is killed, `history.json` is written as `interrupted`, the browser is closed, exit `130`.

### `src/loop.ts`

- New optional `AgentOptions`: `events?: RunEvents`, `control?: RunControl`.
- At the top of each step, before `observe`, `await control?.gate(signal)`. Pausing therefore never interrupts a browser action or spends money.
- Emits the events above at the matching points. Step cost is the cost returned by `decide` (or `BrainError.cost`).
- `onStep` stays, implemented as a subscriber, so existing callers and tests keep working.

### `src/report/plain.ts`

Today's `stepLine` output, driven by `step:end` events. `cli.ts` uses it when `--tui` is absent. Output is byte-for-byte unchanged.

### `src/tui/`

| File | Responsibility |
| --- | --- |
| `state.ts` | Pure reducer `(ViewState, RunEvent \| UiAction) → ViewState`: steps, phases, selection, expanded set, follow mode, help overlay, toasts, end banner. Most logic lives here. |
| `keys.ts` | Pure keymap `(key, ViewState) → UiAction \| ControlCall \| null`, plus `hints(ViewState)` used by the footer and help overlay. |
| `theme.ts` | Colour roles → ANSI colours; state → icon and colour. |
| `sanitize.ts` | Strips control characters and escape sequences on top of `neutralise`/`flat`. |
| `app.ts`, `header.ts`, `timeline.ts`, `footer.ts`, `banner.ts`, `help.ts` | Ink components, written with `React.createElement` (imported as `h`) in plain `.ts` files so `node --test` keeps running sources with type stripping and no JSX build step. |
| `index.ts` | `startTui({ events, control, deps }) → { done: Promise<void> }`; `done` resolves when the user quits after `run:end`. An error boundary stops the run and restores the terminal if rendering throws. |

### CLI wiring

- `args.ts`: `--tui` (boolean, CLI only).
- `CliDeps` gains `isTTY(): boolean` (stdin and stdout both TTYs) and `loadTui(): Promise<typeof import("./tui/index.ts")>` (default: a dynamic `import()`, so plain runs never load React). Tests override both, so `cli.test.ts` never renders Ink.
- **Abort signal.** `bin.ts` keeps its private SIGINT controller and `deps.signal` stays as is. In `--tui` mode `runOne` creates its own `AbortController` for `RunControl`, and uses `AbortSignal.any([deps.signal, tuiController.signal])` everywhere it uses `deps.signal` today: `Brain`, `PlaywrightCLI`, `Agent`, and the `aborted` check that classifies a failure as `interrupted`. Without `--tui` the combined signal is just `deps.signal`.
- **Order in `runOne` with `--tui`:**
  1. Create `RunEvents`, the controller and `RunControl`; `startTui(...)`.
  2. Emit `run:start` from `cli.ts` (it knows model, snapshot mode, headed and workdir; the `Agent` does not know the model).
  3. Run the agent with `events` and `control`; no `onStep` step lines are printed.
  4. Write `history.json` and run the export exactly as today.
  5. Emit `run:end` with the result (or failure), history path and export outcome. This is the only place `run:end` is emitted.
  6. `await done`, then print the plain summary.
- **Output while the TUI is up.** `runOne` swaps `deps.stdout`/`deps.stderr` for a recorder for the whole run. Every recorded line is kept in order. `stderr` lines (warnings, `export failed`, error messages) are also shown as toasts; `stdout` lines are not shown in the TUI (the banner is built from `run:end`). After `done`, the recorded lines are written to the real `deps.stdout`/`deps.stderr` in order. This *is* the plain summary, so it is printed exactly once and matches what a run without `--tui` prints, minus the step lines. Ink's `patchConsole` catches stray `console` output.
- **Ctrl-C in raw mode** reaches Ink as a key, not SIGINT. The first press calls `control.stop()`. The second unmounts Ink (which restores the terminal), then calls `process.exit(130)`, matching `bin.ts`.

### Dependencies

- Runtime: `ink` (^8, Node ≥ 22) and `react` (^19.3). Dev: `ink-testing-library`, `@types/react`.
- README: the "No runtime dependencies" badge and feature bullet change to "the core loop uses only Node's standard library; the optional `--tui` uses Ink", and the TUI roadmap item is ticked when M1 lands. A `--tui` row is added to the options table, with a short "Interactive TUI" section listing the keys.

## Error handling

- **Brain error:** a red `✗` step row with the message; header shows `brain ✗ k/3`; the run continues as today.
- **Playwright error or unexpected exception:** `run:end` carries it; the banner shows `✗ playwright error: …` (or `error: …`) with the `history.json` path. The exit code is unchanged from today.
- **Stop while paused:** the gate rejects with `AbortedError`, the normal interrupted path runs, exit `130`.
- **Stop mid-step:** the running `claude` or `playwright-cli` child is killed, as with Ctrl-C today.
- **Paused:** nothing runs and nothing is spent; the browser session stays open; the header shows paused time.
- **Render crash:** the error boundary calls `control.stop()`, restores the terminal, and prints the error; `history.json` is still written and the browser closed.
- **Terminal always restored** (quit, crash, second Ctrl-C): leave the alternate screen, show the cursor, turn raw mode off. Ink does this; a `finally` in `cli.ts` is the backup.

## Testing

- `test/control.test.ts`: every row of the transition table; gate passes while running; waits while paused; `step()` lets exactly one gate through; `step()` while running is a no-op; `resume()` releases; abort while waiting rejects with `AbortedError`; `control` events are emitted.
- `test/loop.test.ts` (extended): with the fake brain and fake Playwright, the event order for a normal step, a brain-error step and a `done` step; per-step costs sum to `costUsd`; pause holds before `observe`; stepping runs exactly one step; stop while paused gives `AbortedError`; `onStep` still fires.
- `test/report.test.ts`: plain output from events matches today's lines exactly.
- `test/tui/state.test.ts`, `test/tui/keys.test.ts`: reducer and keymap, including follow mode, expand/collapse, footer hints per run state, the `q` confirmation.
- `test/tui/sanitize.test.ts`: escape sequences and control characters are removed.
- `test/tui/app.test.ts`: `ink-testing-library` frames for running, paused, success, failure, brain error and narrow terminals; simulated keys call `RunControl`.
- `test/cli.test.ts` (with fake `isTTY` and `loadTui`): `--tui` without a TTY exits `2`; the TUI's stop aborts the combined signal and gives exit `130`; `run:end` is emitted once after `history.json` is written; recorded lines are printed once, after `done`; `--tui` with a batch exits `2` (M1); output without `--tui` is unchanged; the plain summary is printed after quitting the TUI.
- `test/packaging.test.ts`: the packed tarball installs, can import `ink` and `react`, and `dist/cli.js`'s dynamic import points at `./tui/index.js` (the `.ts` extension is rewritten).
