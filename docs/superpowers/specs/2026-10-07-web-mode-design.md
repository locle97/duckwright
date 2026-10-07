# Web mode (`duckwright --web`)

## Goal

`duckwright --web` starts a local web server and serves a browser UI with the same functions as the
interactive TUI, in a neo-brutalist style. The TUI and print mode keep working as they do today.

Success criteria:

- Everything the TUI does is possible in the browser: add tasks (typed and `@` file mentions), plan a
  test plan file, start, pause, resume, step and stop runs, run several at once up to `--max-parallel`,
  watch each step live (goal, actions, results, network calls, cost), edit global and per-task options,
  edit task files and a plan's shared setup, reorder and run a plan's tasks, answer 2FA prompts, and
  browse and re-run past runs.
- It is reachable from the same machine only.
- No change to the run loop (`loop.ts`, `brain.ts`, `pw.ts`) or to how `RunManager` behaves.
- The published package gains no new runtime dependency.

Out of scope: access from another machine (`--host`), multi-user accounts, a mobile layout beyond a
collapsible sidebar, and any feature the TUI does not have.

## Decisions

| Question | Decision |
| --- | --- |
| Frontend stack | React + Vite, built into `dist/` (chosen over a zero-build vanilla app) |
| Layout | Two panes like the TUI: sidebar (plans, tasks, past runs) and run timeline, global options strip at the bottom |
| Access | Loopback only, random per-launch token, Host/Origin checks |
| Server to browser | SSE for events, JSON over HTTP for actions |
| Shared logic | The run-event to view-state reducer is extracted from `src/tui/state.ts` and shared |

## Architecture

`RunManager` is already UI-free (`ManagerLike` plus `subscribe(ManagerEvent)`). Web mode is a second
frontend on it, as the Ink TUI is the first.

```
src/web/            Node side, compiled by tsc into dist/web/
  index.ts          startWeb(): { url, done, quit }, like TuiHandle
  server.ts         node:http: static files, API, SSE
  api.ts            route table: request -> ManagerLike call (takes a ManagerLike, unit-testable)
  auth.ts           token, cookie, Host and Origin checks
src/runviews.ts     RunEvent -> RunView/StepView reducer, extracted from src/tui/state.ts (no ink, no react)
web/                Browser side: React + Vite, own tsconfig (DOM + JSX)
  src/              components, store, SSE client, CSS
  vite.config.ts    outputs to dist/web-ui/
```

- `src/` stays Node-only. The client imports `ManagerEvent`, `TaskSnapshot`, `PlanSnapshot`, `Globals`
  and the other shared types with `import type`, so there is no runtime coupling and no copied types.
- `src/tui/candidates.ts` (the `@` completion walk and ranking) is reused by the server for
  `/api/candidates`. Nothing in it depends on Ink.

### Build and packaging

- `build` becomes `tsc -p tsconfig.build.json && vite build`. `prepare`, CI and `scripts/smoke_install.sh`
  pick it up unchanged. `files` already ships `dist`, so `dist/web-ui/` is published.
- New dev dependencies: `vite`, `@vitejs/plugin-react`, `react-dom`, `@types/react-dom`. React is bundled
  into the client, so `dependencies` is unchanged.
- `npm test` also typechecks `web/` (a second `tsc -p web/tsconfig.json`).

### CLI wiring (`src/cli.ts`, `src/args.ts`)

- New flags: `--web` and `--port N` (default: a free port). `--web` is a third mode beside the TUI and `-p`.
- `--web` with `-p` is a usage error. `--port` without `--web` is a usage error. `--max-parallel`,
  `--past` and `--theme` apply to web mode as to the TUI (`--theme auto` follows `prefers-color-scheme`).
- A task, `-f` and `--plan` given with `--web` are added and started once the server is up, exactly as in
  the TUI. A bad file is reported on the terminal before the server starts (exit `2`).
- `tuiMain` is split: the manager setup (past runs, preflight, planner, given tasks and plan) is shared;
  only the frontend differs (`startTui` or `startWeb`). The batch summary is printed on exit in both.
- With no terminal, `--web` still works (it needs none).

### Lifecycle

1. Bind `127.0.0.1` on `--port` or an ephemeral port. A taken `--port` is an error (exit `2`).
2. Print `duckwright web: http://127.0.0.1:PORT/?t=TOKEN` and try to open the default browser. If opening
   fails, the printed URL is enough; it is not an error.
3. The first request with `?t=TOKEN` sets an HttpOnly, SameSite=Strict cookie and redirects to the bare
   URL, so the token leaves the address bar.
4. Quit: Ctrl-C (the existing `AbortSignal`) or the UI's Quit button calls `manager.stopAll()`, closes the
   server and SSE streams, prints the batch summary and exits (`130` if interrupted, else the summary's code).
5. Closing the tab does not stop runs; the server keeps going. Any number of tabs may be open at once.

## HTTP API

All routes require the token cookie. Request bodies are JSON, capped at 1 MiB. Action routes return
`{ ok: true, ... }` or `{ ok: false, error }` (HTTP 4xx), mirroring `Result`.

| Route | Calls |
| --- | --- |
| `GET /api/state` | one snapshot: `list()`, `plans()`, `globals()`, `activeCount()`, `maxParallel`, startup notices |
| `GET /api/events` | SSE: every `ManagerEvent` as `data: <json>`; `: ping` comment every 15 s |
| `POST /api/tasks` | `add({ mentions, typed })`; on failure returns the per-mention errors for the add box |
| `POST /api/tasks/:id/start`, `pause`, `resume`, `step`, `stop` | the same-named `ManagerLike` methods |
| `DELETE /api/tasks/:id` | `remove(id)` |
| `PUT /api/tasks/:id/overrides` | `setOverrides(id, o)` |
| `PUT /api/globals` | `setGlobals(o)` |
| `POST /api/tasks/:id/twofa` | `answerTwoFactor(id, value \| null)` |
| `POST /api/plans` | `plan(source)` |
| `POST /api/plans/:id/retry`, `cancel`, `run` (`which`), `stop` | `retryPlan`, `cancelPlan`, `runPlan`, `stopPlan` |
| `DELETE /api/plans/:id` | `removePlan(id)` |
| `POST /api/tasks/:id/move` (`delta`) | `movePlanTask(id, delta)` |
| `GET /api/source`, `PUT /api/source` | `readSource(target)`, `saveSource(target, text)` |
| `GET /api/candidates?q=` | `walk()` and `rank()` from `src/tui/candidates.ts` |
| `POST /api/quit` | `stopAll()`, then resolve `done` |

The manager's `RunManager`-only methods used by the CLI (`startQueued`, `notify`, `summary`) are not
exposed over HTTP.

### Security

The UI can start browsers and read and write task files, so the server is a local capability:

- Loopback bind only; there is no option to change it.
- Every request needs the token cookie (compared in constant time). A missing or wrong token is `401`
  with no body detail.
- The `Host` header must be `127.0.0.1:PORT` or `localhost:PORT` (blocks DNS rebinding). Mutating
  requests (`POST`, `PUT`, `DELETE`) also need an `Origin` that matches (blocks cross-site requests).
- Static files are served from `dist/web-ui/` only, with a resolved-path prefix check against traversal.
- `/api/source` reads and writes only the paths the manager already knows (a task's file or a plan's
  setup file), never an arbitrary path from the client.
- Responses carry `Cache-Control: no-store` for API routes and a CSP of `default-src 'self'`.
- Page-derived text (snapshots, titles, answers, network data) is rendered as text, never as HTML, and
  control characters are stripped with the logic of `src/tui/sanitize.ts`. History and events already
  pass through the existing redaction, so the web UI shows nothing the TUI does not.

## Client

### State

- `src/runviews.ts` holds the pure reducer from `RunEvent` to `RunView`/`StepView` (and the helpers
  `entriesOf` and `stringsOf` it needs), moved out of `src/tui/state.ts`. The TUI imports it from there.
  `test/tui/state.test.ts` is the safety net for the move and must pass unchanged in behaviour.
- The web store is a `useReducer` with `tasks`, `plans`, `globals`, `runViews[taskId]`, `toasts` and UI
  state (selection, filter, open dialog, sidebar width).
- On load and after every SSE reconnect the client refetches `/api/state` and rebuilds the store. Past
  tasks arrive with `past.events` inside the snapshot and are replayed through the reducer at once.
- Network entries come on `step:end` records, so no extra endpoint is needed for them.

### Layout (two panes)

- **Header** (yellow): logo, `N/limit running · $cost`, Help, Quit.
- **Sidebar** (about 34%, resizable): Add task and Plan buttons, a filter input, then plans (collapsible
  rows with a progress tag and Run, Stop, Run-failed), their tasks (with up/down move), typed and file
  tasks, and muted past runs. Each row has a state tag (IDLE, RUN, PAUSED, PASS, FAIL, STOPPED) and a `?`
  badge while the task waits on 2FA.
- **Main pane:** the task title and controls (Start or Run again, Pause or Resume, Step, Stop, Edit,
  Remove, Options), then expandable step cards. A step shows goal, evaluation, memory (only when it
  changed), actions with results, up to 8 network calls then "…and N more", cost and duration. A footer
  shows the outcome, the answer, the history path and the export result. The timeline follows the newest
  step unless the user scrolls up.
- **Bottom strip** (green): global options as inline-editable chips (model, max steps, headed, export,
  snapshot). Per-task overrides open from the main pane in the same style.
- **Dialogs** (modals): Add task (textarea with `@` completion dropdown), Plan (path input with the same
  completion), Editor (textarea; save errors inline), 2FA (masked code input, or Approve/Cancel for a
  passkey, with a countdown to the deadline), Confirm quit (shown while runs are active), Help.
- **Keyboard:** the TUI's main keys work outside inputs (`a`, `P`, space, `p`, `s`, `j`/`k`, `/`, `?`).
- Below about 800 px the sidebar becomes a drawer.

### Visual language

Background `#fffdf5`, ink `#111`, accents yellow `#ffd93d`, pink `#ff6b9d`, blue `#6bcbff`, green `#7ee081`,
red `#ff5d5d`. 3 px solid borders, hard offset shadows (`6px 6px 0`), square corners, monospace type
(`ui-monospace`), uppercase labels and buttons. A button moves a few pixels and shrinks its shadow on
hover, and loses its shadow when pressed. Dark theme (`--theme dark`, or `auto` with
`prefers-color-scheme: dark`) swaps ink and paper, keeps the accents and uses a light shadow. State is
never conveyed by colour alone (tags carry text), controls are real buttons with visible focus rings.

## Errors

- A failed action returns `{ ok: false, error }` and the UI shows it as a toast; the add box shows
  per-mention errors inline, as the TUI does.
- `401`: a "token expired, relaunch duckwright --web" screen.
- Server unreachable: a disconnected banner; the SSE client retries and refetches state on reconnect.
- A throwing SSE writer or closed socket drops that subscriber only; it never reaches the manager.
- Unknown routes `404`, wrong method `405`, malformed JSON or oversize body `400` and `413`.

## Testing

- `api.ts` takes a `ManagerLike`, so route tests run against a fake manager over a real ephemeral-port
  server: each route's mapping to the manager call, `ok:false` mapping to 4xx, token, Host and Origin
  rejection, body-size cap, static-file traversal, SSE framing and subscriber cleanup on disconnect.
- `args` tests for `--web` and `--port`, including the conflicts with `-p` and each other.
- A CLI test with an injected `startWeb` (as `loadTui` is injected today): given tasks are added and
  started once the server is up, a bad file exits `2` before it starts, and the summary prints on exit.
- `runviews` tests move with the reducer; the TUI tests keep passing.
- Client store tests run under `node --test` (the reducer is plain TypeScript).
- One Playwright smoke test of the built UI against a fake agent: add a task, watch it finish, open a
  step, answer a 2FA prompt.
- `npm test`, `npm run build` and `smoke_install.sh` stay green in CI on Node 22 and 24.

## Documentation

README: a "Web mode" section (flags and the security model), the options table
rows for `--web` and `--port`, the feature list, and a roadmap entry marked done.
