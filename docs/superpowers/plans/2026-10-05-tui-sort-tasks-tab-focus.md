# TUI newest-first task list and Tab list/add-box focus Implementation Plan

**Goal:** The `--tui` sidebar lists tasks newest first, and Tab moves focus between the task list and the add box (`→` opens the detail pane).
**Architecture:** Every `TaskSnapshot` gets an immutable `createdAt` (epoch ms): stamped by `RunManager` through an injectable clock for new tasks, derived from the run start (`PastRun.startedAt`) for past runs. Sorting is view-only: a pure `newestFirst` helper in `src/tui/order.ts` feeds `visibleTasks`, while `ViewState.tasks` stays in arrival order. Keys change in the binding tables of `src/tui/keys.ts`; `app.ts` stops re-selecting a newly added task.
**Tech Stack:** TypeScript (Node >= 22.18, type stripping), Ink/React TUI, `node:test`.
**Spec:** `docs/superpowers/specs/2026-10-05-tui-sort-tasks-tab-focus-design.md`

## Global Constraints

- Sort key: `createdAt` descending, then `id` descending.
- Sorting happens in the TUI view layer only. `RunManager.list()` order, `summary()` and the plain report are unchanged.
- `createdAt` is set once and never changes, so a re-run does not move a task.
- `ViewState.tasks` stays in arrival order (append on `task:added`); `selected` stays an index into `tasks`. Only the display order is sorted.
- `selectTask` is kept in `UiAction` and the reducer with its existing tests, though `app.ts` no longer dispatches it.
- The `toggleFocus` `UiAction` and its reducer case are deleted.
- All checks run through `npm test` (typecheck plus `node --test "test/**/*.test.ts"`). No e2e tests.
- Existing tests that break because of the new order or the new keys are updated to the new behaviour, never deleted or skipped.

## Review Focus

1. Removing the selected task: selection goes to the row below in the old display order, else the row above, else index `0` (including when it was the only visible task under a filter). Pinned by `state_remove_selected_picks_neighbour` and `state_remove_only_visible_falls_back_to_zero` (Task 3).
2. Selection survives `task:added` (append) and the add-box submission no longer jumps to the new task, yet on an empty list the new task becomes selected. Pinned by `state_add_keeps_selection` (Task 3), `app_add_keeps_selection`, `app_add_on_empty_list_selects_new`, `app_mixed_submission` (Task 5).
3. Tab in compose: completion closed goes to the list keeping the draft; completion open still completes. Pinned by `keys_compose_tab_to_list_keeps_draft` and the existing completion tests (Task 4).
4. `startedAt` fallback chain: `run:start` `at` → folder mtime → `0`. Pinned by the four `past_started_at_*` tests (Task 1).
5. `createdAt` immutable across re-runs and `list()` still in arrival order. Pinned by `manager_created_at_stamped_and_stable` (Task 2).

---

### Task 1: `PastRun.startedAt`

**Files:**
- Modify: `src/runs/past.ts`
- Modify (fixtures only): `test/runs/manager.test.ts` (`pastRun()` gains `startedAt: 0`), `test/cli.test.ts` (`aPastRun()` gains `startedAt: 0`)
- Test: `test/runs/past.test.ts`

**Interfaces:**
- Produces: `PastRun.startedAt: number` (required).

**Checks:** `node --test test/runs/past.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** in `test/runs/past.test.ts`, and add `startedAt` to any existing whole-`PastRun` `deepEqual` expectations:
  - `past_started_at_from_events_jsonl`: run folder with `hist()` and `events.jsonl` = `lines({ ...startEv(), at: 1234 }, endEv(outcome()))` → `r.runs[0].startedAt === 1234`.
  - `past_started_at_history_mtime_without_events`: run folder with only `history.json`; `fs.utimesSync(historyFile, d, d)` to a known date `d` → `startedAt === fs.statSync(historyFile).mtimeMs`.
  - `past_started_at_folder_mtime_without_run_start`: `events.jsonl` = `lines(endEv(outcome()))` (valid, no `run:start`) → `startedAt === fs.statSync(workdir).mtimeMs`. Write all files first, then `fs.utimesSync(workdir, d, d)` with a `d` different from the history mtime.
  - `past_started_at_zero_when_folder_mtime_throws`: fake `PastFs` (`listDirs` returns `["20261001-100000-a"]`; `readFile` returns `JSON.stringify(hist())` for `history.json` and `lines(endEv(outcome()))` for `events.jsonl`; `mtimeMs` returns `5` for `history.json` and throws for the run folder; `exists` false) passed as `fs` → `startedAt === 0`.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/past.test.ts` / `Expected: FAIL (startedAt undefined)`
- [ ] **Step 3: Implement** in `loadPastRuns`: after choosing `const chosen = events ?? eventsFromHistory(h, workdir, at)`, set `startedAt` to the `at` of the first `run:start` in `chosen`; if none, `fsx.mtimeMs(workdir)` in `try`; on throw `0`. Push `{ ..., events: chosen, outcome, startedAt }`. Add `startedAt: 0` to the `pastRun()` and `aPastRun()` fixtures.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/past.ts test/runs/past.test.ts test/runs/manager.test.ts test/cli.test.ts && git commit -m "feat(runs): record past run start time"`

---

### Task 2: `createdAt` on tasks and an injectable clock

**Files:**
- Modify: `src/runs/manager.ts`
- Modify (fixtures only, `createdAt: 0` default): `test/tui/fake-manager.ts` (`snapshot()`), `test/tui/state.test.ts` (`task()`), `test/tui/keys.test.ts` (`task()`), plus any other `TaskSnapshot` literal the typecheck flags (e.g. in `test/tui/index.test.ts`, `test/tui/app.test.ts`)
- Test: `test/runs/manager.test.ts`

**Interfaces:**
- Consumes: `PastRun.startedAt` (Task 1).
- Produces: `TaskSnapshot.createdAt: number` (required); `ManagerOptions.now?: () => number` (default `Date.now`).

**Checks:** `node --test test/runs/manager.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** in `test/runs/manager.test.ts`:
  - `manager_created_at_stamped_and_stable`: `setup({ now })` with `now` returning `100` then `200` on successive calls; `addTyped("a")`, `addTyped("b")` → `mgr.list().map((t) => t.createdAt)` equals `[100, 200]`; the two `task:added` events carry `createdAt` `100` and `200`. Then `mgr.start(id1)`, `fakes[0].finish(outcome("pass"))`, `await tick()` → task 1's `createdAt` still `100`, and `mgr.list().map((t) => t.id)` is still `[1, 2]` (arrival order).
  - `manager_created_at_file_task`: with `now = () => 300` and a temp dir holding `a.md`, `mgr.add({ mentions: [file], typed: null })` → the added snapshot's `createdAt === 300`.
  - `manager_past_created_at_is_started_at`: `setup({ past: [pastRun("20260101-000000-a", "pass", { startedAt: 42 })] })` → `mgr.list()[0].createdAt === 42`.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/manager.test.ts` / `Expected: FAIL (createdAt undefined / now ignored)`
- [ ] **Step 3: Implement** in `src/runs/manager.ts`: add `createdAt: number` to `TaskSnapshot` and `Task`; `now?: () => number` to `ManagerOptions` with a doc comment; private `#now` set in the constructor to `o.now ?? Date.now`; past tasks get `createdAt: p.startedAt`; `#addTask` stamps `this.#now()`; `#snapshot` copies it. Add `createdAt: 0` to the listed test fixtures (overridable through the existing `over`/spread where a helper has one).
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS` (display order is not yet sorted, so no TUI test changes behaviour)
- [ ] **Step 5: Commit**: `git add src/runs/manager.ts test/runs/manager.test.ts test/tui/fake-manager.ts test/tui/state.test.ts test/tui/keys.test.ts <other fixture files touched> && git commit -m "feat(runs): stamp task creation time"`

---

### Task 3: Newest-first display order and selection rules

**Files:**
- Create: `src/tui/order.ts`
- Modify: `src/tui/state.ts`
- Test: `test/tui/order.test.ts` (new), `test/tui/state.test.ts`; update order-dependent tests in `test/tui/keys.test.ts`, `test/tui/app.test.ts`, `test/tui/index.test.ts` as needed

**Interfaces:**
- Consumes: `TaskSnapshot.createdAt` (Task 2).
- Produces: `export function newestFirst(tasks: readonly { id: number; createdAt: number }[]): number[]` in `src/tui/order.ts` (indexes of `tasks`, newest first, ties by higher id; returns a new array; no imports beyond types). `visibleTasks(s)` now returns indexes in that order, filtered by `activeQuery(s)`.

**Checks:** `node --test test/tui/order.test.ts test/tui/state.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests**. Build snapshots with `{ ...task(id), createdAt: n }`.
  - `test/tui/order.test.ts`:
    - `order_newest_first`: `createdAt` 1, 2, 3 (ids 1, 2, 3, indexes 0, 1, 2) → `[2, 1, 0]`.
    - `order_ties_by_higher_id`: all `createdAt` 7, ids 1, 2, 3 → `[2, 1, 0]`.
    - `order_past_above_typed`: `[{ id: 1, createdAt: 5 }, { id: 2, createdAt: 4 }]` → `[0, 1]`.
    - `order_does_not_mutate`: input array deep-equals a copy taken before the call.
  - `test/tui/state.test.ts` (import `visibleTasks`):
    - `state_sidebar_newest_first`: three `task:added` with `createdAt` 1, 2, 3 → `visibleTasks(s).map((i) => s.tasks[i].id)` is `[3, 2, 1]`; `initialState(0, [{...task(1), createdAt: 5}, {...task(2), createdAt: 4}])` → ids `[1, 2]`.
    - `state_initial_selects_newest`: `initialState(0, [task(1) createdAt 1, task(2) createdAt 3, task(3) createdAt 2])` → `selectedTask(s).id === 2`.
    - `state_add_keeps_selection`: tasks A(1, `createdAt` 1), B(2, 2); select B; `task:added` C(3, 3) → `selectedTask(s).id === 2` and `s.tasks[visibleTasks(s)[0]].id === 3`.
    - `state_update_keeps_selection_and_order`: `task:updated` of the selected task to `running` → same selected id, same `visibleTasks` id order.
    - `state_remove_keeps_selected_id`: ids 1, 2, 3 (`createdAt` 1, 2, 3; display 3, 2, 1), select id 1 (bottom); remove id 3 → `selectedTask(s).id === 1`.
    - `state_remove_selected_picks_neighbour`: display 3, 2, 1, select id 2, remove 2 → selected id 1 (below); fresh state, select id 1 (bottom), remove 1 → selected id 2 (above).
    - `state_remove_only_visible_falls_back_to_zero`: tasks `task(1)` text "apple", `task(2)` text "pear" (set `text`/`name`), filter kept to `apple` so only id 1 is visible and selected; remove id 1 → `s.selected === 0`, `selectedTask(s) === null`.
    - `state_filter_keeps_newest_first`: four tasks, filter matching two of them → `visibleTasks` ids in descending `createdAt`.
    - `state_focus_list_keeps_compose_text`: focus compose, compose text "hello", `{ type: "focus", target: "list" }` → mode `list`, focus `list`, `compose.text === "hello"`.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/order.test.ts test/tui/state.test.ts` / `Expected: FAIL (module missing, old order)`
- [ ] **Step 3: Implement**:
  - `newestFirst` in `src/tui/order.ts`: sort a fresh index array by `createdAt` desc, then `id` desc.
  - `visibleTasks(s)`: `const shown = new Set(visibleIndexes(s.tasks, activeQuery(s))); return newestFirst(s.tasks).filter((i) => shown.has(i));` and update its doc comment.
  - `initialState`: after replay and toasts, `selected = visibleTasks(s)[0] ?? 0`.
  - `task:removed`: record `vis = visibleTasks(s)` and the selected id before removing; remove; if the selected id survives, `selected` = its new index; else the neighbour after it in `vis`, then before it, mapped by id to the new index; else `0`; then `snap`.
  - Run `npm test`; update every test in `test/tui/` that fails only because the display order is now newest-first (e.g. `state_selection_clamps_after_remove`, `state_task_events`, keys/app tests assuming task 1 is selected first or `j` goes 1 → 2) to the new order. Give such fixtures explicit `createdAt` values or adjust the expected ids; do not delete or skip them.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/order.ts src/tui/state.ts test/tui/order.test.ts test/tui/state.test.ts <updated test files> && git commit -m "feat(tui): list tasks newest first"`

---

### Task 4: Tab between list and add box, `→` to details

**Files:**
- Modify: `src/tui/keys.ts`, `src/tui/state.ts` (drop `toggleFocus`)
- Test: `test/tui/keys.test.ts`, `test/tui/state.test.ts`

**Interfaces:**
- Consumes: `UiAction` `{ type: "focus"; target: "list" | "detail" | "compose" }` (unchanged).
- Produces: `UiAction` without `{ type: "toggleFocus" }`.

**Checks:** `node --test test/tui/keys.test.ts test/tui/state.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** in `test/tui/keys.test.ts`:
  - `keys_list_tab_opens_add_box`: `press(mk("idle"), "tab")` and `press(mk(), "tab")` (empty list) and `press(mk("idle"), "shift+tab")` each equal `[ui({ type: "focus", target: "compose" })]`.
  - `keys_list_right_opens_details`: list with a task that has a run (`mk("passed")`) → `press(s, "right")` equals `[ui({ type: "focus", target: "detail" })]`; `mk("idle")` → `[]`.
  - `keys_compose_tab_to_list_keeps_draft`: compose with completion closed and text "hello" → `press(s, "tab")` equals `[ui({ type: "focus", target: "list" })]`; `play` gives `mode === "list"`, `focus === "list"`, `compose.text === "hello"`. `ctrl+tab`/`alt+tab` in compose → no focus command.
  - `keys_detail_tab_to_list`: detail mode, both with and without a run → `[ui({ type: "focus", target: "list" })]`.
  - Footer: rewrite `hints_per_mode_and_state` list strings to exactly `footer(mk("running"))` = `"⏎ open · tab add · → details · p pause · s stop · ? help"`, `mk("paused")` = `"⏎ open · tab add · → details · r resume · n step · s stop · ? help"`, `mk("idle")` = `"⏎ run · tab add · o options · d remove · ? help"`, `mk("stopping")` = `"⏎ open · tab add · → details · ? help"`, `initialState(0)` = `"tab add · ? help"` (no `a add` anywhere in list footers); detail footer contains `tab tasks`; `footer(composing("hello", false))` equals `"⏎ add · @ file · alt+⏎ newline · ↑↓ history · tab tasks · esc back"`; compose-open footer unchanged (existing `↑↓ move · tab complete · ⏎ accept · esc close` test).
  - `help_lists_mode_bindings`: replace `"tab focus"` with `"tab add"` and add `"→ details"` in the list wants (keep `"a add"`); detail help contains `tab tasks`.
  - Rewrite `keys_list_bindings` (the `toggleFocus` assertion at line ~49 becomes the list Tab → focus compose), the empty-list loop in `keys_noop_without_live_run` (drop `"tab"` from the no-op list; Tab now opens the add box), the old footer strings with `a add`/`tab focus` (lines ~225–242), and `state_escape_restores_previous_focus` in `test/tui/state.test.ts` (use `{ type: "focus", target: "detail" }` instead of `toggleFocus`).
- [ ] **Step 2: Run it**: `Run: node --test test/tui/keys.test.ts test/tui/state.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement** in `src/tui/keys.ts`:
  - `SHARED`: delete the Tab binding; set the `a` binding's `footer` to `false`.
  - `LIST_ONLY`: after the `return` binding add `{ match: named("tab"), when: () => true, run: () => [ui({ type: "focus", target: "compose" })], hint: { key: "tab", label: "add" }, footer: true }` and `{ match: named("right"), when: (c) => hasTask(c) && c.t?.runId != null, run: () => [ui({ type: "focus", target: "detail" })], hint: { key: "→", label: "details" }, footer: true }`.
  - `DETAIL_ONLY`: add `{ match: named("tab"), when: () => true, run: () => [ui({ type: "focus", target: "list" })], hint: { key: "tab", label: "tasks" }, footer: true }`.
  - `composeCommands`: after the `if (open && !k.ctrl && !k.meta) { … }` block, before the `return` handling: `if (k.name === "tab" && !open && !k.ctrl && !k.meta) return [ui({ type: "focus", target: "list" })];`.
  - `hints` compose (closed): insert `{ key: "tab", label: "tasks" }` before `{ key: "esc", label: "back" }`.
  - `src/tui/state.ts`: remove `{ type: "toggleFocus" }` from `UiAction` and its `apply` case.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS` (fix any app test that relied on `a add` in the footer, e.g. the `/a add/` assertion near `app_completion_*`, to the new footer such as `/tab add/`)
- [ ] **Step 5: Commit**: `git add src/tui/keys.ts src/tui/state.ts test/tui/keys.test.ts test/tui/state.test.ts <updated app test> && git commit -m "feat(tui): tab moves between task list and add box"`

---

### Task 5: Keep the selection on add-box submission

**Files:**
- Modify: `src/tui/app.ts`
- Test: `test/tui/app.test.ts`

**Interfaces:**
- Consumes: newest-first `visibleTasks` (Task 3); `FakeManager`, `snapshot()` (createdAt 0 default, so ties sort by higher id first).

**Checks:** `node --test test/tui/app.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** in `test/tui/app.test.ts`:
  - Update `app_mixed_submission`: `FakeManager([snapshot(1, "older")])`; type `a`, `@a.md check the price`, `\r` → `m.log` equals `["add:a.md|check the price"]`; box empty again; in the frame the index of `check the price` in the sidebar is before the `older` row (compare `f.indexOf('"check the price"')` < `f.indexOf('"older"')`); `assert.doesNotMatch(f, /││ check the price/)` (the detail pane is not on the new task) and `assert.match(f, /││ older/)` (it still shows "older").
  - New `app_add_keeps_selection`: `FakeManager([snapshot(1, "First"), snapshot(2, "Second")])`; type `j` (selects First), `a`, `x`, `\r`, `\x1b`, `\r` → `m.log` ends with `"start:1"`; in the frame the `"x"` row comes before the `"Second"` row.
  - New `app_add_on_empty_list_selects_new`: `FakeManager([])`; type `a`, `fresh task`, `\r`, `\x1b` → the detail pane shows the new task (e.g. matches `/││ fresh task/` and `/source: typed/`).
- [ ] **Step 2: Run it**: `Run: node --test test/tui/app.test.ts` / `Expected: FAIL (detail still jumps to the new task)`
- [ ] **Step 3: Implement** in `src/tui/app.ts` `case "addSubmission"`: delete `const added = r.added[0];` and the `selectTask` dispatch after it; nothing else in the case changes.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS` (other submitting app tests stay as they are unless they fail on selection, in which case update them to the new behaviour)
- [ ] **Step 5: Commit**: `git add src/tui/app.ts test/tui/app.test.ts && git commit -m "feat(tui): keep selection when adding tasks"`

## Manual e2e

- [ ] Run `duckwright --tui` with a few past runs; add two tasks and check they appear on top in newest-first order while the selection stays put.
- [ ] Press Tab to move between the list and the add box (draft kept); with `@` completion open, Tab still completes.
- [ ] Press `→` on a finished run to open its detail pane, then Tab to come back to the list.
