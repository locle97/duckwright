# TUI: newest-first task list and Tab between the add box and the task list (design)

Status: draft for review, 2026-10-05. Parents: [2026-10-04-tui-design.md](2026-10-04-tui-design.md), [2026-10-05-tui-m3-polish-design.md](2026-10-05-tui-m3-polish-design.md).

## Summary

The `duckwright --tui` sidebar currently lists tasks in the order the manager holds them: past runs (oldest first), then tasks added this session. Users want the newest task on top. Every `TaskSnapshot` gets a creation time, `createdAt` (epoch ms): typed and file tasks are stamped when added, and past-run tasks use their recorded run start. The TUI shows tasks sorted by `createdAt` descending (ties: higher id first). Sorting is a pure view concern in `src/tui/`; `RunManager.list()`, the plain report and the quit summary keep their order.

Tab also changes meaning. Today it toggles focus between the task list and the detail pane. From now on Tab moves between the task list and the add box: list → add box, add box (with the `@` completion list closed) → list, detail → list. With the completion list open, Tab still accepts or descends into the highlighted candidate. Because Tab no longer opens the detail pane, `→` (right arrow) takes over the old Tab job of focusing the detail pane of a task that has a run, so finished and past runs can still be browsed.

## Decisions

| Topic | Decision |
| --- | --- |
| Meaning of "created" | The time a task was added in this session, or the run start time for a past-run task. (Brief assumption.) |
| `createdAt` field | `TaskSnapshot` gains required `createdAt: number` (epoch ms). The internal `Task` record in `src/runs/manager.ts` stores it. It is set once and never changes, so a re-run does not move a task. |
| Clock injection | `ManagerOptions` gains optional `now?: () => number`, default `Date.now`, following the existing optional-option pattern (`cwd?`, `past?`). `#addTask` stamps `createdAt = this.#now()`. (Brief assumption: clock injection follows the manager's patterns.) |
| Past-run time | `PastRun` (`src/runs/past.ts`) gains required `startedAt: number`. `loadPastRuns` sets it to the `at` of the first `run:start` event in the run's chosen events; if there is none, to `fsx.mtimeMs(workdir)` (the run folder); if that throws, to `0`. The manager copies `p.startedAt` into the past task's `createdAt`. For runs without a valid `events.jsonl`, the synthesised events already carry `history.json`'s mtime as the `run:start` `at`, so that value is used. |
| Where sorting happens | In the TUI view layer only. `RunManager.list()` order, `summary()` and the plain report are unchanged. (Brief assumption.) |
| Sort key | `createdAt` descending, then `id` descending. |
| Storage vs display | `ViewState.tasks` stays in arrival order (append on `task:added`); `selected` stays an index into `tasks`. Only the display order is sorted: `visibleTasks(s)` returns indexes in newest-first order, filtered by the active query. All navigation (`select`, `selectEdge`, `snap`) and the sidebar already walk `visibleTasks`, so they follow the display order. |
| Order helper | New pure module `src/tui/order.ts` exporting `newestFirst(tasks: readonly { id: number; createdAt: number }[]): number[]`, the indexes of `tasks` in display order. `filter.ts` is unchanged. |
| Initial selection | `initialState` selects the top row: `visibleTasks(s)[0] ?? 0` (the newest task), not index 0. |
| Selection on add | `task:added` appends, so the selected index (and task) does not change. A new task appears at the top because it is newest. |
| Selection on update | `task:updated` replaces in place; selection unchanged. |
| Selection on remove | If a task other than the selected one is removed, selection stays on the same task (its index is recomputed by id). If the selected task is removed, selection moves to the task that was directly below it in the display order (visible rows only), else the one directly above, else index `0`. `snap` still runs afterwards. |
| Add-box submission selection | Changed: `app.ts` no longer dispatches `selectTask` for `r.added[0]` after a successful add-box submission (the two lines `const added = r.added[0]; if (added !== undefined) dispatch({ type: "selectTask", id: added });` are deleted). The selection stays on the previously selected task, as the brief asks. When the list was empty before the submission, `selected` is already `0`, so the first appended task (the new one) becomes the selection with no extra code. (Conductor ruling, following the brief literally.) |
| Filter and a new task | Because `selectTask` is no longer dispatched on submission, an active filter is no longer cleared when a new task does not match it; the new task is simply hidden until the filter changes, like any other non-matching task. |
| `selectTask` action | Kept in `UiAction` and the reducer with its existing tests, though `app.ts` no longer dispatches it. Removing it is outside this change. |
| `j` / `↓`, `g` / `G` | Unchanged bindings; in display order `↓` moves to an older task, `g` goes to the newest (top), `G` to the oldest (bottom). |
| Tab in list mode | `{ type: "focus", target: "compose" }`, always (also on an empty list), like `a`. Shift+Tab behaves the same (the `named("tab")` matcher ignores shift). |
| Tab in compose, completion closed | `{ type: "focus", target: "list" }`: focus `list`, mode `list`. The draft (`compose`) and `addErrors` are kept, as Esc keeps them. Tab always goes to the list, even if compose was opened from the detail pane. (Brief assumption: draft kept.) Tab with `ctrl` or `meta` in compose is ignored as before. |
| Tab in compose, completion open | Unchanged: accept the highlighted file, or descend into the highlighted folder; nothing when there is no candidate. |
| Tab in detail mode | `{ type: "focus", target: "list" }`. Always active (even with no run). |
| Old list↔detail Tab toggle | Removed. The `toggleFocus` `UiAction` and its reducer case are deleted. (Brief assumption.) |
| Reaching the detail pane | `⏎` on a live task still focuses the detail pane. New list binding: `→` (key name `right`) focuses the detail pane when the selected task has a run (`t.runId != null`), the old Tab condition. Hint `{ key: "→", label: "details" }`, footer shown. Esc and Tab in detail return to the list. Without this, finished and past runs could not be browsed in the detail pane, and on narrow terminals (< 60 columns) not seen at all. |
| `a` hint | The `a` binding stays in both list and detail but its hint moves out of the footer (`footer: false`); it is still listed in help. The footer uses `tab add` in list mode instead, to avoid two "add" hints. |
| Footer hints, list mode | The list Tab binding has hint `{ key: "tab", label: "add" }`, `footer: true`. |
| Footer hints, detail mode | The detail Tab binding has hint `{ key: "tab", label: "tasks" }`, `footer: true`. |
| Footer hints, compose mode (completion closed) | `⏎ add · @ file · alt+⏎ newline · ↑↓ history · tab tasks · esc back`. With the completion open, unchanged: `↑↓ move · tab complete · ⏎ accept · esc close`. |
| Help overlay | Generated from the binding tables as now, so it lists `tab add` and `→ details` in list mode and `tab tasks` in detail mode, plus `a add`. No new help code. |
| Binding placement | The Tab binding moves out of `SHARED` into `LIST_ONLY` (focus compose) and `DETAIL_ONLY` (focus list); the `→` binding goes into `LIST_ONLY`, after the `return` binding. |
| Mouse, sort options | Not built. |

## Architecture / Components

### `src/runs/past.ts`
- `PastRun` gains `startedAt: number`.
- `loadPastRuns` computes it after choosing `events` (from `events.jsonl` or `eventsFromHistory`): first `run:start` event's `at`; else `fsx.mtimeMs(workdir)` inside `try`; on throw, `0`.

### `src/runs/manager.ts`
- `TaskSnapshot` gains `createdAt: number`; `Task` gains `createdAt: number`.
- `ManagerOptions` gains `now?: () => number`. The manager adds a private `#now` field, set in the constructor to `o.now ?? Date.now`.
- Constructor: past tasks get `createdAt: p.startedAt`.
- `#addTask`: `createdAt: this.#now()`.
- `#snapshot` copies `createdAt`.
- `list()`, `summary()`, ids and everything else unchanged.

### `src/tui/order.ts` (new)
```ts
/** Indexes of `tasks` in sidebar order: newest `createdAt` first, then higher id first. */
export function newestFirst(tasks: readonly { id: number; createdAt: number }[]): number[]
```
Pure, no imports beyond types; returns a new array, never mutates `tasks`.

### `src/tui/state.ts`
- `visibleTasks(s)`: `const shown = new Set(visibleIndexes(s.tasks, activeQuery(s))); return newestFirst(s.tasks).filter((i) => shown.has(i));`
- `initialState`: after building the state, `selected = visibleTasks(s)[0] ?? 0`.
- `reduceManager` `task:removed`: implements the removal rule from Decisions: take the old display order (`visibleTasks(s)`) and the selected id; remove; if the selected task survives, `selected = new index of that id`; otherwise pick the neighbour below, then above, in the old display order, mapped to its new index; else `0`; then `snap`.
- `UiAction`: drop `{ type: "toggleFocus" }`; drop its `apply` case. `focus` is unchanged (`target: "list"` already sets `focus: "list", mode: "list"` and leaves `compose` alone).

### `src/tui/keys.ts`
- `SHARED`: remove the Tab binding; set the `a` binding's `footer` to `false`.
- `LIST_ONLY`: add `{ match: named("tab"), when: () => true, run: () => [ui({ type: "focus", target: "compose" })], hint: { key: "tab", label: "add" }, footer: true }` and `{ match: named("right"), when: (c) => hasTask(c) && c.t?.runId != null, run: () => [ui({ type: "focus", target: "detail" })], hint: { key: "→", label: "details" }, footer: true }`.
- `DETAIL_ONLY`: add `{ match: named("tab"), when: () => true, run: () => [ui({ type: "focus", target: "list" })], hint: { key: "tab", label: "tasks" }, footer: true }`.
- `composeCommands`: after the `if (open && !k.ctrl && !k.meta) { … }` block and before the `return` handling, add: if `k.name === "tab" && !open && !k.ctrl && !k.meta` → `[ui({ type: "focus", target: "list" })]`.
- `hints` compose case (completion closed): insert `{ key: "tab", label: "tasks" }` before `{ key: "esc", label: "back" }`.

### `src/tui/app.ts`
- `run`, `case "addSubmission"`: delete the `const added = r.added[0];` line and the `selectTask` dispatch after it. Everything else in the case (error handling, clearing the compose box, duplicate toasts) is unchanged.

### Unchanged
`sidebar.ts` (already renders `visibleTasks` order and positions by `visible.indexOf(s.selected)`), `help.ts`, `footer.ts`, `filter.ts`, `compose.ts`, the CLI and the report.

## Data flow

1. Startup: `loadPastRuns` returns `PastRun`s with `startedAt`; `RunManager` turns them into tasks with `createdAt = startedAt`. `manager.list()` (arrival order) goes to `initialState`, which replays past runs and selects the first index of `visibleTasks` (the newest task).
2. Add: the user submits the add box; `RunManager.#addTask` stamps `createdAt = now()` and emits `task:added`; the reducer appends the snapshot. `visibleTasks` now puts it first, so the sidebar draws it on top; `selected` still points at the same task. `app.ts` no longer re-selects the new task, so the selection stays where it was (on an empty list it is index `0`, which is now the new task).
3. Re-run / state change: `task:updated` replaces the snapshot; `createdAt` is unchanged, so the row stays put.
4. Remove: `task:removed` removes the task and re-points `selected` per the removal rule.
5. Keys: `keymap` maps Tab per mode to `focus` actions (`list` → compose, compose with closed completion → list, detail → list) and `→` in list to `focus detail`. `hints` / `helpBindings` read the same binding tables, so the footer and help follow.

## Error handling

| Failure | Behavior |
| --- | --- |
| Past run with no `run:start` event (e.g. failed before the run started) | `startedAt` = run folder mtime. |
| Run folder mtime unreadable | `startedAt` = `0`; the task sorts at the bottom (ties broken by id). |
| Two tasks with the same `createdAt` (same-ms adds, multi-file submission) | Higher id first, so later-added is on top; stable and deterministic. |
| Clock going backwards between adds | Tasks sort by the recorded value; no correction. |
| Selected task removed and it was the only visible task | Selection becomes `0`, then `snap` (unchanged from today when nothing is visible). |
| Tab in list with no tasks | Opens the add box. |
| Tab in detail with no run | Returns to the list. |
| `→` on a task with no run | No command (binding inactive, no hint). |
| Tab in compose with completion open but no candidates | Nothing (unchanged). |

## Testing

All through `npm test` (typecheck plus `node --test "test/**/*.test.ts"`). No e2e tests.

Fixture updates: every `TaskSnapshot` built in tests gains `createdAt` (helpers `task()` in `test/tui/keys.test.ts` and `test/tui/state.test.ts`, and `snapshot()` in `test/tui/fake-manager.ts`, default `createdAt: 0`); `pastRun()` in `test/runs/manager.test.ts` gains `startedAt` (default `0`); `PastRun` expectations in `test/runs/past.test.ts` include `startedAt`. Existing tests that assumed the oldest task is selected first or that `j` moves from task 1 to task 2 are updated to the newest-first order. Tests of `toggleFocus` (`state_escape_restores_previous_focus`, `keys_list_bindings`, the empty-list loop in `keys_noop_without_live_run`) are rewritten for the new actions.

New or changed unit tests:

- `test/tui/order.test.ts` (new): `newestFirst` with `createdAt` 1, 2, 3 → order 3, 2, 1; equal `createdAt` → higher id first; a past task with `createdAt` 5 above a typed task with 4; input array not mutated.
- `test/tui/state.test.ts`:
  - sidebar order: tasks added via `task:added` events with `createdAt` 1, 2, 3 give `visibleTasks` mapping to ids 3, 2, 1; a past task (`createdAt` 5) sorts above a typed task (4).
  - `initialState` selects the newest task.
  - with task B selected, a `task:added` for C keeps B selected (`selectedTask(s).id === B`) and C is first in `visibleTasks`.
  - `task:updated` (e.g. state change to `running`) keeps selection and order.
  - removing a non-selected task keeps the selection on the same id; removing the selected task selects the row below it, or above it when it was the bottom row.
  - filter plus order: the filtered `visibleTasks` stays newest-first.
  - `focus` to `list` from compose keeps `compose.text`.
- `test/tui/keys.test.ts`:
  - list: `tab` → `[ui({ type: "focus", target: "compose" })]`, also on an empty list; `right` on a task with a run → `focus detail`; `right` with no run → `[]`.
  - compose, completion closed: `tab` → `[ui({ type: "focus", target: "list" })]`; playing it gives mode `list` with the draft kept.
  - compose, completion open: `tab` still completes (existing tests stay green).
  - detail: `tab` → `[ui({ type: "focus", target: "list" })]`.
  - footer: list footer contains `tab add` and not `a add`; detail footer contains `tab tasks`; compose (closed) footer equals `⏎ add · @ file · alt+⏎ newline · ↑↓ history · tab tasks · esc back`; compose (open) footer unchanged.
  - `helpBindings` in list contains `tab add`, `→ details`, `a add`; in detail contains `tab tasks`.
- `test/tui/app.test.ts`:
  - `app_mixed_submission` is updated, not deleted or skipped: with "older" selected, submitting `@a.md check the price` adds the task, the sidebar shows it on top (its row comes before the "older" row in the frame), and the detail pane still shows "older" (no `source: typed` / `check the price` detail lines; the "older" detail is shown).
  - new `app_add_keeps_selection`: `FakeManager` with `snapshot(1, "First")` and `snapshot(2, "Second")` (both `createdAt: 0`, so the display order is Second, First). Press `j` to select First (id 1), then `a`, `x`, `⏎`, Esc, then `⏎` in the list. `m.log` ends with `start:1` (the start went to First, still selected), and in the frame the `"x"` row comes before the `"Second"` row (the new task is on top).
  - new `app_add_on_empty_list_selects_new`: on an empty list, adding a typed task makes it the selected task (its detail is shown).
  - other app tests that submit tasks (`app_add_tasks_in_a_row`, `app_keys_without_rerender_between_them`, `app_completion_*`, `app_duplicate_toast`) assert nothing about selection and stay as they are; if one does fail because of the selection change, it is updated to the new behaviour, not deleted or skipped.
- `test/runs/manager.test.ts`: with `now` injected returning 100 then 200, `addTyped` twice gives `createdAt` 100 and 200 on the snapshots and in `task:added` events; a file task added through `add()` is stamped; a past task's `createdAt` equals `startedAt`; re-running a task (`start`) leaves `createdAt` unchanged; `list()` order is still arrival order.
- `test/runs/past.test.ts`: `startedAt` equals the `run:start` `at` from `events.jsonl`; equals `history.json` mtime when `events.jsonl` is missing (via the synthesised events); equals the folder mtime when `events.jsonl` is valid but has no `run:start`; `0` when the folder mtime throws (fake `PastFs`).

Success criteria mapping: order 3, 2, 1 and past-5-above-typed-4 → `order.test.ts` and `state.test.ts`; selection kept on add → `state.test.ts` (reducer) and `app.test.ts` (`app_add_keeps_selection`, `app_mixed_submission`); new task selected on an empty list → `app.test.ts`; Tab list↔compose with draft kept and completion still completing → `keys.test.ts` and `state.test.ts`; Tab detail → list → `keys.test.ts`; footer and help labels → `keys.test.ts`.

### Manual e2e

For the user, optional: run `duckwright --tui` with a few past runs, add two tasks and check they appear on top; press Tab to go between the list and the add box, `→` to open a finished run's detail, Tab to come back.

## Out of scope

- User-selectable sort orders or sort keys.
- Changing the order of the plain (non-TUI) report or the quit summary.
- Persisting the creation time anywhere new (`startedAt` is derived from files that already exist).
- Mouse focus.
- A Shift+Tab reverse cycle distinct from Tab.
