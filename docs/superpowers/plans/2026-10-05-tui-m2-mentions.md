# TUI Workspace M2 (`@` Mentions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the TUI's add box, `@`-mention task files and folders (Claude Code style, with inline fuzzy completion). Each mention becomes a file task with its front matter applied, as `-f` does, and any leftover text is still one typed task.

**Architecture:** The add box keeps holding only text and a cursor. `compose.ts` parses mentions from that text on demand. `candidates.ts` walks the folder through an injected `readdir` and ranks entries, both as pure code. `RunManager.add()` expands and loads every mention with the existing `taskPaths`/`loadTaskFile`, all-or-nothing. The keymap opens, drives and closes the completion list. The App does the I/O (the walk, `manager.add`) and renders the list over the panes.

**Tech Stack:** TypeScript run by Node ≥ 22.18 type stripping, `node:test`, Ink 8 + React 19.3 (`createElement as h`, no JSX), `ink-testing-library` 4.

**Spec:** `docs/superpowers/specs/2026-10-04-tui-design.md`. This plan covers the *M2: `@` mentions* section, plus the M2 parts of *RunManager*, *Settings layering*, *Sessions*, *Error handling* and *Testing*. M1 is already built (`docs/superpowers/plans/2026-10-05-tui-m1.md`).

## Global Constraints

- No new dependencies. Only `src/tui/` imports `ink`/`react`; `src/runs/manager.ts` stays UI-free.
- Plain mode (`duckwright "task"`, `-f`) is untouched. `--tui` with a task or `-f` is still `give tasks inside the TUI, not with --tui` (exit 2).
- Copy, exactly: the placeholder `Describe a task, or @ a task file or folder…`; the not-found error `@<path>: not found (type \@ for a literal @)`; the duplicate toast `already added: <path>`; the empty list row `no matches`.
- Numbers: the walk stops after `5000` entries; the list shows at most `8` rows, or half the pane height if that is less (at least 1).
- Skipped by the walk: names starting with `.` (covers `.git`), `node_modules`, `runs`. Task files are `TASK_SUFFIXES` (`.md`, `.txt`), any case.
- Every file path or name drawn on screen (completion rows, mentions in the box, sidebar names, add errors) goes through `sanitize()`.
- The add box holds only text and a cursor. Mentions are always recomputed from the text, never stored.
- Tests: `npm test`. New test files live in `test/tui/` and `test/runs/` and use `tmpDir()` from `test/helpers.ts` for real files.

## Review Focus

1. **Hostile file names.** A file named `evil\x1b[2J.md` must show as inert text in the completion list, the sidebar and add errors. Pinned in Task 5 (`app_completion_sanitizes_names`).
2. **Symlink loops and unreadable folders while walking.** A folder that links back to its parent, or one that cannot be read, must not hang the walk or throw. Pinned in Task 3 (`candidates_node_readdir_survives_loops_and_errors`).
3. **The same file reached twice in one submission** (`@tasks @tasks/a.md`), or a file that is already in the list, must give one task and a duplicate report. Nothing may be added twice. Pinned in Task 1 (`manager_add_skips_duplicates`).
4. **A paste holding a whole mention plus text** (`@a.md check it` in one chunk) must not leave the list open on stale text, and `⏎` must then submit. Pinned in Task 4 (`keys_paste_with_mention_does_not_open_list`).
5. **Mentions outside the current folder** (`@../x.md`, `@/abs/x.md`) must load and show a sensible name (`../x.md`). They are drawn as existing, not in red. Pinned in Task 1 (`manager_add_paths_outside_cwd`) and Task 2 (`compose_spans_mark_missing`).

---

## File Structure

| File | Change |
| --- | --- |
| `src/text.ts` | add `mentionToken(path)`, shared by manager error messages and completion |
| `src/runs/manager.ts` | file tasks: `TaskSource`, `add(Submission)`, front-matter layering, file `session:` ignored, `cwd` option |
| `src/tui/compose.ts` | mention parsing, mention under the cursor, submission split, whole-mention backspace, applying a completion, display spans |
| `src/tui/candidates.ts` (new) | folder walk, fuzzy ranking, Node `readdir` adapter |
| `src/tui/state.ts`, `src/tui/keys.ts` | completion state, add errors, select-by-id; compose keymap with the list; new commands; hints |
| `src/tui/completion.ts` (new), `addBox.ts`, `detail.ts`, `app.ts` | completion overlay, coloured mentions + errors in the box, file source line, command handling, injected file access |
| `test/tui/fake-manager.ts` | `add()` |
| `README.md` | `@` syntax in the Interactive TUI section |

---

### Task 1: File tasks in the RunManager

**Files:**
- Modify: `src/text.ts`, `src/runs/manager.ts`, `src/tui/detail.ts`, `test/tui/fake-manager.ts`
- Test: `test/text.test.ts`, `test/runs/manager.test.ts`, `test/tui/app.test.ts`

**Interfaces:**
- Consumes: `taskPaths(paths): (string | TaskFileError)[]`, `loadTaskFile(p): TaskFile`, `TaskSettings` (src/taskfile.ts); `resolvePath` (src/paths.ts); `parseRunArgs(argv, skill, settings)`.
- Produces:
  - `src/text.ts`: `mentionToken(path: string): string`. Returns `@path`, or `@"path"` when `path` contains whitespace.
  - `src/runs/manager.ts`:
    ```ts
    export type TaskSource = { kind: "typed" } | { kind: "file"; path: string };
    export interface Submission { mentions: string[]; typed: string | null }
    export type AddResult =
      | { ok: true; added: TaskId[]; duplicates: string[] }
      | { ok: false; errors: { mention: number; message: string }[] };
    // TaskSnapshot gains: source: TaskSource
    // ManagerLike gains:  add(sub: Submission): AddResult
    // ManagerOptions gains: cwd?: string   (default process.cwd(); used only for names)
    ```
  - `FakeManager.add(sub)` logs `add:<mentions joined by ",">|<typed or "">`, adds a typed snapshot for `typed`, and returns `this.addResult` when one is set (`addResult: AddResult | null = null`). `snapshot()` defaults `source` to `{ kind: "typed" }`.

Decisions:
- Each mention is expanded on its own with `taskPaths([mention])`, and every resulting file is loaded with `loadTaskFile`. Every error is collected, each tied to its mention index (0-based). If any error occurs, nothing is added.
- Error messages. When an error names the mention's own path (a folder error, or a load error of a directly mentioned file), replace that leading path with `mentionToken(path)`. A directly mentioned file's `: file not found` becomes `: not found (type \@ for a literal @)`. An error for a file inside a mentioned folder is kept as `loadTaskFile` gives it (`file:line: problem`).
- Duplicates are keyed by `resolvePath(file)`. They cover files already in the list and files reached twice in one submission. They are reported by name. A submission with only duplicates is `ok: true`, `added: []`.
- Files are added in mention order. The typed task (if any) is added last.
- A file task's `name` is `path.relative(cwd, resolvePath(p))`, unquoted and not cut (the sidebar truncates). The task text is `tf.task`. `start()` passes `taskFile: p`. The summary row shows the same name.
- Layering: `#argsFor` calls `parseRunArgs(argv, defaultSkill, fileSettings)` and applies overrides on top. `fileSettings` is the file's settings with `session` removed (the slot wins); `skill`, `state` and the rest are kept. Typed tasks have `{}`.
- `addTyped(text)` stays, as `add({ mentions: [], typed: text })` minus the result.

- [ ] **Step 1: Write the failing tests**

`test/text.test.ts`:
```ts
test("text_mention_token", () => {
  assert.equal(mentionToken("tasks/a.md"), "@tasks/a.md");
  assert.equal(mentionToken("my tasks/a.md"), '@"my tasks/a.md"');
});
```

`test/runs/manager.test.ts` (a `dir = tmpDir()` with files written per test; `setup({ cwd: dir })`; mentions given as absolute paths under `dir` unless the test says otherwise):
- `manager_add_typed_only`: `add({ mentions: [], typed: "x" })` → `{ ok: true, added: [1], duplicates: [] }`; snapshot `source` `{ kind: "typed" }`, name `"x"` (quoted).
- `manager_add_file_and_folder_in_order`: `a.md`, plus `smoke/b.md` and `smoke/c.txt`. `add({ mentions: [a, smoke], typed: "check it" })` adds names `["a.md", "smoke/b.md", "smoke/c.txt", '"check it"']`, in that order. `source` is `{ kind: "file", path: a }` for the first. The task text is the file body without front matter.
- `manager_add_all_or_nothing`: `good.md`, a missing `nope.md`, and `bad/x.md` whose front matter is `foo: 1` on line 2. `add({ mentions: [good, nope, bad], typed: "t" })` returns `ok: false` with
  ```ts
  [{ mention: 1, message: `@${nope}: not found (type \\@ for a literal @)` },
   { mention: 2, message: `${bad}/x.md:2: unknown setting "foo"` }]
  ```
  and `list()` is still empty.
- `manager_add_folder_errors_name_the_mention`: an empty folder `empty/` gives `@${empty}: no task files (.md or .txt)`. A path with a space (`my dir/` with no task files) is quoted: `@"${myDir}": no task files (.md or .txt)`.
- `manager_add_skips_duplicates`: `t/a.md`, `t/b.md`. `add({ mentions: [t, `${t}/a.md`], typed: null })` gives `added.length === 2`, `duplicates: ["t/a.md"]`. Then `add({ mentions: [`${t}/b.md`], typed: null })` gives `{ ok: true, added: [], duplicates: ["t/b.md"] }`.
- `manager_add_paths_outside_cwd`: with `cwd: ${dir}/sub`, a mention of `${dir}/x.md` is named `../x.md`.
- `manager_file_settings_layering`: `f.md` has `model: opus`, `max-steps: 7`, `session: mine`. With `argv: []`, the effective model is `opus` and maxSteps `7`. With `argv: ["--model", "haiku"]`, the model is `haiku`. With override `{ model: "sonnet" }`, it is `sonnet`. `start()` passes a spec with `args.session === "duckwright-1"`, `taskFile === f` and `task` equal to the body.
- `manager_file_skill_reaches_preflight`: a file `skill: s.md` (an existing file next to it). The preflight fake records `args.skill`, which equals `resolvePath(${dir}/s.md)`.
- `manager_summary_names_file_tasks`: the summary row for a finished file task starts `pass  a.md  `.

`test/tui/app.test.ts`:
- `app_detail_shows_file_source`: a `FakeManager` with `snapshot(1, "body", { source: { kind: "file", path: "tasks/a.md" }, name: "tasks/a.md" })`. The frame contains `source: tasks/a.md`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/text.test.ts test/runs/manager.test.ts test/tui/app.test.ts`
Expected: FAIL (`mentionToken` not exported, `add` is not a function, no `source: tasks/a.md`).

- [ ] **Step 3: Implement**

- `mentionToken` in `src/text.ts`.
- In `manager.ts`, the internal `Task` gains `source` and `fileSettings`. Add `add()`, the `cwd` option, and the name/argsFor/start/summary changes per the decisions above. Use one private `#addTask(source, text, fileSettings, name)` for both `add` and `addTyped`.
- In `detail.ts` `IdleTask`, the source line shows `sanitize(t.source.path)` for file tasks, `typed` otherwise.
- `FakeManager.add` and the `source` default in `snapshot()`.

- [ ] **Step 4: Run them to see them pass**

Run: `npm test`
Expected: PASS (M1 tests included: typed tasks behave as before).

- [ ] **Step 5: Commit**

```bash
git add src/text.ts src/runs/manager.ts src/tui/detail.ts test/
git commit -m "feat(tui): file tasks and all-or-nothing add() in the run manager"
```

---

### Task 2: Mentions in the compose model

**Files:**
- Modify: `src/tui/compose.ts`
- Test: `test/tui/compose.test.ts`

**Interfaces:**
- Consumes: `ComposeState`, `insertText`; `mentionToken` (src/text.ts).
- Produces (all in `src/tui/compose.ts`):
  ```ts
  /** [start, end) covers the `@` through the last path character or the closing quote. */
  export interface Mention { start: number; end: number; path: string; quoted: boolean }
  export function parseMentions(text: string): Mention[]
  /** The mention with start < cursor <= end, or null. */
  export function mentionAt(text: string, cursor: number): Mention | null
  /** Mentions with a non-empty path, and the leftover typed task (null if empty). */
  export function submission(text: string): { mentions: Mention[]; typed: string | null }
  /** Backspace right after a non-empty mention: delete all of it. Null when not after one. */
  export function deleteMentionBefore(s: ComposeState): ComposeState | null
  export function applyCompletion(s: ComposeState, path: string, how: "descend" | "accept"): ComposeState
  export type SpanKind = "text" | "mention" | "missing";
  export interface Span { start: number; text: string; kind: SpanKind }
  export function spans(text: string, exists: (path: string) => boolean): Span[]
  ```

Rules (from the spec, plus the choices the spec leaves open):
- An `@` starts a mention at index 0 or after any whitespace (newline included), unless it is preceded by `\`. `@` inside a word is text.
- Unquoted: the path runs to the next whitespace. `@"…`: the path runs to the closing `"`, which ends the mention. If there is no closing quote, the path runs to the end of the line.
- A bare `@` (empty path) is a mention for `mentionAt` (completion queries `""`), but `submission` treats it as text, and `spans` gives it `"text"`.
- `submission`: remove each non-empty mention. Where one was removed, collapse the horizontal whitespace touching it into one space. Then turn every `\@` into `@`, and trim. An empty result means `typed: null`.
- `applyCompletion` replaces the mention under the cursor (`mentionAt`; no mention means `s` is returned unchanged) with `mentionToken(path)`:
  - `"accept"`: the cursor goes after the token. A space is inserted after the token unless one already follows, and the cursor goes past that space.
  - `"descend"` (folders, `path` ends with `/`): no space is added. The cursor goes to the end of the token, or just before the closing quote when quoted, so typing continues inside the mention.
- `spans`: a non-empty mention whose `exists(path)` is true is `"mention"`, false is `"missing"`. Everything else is `"text"`. The spans' texts joined give back `text` exactly.

- [ ] **Step 1: Write the failing tests**

```ts
test("compose_parse_mention_positions", () => {
  assert.deepEqual(parseMentions("@a.md x @b/ me@ex.com \\@c"), [
    { start: 0, end: 5, path: "a.md", quoted: false },
    { start: 8, end: 11, path: "b/", quoted: false },
  ]);
  assert.deepEqual(parseMentions('go @"my tasks/a.md" now')[0], { start: 3, end: 19, path: "my tasks/a.md", quoted: true });
  assert.deepEqual(parseMentions("@a.md,"), [{ start: 0, end: 6, path: "a.md,", quoted: false }]);
  assert.equal(parseMentions("x\n@a.md\nmore")[0]?.path, "a.md");
  assert.deepEqual(parseMentions('@"open quo'), [{ start: 0, end: 10, path: "open quo", quoted: true }]);
});

test("compose_mention_at_cursor", () => {
  assert.equal(mentionAt("x @tasks/sm", 11)?.path, "tasks/sm");
  assert.equal(mentionAt("x @tasks/sm", 2), null);          // before the @
  assert.equal(mentionAt("x @", 3)?.path, "");
  assert.equal(mentionAt("@a.md b", 6), null);
});

test("compose_submission_split", () => {
  assert.deepEqual(submission("@a.md Check the price").typed, "Check the price");
  assert.deepEqual(submission("Check @a.md   the price").typed, "Check the price");
  assert.deepEqual(submission("a  b @x.md  c").typed, "a  b c");
  assert.deepEqual(submission("@a.md @b.md").typed, null);
  assert.deepEqual(submission("mail \\@john and @ 5pm").typed, "mail @john and @ 5pm");
  assert.deepEqual(submission("@a.md x @b.md").mentions.map((m) => m.path), ["a.md", "b.md"]);
});

test("compose_backspace_deletes_whole_mention", () => {
  const s = { ...EMPTY_COMPOSE, text: "go @tasks/a.md", cursor: 14 };
  assert.deepEqual(pick(deleteMentionBefore(s)), ["go ", 3]);
  assert.equal(deleteMentionBefore({ ...s, cursor: 13 }), null);
  assert.equal(deleteMentionBefore({ ...s, text: "go @", cursor: 4 }), null);
});

test("compose_apply_completion", () => {
  const s = { ...EMPTY_COMPOSE, text: "@tasks/sm x", cursor: 9 };
  assert.deepEqual(pick(applyCompletion(s, "tasks/smoke/", "descend")), ["@tasks/smoke/ x", 13]);
  assert.deepEqual(pick(applyCompletion(s, "tasks/smoke.md", "accept")), ["@tasks/smoke.md x", 16]);
  const end = { ...EMPTY_COMPOSE, text: "@sm", cursor: 3 };
  assert.deepEqual(pick(applyCompletion(end, "smoke.md", "accept")), ["@smoke.md ", 10]);
  assert.deepEqual(pick(applyCompletion(end, "my tasks/", "descend")), ['@"my tasks/"', 11]);
  assert.deepEqual(pick(applyCompletion(end, "my tasks/a.md", "accept")), ['@"my tasks/a.md" ', 17]);
});

test("compose_spans_mark_missing", () => {
  const exists = (p: string) => p === "a.md" || p === "../up.md";
  assert.deepEqual(spans("x @a.md @no.md @../up.md @", exists).map((s) => [s.text, s.kind]), [
    ["x ", "text"], ["@a.md", "mention"], [" ", "text"], ["@no.md", "missing"], [" ", "text"],
    ["@../up.md", "mention"], [" @", "text"],
  ]);
});
```
(`pick = (s) => s && [s.text, s.cursor]`.)

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/tui/compose.test.ts`
Expected: FAIL (the new exports are missing).

- [ ] **Step 3: Implement the functions above in `src/tui/compose.ts`**

`composeKey`, `submit` and history are unchanged.

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/tui/compose.test.ts`
Expected: PASS, M1 compose tests included.

- [ ] **Step 5: Commit**

```bash
git add src/tui/compose.ts test/tui/compose.test.ts
git commit -m "feat(tui): parse @ mentions in the add box text"
```

---

### Task 3: Completion candidates

**Files:**
- Create: `src/tui/candidates.ts`
- Test: `test/tui/candidates.test.ts`

**Interfaces:**
- Consumes: `TASK_SUFFIXES` (src/taskfile.ts), `compareCodePoints` (src/text.ts).
- Produces:
  ```ts
  export interface DirEntry { name: string; dir: boolean }
  /** Entries of `relDir` ("" is the current folder, "tasks/smoke" a subfolder). Never throws. */
  export type ReadDir = (relDir: string) => DirEntry[];
  /** Folder paths end with "/"; `count` is the folder's root-level task files (0 for files). */
  export interface Candidate { path: string; folder: boolean; count: number }
  export interface CandidateIndex { items: Candidate[]; truncated: boolean }
  export const WALK_LIMIT = 5000;
  export function walk(readdir: ReadDir, limit?: number): CandidateIndex
  export function rank(index: CandidateIndex, query: string): Candidate[]
  export function nodeReadDir(root: string): ReadDir
  ```

Decisions:
- `walk` is breadth-first, with each folder's entries sorted by `compareCodePoints`, so shallow paths survive the cap. Every entry `readdir` returns counts toward `limit`. When the limit is reached the walk stops and `truncated` is `true`.
- Skipped entries are names starting with `.`, plus `node_modules` and `runs`, and any name containing `"` (it cannot be quoted in a mention). Skipped folders are not descended into.
- Files are candidates when their extension (lower-cased) is in `TASK_SUFFIXES`. Folders are candidates only when `count > 0`, but every folder is still descended into.
- `nodeReadDir(root)` uses `fs.readdirSync(path.join(root, relDir), { withFileTypes: true })`. A symlink is `stat`ed: a link to a file counts as a file, and a link to a folder is skipped (never followed, so no loops). Any error returns `[]`.
- `rank` is case-insensitive and requires the query to be a subsequence of the path. Results are sorted by score descending, then path length, then `compareCodePoints`. An empty query returns every item, sorted by depth (the number of `/`, not counting a trailing one) and then by path. Scoring is the one algorithm the tests do not determine:
  ```
  for each index i where path[i] matches query[0]:
    greedily match the rest of the query from i onward; skip i if it fails
    score = Σ per matched char: 16
                               + 8  if the previous query char matched at the previous path index
                               + 10 if the index is 0 or path[index-1] is one of "/-_. "
  best = max over i;  final = best - path.length
  ```

- [ ] **Step 1: Write the failing tests**

A `fakeReadDir(tree: Record<string, string[]>)` helper: keys are relDirs, and names ending in `/` are folders.

- `candidates_skip_rules_and_counts`: tree `"" → [".git/", "node_modules/", "runs/", "tasks/", "README.md", "notes.TXT", "x.json", 'q"a.md']`, `"tasks" → ["a.md", "b.md", "deep/", "empty/"]`, `"tasks/deep" → ["c.md"]`, `"tasks/empty" → ["img.png"]`. `walk(...)` gives paths `["README.md", "notes.TXT", "tasks/", "tasks/a.md", "tasks/b.md", "tasks/deep/", "tasks/deep/c.md"]` (order as walked), `tasks/` count 2, `tasks/deep/` count 1, and no `.git`, `node_modules`, `runs` or `empty` entries. The readdir fake records that `.git`, `node_modules` and `runs` were never read.
- `candidates_walk_cap`: a root with 6000 `fN.md` entries. `walk(r)` has `truncated: true` and at most 5000 items. `walk(r, 10)` has 10 items.
- `candidates_rank_order`: items `["tasks/smoke/", "tasks/smoke-login.md", "benchmark_tasks/05-saucedemo-checkout.md", "docs/misc.md"]`. `rank(_, "tasks/sm")` gives the first three in that order (the folder is shorter, and `sm` starts a segment there). `rank(_, "zz")` gives `[]`. `rank(_, "SMOKE")` gives `tasks/smoke/` first.
- `candidates_rank_prefers_segment_starts`: `rank` of `["xlogin.md", "auth/login.md"]` for `login` puts `auth/login.md` first, despite it being longer.
- `candidates_rank_empty_query`: the order is by depth, then path.
- `candidates_node_readdir_survives_loops_and_errors`: a real `tmpDir()` with `a.md`, `sub/b.md`, a symlink `sub/loop → ..` and a symlink `l.md → a.md`. `walk(nodeReadDir(dir))` finishes and contains `a.md`, `l.md`, `sub/` and `sub/b.md`, and nothing under `sub/loop`. `nodeReadDir(dir)("missing")` returns `[]`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/tui/candidates.test.ts`
Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement `src/tui/candidates.ts` per the decisions above**

- [ ] **Step 4: Run them to see them pass**

Run: `node --test test/tui/candidates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/candidates.ts test/tui/candidates.test.ts
git commit -m "feat(tui): folder walk and fuzzy ranking for @ completion"
```

---

### Task 4: Completion and submission in the view state and keymap

**Files:**
- Modify: `src/tui/state.ts`, `src/tui/keys.ts`
- Test: `test/tui/state.test.ts`, `test/tui/keys.test.ts`

**Interfaces:**
- Consumes: Task 2 (`mentionAt`, `submission`, `deleteMentionBefore`, `applyCompletion`, `Mention`), Task 3 (`CandidateIndex`, `Candidate`, `rank`).
- Produces:
  ```ts
  // state.ts
  ViewState.completion: { index: CandidateIndex; highlight: number } | null   // initial null
  ViewState.addErrors: string[]                                                 // initial []
  UiAction |= { type: "completion"; value: ViewState["completion"] }
            | { type: "completionMove"; delta: number }
            | { type: "addFailed"; errors: string[]; cursor: number }
            | { type: "selectTask"; id: TaskId }
  export function completionItems(s: ViewState): Candidate[]   // rank(index, mentionAt(text, cursor)?.path ?? "")
  // keys.ts — Command: "addTask" is replaced by
  | { kind: "openCompletion" }
  | { kind: "addSubmission"; mentions: Mention[]; typed: string | null }
  ```

Reducer rules:
- `completionMove` clamps the highlight to `[0, items.length - 1]`.
- `addFailed` sets `addErrors`, moves `compose.cursor` to `cursor`, and closes the completion.
- `selectTask` selects the index of that id, if it is present.
- A `compose` action whose text differs from the current text clears `addErrors`.
- `escape` from compose also clears `completion`.

Compose keymap (`composeCommands`), in this order:
1. `esc` closes the completion when it is open (`completion: null`). Otherwise it is M1's `escape`.
2. While open: `up`/`down` give `completionMove ∓1/±1`. `tab` on a folder gives `applyCompletion(…, "descend")` and keeps the list open with highlight 0. `tab` on a file, or `⏎` on any entry, gives `"accept"` and closes the list. With no items, `tab` does nothing and `⏎` falls through to step 3.
3. `⏎` (not `alt`): if the text is blank, do nothing. Otherwise `submission(text)` gives `[ui completion null, { kind: "addSubmission", mentions, typed }]`. The box is not cleared here; the App does that on success.
4. `backspace` while closed: `deleteMentionBefore` if it applies, otherwise M1 editing.
5. Anything else goes through `composeKey`. Afterwards: if open and the cursor left the mention, close the list. If open and the mention's path changed, set highlight 0. If closed, and the key inserted text (no `name`, no ctrl/meta) and the cursor is now inside a mention, also emit `{ kind: "openCompletion" }`.

Hints in compose mode: when open, `↑↓ move · tab complete · ⏎ accept · esc close`. When closed, M1's hints with `{ key: "@", label: "file" }` inserted after `⏎ add`.

- [ ] **Step 1: Write the failing tests**

`test/tui/keys.test.ts` (a `composing(text, completion?)` helper builds a compose-mode state with the cursor at the end, and `IDX` is a fixed `CandidateIndex` of `tasks/`, `tasks/a.md`, `tasks/b.md`):
- `keys_at_opens_completion`: typing `@` on `"go "` gives `[ui compose, { kind: "openCompletion" }]`. Typing `x` on `"me"` gives no `openCompletion`. Moving `left` into an existing mention gives no `openCompletion`.
- `keys_completion_navigation`: open on `"@tas"`: `down` gives `completionMove 1`. `tab` on `tasks/` gives text `@tasks/` with the list still open. `⏎` on `tasks/a.md` gives text `@tasks/a.md `, the list closed, and no `addSubmission`.
- `keys_completion_escape_then_escape`: the first `esc` gives `completion null` and stays in compose mode. The second gives M1's `escape`.
- `keys_completion_closes_when_cursor_leaves`: open on `"@ta"`, a `space` closes the list.
- `keys_return_with_no_matches_submits`: open with a query matching nothing. `⏎` gives `addSubmission` with `mentions[0].path === "zz"`.
- `keys_submit_split`: closed on `"@a.md check it"`. `⏎` gives `{ kind: "addSubmission", mentions: [{ start: 0, end: 5, path: "a.md", quoted: false }], typed: "check it" }`. A blank box gives `[]`.
- `keys_backspace_mention_only_when_closed`: on `"@a.md"`, closed: text `""`. Open: text `"@a."`.
- `keys_up_down_history_only_when_closed`: closed, `up` recalls history (M1 behaviour). Open, `up` gives `completionMove`.
- `keys_paste_with_mention_does_not_open_list`: the single input `"@a.md check it"` on an empty box gives no `openCompletion`. A following `⏎` gives `addSubmission`.
- `keys_compose_hints_with_completion`: the closed and open hint lists, as above.

`test/tui/state.test.ts`:
- `state_add_failed_sets_errors_and_cursor`, `state_compose_edit_clears_errors`, `state_completion_move_clamps`, `state_select_task_by_id`, `state_completion_items_rank_query`. Each asserts its reducer rule above.

Update the M1 test `keys_compose_submit_and_escape` to expect `addSubmission` (`mentions: []`, `typed: "buy milk"`) instead of `addTask`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/tui/keys.test.ts test/tui/state.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the state and keymap changes above**

The `addTask` case in `app.ts` must now compile. Handle `addSubmission` there as typed-only for now, `manager.add({ mentions: c.mentions.map((m) => m.path), typed: c.typed })`; Task 5 completes it.

- [ ] **Step 4: Run them to see them pass**

Run: `npm test`
Expected: PASS (typecheck included). Also update the two `app.test.ts` assertions that expected `addTyped:` log entries to the `add:|<text>` form.

- [ ] **Step 5: Commit**

```bash
git add src/tui/state.ts src/tui/keys.ts src/tui/app.ts test/tui/
git commit -m "feat(tui): completion and mention submission in the keymap"
```

---

### Task 5: Completion list, coloured mentions and add errors on screen

**Files:**
- Create: `src/tui/completion.ts`
- Modify: `src/tui/addBox.ts`, `src/tui/app.ts`
- Test: `test/tui/app.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  // app.ts
  export interface TuiFiles { readdir: ReadDir; exists(path: string): boolean }
  AppProps.files?: TuiFiles   // default { readdir: nodeReadDir(process.cwd()), exists: fs.existsSync }
  // addBox.ts
  AddBox props gain: exists(path: string): boolean; errors: string[]
  export function addBoxHeight(c: ComposeState, errors: string[]): number
  // completion.ts
  export function Completion(p: { s: ViewState; width: number; paneHeight: number }): ReactElement | null
  ```

Decisions:
- App `openCompletion`: dispatch `completion { index: walk(files.readdir), highlight: 0 }`. The walk runs again each time the list opens, so new files show up.
- App `addSubmission`: `r = manager.add(...)`. If `!r.ok`, dispatch `addFailed` with each error's `message` and `cursor: c.mentions[r.errors[0].mention].start`. If ok, dispatch `compose submit(s.compose).state`, then an info toast `already added: <name>` per duplicate, then `selectTask r.added[0]` when any task was added.
- AddBox: the placeholder becomes `Describe a task, or @ a task file or folder…`. Mention spans are drawn in `ROLE.accent` or `ROLE.error`, as `spans()` says, with the cursor drawn as in M1. Below the text, inside the border, at most 3 error lines in `ROLE.error`, then `…and N more` if needed. `addBoxHeight` counts these rows.
- Completion: positioned absolutely at the bottom of the pane area, from column 1, with width `min(60, columns - 2)` and a round border in `ROLE.accent`. The top border title is the sanitized query (or `@` when empty). It shows `max(1, min(8, floor(paneHeight / 2)))` rows, scrolled so the highlight stays visible (reuse `scrollStart` from sidebar.ts). Each row is `▸ ` or two spaces, then the path (truncated in the middle), then, right-aligned and muted, `folder · <count>` for folders. With no items the only row is `no matches`. When `truncated` is set, a muted last row reads `first 5,000 entries only`.

- [ ] **Step 1: Write the failing tests** (`ink-testing-library`. `files` is a fake `readdir` over `{ "": ["tasks/", "a.md"], tasks: ["login.md", "smoke.md"] }` and `exists` checks that set plus folders)

- `app_completion_file`: type `a`, `@`, `t`, `a`, `s`, `k`, `s`, `/`, `l`. The frame shows `tasks/login.md`. `⏎` closes the list, and the box reads `@tasks/login.md `. A second `⏎` logs `add:tasks/login.md|`.
- `app_completion_folder`: type `@tas`. The frame shows `tasks/` and `folder · 2`. `tab` gives the box `@tasks/` with the list still showing `tasks/login.md`. `esc` closes the list (no `tasks/login.md` row) and focus stays in the box. A second `esc` leaves the box.
- `app_mixed_submission`: `@a.md check the price` then `⏎` logs `add:a.md|check the price`. The box is empty afterwards and the selection is on the new task.
- `app_bad_mention_adds_nothing`: the FakeManager `addResult` is `{ ok: false, errors: [{ mention: 1, message: "@nope.md: not found (type \\@ for a literal @)" }] }`. Submitting `@a.md @nope.md x` shows that message under the box, keeps the text, and adds no task row.
- `app_duplicate_toast`: `addResult` is `{ ok: true, added: [], duplicates: ["a.md"] }`. The frame shows `already added: a.md` and the box is empty.
- `app_completion_sanitizes_names`: the readdir yields `evil\x1b[2J.md`. After typing `@ev`, the raw frame contains no `\x1b[2J` and does contain `evil`.
- `app_missing_mention_is_red`: the raw frame for the box text `@a.md @zz.md` (not focused) has `@zz.md` wrapped in the red SGR code and `@a.md` in cyan.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/tui/app.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `completion.ts`, the `addBox.ts` changes and the `app.ts` command handling; pass `addErrors` and `exists` to the box and render `Completion` after the panes (before toasts)**

- [ ] **Step 4: Run them to see them pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/ test/tui/app.test.ts
git commit -m "feat(tui): @ completion list, coloured mentions and add errors"
```

---

### Task 6: README

**Files:**
- Modify: `README.md` (the *Interactive TUI* section)

- [ ] **Step 1: Document mentions.** After the five-keys table, add a short paragraph and example. It says that in the add box `@path` adds a task file and `@folder` adds every task file at its root, with front matter applied as with `-f`. Text left over becomes one typed task. `tab`/`⏎` complete, a path with spaces is written `@"my tasks/a.md"`, and `\@` types a literal `@`. If any mention fails, nothing is added. Example: `@tasks/smoke/ @tasks/login.md Check the footer links`.

- [ ] **Step 2: Verify:** `npm test` still passes and `grep -n '@"my tasks' README.md` finds the line.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: @ mentions in the TUI add box"
```
