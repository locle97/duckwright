# TUI Global Options Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable "global options" pane to the TUI's left column, below the task list and above the add box. Its values apply to every task's next run.

**Architecture:** `RunManager` keeps a session-wide `Overrides` object (the "globals") and layers it between the command-line flags and each task's own overrides. The view state mirrors it through a new `globals:updated` manager event. The pane edits the globals with the existing `FormState`/`formKey` model (a form whose `taskId` is `null`), rendered inline in the new `OptionsPane` instead of the centred dialog.

**Tech Stack:** TypeScript (Node ≥ 22.18, run with `node --test`), Ink 8 + React 19, `ink-testing-library`.

**Spec:** No separate spec. Sources are the user's request ("add a global options pane under the task pane and above the input box, splitting the current task pane vertically") and their answers: tasks 70 / options 30, and editable defaults. The layering rule and the existing settings form are in `docs/superpowers/specs/2026-10-04-tui-design.md` (*Settings form*, *Settings layering*).

## Global Constraints

- The left column splits vertically: the task list (`Sidebar`) on top with 70% of the pane height, and the `OptionsPane` below it with 30%: `optionsHeight = Math.round(paneHeight * 0.3)`. The detail pane on the right keeps the full pane height.
- The fields are the same five as the per-task form, in the same order and with the same labels and validation: model, max steps, headed, export, snapshot mode (`FieldKey`, `LABELS` and `validate` in `src/tui/form.ts`).
- Settings layering, lowest first: built-in defaults < task-file front matter < command-line flags < **global options** < the task's own overrides.
- A global option counts only when it is set. An unset field shows the value from built-in defaults plus command-line flags, which is the value `ctrl+r` restores.
- Changing the globals never changes a run that is already live. It changes each task's `effective` settings and so its next start.
- The pane title is `OPTIONS`. A set value is drawn in `role.accent`, like an overridden per-task value.
- Key `O` (shift+o) edits the globals in every list or detail state, live tasks included. Within the form: `⏎` saves, `esc` cancels, `ctrl+r` resets the field, and `↑↓`/`tab` move between fields, as in the existing form.
- The pane is only drawn when there is room. At least 60 columns, and `paneHeight >= 10` (so the pane is at least 3 rows high and the list keeps at least 7). Otherwise `O` opens the same form as a centred dialog titled `Global options`.
- No new runtime dependencies. All text from task files or typed input goes through `sanitize` before it is drawn.

## Review Focus

1. **Short terminal (24 rows, the default test size).** With `paneHeight = 17` the pane is 5 rows, so it shows 2 of the 5 fields. Moving focus to snapshot mode must scroll the pane so the focused field stays visible. Test `app_global_options_pane_scrolls_to_focus` is in Task 3.
2. **Terminal too short or narrow for the pane.** `O` must still work, as a dialog, and must never edit an invisible form. Test `app_global_options_dialog_when_no_room` is in Task 3.
3. **A global and a per-task override for the same field.** The task wins. A global and a file's front matter for the same field: the global wins. Test `manager_globals_layering` is in Task 1.
4. **Invalid input (max steps `abc`).** It is not saved, the form stays open and the error shows inline in the pane. Test `app_global_options_edit_and_save` is in Task 3. The key-level test `keys_global_form_saves_globals` is in Task 2.
5. **Clearing a global with `ctrl+r`.** It must drop the field from the saved globals, so the effective value goes back to the flags/default value. Test `manager_globals_layering` (setting `{}`) is in Task 1. Test `keys_global_form_saves_globals` (reset then save) is in Task 2.

---

### Task 1: Global options in the run manager

**Files:**
- Modify: `src/runs/manager.ts` (types near line 18–54; `setOverrides` ~192; `#argsFor` ~346)
- Modify: `test/tui/fake-manager.ts`
- Test: `test/runs/manager.test.ts`

**Interfaces:**
- Produces (exported from `src/runs/manager.ts`):
  - `export interface GlobalOptions { base: Effective; overrides: Overrides }`. `base` is built-in defaults plus command-line flags. `overrides` holds the set globals.
  - `ManagerEvent` gains `| { type: "globals:updated"; globals: GlobalOptions }`.
  - `ManagerLike` gains `globals(): GlobalOptions` and `setGlobals(o: Overrides): void`.
  - `FakeManager` gains `globalsValue: GlobalOptions` (default `{ base: <the snapshot() effective>, overrides: {} }`), `globalsSaved: Overrides[]`, `globals()` and `setGlobals(o)`. `setGlobals` logs `"setGlobals"`, pushes `o` onto `globalsSaved`, sets `globalsValue.overrides = { ...o }` and emits `globals:updated`.

- [ ] **Step 1: Write the failing tests** in `test/runs/manager.test.ts`, using the existing `setup`, `tree` and `tick` helpers.

```ts
test("manager_globals_layering", () => {
  const dir = tree({ "f.md": "---\nmodel: opus\n---\nThe body" });
  const { mgr, events } = setup({ cwd: dir, argv: ["--max-steps", "9"] });
  mgr.add({ mentions: [`${dir}/f.md`], typed: null });
  const typed = mgr.addTyped("t");
  assert.deepEqual(mgr.globals(), {
    base: { model: "sonnet", maxSteps: 9, headed: false, export: false, snapshot: "hybrid" }, overrides: {},
  });
  events.length = 0;
  mgr.setGlobals({ model: "haiku", maxSteps: 3 });
  const [file, t] = mgr.list();
  assert.equal(file.effective.model, "haiku", "a global beats front matter");
  assert.equal(t.effective.maxSteps, 3, "a global beats a flag");
  mgr.setOverrides(typed, { maxSteps: 4 });
  assert.equal(mgr.effectiveArgs(typed).maxSteps, 4, "a task override beats a global");
  assert.deepEqual(events.slice(0, 3).map((e) => e.type), ["globals:updated", "task:updated", "task:updated"]);
  mgr.setGlobals({});
  assert.equal(mgr.list()[0].effective.model, "opus", "clearing a global restores the file value");
  assert.equal(mgr.list()[1].effective.maxSteps, 4);
});

test("manager_globals_do_not_change_a_live_run", async () => {
  const { mgr, fakes } = setup();
  const id = mgr.addTyped("t");
  assert.equal(mgr.start(id).ok, true);
  mgr.setGlobals({ model: "opus" });
  assert.equal(fakes[0].spec.args.model, "sonnet");
  fakes[0].finish(outcome("pass"));
  await tick();
  assert.equal(mgr.start(id).ok, true);
  assert.equal(fakes[1].spec.args.model, "opus");
});
```

(The outcome helper at the top of the file is the function that builds a `RunOutcome` from a status. Use its real name.)

- [ ] **Step 2: Run the tests and check that they fail**

Run: `node --test --test-name-pattern=manager_globals test/runs/manager.test.ts`
Expected: FAIL, because `mgr.globals` is not a function.

- [ ] **Step 3: Implement it in `src/runs/manager.ts`**

- Add the field `#globals: Overrides = {}`.
- Change `#argsFor` to apply `this.#globals` and then `task.overrides`, in that order. Pull the existing five `if (o.x !== undefined)` lines into one private `#apply(args: RunArgs, o: Overrides): void`.
- `globals()` returns `{ base, overrides: { ...this.#globals } }`. `base` comes from `parseRunArgs(this.#o.argv, this.#o.defaultSkill)` (no file settings), mapped to `Effective`.
- `setGlobals(o)` stores `{ ...o }`, emits `globals:updated` and then calls `#updated(task)` for every task in `#tasks`.

In `test/tui/fake-manager.ts`, add the `FakeManager` members listed under Interfaces.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npm test`
Expected: PASS. Typecheck is clean, and the existing manager and TUI tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/runs/manager.ts test/runs/manager.test.ts test/tui/fake-manager.ts
git commit -m "feat(runs): session-wide global options between flags and task overrides"
```

---

### Task 2: Globals in the view state and keymap

**Files:**
- Modify: `src/tui/form.ts` (`FormState`, `openForm`)
- Modify: `src/tui/state.ts` (`ViewState`, `initialState`, `reduceManager`)
- Modify: `src/tui/keys.ts` (`Command`, `SHARED`, `formCommands`)
- Test: `test/tui/keys.test.ts`, `test/tui/state.test.ts`

**Interfaces:**
- Consumes: `GlobalOptions`, the `globals:updated` event and `Overrides` from Task 1.
- Produces:
  - `FormState.taskId: TaskId | null`, where `null` means the form edits the global options. `openForm(taskId: TaskId | null, effective: Effective, overrides: Overrides): FormState`, with an unchanged body.
  - `ViewState.globals: GlobalOptions | null`. It is `null` until the app supplies it.
  - `initialState(now, tasks = [], notices = [], globals: GlobalOptions | null = null)`.
  - `export function editingGlobals(s: ViewState): boolean`, in `state.ts`. It is true when `s.mode === "form" && s.form?.taskId === null`.
  - `Command` gains `| { kind: "saveGlobals"; overrides: Overrides }`.

- [ ] **Step 1: Write the failing tests**

In `test/tui/state.test.ts`:

```ts
test("state_globals_follow_manager", () => {
  const g = { base: task(1).effective, overrides: {} };
  let s = initialState(0, [], [], g);
  assert.deepEqual(s.globals, g);
  s = reduce(s, mgr({ type: "globals:updated", globals: { ...g, overrides: { model: "opus" } } }));
  assert.deepEqual(s.globals?.overrides, { model: "opus" });
});
```

(Use the file's existing `task(...)` and `mgr(...)` helpers with their real arities.)

In `test/tui/keys.test.ts`:

```ts
const G = { base: task(1).effective, overrides: { maxSteps: 3 } };

test("keys_O_opens_global_form_even_when_live", () => {
  const s = initialState(0, [task(1, "running")], [], G);
  const [c] = press(s, "O");
  assert.equal(c.kind, "ui");
  const after = play(s, [c]);
  assert.equal(after.mode, "form");
  assert.equal(after.form?.taskId, null);
  assert.equal(after.form?.fields[1].raw, "3", "a set global shows its value");
  assert.equal(after.form?.fields[0].raw, "m", "an unset field shows the base value");
  assert.deepEqual(press(initialState(0, [task(1)]), "O"), [], "no globals known: O does nothing");
});

test("keys_global_form_saves_globals", () => {
  const open = play(initialState(0, [task(1)], [], G), press(initialState(0, [task(1)], [], G), "O"));
  // Reset max steps (field 1), then save: the global is dropped.
  const reset = reduce(open, { type: "form", next: formKey(formKey(open.form!, key("down")), key("ctrl+r")) });
  assert.deepEqual(press(reset, "return"), [{ kind: "saveGlobals", overrides: {} }, ui({ type: "form", next: null })]);
  const bad = reduce(open, { type: "form", next: formKey(formKey(open.form!, key("down")), key("x")) });
  assert.deepEqual(press(bad, "return"), [], "an invalid global form does not save");
});
```

Extend `help_lists_mode_bindings` so that both the list and the detail help include `{ key: "O", label: "global options" }`.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `node --test test/tui/keys.test.ts test/tui/state.test.ts`
Expected: FAIL. Typecheck errors on the 4th `initialState` argument and the `globals:updated` event.

- [ ] **Step 3: Implement it**

- `form.ts`: widen `taskId`.
- `state.ts`: add the `globals` field and parameter. In `reduceManager`, `globals:updated` sets `s.globals`. Add `editingGlobals`.
- `keys.ts`: add a `SHARED` binding before `o`.
  - `match: char("O")`, `when: (c) => c.s.globals !== null`.
  - `run`: opens `openForm(null, c.s.globals.base, c.s.globals.overrides)`.
  - `hint: { key: "O", label: "global options" }`, `footer: false`.
  - In `formCommands`, when `f.taskId === null`, save with `{ kind: "saveGlobals", overrides: r.overrides }` instead of `saveOverrides`.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npm test`
Expected: PASS. Typecheck fails in `app.ts`'s `run` switch until `saveGlobals` is handled there. Add the one-line case now (`manager.setGlobals(c.overrides); return;`) so this task's commit typechecks.

- [ ] **Step 5: Commit**

```bash
git add src/tui/form.ts src/tui/state.ts src/tui/keys.ts src/tui/app.ts test/tui/keys.test.ts test/tui/state.test.ts
git commit -m "feat(tui): global options in view state, O key edits them"
```

---

### Task 3: Options pane and the split left column

**Files:**
- Create: `src/tui/optionsPane.ts`
- Modify: `src/tui/app.ts` (initial state ~85; layout ~200–230)
- Modify: `src/tui/formView.ts` (title)
- Modify: `README.md` (*Interactive TUI* section, ~line 144)
- Test: `test/tui/app.test.ts`

**Interfaces:**
- Consumes: `ViewState.globals`, `editingGlobals(s)`, `FormState` (`taskId: null`), `scrollStart(selected, count, size)` from `sidebar.ts`, `paneBorder(theme, focused)` from `theme.ts`, and `FakeManager.globalsValue`/`globalsSaved` from Task 1.
- Produces:
  - `export function OptionsPane({ s, width, height }: { s: ViewState; width: number; height: number }): ReactElement`.
  - `export function optionsHeight(paneHeight: number, columns: number): number`, in `optionsPane.ts`. It returns `0` (no pane) when `columns < 60 || paneHeight < 10`, else `Math.round(paneHeight * 0.3)`.
  - `FormView` gains the prop `title: string`. The task form passes `"Settings"` and the globals dialog passes `"Global options"`.

- [ ] **Step 1: Write the failing tests** in `test/tui/app.test.ts`. Use the existing `mount`, `settle` and `FakeManager` helpers, and `role.accent` checks through `raw()` the way existing colour tests do.

```ts
test("app_global_options_pane_layout", async () => {
  const m = new FakeManager([snapshot(1, "First")]);
  m.globalsValue = { base: snapshot(1, "x").effective, overrides: { model: "opus" } };
  const t = mount(m, { columns: 100, rows: 40 });
  await settle();
  const lines = t.frame().split("\n");
  const tasksRow = lines.findIndex((l) => /TASKS/.test(l));
  const optionsRow = lines.findIndex((l) => /OPTIONS/.test(l));
  const inputRow = lines.findIndex((l) => /Describe a task/.test(l));
  assert.ok(tasksRow < optionsRow && optionsRow < inputRow, "tasks, then options, then the add box");
  assert.match(lines[optionsRow + 1] ?? "", /model +opus/);
  assert.match(t.frame(), /snapshot mode +hybrid/, "all five fields fit at 40 rows");
  assert.match(t.frame(), /source: typed/, "the detail pane is still beside the column");
});

test("app_global_options_edit_and_save", async () => {
  const m = new FakeManager([snapshot(1, "First")]);
  const t = mount(m, { columns: 100, rows: 40 });
  await settle();
  await t.type("O", "\x1b[B", "x");
  assert.match(t.frame(), /max-steps must be a whole number/, "inline error in the pane");
  assert.doesNotMatch(t.frame(), /Settings|Global options/, "no dialog: edited in place");
  await t.type("\r");
  assert.deepEqual(m.globalsSaved, [], "invalid: not saved");
  await t.type("\x7f", "\x7f", "\x7f", "8", "\r");
  assert.deepEqual(m.globalsSaved, [{ maxSteps: 8 }]);
  assert.match(t.frame(), /max steps +8/);
});

test("app_global_options_pane_scrolls_to_focus", async () => {
  const t = mount(new FakeManager([snapshot(1, "First")]));   // 100x24: a 5-row pane
  await settle();
  await t.type("O", "\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B");
  assert.match(t.frame(), /snapshot mode/, "the focused last field is visible");
});

test("app_global_options_dialog_when_no_room", async () => {
  for (const size of [{ columns: 59, rows: 24 }, { columns: 100, rows: 12 }]) {
    const t = mount(new FakeManager([snapshot(1, "First")]), size);
    await settle();
    assert.doesNotMatch(t.frame(), /OPTIONS/);
    await t.type("O");
    assert.match(t.frame(), /Global options/, `${size.columns}x${size.rows}: dialog fallback`);
    cleanup();
  }
});
```

Also update `app_settings_form` to keep asserting `/Settings/` for the per-task form. If the new pane shortens the list, re-check `app_narrow_layouts` and `app_filter_narrows_sidebar`. Fix a broken assertion only when the content it looks for really moved, and then assert on the new position.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `node --test --test-name-pattern=global_options test/tui/app.test.ts`
Expected: FAIL, because there is no `OPTIONS` in the frame.

- [ ] **Step 3: Implement it**

- `optionsPane.ts`:
  - A bordered pane with `paneBorder(theme, editingGlobals(s))` and `paddingX: 1`, like `Sidebar`. The title is `OPTIONS`, muted and bold.
  - While editing the globals, render rows from `s.form` like `FormView`: the `› ` focus marker, inverse on the focused value, and an error row under an invalid field. Otherwise render rows from `openForm(null, g.base, g.overrides).fields`, with set values in `role.accent`.
  - Window the rows with `scrollStart(focusedRowIndex, rows.length, height - 3)`, where `focusedRowIndex` counts error rows. Every value goes through `sanitize` and uses `wrap: "truncate-end"`.
  - Render nothing (an empty `Box` of the given size) when `s.globals === null`.
- `app.ts`:
  - Pass `manager.globals()` as the 4th `initialState` argument.
  - In the ≥ 60-column branch, wrap the sidebar in a column `Box` of width `sideWidth`. The `Sidebar` gets `height: paneHeight - oh`, and below it goes `OptionsPane` with `height: oh`, where `oh = optionsHeight(paneHeight, columns)`. Leave out the pane when `oh === 0`.
  - The overlay shows `FormView` for a task form (`title: "Settings"`). It also shows `FormView` for a globals form when `oh === 0` (`title: "Global options"`).
  - `listFocused` is also false while `editingGlobals(s)`.
- `formView.ts`: replace the literal `"Settings"` with the `title` prop.
- README: in *Interactive TUI*, add one sentence. The left column's lower pane shows the global options (model, max steps, headed, export, snapshot mode). `O` edits them. They apply to every task's next run, above command-line flags and below a task's own `o` options.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npm test`
Expected: PASS, with the whole suite green and no typecheck errors.

- [ ] **Step 5: Look at the real app**

Run `node src/bin.ts --tui` in a 100×30 terminal. Confirm by eye that the left column shows TASKS above OPTIONS at about 70/30, `O` focuses the options border, and `esc` returns to the list.

- [ ] **Step 6: Commit**

```bash
git add src/tui/optionsPane.ts src/tui/app.ts src/tui/formView.ts README.md test/tui/app.test.ts
git commit -m "feat(tui): global options pane under the task list"
```
