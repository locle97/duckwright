# Replay the exported spec in the Playwright Inspector: design

## Summary

Every passed run writes `runs/<id>/duckwright.spec.ts` (`SPEC_NAME` in `src/export.ts`). Users want to read and step through that test without leaving Duckwright. This change adds a "replay spec" action to the TUI (key `R`) and the web UI (a **Replay spec** button). Both call one new manager method, `replaySpec(id)`. It finds the run's spec and starts `playwright test duckwright.spec.ts --debug` in the run folder, as a detached child process with its output discarded. That opens the Playwright Inspector, which shows the code and lets the user step through it. A run can have one open replay at a time. Every failure (unknown task, no spec, Playwright missing, spawn error) reaches the user as a toast or an API error, never as a crash. `@playwright/test` becomes a runtime dependency, so the bundled `playwright` CLI is always present.

## Decisions

| Topic | Decision |
| --- | --- |
| Playwright mode | Inspector (`playwright test … --debug`). No `--ui` mode and no mode picker. (brief) |
| Which spec | `<run workdir>/duckwright.spec.ts`. A run "has a spec" when that file exists, for both live-finished and past (`runs/`) runs. The API spec `duckwright.api.spec.ts` is never replayed. (brief assumption) |
| Which run of a task | The task's latest session run once it is no longer active (`task.runs` last entry, `handle.workdir`). With no session run, the past run folder (`task.past.workdir`). A task with neither has no spec. |
| Live tasks | A task in `running`, `paused` or `stopping` cannot be replayed. Its new run has no spec yet, and the key/button are hidden. |
| Spec path resolution | `path.resolve(workdir, SPEC_NAME)`, so a relative `runs/…` workdir resolves against the process cwd, the same place the run wrote it. |
| How Playwright is started | `spawn(process.execPath, [cliJs, "test", "duckwright.spec.ts", "--debug"], …)`. `cliJs` is the `bin.playwright` file of the `@playwright/test` installed with Duckwright. It is resolved in code with `createRequire(import.meta.url).resolve("@playwright/test/package.json")`. Running the JS file with Node's own executable avoids `.cmd` shims and any shell on every platform. (brief assumption: bundled bin, no global install) |
| Spec argument | The bare file name `duckwright.spec.ts`, with `cwd` set to the spec's folder. Playwright treats positional args as path filters. A bare name avoids regex trouble from Windows backslashes in an absolute path, and it does not match `duckwright.api.spec.ts`. No config file is passed. The run folder has none, so Playwright uses its defaults with `testDir` = cwd. (brief assumption) |
| Spawn options | `cwd: <spec folder>`, `stdio: "ignore"`, `detached: true`, `windowsHide: true`, `shell` unset (false). After a successful spawn, `child.unref()` so Duckwright can exit while the Inspector stays open. (brief) |
| `@playwright/test` import resolution | `env` = `process.env` with `NODE_PATH` set to Duckwright's `node_modules` folder (the folder that holds `@playwright/test`), followed by any existing `NODE_PATH` after `path.delimiter`. The spec's `import … from '@playwright/test'` then resolves even when the user's project lacks the package. |
| Dependency | `"@playwright/test": "^1.63.0"` in `dependencies`, the same range as the `playwright-core` devDependency. `package-lock.json` is regenerated with `npm install`. (brief) |
| One replay per run | An in-memory `Set` of run ids holds the replays that are open. The id is added synchronously before spawning and removed on the child's `exit`, or on a spawn `error` before `spawn`. A second trigger while the id is present is refused with an error and spawns nothing. Lost on restart. (brief assumption) |
| Lock key | The run id (run folder name, `path.basename(workdir)`). A re-run of the same task makes a new run id and can be replayed separately. |
| Parallel limit | A replay does not count toward `--max-parallel` and is allowed while other runs are active. (brief assumption) |
| Process lifetime | Not tracked or killed when Duckwright quits. `detached` keeps it out of Duckwright's process group, so Ctrl-C in the TUI does not kill it. (brief) |
| Feedback on success | The manager emits an info toast through its existing `notify`, which reaches the TUI and the web UI. |
| Feedback on close | When the child exits, the manager emits an info toast. With output discarded, the exit code is the only hint for a spec that failed to load, so a non-zero code is named. |
| Failure reporting | `replaySpec` returns `Result`. The TUI shows `!ok` as an error toast. The web route maps `!ok` to `409 { ok: false, error }`, which the web UI's existing `shown()` helper turns into an error toast. Unknown id: 404 in the web route; the manager returns `"no such task"`. |
| `hasSpec` on the snapshot | `TaskSnapshot` gains `hasSpec: boolean`, computed in `RunManager.#snapshot`: true when the task is not live, it has a run folder (as above), and `fs.existsSync(specPath)` holds. The UIs use it to show the key and button. `replaySpec` checks the file again, because the file can be deleted between snapshot and click. |
| TUI key | `R` (uppercase, currently unbound in every table), label `replay spec`, in the `SHARED` table so it works from the list and the detail view, `footer: true`. Shown when the selected task has `hasSpec` and is not live. |
| Web control | A **Replay spec** button in the task card's action row in `web/src/MainPane.tsx`, after **Options**. Rendered only when `task.hasSpec && !live`, with title `Open duckwright.spec.ts in the Playwright Inspector`. No web keyboard shortcut (YAGNI). The README lists `R` among the TUI-only keys. |
| API route | `POST /api/tasks/:id/replay`, with no body (any body is ignored). The client only ever sends a task id. The server derives the path. (brief) |
| Display / headless | Nothing is detected. A machine without a display gets Playwright's own failure, reported through the close toast with its exit code. (brief) |
| README | Update the TUI key table and the help text, the Web mode section, "Turning a run into a regression test", the "Minimal dependencies" feature bullet and the dependencies badge. |

## Architecture / Components

### `src/replay.ts` (new): the launcher

One purpose: start the Playwright Inspector for a spec file and remember which runs have one open. It has no UI and no knowledge of tasks.

- `export interface PlaywrightCli { cli: string; nodeModules: string }`
- `export function findPlaywrightCli(resolve?: (id: string) => string): PlaywrightCli | null`
  - `resolve` defaults to `createRequire(import.meta.url).resolve`.
  - Resolves `@playwright/test/package.json`, reads it, and takes `bin.playwright` (a string, or `bin` itself if `bin` is a string). The result is `cli = path.resolve(path.dirname(pkgJson), bin)`.
  - `nodeModules = path.dirname(path.dirname(path.dirname(pkgJson)))` (`…/node_modules/@playwright/test/package.json` → `…/node_modules`).
  - Returns `null` if resolution throws, the bin entry is missing, or `cli` does not exist.
- `export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildLike`, where `ChildLike` is the subset of `ChildProcess` used: `once("spawn" | "error" | "exit", …)` and `unref()`. The default is `node:child_process` `spawn`.
- `export class SpecReplays`
  - `constructor(o: { spawn?: SpawnFn; cli?: () => PlaywrightCli | null } = {})`
  - `isOpen(runId: string): boolean`
  - `launch(runId: string, specPath: string, onExit: (code: number | null) => void): Promise<{ ok: true } | { ok: false; error: string }>`
    1. If `isOpen(runId)`, resolve with the "already open" error.
    2. `const pw = cli()`. If it is `null`, resolve with the "not installed" error.
    3. Add `runId` to the open set, then call `spawn(process.execPath, [pw.cli, "test", path.basename(specPath), "--debug"], { cwd: path.dirname(specPath), stdio: "ignore", detached: true, windowsHide: true, env })`, with `env` as in Decisions. A synchronous throw counts as a spawn error.
    4. On `spawn`: `child.unref()`, then resolve `{ ok: true }`.
    5. On `error` before `spawn`: remove `runId` and resolve with the spawn-failure error. `onExit` is not called.
    6. On `exit(code)`: remove `runId`, then call `onExit(code)` (`code` is `null` when the child was killed by a signal).
- Error strings are exported constants or builders, so tests and the manager share them (exact text in Contracts C1).

### `src/runs/manager.ts` (modified)

- `TaskSnapshot` gains `hasSpec: boolean`.
- `ManagerLike` gains `replaySpec(id: TaskId): Promise<Result>`.
- `ManagerOptions` gains `replays?: SpecReplays` (tests inject one with a fake spawn). The default is `new SpecReplays()`.
- A private `#specOf(task): { runId: string; path: string } | null` picks the run folder (Decisions, "Which run of a task") and returns `{ runId: path.basename(workdir), path: path.resolve(workdir, SPEC_NAME) }`. It returns `null` when no folder exists, or when the latest handle's `workdir` is `""` (a run whose folder could not be made).
- `#snapshot` sets `hasSpec`.
- `replaySpec(id)`:
  1. No task with this id → `{ ok: false, error: "no such task" }`.
  2. Task live → the "still running" error.
  3. `#specOf` is `null` → the "not run yet" error.
  4. The file does not exist (`fs.existsSync`) → the "no spec" error.
  5. `await replays.launch(runId, path, onExit)`. On ok, `notify("info", …opening…)`. `onExit` calls `notify("info", …closed…)`.
  6. Returns the `Result`.

### `src/web/api.ts` (modified)

Adds one route to `ROUTES`: `POST ^/api/tasks/(\d+)/replay$`. It uses `taskExists` → 404 `"no such task"`, then `fromResult(await ctx.manager.replaySpec(id))`.

### TUI (modified)

- `src/tui/keys.ts`: a new `Command` variant `{ kind: "replay"; id: TaskId }`. A new `SHARED` binding: `match: char("R")`, `when: (c) => c.t !== null && c.t.hasSpec && !isLive(c.t)`, `run: (c) => c.t ? [{ kind: "replay", id: c.t.id }] : []`, `hint: { key: "R", label: "replay spec" }`, `footer: true`. The help overlay and footer pick it up from the table automatically.
- `src/tui/app.ts`: `case "replay"` runs `void manager.replaySpec(c.id).then((r) => { if (!r.ok) dispatch({ type: "toast", level: "error", message: r.error }); })`.

### Web UI (modified)

- `web/src/actions.ts`: `export const replaySpec = (d: Dispatch, id: TaskId) => shown(d, api.post(`/api/tasks/${id}/replay`));`
- `web/src/MainPane.tsx`: the **Replay spec** button (Decisions, "Web control").

### Other files

- `package.json` and `package-lock.json`: the dependency.
- `test/tui/fake-manager.ts`: `snapshot()` defaults `hasSpec: false`. `FakeManager.replaySpec` logs `replaySpec:<id>` and returns a settable `replayResult` (default `{ ok: true }`).
- `test/packaging.test.ts`: the expected `dependencies` keys become `["@playwright/test", "ink", "react"]`.
- `README.md`.

Dependencies: `replay.ts` depends only on Node built-ins. `manager.ts` depends on `replay.ts` and `SPEC_NAME` from `export.ts`. The UIs depend only on `ManagerLike` / the HTTP API.

## Contracts

### C1: `ManagerLike.replaySpec` (Library)

- **Surface:** `replaySpec(id: TaskId): Promise<Result>`, where `Result = { ok: true } | { ok: false; error: string }`.
- **Input:** `id`, a task id from `list()`.
- **Output:** `{ ok: true }` once the Playwright process has spawned. It then emits a manager event `{ type: "toast", level: "info", message: "opening <runId>/duckwright.spec.ts in the Playwright Inspector" }`. When that process exits it emits `{ type: "toast", level: "info", message }`, where `message` is:
  - exit code `0` or `null`: `Playwright Inspector closed for <runId>`
  - any other code N: `Playwright exited with code N for <runId>; run "npx playwright test duckwright.spec.ts --debug" in runs/<runId> to see why`
- **Errors** (each spawns nothing, emits no toast, and returns `{ ok: false, error }` with this exact `error`):
  - unknown id → `no such task`
  - task `running`, `paused` or `stopping` → `<task name> is still running; replay its spec when it finishes` (`<task name>` is `TaskSnapshot.name`)
  - no run folder → `<task name> has not run yet`
  - spec file missing → `no spec for run <runId>: only a passed run writes duckwright.spec.ts`
  - replay of this run id already open → `the spec of run <runId> is already open in the Playwright Inspector`
  - `@playwright/test` CLI not resolvable → `cannot replay: @playwright/test is not installed with Duckwright; reinstall duckwright`
  - spawn `error` event or synchronous throw → `cannot start Playwright: <error message>` (in this case the open-replay lock is released)
- **Criteria:** SC1, SC2, SC3, SC4, SC5

### C2: `TaskSnapshot.hasSpec` (Library / Event)

- **Surface:** the `hasSpec: boolean` field on every `TaskSnapshot`, from `list()`, `task:added`/`task:updated` events, `GET /api/state` and the web event stream.
- **Output:** `true` when the task is not live, it has a run folder (latest finished session run, else the past folder), and `<folder>/duckwright.spec.ts` exists when the snapshot is taken. Otherwise `false`.
- **Errors:** none. A filesystem error during the check counts as `false`.
- **Criteria:** SC1, SC2

### C3: `POST /api/tasks/:id/replay` (API)

- **Surface:** `POST /api/tasks/<id>/replay`, where `<id>` is a whole number.
- **Who:** same as every route: a request on `127.0.0.1` with the per-launch token, a matching `Host`, and a matching `Origin`. Anything else is refused by the existing server checks (unchanged).
- **Input:** path parameter `id`. The request body is ignored, and the route never reads a path from the client.
- **Output:** `200 { "ok": true }`. The info toasts from C1 arrive on the event stream.
- **Errors:**
  - task id not in `list()` → `404 { "ok": false, "error": "no such task" }`
  - any C1 failure → `409 { "ok": false, "error": "<C1 error text>" }`
  - wrong method (for example `GET`) → `405 { "ok": false, "error": "method not allowed" }` (existing behavior)
  - manager throws → `500 { "ok": false, "error": "internal error" }` (existing behavior)
- **Criteria:** SC2, SC3, SC4, SC5

### C4: TUI `R` key (UI)

- **Surface:** the key `R` in the TUI list view and detail view.
- **Input:** a selected task with `hasSpec === true` that is not live.
- **Output:** calls `replaySpec` for the selected task. On success the user sees the info toast `opening <runId>/duckwright.spec.ts in the Playwright Inspector`, and the Inspector window opens. Later, the close toast from C1 appears.
- **Errors:** a `{ ok: false, error }` result shows an error toast with exactly `error`.
- **States:**
  - Key available: the footer shows `R replay spec`. Help (`?`) always lists `R` with the label `replay spec`.
  - Key unavailable (no task selected, task live, or `hasSpec` false): `R` does nothing and the footer omits it.
- **Criteria:** SC1, SC3, SC4, SC5

### C5: Web **Replay spec** button (UI)

- **Surface:** a button labelled `Replay spec` in the selected task's card (`MainPane`), after **Options**.
- **Input:** a click.
- **Output:** sends `POST /api/tasks/<id>/replay`. On 200 there is no extra client toast; the info toast arrives from the server's event stream.
- **Errors:** a non-2xx reply shows an error toast with the reply's `error` text. A 401 marks the session expired (the existing `checked` behavior).
- **States:**
  - Shown only when `task.hasSpec && !live`, with title `Open duckwright.spec.ts in the Playwright Inspector`.
  - Hidden for tasks that are live, have not run, or failed without a spec.
- **Criteria:** SC2, SC3, SC4, SC5

### C6: Package dependency (File)

- **Surface:** `package.json` `dependencies`.
- **Output:** contains `"@playwright/test": "^1.63.0"` alongside `ink` and `react`. `package-lock.json` is updated to match.
- **Criteria:** SC6

### C7: README (File)

- **Surface:** `README.md`.
- **Output:**
  - The TUI section's key table gains a row for `R`: `Open the selected run's spec in the Playwright Inspector`.
  - The Web mode paragraph mentions the **Replay spec** button and adds `R` to the TUI-only keys.
  - "Turning a run into a regression test" step 3 mentions replaying from the TUI/web.
  - The process is described: Inspector, one per run, output discarded, needs a display, and needs Playwright's browser installed (`npx playwright install chromium` if the close toast shows a non-zero exit).
  - The "Minimal dependencies" bullet and the dependencies badge name `@playwright/test` as a runtime dependency for spec replay.
- **Criteria:** SC6

## Data flow

1. The user presses `R` in the TUI (C4), or clicks **Replay spec** in the web UI (C5), which sends `POST /api/tasks/<id>/replay` (C3), which looks up the task id.
2. `RunManager.replaySpec(id)` finds the task and refuses a live one. It picks the run folder: latest finished session run, else the past folder. It builds `specPath = path.resolve(workdir, "duckwright.spec.ts")` and `runId = basename(workdir)`, then checks that the file exists.
3. `SpecReplays.launch(runId, specPath, onExit)` checks the open set and resolves the `@playwright/test` CLI. It adds `runId` to the open set and spawns `node <cli> test duckwright.spec.ts --debug` in the spec's folder, detached, with stdio ignored and `NODE_PATH` set to Duckwright's `node_modules`.
4. On `spawn` it unrefs the child and returns `{ ok: true }`. The manager emits the "opening…" toast, and the TUI and web UI show it.
5. Playwright opens a headed browser and the Inspector, paused at the start of the test. The user steps through it.
6. When the user closes it (or Playwright fails), the child exits. The open set drops `runId`, and the manager emits the close toast. A new replay of that run is allowed again.
7. Any refusal along the way returns `{ ok: false, error }`. The TUI toasts it; the web route returns 409 and the web UI toasts it.

## Error handling

| Failure | Behavior |
| --- | --- |
| Unknown task id (web) | 404 `no such task`, nothing spawned (C3) |
| Unknown task id (manager) | `no such task` (C1) |
| Task is live | `<name> is still running; replay its spec when it finishes`; key/button hidden (C1, C4, C5) |
| Task never ran | `<name> has not run yet` (C1) |
| Spec file missing (failed run, or deleted) | `no spec for run <runId>: only a passed run writes duckwright.spec.ts` (C1) |
| Replay of this run already open | `the spec of run <runId> is already open in the Playwright Inspector`, no second process (C1) |
| `@playwright/test` not resolvable | `cannot replay: @playwright/test is not installed with Duckwright; reinstall duckwright` (C1) |
| `spawn` emits `error` or throws (e.g. cwd vanished, EACCES) | `cannot start Playwright: <message>`, lock released, Duckwright keeps running (C1) |
| Playwright starts but exits non-zero (spec import fails, no browser, no display, user closed the browser mid-test) | Info toast `Playwright exited with code N for <runId>; run "npx playwright test duckwright.spec.ts --debug" in runs/<runId> to see why`, lock released (C1) |
| Duckwright quits while the Inspector is open | The Inspector keeps running (detached, unref'd). No toast. |
| Filesystem error while computing `hasSpec` | `hasSpec: false` (C2) |

## Testing

All tests use `node --test` under `test/` and run with `npm test` (typecheck of the server and web tsconfigs, then all tests). No test spawns a real Playwright or a browser: `SpecReplays` takes a fake `spawn` and `cli`.

- `test/replay.test.ts` (new):
  - `findPlaywrightCli` with a fake `resolve` against a temp folder laid out as `node_modules/@playwright/test/{package.json,cli.js}` returns the right `cli` and `nodeModules`.
  - It returns `null` when `resolve` throws, when `bin` is missing, and when `cli.js` is missing.
  - `launch` calls the fake spawn with `process.execPath` and `[cli, "test", "duckwright.spec.ts", "--debug"]`, plus `cwd` = the spec's folder, `stdio: "ignore"`, `detached: true`, no `shell`, and `env.NODE_PATH` starting with `nodeModules`.
  - The fake child's `spawn` event resolves `{ ok: true }` and calls `unref`.
  - A second `launch` for the same run id before `exit` resolves with the already-open error and does not call spawn. After `exit` it spawns again.
  - An `error` event before `spawn`, and a synchronous throw, both resolve with `cannot start Playwright: <msg>` and release the lock.
  - `exit(3)` calls `onExit(3)`.
  - `cli()` returning `null` gives the not-installed error without spawning.
- `test/runs/manager.test.ts` (extended), using a temp runs folder and an injected `SpecReplays` with a fake spawn:
  - `hasSpec` is true for a past run whose folder has `duckwright.spec.ts`, and false without it.
  - It is false while a session run is live, and true after a passed session run whose fake workdir contains the file.
  - `replaySpec` returns each C1 error text exactly: unknown, live, not run, missing spec, already open, spawn failure.
  - On success it emits the opening toast, and on fake exit it emits the closed / exit-code toast with the exact text.
  - The spec used is the latest session run's, not the past folder's, after a re-run.
- `test/web/api.test.ts` (extended): `POST /api/tasks/1/replay` → 200 `{ ok: true }` and the fake manager logs `replaySpec:1`. An unknown id → 404 `no such task`. A fake `{ ok: false, error: "x" }` → 409 `{ ok: false, error: "x" }`. `GET` on the route → 405.
- `test/tui/keys.test.ts` (extended): `R` on a selected task with `hasSpec: true` and state `passed` gives `[{ kind: "replay", id }]`, in both list and detail modes. `R` gives `[]` for `hasSpec: false` and for a `running` task. `hints()` includes `R replay spec` only when available. `helpBindings()` always includes it.
- `test/tui/app.test.ts` (extended): pressing `R` calls `replaySpec` on the fake manager. A fake failure shows the error toast text on screen.
- `test/web/ui.smoke.test.ts` / `test/web/actions.test.ts` (extended where those files already cover MainPane buttons and actions): `replaySpec` posts to `/api/tasks/<id>/replay` and a failure becomes an error toast. The button renders only for `hasSpec && !live`.
- `test/packaging.test.ts` (updated): dependencies are `@playwright/test`, `ink`, `react`.

Check command: `npm test`.

| Criterion | Contracts | Proved by |
| --- | --- | --- |
| SC1: TUI key launches `playwright test <spec> --debug`; footer/help list it | C1, C2, C4 | check: `replay.test.ts` (argv/options), `manager.test.ts`, `keys.test.ts`, `app.test.ts`; QA scenarios on C4 |
| SC2: Web "Replay spec" button via authenticated route | C1, C2, C3, C5 | check: `api.test.ts`, web action/smoke tests; auth is the existing server path (`server.test.ts` unchanged); QA scenarios on C3/C5 |
| SC3: No spec / unknown id → clear error, nothing spawned | C1, C3, C4, C5 | check: `manager.test.ts` (fake spawn not called), `api.test.ts` 404/409; QA scenarios |
| SC4: Second trigger while open spawns nothing | C1, C3, C4, C5 | check: `replay.test.ts`, `manager.test.ts`; QA scenario (trigger twice) |
| SC5: Spawn failure reported, no crash | C1, C3, C4, C5 | check: `replay.test.ts` (error event and throw), `manager.test.ts`; QA scenario (uninstalled package) |
| SC6: Dependency and README; `npm test` passes | C6, C7 | check: `packaging.test.ts`, `npm test`; review of README |

### Manual e2e

For the user, outside the run: on a desktop machine with a display, do a passed run, press `R` in the TUI (and click **Replay spec** in `--web`), and confirm the Inspector opens with the spec and can step. Repeat from a folder whose `package.json` has `"type": "module"` to check that `@playwright/test` resolves there.

## Out of scope

- `playwright test --ui` (UI mode) and a mode picker.
- A `duckwright replay` CLI subcommand.
- Tracking or killing the spawned Playwright process when Duckwright quits.
- Replaying the API-only spec (`duckwright.api.spec.ts`).
- Fixing or re-exporting a missing spec; running specs headless or capturing their results or output.
- A web keyboard shortcut for replay.
- Detecting a missing display or a missing Playwright browser before spawning.
- Showing "replay open" state in the UIs (the second trigger's error covers it).
