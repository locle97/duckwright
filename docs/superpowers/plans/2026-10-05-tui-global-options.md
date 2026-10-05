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
