# Replay the exported spec in the Playwright Inspector: Implementation Plan

**Goal:** Let the user open a run's `duckwright.spec.ts` in the Playwright Inspector from the TUI (`R`) and the web UI (**Replay spec**). Every failure shows up as a toast or an API error, never as a crash.
**Architecture:** A new `src/replay.ts` (`SpecReplays`) resolves the bundled `@playwright/test` CLI and spawns `node <cli> test duckwright.spec.ts --debug`. The child is detached, its output is discarded, and it is locked per run id. `RunManager.replaySpec(id)` picks the run folder, checks it, launches, and toasts. `TaskSnapshot.hasSpec` drives the UI hints. The TUI key, the HTTP route and the web button all call `replaySpec`.
**Tech Stack:** TypeScript (Node >= 22.18, type stripping), `node --test`, Ink (TUI), React + Vite (web), `@playwright/test` (new runtime dependency).
**Spec:** `docs/superpowers/specs/2026-10-07-replay-spec-playwright-debug-ui-design.md`

## Global Constraints

- No test spawns a real Playwright or a browser: `SpecReplays` takes a fake `spawn` and `cli`.
- Check command: `npm test` (typecheck of the server and web tsconfigs, then all tests).
- The client only ever sends a task id. The server derives the path.
- The API spec `duckwright.api.spec.ts` is never replayed.
- A replay does not count toward `--max-parallel`. It is not tracked or killed when Duckwright quits.
- Error strings are exported constants or builders, so tests and the manager share them (exact text in Contracts C1).
- Use `@playwright/test` with the version range `"^1.63.0"`, the same range as the `playwright-core` devDependency.

## Review Focus

1. **A late child `error` must not crash Duckwright.** After `spawn`, an `error` event with no listener would throw from the EventEmitter. `SpecReplays.launch` keeps a persistent `on("error")` listener. Pinned by Task 2, test `a late error after spawn is swallowed`.
2. **Lock release on every path.** The lock is released on `exit`, on an `error` before `spawn`, and on a synchronous throw. It is never released on the second (refused) trigger. Pinned by Task 2 lock tests.
3. **The run folder choice.** The latest session run beats the past folder after a re-run. A latest run with `workdir: ""` must not be reported as "has not run yet" (see Ruling R1). Pinned by Task 3, tests `replaySpec uses the latest session run after a re-run` and `replaySpec on a run without a folder`.
4. **The exit-code toast names the resolved absolute folder.** The text says `path.dirname(specPath)`, not `runs/<id>`. Pinned by Task 3 with a past run in a tmp folder outside `runs/`.
5. **`R` fires with `hasSpec: false`, and the footer hides it.** These are two `SHARED` bindings, and help lists `R` exactly once. Pinned by Task 5 keys tests.

---

### Task 1: `@playwright/test` runtime dependency

**Files:**
- Modify: `package.json`, `package-lock.json`
- Test: `test/packaging.test.ts`

**Contracts:** C6

**Interfaces:**
- Produces: `@playwright/test` is installed in `node_modules`, with `node_modules/@playwright/test/package.json` holding `"bin": { "playwright": "cli.js" }`.

**Checks:** `node --test test/packaging.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing test.** In `test/packaging.test.ts` (line 45), change the expected keys to `["@playwright/test", "ink", "react"]`. Also assert `pkg.dependencies["@playwright/test"] === "^1.63.0"`.
- [ ] **Step 2: Run it.** `Run: node --test test/packaging.test.ts` / `Expected: FAIL (keys are ["ink","react"])`
- [ ] **Step 3: Implement.** In the worktree, run `npm install --save @playwright/test@^1.63.0`, then make sure `package.json` reads exactly `"@playwright/test": "^1.63.0"` under `dependencies` (fix it by hand if npm wrote a different range). Do not add it to devDependencies.
- [ ] **Step 4: Run it.** `Run: node --test test/packaging.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit.** `git add package.json package-lock.json test/packaging.test.ts && git commit -m "build: add @playwright/test as a runtime dependency"`

---

### Task 2: `src/replay.ts`, the launcher

**Files:**
- Create: `src/replay.ts`
- Test: `test/replay.test.ts` (new)

**Contracts:** C1 (the launcher half: already open, not installed, spawn failure, argv and options)

**Interfaces:**
- Consumes: none (Node built-ins only).
- Produces:
  ```ts
  export interface PlaywrightCli { cli: string; nodeModules: string }
  export function findPlaywrightCli(resolve?: (id: string) => string): PlaywrightCli | null;
  export interface ChildLike {
    once(ev: "spawn", fn: () => void): unknown;
    once(ev: "exit", fn: (code: number | null) => void): unknown;
    on(ev: "error", fn: (err: Error) => void): unknown;
    unref(): void;
  }
  export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildLike;
  export type LaunchResult = { ok: true } | { ok: false; error: string };
  export const NOT_INSTALLED = "cannot replay: @playwright/test is not installed with Duckwright; reinstall duckwright";
  export const alreadyOpen = (runId: string) => `the spec of run ${runId} is already open in the Playwright Inspector`;
  export const cannotStart = (message: string) => `cannot start Playwright: ${message}`;
  export class SpecReplays {
    constructor(o?: { spawn?: SpawnFn; cli?: () => PlaywrightCli | null });
    isOpen(runId: string): boolean;
    launch(runId: string, specPath: string, onExit: (code: number | null) => void): Promise<LaunchResult>;
  }
  ```

**Checks:** `node --test test/replay.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/replay.test.ts`. The fake child is a `node:events` `EventEmitter` with an `unref()` that counts calls. The fake spawn records `(cmd, args, opts)` and returns the child, or throws when told to.
  - `findPlaywrightCli resolves cli and nodeModules`: use a `tmpDir()` with `node_modules/@playwright/test/package.json` = `{"bin":{"playwright":"cli.js"}}` and an empty `cli.js`. Pass a fake `resolve` that returns that package.json path. Expect `{ cli: <tmp>/node_modules/@playwright/test/cli.js, nodeModules: <tmp>/node_modules }`. A second case uses `"bin": "cli.js"` (string form) and gets the same result.
  - `findPlaywrightCli returns null`: when `resolve` throws, when `bin` is missing, and when `cli.js` does not exist.
  - `findPlaywrightCli finds the installed package by default`: `findPlaywrightCli()` is non-null and `fs.existsSync(result.cli)` holds (this proves Task 1).
  - `launch spawns node with the bare spec name`: `launch("r1", "/abs/runs/r1/duckwright.spec.ts", ...)`, then emit `spawn`. Expect `cmd === process.execPath` and `args` deep-equal to `[cli, "test", "duckwright.spec.ts", "--debug"]`. Expect `opts.cwd === "/abs/runs/r1"`, `opts.stdio === "ignore"`, `opts.detached === true`, `opts.windowsHide === true`, and `opts.shell === undefined`. Expect `opts.env.NODE_PATH` to start with `nodeModules`. When `process.env.NODE_PATH` is preset, it follows after `path.delimiter`. The result is `{ ok: true }`, and `unref` was called once.
  - `a second launch while open is refused`: the second `launch("r1", ...)` before `exit` resolves `{ ok: false, error: alreadyOpen("r1") }` and spawn was called once. After the child emits `exit(0)`, `isOpen("r1")` is false and a third launch spawns again. A different run id `r2` is not blocked by `r1`.
  - `an error before spawn releases the lock`: emit `error(new Error("ENOENT x"))` and expect `{ ok: false, error: "cannot start Playwright: ENOENT x" }` and `isOpen` false. A later `exit` does **not** call `onExit`.
  - `a synchronous spawn throw releases the lock`: spawn throws `new Error("EACCES")`, giving `cannot start Playwright: EACCES` and `isOpen` false.
  - `a late error after spawn is swallowed`: after `spawn`, `child.emit("error", new Error("late"))` does not throw (`assert.doesNotThrow`), and nothing else changes.
  - `exit passes its code`: `exit(3)` gives `onExit(3)`, and `exit(null)` gives `onExit(null)`. Each releases the lock.
  - `no CLI gives the not-installed error`: `cli: () => null` resolves `{ ok: false, error: NOT_INSTALLED }`. Spawn is not called and `isOpen` is false.
- [ ] **Step 2: Run it.** `Run: node --test test/replay.test.ts` / `Expected: FAIL (module src/replay.ts not found)`
- [ ] **Step 3: Implement** `src/replay.ts` as in the spec ("src/replay.ts (new): the launcher").
  - **`findPlaywrightCli`:** the default `resolve` is `createRequire(import.meta.url).resolve`. Wrap all of it in try/catch and return `null` on any throw.
  - **Settling the launch:** settle the promise once, with a local `settled` flag. Use a `failed` flag so that an `exit` after a pre-spawn error neither calls `onExit` nor touches the lock again.
  - **The persistent error listener:** register it with `child.on("error", ...)`, never `once`. Before `spawn`, it deletes the id and resolves `cannotStart(err.message)`. After `spawn`, it ignores the error.
  - **`env`:** `{ ...process.env, NODE_PATH: [pw.nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) }`.
  - **The default `spawn`:** `node:child_process` `spawn`, cast to `SpawnFn`.
- [ ] **Step 4: Run it.** `Run: node --test test/replay.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit.** `git add src/replay.ts test/replay.test.ts && git commit -m "feat: add SpecReplays launcher for the Playwright Inspector"`

---

### Task 3: `RunManager.replaySpec` and `TaskSnapshot.hasSpec`

**Files:**
- Modify: `src/runs/manager.ts`, `test/tui/fake-manager.ts`, `test/tui/keys.test.ts` (`task()` fixture only), `test/tui/state.test.ts` (`task()` fixture only), and any other `TaskSnapshot` literal that `npm run typecheck` flags
- Test: `test/runs/manager.test.ts`

**Contracts:** C1, C2

**Interfaces:**
- Consumes: `SpecReplays`, `LaunchResult`, `NOT_INSTALLED`, `alreadyOpen`, `cannotStart` from `src/replay.ts`, and `SPEC_NAME` from `src/export.ts`.
- Produces:
  - `TaskSnapshot.hasSpec: boolean`
  - `ManagerLike.replaySpec(id: TaskId): Promise<Result>`
  - `ManagerOptions.replays?: SpecReplays` (default `new SpecReplays()`)
  - Exported message builders in `src/runs/manager.ts`:
    - `stillRunning(name)` = `` `${name} is still running; replay its spec when it finishes` ``
    - `notRunYet(name)` = `` `${name} has not run yet` ``
    - `noRunFolder(name)` = `` `${name}'s latest run has no run folder, so it has no spec` `` (Ruling R1)
    - `noSpec(runId)` = `` `no spec for run ${runId}: only a passed run writes duckwright.spec.ts` ``
    - `openingToast(runId)` = `` `opening ${runId}/duckwright.spec.ts in the Playwright Inspector` ``
    - `closedToast(runId, code, specDir)`: for code `0`/`null`, `` `Playwright Inspector closed for ${runId}` ``. Otherwise `` `Playwright exited with code ${code} for ${runId}; run "npx playwright test duckwright.spec.ts --debug" in ${specDir} to see why` ``.
  - `FakeManager.replaySpec(id)` logs `replaySpec:<id>` and returns `this.replayResult` (a public field, default `{ ok: true }`). `snapshot()` defaults `hasSpec: false`.

**Checks:** `node --test test/runs/manager.test.ts`, `npm test`

- [ ] **Step 1: Write the failing tests** in `test/runs/manager.test.ts`.
  - **Test setup:** give `setup` an optional second argument `{ workdir?: (n: number) => string }`. The default stays `"/tmp/x"`, so existing tests are unchanged. Build an injected `new SpecReplays({ spawn: fakeSpawn, cli: () => ({ cli: "/pw/cli.js", nodeModules: "/pw" }) })`. `fakeSpawn` returns `EventEmitter` children (with `unref`) and records calls. Write spec files with `fs.writeFileSync(path.join(dir, "duckwright.spec.ts"), "")` in `tmpDir()` folders.
  - `hasSpec reflects the past folder's spec file`: a past run with `workdir` = a tmp dir containing the spec gives `hasSpec: true`. Without the file it gives `false`. A typed task that never ran gives `false`.
  - `hasSpec is false while live and true after a passed run`: start a task whose fake `workdir` is a tmp dir with the spec. While it is `running`, `hasSpec` is false. After `finish(outcome("pass"))` and `tick()`, `hasSpec` is true.
  - `replaySpec error texts` (each also asserts the fake spawn was not called and no `toast` event was emitted):
    - id 99 gives `no such task`.
    - A running task gives `stillRunning(name)`, e.g. `"\"t\" is still running; replay its spec when it finishes"`.
    - A never-run typed task gives `'"t" has not run yet'`.
    - A past folder without the file gives `no spec for run <id>: only a passed run writes duckwright.spec.ts`.
  - `replaySpec on a run without a folder`: the latest session run has `workdir: ""` and `id: ""` (an override of `startRun`). Finish it with a fail outcome. The result is `noRunFolder(name)`, not `notRunYet`, even when the task also has a past folder with a spec. `hasSpec` is false.
  - `replaySpec already open`: a second call before the fake child exits gives `the spec of run <runId> is already open in the Playwright Inspector`, and spawn was called once.
  - `replaySpec spawn failure`: the fake child emits `error(new Error("boom"))` before `spawn`, giving `cannot start Playwright: boom`. No toast.
  - `replaySpec not installed`: with `cli: () => null`, the result is `NOT_INSTALLED`.
  - `replaySpec success toasts`: after `spawn` the result is `{ ok: true }`, and the events contain `{ type: "toast", level: "info", message: "opening <runId>/duckwright.spec.ts in the Playwright Inspector" }`. The fake spawn's args end with `"duckwright.spec.ts", "--debug"`, and `cwd` is the tmp folder. Exiting with `0` toasts `Playwright Inspector closed for <runId>`. A second launch and exit with `2` toasts `Playwright exited with code 2 for <runId>; run "npx playwright test duckwright.spec.ts --debug" in <tmpDir> to see why`, where `<tmpDir>` is the past folder (outside `runs/`), as an absolute path.
  - `replaySpec uses the latest session run after a re-run`: a past task with a spec in folder A is started again with a fake `workdir` = folder B, which also has the spec, and passes. The spawn `cwd` is B and the opening toast names `basename(B)`.
  - `replaySpec resolves a relative workdir against cwd`: a past run with `workdir: path.relative(process.cwd(), tmp)` gives spawn `cwd === tmp`.
- [ ] **Step 2: Run it.** `Run: node --test test/runs/manager.test.ts` / `Expected: FAIL (replaySpec is not a function / hasSpec undefined)`
- [ ] **Step 3: Implement** in `src/runs/manager.ts`:
  - **`#specOf(task)`:** returns `{ runId, path } | { noFolder: true } | null`. If `task.runs` has a latest record, use its `handle.workdir`; when that is `""`, return `{ noFolder: true }`. With no session runs, use `task.past?.workdir`. With neither, return `null`. When there is a folder, return `runId = path.basename(workdir)` and `path = path.resolve(workdir, SPEC_NAME)`.
  - **Liveness:** "live" means the task's state is `running`, `paused` or `stopping`, the same rule as the UIs. Use the latest session run even while its `active` flag is still settling (Ruling R2).
  - **`#snapshot`:** sets `hasSpec = !live && spec has a path && fs.existsSync(path)`.
  - **`replaySpec`:** follows the spec's order: no such task, live, `null` (not run yet), `noFolder`, file missing, launch. `onExit(code)` calls `this.notify("info", closedToast(runId, code, path.dirname(specPath)))`. On an ok launch, `this.notify("info", openingToast(runId))`.
  - Add `replaySpec` to `ManagerLike`, and `replays` to `ManagerOptions`.
  - Update `FakeManager` as described under Interfaces. Add `hasSpec: false` to the `task()` fixtures in `test/tui/keys.test.ts` and `test/tui/state.test.ts`, and to any other literal the typecheck flags.
- [ ] **Step 4: Run it.** `Run: node --test test/runs/manager.test.ts && npm test` / `Expected: PASS`
- [ ] **Step 5: Commit.** `git add src/runs/manager.ts test/runs/manager.test.ts test/tui/fake-manager.ts test/tui/keys.test.ts test/tui/state.test.ts <any other fixture files edited> && git commit -m "feat: add replaySpec and hasSpec to the run manager"`

---

### Task 4: `POST /api/tasks/:id/replay`

**Files:**
- Modify: `src/web/api.ts`
- Test: `test/web/api.test.ts`

**Contracts:** C3 (it carries every C1 error, including the live-task error `<name> is still running; replay its spec when it finishes`, as a 409)

**Interfaces:**
- Consumes: `ManagerLike.replaySpec`, `FakeManager.replayResult`.
- Produces: a route `{ method: "POST", re: /^\/api\/tasks\/(\d+)\/replay$/ }` in `ROUTES`.

**Checks:** `node --test test/web/api.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests.**
  - `POST /api/tasks/1/replay` gives `{ status: 200, body: { ok: true } }`, and `m.log` includes `replaySpec:1`.
  - A body `{ path: "/etc" }` is ignored: still 200, and `replaySpec:1` is logged.
  - `POST /api/tasks/99/replay` gives `404 { ok: false, error: "no such task" }`, and `replaySpec:99` is not logged.
  - `m.replayResult = { ok: false, error: "x" }` gives `409 { ok: false, error: "x" }`.
  - Set `m.replayResult` to `{ ok: false, error: '"one" is still running; replay its spec when it finishes' }`. The reply is 409 with that exact text (the live-task row, C3).
  - `GET /api/tasks/1/replay` gives `405 { ok: false, error: "method not allowed" }`.
  - When `replaySpec` throws (override it on the fake), the reply is `500 { ok: false, error: "internal error" }`.
- [ ] **Step 2: Run it.** `Run: node --test test/web/api.test.ts` / `Expected: FAIL (404 not found)`
- [ ] **Step 3: Implement** the route: `taskExists` gives a 404 `no such task`, otherwise `fromResult(await ctx.manager.replaySpec(id))`. Make the route's `run` `async`. Never read `req.body`.
- [ ] **Step 4: Run it.** `Run: node --test test/web/api.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit.** `git add src/web/api.ts test/web/api.test.ts && git commit -m "feat: add the replay spec API route"`

---

### Task 5: TUI `R` key

**Files:**
- Modify: `src/tui/keys.ts`, `src/tui/app.ts`
- Test: `test/tui/keys.test.ts`, `test/tui/app.test.ts`

**Contracts:** C4

**Interfaces:**
- Consumes: `ManagerLike.replaySpec`, `TaskSnapshot.hasSpec`, `FakeManager.replayResult`.
- Produces: the `Command` variant `{ kind: "replay"; id: TaskId }`.

**Checks:** `node --test test/tui/keys.test.ts test/tui/app.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests.**
  - In `keys.test.ts`, use a helper `withSpec(t, hasSpec)` that spreads `hasSpec` onto `task()`:
    - `R` on a selected `passed` task with `hasSpec: true` gives `[{ kind: "replay", id: 1 }]`, both in the list and after `reduce(..., { type: "focus", target: "detail" })`.
    - `R` gives the same on `passed`, `failed` and `idle` (never ran) tasks with `hasSpec: false`.
    - `R` gives `[]` for `running`, `paused` and `stopping` tasks (even with `hasSpec: true`), and with no task selected (`initialState(0, [])`).
    - `footer(s)` includes `R replay spec` only for a non-live task with `hasSpec: true`. It does not include it for `hasSpec: false` or for a live task.
    - `helpBindings` for the list and the detail view each contain exactly one `{ key: "R", label: "replay spec" }`.
    - Lowercase `r` on a paused task still gives resume.
  - In `app.test.ts`, test `app_replay_key`: give a `FakeManager` one task `snapshot(1, "Check the price", { state: "passed", runId: "r1", hasSpec: true })`. Typing `R` logs `replaySpec:1`.
  - In `app.test.ts`, test `app_replay_error_toast`: give the task `hasSpec: false` and state `failed`, and set `m.replayResult = { ok: false, error: "no spec for run r1: only a passed run writes duckwright.spec.ts" }`. After typing `R` and `settle()`, the frame matches `/no spec for run r1/`.
- [ ] **Step 2: Run it.** `Run: node --test test/tui/keys.test.ts test/tui/app.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement.**
  - **`keys.ts`:** add the two `SHARED` bindings exactly as in the spec ("TUI (modified)"), placed after the `o` binding. The `R` binding with the footer goes first. Both use `char("R")` and the hint `{ key: "R", label: "replay spec" }`. The `Command` union gains `{ kind: "replay"; id: TaskId }`.
  - **`app.ts`:** add `case "replay"`, which does `void manager.replaySpec(c.id).then((r) => { if (!r.ok) dispatch({ type: "toast", level: "error", message: r.error }); });`.
- [ ] **Step 4: Run it.** `Run: node --test test/tui/keys.test.ts test/tui/app.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit.** `git add src/tui/keys.ts src/tui/app.ts test/tui/keys.test.ts test/tui/app.test.ts && git commit -m "feat: replay a run's spec from the TUI with R"`

---

### Task 6: Web **Replay spec** button

**Files:**
- Modify: `web/src/actions.ts`, `web/src/MainPane.tsx`
- Test: `test/web/actions.test.ts`

**Contracts:** C5

**Interfaces:**
- Consumes: `POST /api/tasks/:id/replay`, `TaskSnapshot.hasSpec`.
- Produces, in `web/src/actions.ts`:
  - `export const replaySpec = (d: Dispatch, id: TaskId) => shown(d, api.post(`/api/tasks/${id}/replay`));`
  - `export function replayTitle(task: TaskSnapshot): string | null`: returns `null` for a live task, `"Open duckwright.spec.ts in the Playwright Inspector"` when `task.hasSpec`, and `"No spec yet: only a passed run writes duckwright.spec.ts"` otherwise (Ruling R3).

**Checks:** `node --test test/web/actions.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/web/actions.test.ts`. Stub `globalThis.fetch` per test and restore it in `finally`.
  - `replaySpec posts to the replay route`: fetch is called with `"/api/tasks/7/replay"` and `method: "POST"`. A 200 `{ ok: true }` reply dispatches nothing.
  - `replaySpec shows a 409 as an error toast`: a 409 `{ ok: false, error: '"t" has not run yet' }` reply dispatches exactly `[{ type: "toast", level: "error", message: '"t" has not run yet' }]`.
  - `replaySpec 401 expires the session`: the actions are `["expired", "toast"]`.
  - `replayTitle`: it returns the two exact titles for `passed` with `hasSpec: true`/`false` and for `idle` with `hasSpec: false`. It returns `null` for `running`, `paused` and `stopping`. Build tasks with `snapshot()` from `test/tui/fake-manager.ts`.
- [ ] **Step 2: Run it.** `Run: node --test test/web/actions.test.ts` / `Expected: FAIL (replaySpec / replayTitle not exported)`
- [ ] **Step 3: Implement** both exports. In `MainPane.tsx` `TaskView`, right after the **Options** button, add `{replayTitle(task) !== null ? <Button title={replayTitle(task)!} onClick={() => void replaySpec(dispatch, id)}>Replay spec</Button> : null}`. Never set `disabled`.
- [ ] **Step 4: Run it.** `Run: node --test test/web/actions.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit.** `git add web/src/actions.ts web/src/MainPane.tsx test/web/actions.test.ts && git commit -m "feat: add the Replay spec button to the web UI"`

---

### Task 7: README

**Files:**
- Modify: `README.md`

**Contracts:** C7

**Interfaces:** none.

**Checks:** `npm test`

- [ ] **Step 1: Edit the README** (there is no test; this is checked by review against C7).
  - **TUI key table** (around line 173): add the row `` | `R` | Open the selected run's spec in the Playwright Inspector | ``.
  - **Web mode paragraph** (around line 203): mention the **Replay spec** button in a task's card, and add `R` to the TUI-only keys list (`g`, `r`, `R`, `h`/`l`, `J`/`K` and `F`).
  - **"Turning a run into a regression test"**: in step 3 (or the step about running the test), say that `R` in the TUI or **Replay spec** in the web UI opens the spec in the Playwright Inspector. Add a short paragraph saying:
    - it runs `playwright test duckwright.spec.ts --debug` in the run folder;
    - each run can have one replay open at a time;
    - Playwright's output is discarded, so a non-zero exit shows only as a toast;
    - it needs a display and Playwright's browser (`npx playwright install chromium` if the close toast shows a non-zero exit).
  - **"Minimal dependencies" bullet** (line 50): add that `@playwright/test` is a runtime dependency, used for spec replay.
  - **Badge** (line 8): change it to `![Dependencies](https://img.shields.io/badge/dependencies-ink%20%2B%20%40playwright%2Ftest-brightgreen)`.
- [ ] **Step 2: Run it.** `Run: npm test` / `Expected: PASS (full suite)`
- [ ] **Step 3: Commit.** `git add README.md && git commit -m "docs: document replaying a run's spec in the Playwright Inspector"`

## Manual e2e

- [ ] On a desktop machine with a display, do a passed run and press `R` in the TUI. Confirm that the Inspector opens with `duckwright.spec.ts` and can step through it.
- [ ] Repeat with **Replay spec** in `duckwright --web`.
- [ ] Repeat from a folder whose `package.json` has `"type": "module"`, to check that `@playwright/test` resolves there.
