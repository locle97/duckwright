# Video and screenshot evidence options: design

Brief: `.duckor/flow/20261008-034720-video-screenshot-evidence-options/brief.md`

## 1. Summary

A run happens in a browser the user usually can't see (headless), and even with `--headed` nobody watches every step. This change adds two independent, off-by-default evidence options. `--screenshot` saves one PNG of the viewport after every loop step under `runs/<id>/screenshots/`. `--video` records one WebM for the whole run, `runs/<id>/video.webm`, with playwright-cli's `video-start`/`video-stop`. Both are linked from `history.json` and from the run's events, so the TUI, the web UI and past-run loading all find them. The web UI gets the best experience: an "Evidence" group with two checkboxes in the options dialog, chips in the options strip, a screenshot thumbnail on every timeline step (click for full size), and a video player on the run page once the run has ended, for live and past runs. Two new web routes serve these files from inside the run directory only. Evidence is only for people to look at: the prompts, the model's decisions and the exported spec stay the same. An evidence failure becomes a warning and never fails the run.

## 2. Decisions

| # | Topic | Decision |
|---|-------|----------|
| D1 | Flag names | `--video` / `--no-video` and `--screenshot` / `--no-screenshot`, parsed exactly like `--network` / `--no-network` (last one wins; `--x=v` is the error `argument --video/--no-video: ignored explicit argument 'v'`). (Brief assumption.) |
| D2 | Config and front-matter keys | `video` and `screenshot`, kind `bool` (`true`/`false`), added to `KEYS` in `src/taskfile.ts`, so task files and `duckwright.conf` both get them. Precedence stays: built-in < config < task file < flags < web/TUI global overrides < per-task overrides. (Brief assumption.) |
| D3 | Defaults | Both `false`. With both off, no extra playwright-cli command runs and no file or folder is created. |
| D4 | "headless = false" | This means the existing `--headed` option. Evidence works the same way headed or headless; nothing about it depends on `headed`. (Brief assumption.) |
| D5 | Screenshot command | `playwright-cli -s=<session> screenshot --filename=<abs path>`: the viewport, with no `--full-page`. It runs once per step, after the step is recorded (after the actions and network capture), including steps where the brain failed, so every step in `history` gets exactly one screenshot attempt. (Brief assumption.) |
| D6 | Video commands | `playwright-cli -s=<session> video-start <abs path to video.webm>` runs right after `open` succeeds, before `state-load`. `playwright-cli -s=<session> video-stop` runs in `Agent.run`'s `finally`, before `close`, only if `video-start` succeeded. `video-stop` runs without the abort signal (like `close`), so Ctrl-C still saves the video. Its timeout is 60 s, other commands keep 30 s. (Brief assumption.) |
| D7 | File layout | `runs/<id>/screenshots/step-NNN.png` (step number zero-padded to at least 3 digits: `step-001.png`, `step-1000.png`) and `runs/<id>/video.webm`. `screenshots/` is created on the first screenshot only. (Brief assumption.) |
| D8 | References in `history.json` | Paths are relative to the run folder. Each step gets `"screenshot": "screenshots/step-001.png"` when the file was written, or `"screenshot_error": "<message>"` when the attempt failed. Neither key appears when screenshots are off. The top level gets `"video": "video.webm"` only when the video was saved (stop succeeded and the file exists and is not empty). |
| D9 | References in events | `StepRecord` gains `screenshot?: string` and `screenshotError?: string`, so `step:end` events (and `events.jsonl`) carry them. `RunOutcome` gains optional `video?: string` (relative, `"video.webm"`), so `run:end` carries it. Past runs load both from `events.jsonl`, or from `history.json` when there is no valid `events.jsonl`. |
| D10 | Warnings | Each evidence failure adds one string to `RunOutcome.warnings`, on both the success and the failure path. The exact messages are listed in Error handling. A failure never changes `status`, `exitCode` or `success`. |
| D11 | Interrupts | An `AbortedError` (or any failure while the signal is aborted) during a screenshot is not swallowed; it propagates as an interrupt as it does today. Only non-abort failures become warnings. |
| D12 | Agent to run plumbing | `Agent` exposes `evidence: { video: string \| null; warnings: string[] }`, kept up to date as the run goes (like `costUsd`), so `run.ts` can read it after `run()` returns or throws. `AgentLike` gains an optional `evidence?` with the same shape. |
| D13 | Web evidence routes | `GET`/`HEAD /api/runs/{runId}/screenshots/{name}` and `GET`/`HEAD /api/runs/{runId}/video.webm`, served by `server.ts` before `handleApi`, because they return bytes, not JSON. `runId` must match `^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$`, `name` must match `^step-\d{3,}\.png$`. The resolved real path must be inside `realpath(runsDir)/<runId>/`. Anything else is a 404. |
| D14 | Runs folder for the server | `ServerOptions.runsDir` / `StartWebOptions.runsDir`, default `path.resolve("runs")`, the same folder `startRun` and `loadPastRuns` use. |
| D15 | Video range requests | The video route supports one `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` range (206 + `Content-Range`), so the browser player can seek. It answers 416 with `Content-Range: bytes */<size>` when the range is past the end. A malformed or multi-range header is ignored (200, the whole file). Screenshots are always sent whole. |
| D16 | Caching | Evidence responses send `Cache-Control: no-store` and the existing `SECURITY` headers. The CSP needs no change: `img-src 'self'`, and media falls back to `default-src 'self'`. |
| D17 | Web checkboxes vs. inherit | The existing dialog has a three-way inherit/on/off select. Evidence uses real checkboxes, as the brief asks. Each box shows `draft ?? inherited`. Clicking it sets `draft = newValue === inherited ? null : newValue`, and `null` means "no override" (the key is left out of the PUT). "Reset all" sets both drafts to `null`. |
| D18 | Inherited value for a task | `TaskSnapshot` gains `inherited: Effective`: the task's options without its own overrides (config, file, flags, global overrides). The global dialog uses `globals.base` as its inherited value. This adds one field. Without it a task dialog can't show what an unchecked "no override" box means. |
| D19 | Thumbnail placement | The thumbnail goes in the step body, which is visible when the step is expanded; under Follow, the live step is expanded. It is an `<img loading="lazy">`, max 320 px wide, alt `Screenshot after step N`. Clicking it opens an image dialog with the full-size picture. |
| D20 | Video placement | A "Video" card under the Result card, shown only when `run.outcome?.video` is set, with `<video controls preload="metadata">`. It appears for a live run when `run:end` arrives, and for past runs straight away. |
| D21 | URL safety in the browser | `src/runviews.ts` keeps `StepView.screenshot` only when it matches `^screenshots/step-\d{3,}\.png$`, and `RunView.video` only when it equals `"video.webm"`. Otherwise it stores `null`. The web UI builds URLs only from these values and `encodeURIComponent(runId)`. |
| D22 | TUI | The options pane and the per-task form gain `video` and `screenshot` boolean fields, which toggle like `headed`. The idle task detail lists them. An expanded step shows `shot  <workdir>/screenshots/step-NNN.png`, or `shot error  <message>` in the error colour. The run's result lines add `video  <workdir>/video.webm`. No image is drawn in the terminal. |
| D23 | Where the TUI path comes from | `RunView` gains `workdir: string`, taken from `run:start.workdir`. Paths are joined as `${workdir}/${rel}`, because `runviews.ts` must stay free of node modules. |
| D24 | `-p` report | `printOutcome` prints `Video: <dirname(historyPath)>/video.webm` after `History:` when `o.video` is set. Screenshots are not listed one by one. |
| D25 | Secrets on screen | Screenshots and the video are pixels, so the 2FA scrubber can't redact them. A typed code or any data on the page can show up in them. The README says so, next to the existing note on what is and is not recorded. The options stay off by default. |
| D26 | Multiple tabs | The video follows the page that playwright-cli records (its screencast of the current page). If the agent opens or switches tabs, the video may not show them. This is documented in the README, not worked around. |
| D27 | Web summary line | The task card's settings line appends ` · video on\|off · screenshots on\|off`. |
| D28 | New code modules | `src/evidence.ts` holds the names, the screenshot helper and the video start/stop helpers. `src/web/evidence.ts` holds route matching, path confinement and range parsing, and is pure apart from `fs.realpathSync`/`fs.statSync`, so it is easy to unit test. |

## 3. Architecture / Components

### Run side

- **`src/args.ts`**: `RunArgs` gains `video: boolean` and `screenshot: boolean` (defaults `false`). `RUN_SPEC.names` gains `--video`, `--no-video` (display `--video/--no-video`) and `--screenshot`, `--no-screenshot` (display `--screenshot/--no-screenshot`). `RUN_USAGE` gains the line `                  [--video | --no-video] [--screenshot | --no-screenshot]` after the `--network` line. `RUN_HELP` gains (after `--network`):
  ```
    --video, --no-video   record one video of the whole run to
                          runs/<id>/video.webm (default off)
    --screenshot, --no-screenshot
                          save a screenshot of the page after every step to
                          runs/<id>/screenshots/ (default off)
  ```
- **`src/taskfile.ts`**: `TaskSettings` gains `video` and `screenshot`. `KEYS` gains `video: ["video", "bool"]` and `screenshot: ["screenshot", "bool"]`. The key union of `settingValue` widens to include `"video" | "screenshot"`.
- **`src/config.ts`**: `DEFAULT_CONFIG` gains `# video: false` and `# screenshot: false` after `# network: true`. The config gets the keys through `RUN_KEYS` automatically.
- **`src/pw.ts`**: `PlaywrightCLI` gains:
  - `screenshot(path: string): Promise<void>` runs `screenshot --filename=<path>` and throws `PlaywrightError(stderr || stdout || "exit <code>")` on a non-zero exit.
  - `videoStart(path: string): Promise<void>` runs `video-start <path>` and throws in the same way.
  - `videoStop(): Promise<void>` runs `video-stop` without the signal, with a 60 s timeout, and throws `PlaywrightError` on a non-zero exit.
- **`src/evidence.ts`** (new):
  - `SCREENSHOTS_DIR = "screenshots"`, `VIDEO_NAME = "video.webm"`
  - `screenshotName(step: number): string` gives `step-${String(step).padStart(3, "0")}.png`
  - `screenshotRel(step)` gives `screenshots/step-NNN.png`
  - `takeScreenshot(pw, workdir, step, signal?): Promise<{ rel: string } | { error: string }>` creates `screenshots/`, calls `pw.screenshot(abs)` and checks the file exists. It rethrows `AbortedError`, and any error while `signal?.aborted`, as `AbortedError`. Other failures become `{ error }`, with the message cut to its first line, trimmed, at most 200 characters.
  - `startVideo(pw, workdir): Promise<string | null>` returns the warning message or null.
  - `stopVideo(pw, workdir): Promise<{ video: string | null; warning: string | null }>`.
- **`src/prompt.ts`**: `StepRecord` gains `screenshot?: string` and `screenshotError?: string`. `stepLine` and `buildPrompt` don't change, so the model never sees evidence.
- **`src/loop.ts`**: `AgentOptions` gains `video?: boolean` and `screenshot?: boolean`. `Agent` gains `readonly video`, `readonly screenshot` and `evidence = { video: null, warnings: [] }`. `run()` calls `startVideo` after `open`, and `stopVideo` in `finally` before `close` when the video started. `record()` takes the screenshot (when on) before it pushes the record and emits `step:end`, so the event already carries it. That covers both the normal path and the brain-error path.
- **`src/events.ts`**: `RunOutcome` gains `video?: string`.
- **`src/runs/run.ts`**: passes `video`/`screenshot` to `createAgent`. `historyJson` gains a `video: string | null` parameter (after `taskFile`, default `null`) and writes the step keys from D8. `finish()` and the catch path both read `agent?.evidence` and append its warnings to `outcome.warnings`, set `outcome.video`, and write `video` into `history.json`. `failure()` takes the warnings and the video.
- **`src/export.ts`**: `HistoryData` gains `video?: string`. `HistoryStep` gains `screenshot?: string` and `screenshot_error?: string`. Export ignores them.
- **`src/runs/past.ts`**: `eventsFromHistory` copies `screenshot`/`screenshot_error` into the step record, and `outcomeFromHistory` sets `video` when `h.video === "video.webm"`.
- **`src/report/plain.ts`**: prints the `Video:` line (D24).
- **`src/runs/manager.ts`**: `Overrides` and `Effective` gain `video` and `screenshot` booleans. `effectiveOf` and `#argsFor` apply them. `TaskSnapshot` gains `inherited: Effective`, computed by `#argsFor` without `task.overrides`.

- **`README.md`**:
  - The options table gains `--video` and `--screenshot` rows (default off).
  - The front-matter table gains the `video` and `screenshot` keys.
  - The Output section describes `screenshots/`, `video.webm` and the new `history.json` keys.
  - The web mode and TUI paragraphs mention the Evidence group, thumbnails and the player.
  - It notes D25 (secrets can appear on screen) and D26 (other tabs).

### Shared view

- **`src/runviews.ts`**: `StepView` gains `screenshot: string | null` and `screenshotError: string | null`, set on `step:end` (validated by D21). `RunView` gains `workdir: string` (from `run:start`, `""` in the `foldPast` fallback) and `video: string | null` (set on `run:end` from `outcome.video`, validated).

### Web server

- **`src/web/evidence.ts`** (new):
  - `matchEvidence(pathname): { runId: string; rel: string; type: "image/png" | "video/webm" } | null`
  - `resolveEvidence(runsDir, runId, rel): string | null` does realpath confinement and requires a regular file.
  - `parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null`
- **`src/web/server.ts`**: `ServerOptions.runsDir?: string`. In `handle`, after authorization, `/api/runs/` paths go to `serveEvidence`.
- **`src/web/api.ts`**: `parseOverrides` accepts `video` and `screenshot` booleans, with the messages `video must be true or false` and `screenshot must be true or false`.
- **`src/web/index.ts`**: `StartWebOptions.runsDir?: string` is passed through.

### Web UI

- **`web/src/dialogs/OptionsDialog.tsx`**: a `<fieldset className="evidence"><legend>Evidence</legend>` with two `<label><input type="checkbox"> Video</label>` / `Screenshot` checkboxes (ids `opt-video`, `opt-screenshot`), between "snapshot mode" and the hint. Draft fields are `video: boolean | null` and `screenshot: boolean | null` (D17).
- **`web/src/OptionsStrip.tsx`**: chips `video: on|off` and `screenshot: on|off`, with ✱ when overridden.
- **`web/src/Timeline.tsx`**: `StepCard` gets `runId`, renders the thumbnail button (D19) or `screenshotError` as a muted line `screenshot failed: <message>`, and dispatches the image dialog.
- **`web/src/MainPane.tsx`**: the `VideoCard` (D20) and the summary text (D27).
- **`web/src/store.ts`**: `Dialog` gains `{ kind: "image"; src: string; title: string }`. **`web/src/App.tsx`** renders it with the existing `Modal`, holding `<img className="evidence-full">`.
- **`web/src/evidence.ts`** (new, pure): `screenshotUrl(runId, rel)` gives `/api/runs/${encodeURIComponent(runId)}/${rel}`, and `videoUrl(runId)`.
- **`web/src/styles.css`**: `.thumb` (max-width 320 px, border, pointer cursor), `.evidence-full` (max-width 100 %, max-height 80vh), `fieldset.evidence`.

### TUI

- **`src/tui/form.ts`**: `FieldKey` gains `"video" | "screenshot"`, with labels `video` and `screenshot`, appended to `ORDER`. They toggle like `headed`.
- **`src/tui/detail.ts`**: `SETTINGS` gains `["video", "video"]` and `["screenshot", "screenshot"]`.
- **`src/tui/timeline.ts`**: the `shot` / `shot error` step rows and the `video` result row (D22).

## 4. Contracts

### C1: Evidence CLI flags (CLI)

- **Surface:** `duckwright [--video | --no-video] [--screenshot | --no-screenshot] ...`, in TUI, web and `-p` modes.
- **Input:** `--video`, `--no-video`, `--screenshot` and `--no-screenshot`, each a flag that takes no value. The last of a pair wins. Default off.
- **Output:** `RunArgs.video` / `RunArgs.screenshot` set. With `-p`, the run writes the evidence of C3/C4. `--help` shows the help lines in §3.
- **Errors:** `--video=x` exits 2 with `duckwright: error: argument --video/--no-video: ignored explicit argument 'x'` (and likewise `--screenshot/--no-screenshot`), in the existing argparse format.
- **Criteria:** SC1, SC2, SC5

### C2: `video` and `screenshot` settings in task files and the config (File)

- **Surface:** task-file front matter and `duckwright.conf`.
- **Input:** `video: true|false` and `screenshot: true|false`.
- **Output:** the run's setting, overridden by flags. `duckwright init` writes `# video: false` and `# screenshot: false`.
- **Errors:** `<file>:<line>: video must be true or false, got "<v>"` (or `screenshot`), and `"video" is set twice` for a duplicate key. These are the existing `TaskFileError` formats, with the existing exit behavior.
- **Criteria:** SC2

### C3: Screenshot files and their `history.json` / event references (File, Event)

- **Surface:** `runs/<id>/screenshots/step-NNN.png`. In `history.json`, the per-step keys `screenshot` and `screenshot_error`. In `step:end` events (live and in `events.jsonl`), the record's `screenshot` and `screenshotError`.
- **Input:** `screenshot` on.
- **Output:** a PNG of the viewport, one per step in `history`. On success the step has `"screenshot": "screenshots/step-NNN.png"`. On failure it has `"screenshot_error": "<message>"`, and `RunOutcome.warnings` contains `screenshot failed at step N: <message>`.
- **Errors:** never fails the run. See Error handling.
- **Criteria:** SC1, SC5

### C4: Run video and its references (File, Event)

- **Surface:** `runs/<id>/video.webm`, the top-level `"video"` key in `history.json`, and `run:end.outcome.video`.
- **Input:** `video` on.
- **Output:** one WebM covering the run from just after the browser opens until just before it closes, on pass, fail and stop alike. `history.json` gets `"video": "video.webm"` and the outcome gets `video: "video.webm"`. The `-p` report prints `Video: <run dir>/video.webm`.
- **Errors:** never fails the run. Start or stop failures, or a missing or empty file, add a warning (Error handling), and then `video` is left out.
- **Criteria:** SC1, SC5

### C5: Overrides API accepts evidence options (API)

- **Surface:** `PUT /api/globals` and `PUT /api/tasks/{id}/overrides`.
- **Who:** an authorized browser (token cookie, matching Origin), as today.
- **Input:** the existing fields plus optional `video: boolean` and `screenshot: boolean`. A field left out means no override.
- **Output:** `200 {"ok": true}`. `GET /api/state` and the event stream show `globals.overrides.video` / `.screenshot`, `globals.base.video` / `.screenshot`, and each task's `overrides`, `effective` and `inherited` with both keys.
- **Errors:** `400 {"ok": false, "error": "video must be true or false"}` (or `screenshot`) when the value is not a boolean. `404 no such task` as today.
- **Criteria:** SC3

### C6: Evidence file routes (API)

- **Surface:** `GET|HEAD /api/runs/{runId}/screenshots/{name}` and `GET|HEAD /api/runs/{runId}/video.webm`.
- **Who:** authorized requests only (`authorize()` runs first). An unauthorized request gets 401 `{"ok":false,"error":"unauthorized"}`, a bad Host gets 403, as for all `/api/*`.
- **Input:** `runId` matching `^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$`, `name` matching `^step-\d{3,}\.png$`. For the video, an optional `Range` header (D15).
- **Output:** `200` with `Content-Type: image/png` or `video/webm`, `Content-Length`, `Cache-Control: no-store`, the `SECURITY` headers and the file bytes (no body for HEAD). The video also sends `Accept-Ranges: bytes`. A satisfiable range gets `206` with `Content-Range: bytes <start>-<end>/<size>` and just those bytes.
- **Errors:** `404 {"ok":false,"error":"not found"}` when the path doesn't match the patterns (including any `..`, encoded slash or extra segment), the run folder or file is missing, the target isn't a regular file, or its real path is outside `realpath(runsDir)/<runId>/` (symlinks out). Other methods get `405 {"ok":false,"error":"method not allowed"}`. A range past the end gets `416` with `Content-Range: bytes */<size>` and an empty body.
- **Criteria:** SC4, SC6

### C7: Web options: Evidence group (UI)

- **Surface:** the Global options dialog and the per-task Options dialog, plus the options strip.
- **Input:** two checkboxes, "Video" and "Screenshot", inside a group whose legend is "Evidence".
- **Output:** each box shows the effective value it would have (D17). Save sends only the changed keys (`video` / `screenshot` booleans) with the other fields, and the dialog closes. The strip shows `video: on|off` and `screenshot: on|off` chips, with ` ✱` when overridden. The task card line shows ` · video on|off · screenshots on|off`. The next run started uses these values.
- **States:** there is no loading state, because the dialog renders from state. If saving fails, the dialog stays open and the server's error appears in the existing `.error` paragraph.
- **Criteria:** SC3

### C8: Web timeline screenshots and run video (UI)

- **Surface:** the task view's timeline and result area, for live runs and past runs.
- **Output:**
  - Every expanded step whose `screenshot` is set shows a thumbnail button holding an `<img alt="Screenshot after step N">` loaded from C6.
  - Clicking it (or pressing Enter/Space on it) opens a dialog titled `Screenshot: step N` with the full-size image. Esc or Close shuts it.
  - A step with `screenshotError` shows the muted line `screenshot failed: <message>`.
  - When the run has ended and `video` is set, a card titled "Video" under the Result card shows a `<video controls preload="metadata">` playing C6's video.
- **States:** while the run is live, no Video card is shown. When the image fails to load (`onError`), the thumbnail is replaced by the muted text `screenshot unavailable`. When both options are off, no evidence element is shown at all.
- **Criteria:** SC4

### C9: TUI evidence settings and paths (UI)

- **Surface:** the TUI options pane, the per-task options form, the idle task detail and the run timeline.
- **Output:**
  - Rows `video` and `screenshot` show `true`/`false`, toggled with ←/→/space, with ctrl+r to reset, as for `headed`.
  - Expanded steps show `shot  <workdir>/screenshots/step-NNN.png`, or `shot error  <message>` in red.
  - A finished run shows `video  <workdir>/video.webm`.
- **Criteria:** SC2, SC3

## 5. Data flow

1. **Settings resolve.** Built-in defaults (`false`) < config `video`/`screenshot` < task-file front matter < CLI flags (`parseRunArgs`). In TUI or web mode, `Manager.#argsFor` then applies the global overrides and the task overrides.
2. **Run start.** `startRun` makes the run folder, and `execute` builds the Agent with `video`/`screenshot` from `RunArgs`.
3. **Browser open.** `Agent.run`: `pw.open(headed)`. If `video` is on: `startVideo` calls `video-start <workdir>/video.webm`. Success marks the video as started; failure pushes `video failed to start: <msg>` to `evidence.warnings`. Then `state-load` and the network clear run as today.
4. **Each step.** Observe, think and act as today. Then, in `record()`: if `screenshot` is on, `takeScreenshot` saves `<workdir>/screenshots/step-NNN.png`. It sets `rec.screenshot = "screenshots/step-NNN.png"`, or sets `rec.screenshotError` and pushes `screenshot failed at step N: <msg>`. Then the record is pushed and `step:end` is emitted, and `jsonlSink` writes it to `events.jsonl`.
5. **Live display.** The manager forwards the event, and `reduceRunEvent` puts `screenshot` on the `StepView`. The web `Timeline` renders `<img src="/api/runs/<runId>/screenshots/step-NNN.png">`. The browser requests it with the token cookie; `server.ts` authorizes, matches C6, confines the path and streams the file.
6. **Run end.** In the `finally`: if the video started, `stopVideo` runs `video-stop` (no signal, 60 s), then checks that `video.webm` exists and has size > 0. That sets `evidence.video = "video.webm"`, or pushes a warning. Then `close`.
7. **Outcome.** `run.ts` (in `finish` or the catch path) writes `history.json` with step keys and the top-level `video`, and builds the `RunOutcome` with `warnings` (export warnings plus evidence warnings) and `video`. It then emits `run:end`.
8. **Video display.** `reduceRunEvent` sets `RunView.video`. The web `MainPane` shows the Video card. The TUI shows the `video` row. `-p` prints `Video:`.
9. **Past runs.** `loadPastRuns` reads `events.jsonl` (or falls back to `history.json`). The same reducers rebuild `screenshot` and `video`, so past runs show the same thumbnails and player.

## 6. Error handling

| Failure | Behavior |
|---------|----------|
| `screenshot` exits non-zero, times out (`stderr: "timeout"`), or no file is written | The step gets `screenshotError` / `screenshot_error` = the first line of stderr, else stdout, else `exit <code>`, at most 200 characters, or `no file was written` when the file is missing. Warning: `screenshot failed at step N: <message>`. The run continues. |
| `mkdir` of `screenshots/` fails | Treated as a screenshot failure, with the message from the `fs` error (`error.message`). |
| Abort (Ctrl-C, Stop) during a screenshot | `AbortedError` propagates, and the run ends as `stop` / exit 130 as today. Screenshot warnings so far, and the video (stopped in `finally`), are still recorded in the outcome. |
| `video-start` fails | Warning `video failed to start: <message>`. No `video-stop` is attempted, and there is no `video` key. The run continues. |
| `video-stop` fails or times out | Warning `video failed to stop: <message>`, and no `video` key. `close` still runs. |
| `video.webm` missing or 0 bytes after a successful stop | Warning `video was not saved: video.webm is missing or empty`, and no `video` key. |
| The run fails or is interrupted (catch path in `run.ts`) | The outcome still carries the evidence warnings and `video` when it was saved. `history.json` still gets `video`. |
| Evidence route: path doesn't match, the file is missing, it isn't a regular file, or it escapes the run folder | 404 `{"ok":false,"error":"not found"}` (C6). |
| Evidence route: wrong method | 405 `{"ok":false,"error":"method not allowed"}`. |
| Evidence route: range past the end | 416, `Content-Range: bytes */<size>`. |
| Evidence route: read error while streaming | The connection is destroyed. If headers weren't sent yet, 500 `{"ok":false,"error":"internal error"}` (the existing handler catch). |
| `PUT` overrides with a non-boolean `video`/`screenshot` | 400 with `video must be true or false` / `screenshot must be true or false`. |
| Front matter or config `video: maybe` | `TaskFileError` `<file>:<line>: video must be true or false, got "maybe"`. |
| `--video=1` | Usage error exit 2: `argument --video/--no-video: ignored explicit argument '1'`. |
| An image fails to load in the browser | The thumbnail is replaced by `screenshot unavailable`, and nothing else changes. |
| A malformed `screenshot` / `video` value in a past run's events | `runviews` stores `null`, so no thumbnail or player is shown and no URL is built. |

## 7. Testing

Checks: `npm run typecheck` and `npm test` (typecheck plus `node --test "test/**/*.test.ts"`). Live playwright tests in `test/e2e.test.ts` stay skipped and are **not** part of this run's verification. Every test below uses fake runners or temp folders.

Unit and integration tests:

- **`test/args.test.ts`**: defaults are false. `--video`, `--no-video`, `--screenshot` and `--no-screenshot` work, last wins, and they override `settings`. `--video=x` gives the error. The help text contains the new lines.
- **`test/taskfile.test.ts`, `test/config.test.ts`**: `video: true` and `screenshot: false` parse. A bad value and a duplicate key give the exact messages. `DEFAULT_CONFIG` holds the commented keys.
- **`test/pw.test.ts`**: the argv of `screenshot`, `video-start` and `video-stop`. `video-stop` has no signal and a 60 s timeout. Non-zero exits throw `PlaywrightError`.
- **New `test/evidence.test.ts`**:
  - `screenshotName(1) === "step-001.png"` and `screenshotName(1000) === "step-1000.png"`.
  - `takeScreenshot` with a fake runner covers success, a non-zero exit (message cut to its first line and 200 characters), a missing file, and abort rethrow.
  - `startVideo` / `stopVideo` cover the start failure, the stop failure, and an empty file.
- **`test/loop.test.ts`**:
  - With both off, the fake runner sees no `screenshot` or `video-*` calls and no `screenshots/` folder exists.
  - With `screenshot` on, there is one screenshot call per step, including a brain-error step. `step:end` records carry `screenshot`. A failing screenshot leaves the run successful and sets `screenshotError` plus the warning.
  - With `video` on, `video-start` runs after `open`, and `video-stop` runs before `close` on success, on a thrown error and on abort. A start failure means no stop.
- **`test/runs/run.test.ts`**: `history.json` holds `screenshot` / `screenshot_error` per step and `video` at the top level. The outcome's `warnings` and `video` are set on the pass, fail and interrupt paths. With both off, `history.json` has none of the new keys.
- **`test/runs/past.test.ts`**: `eventsFromHistory` and `outcomeFromHistory` carry `screenshot` and `video`.
- **`test/runviews.test.ts`**: `StepView.screenshot`, `screenshotError` and `RunView.video` / `workdir`, with values that fail the pattern turned into `null`.
- **`test/runs/manager.test.ts`**: global and task overrides of `video` / `screenshot` reach `RunArgs`. `inherited` leaves out the task's own overrides.
- **`test/web/api.test.ts`**: `parseOverrides` accepts booleans and rejects others with the exact messages.
- **New `test/web/evidence.test.ts`**:
  - `matchEvidence` accepts the two shapes and rejects `..`, `%2F`, wrong names, extra segments and bad run ids.
  - `resolveEvidence` rejects a symlink that leads out of the run folder and a missing file.
  - `parseRange` covers `bytes=0-9`, `bytes=5-`, `bytes=-3`, past the end (unsatisfiable), malformed input (null) and multi-range input (null).
- **`test/web/server.test.ts`**: a real server on a temp `runsDir`:
  - A PNG is served with its type and headers.
  - The video is served with 200 and 206, and 416 for a range past the end.
  - 404s for traversal (`/api/runs/../x`, `/api/runs/<id>/screenshots/..%2Fhistory.json`), for `history.json` itself and for a symlink out.
  - 401 without the cookie, and 405 for POST.
- **`test/web/store.test.ts`**: the image dialog action. **`test/web/ui.smoke.test.ts`**:
  - The OptionsDialog renders an "Evidence" fieldset with two checkboxes, and toggling then saving sends the right body.
  - The Timeline renders a thumbnail for a step with `screenshot`.
  - MainPane renders the Video card only when `outcome` and `video` are set.
- **`test/tui/form.test.ts`, `test/tui/app.test.ts`**: the toggle fields and the `shot` / `video` rows.
- **`test/report.test.ts`**: the `Video:` line.

| Criterion | Contracts | Proved by |
|-----------|-----------|-----------|
| SC1 | C1, C3, C4 | `test/loop.test.ts`, `test/runs/run.test.ts`, `test/evidence.test.ts` (checks); QA scenarios on C3/C4 |
| SC2 | C1, C2, C9 | `test/args.test.ts`, `test/taskfile.test.ts`, `test/config.test.ts`, `test/tui/form.test.ts` (checks) |
| SC3 | C5, C7, C9 | `test/web/api.test.ts`, `test/runs/manager.test.ts`, `test/web/ui.smoke.test.ts` (checks); QA scenarios on C7 |
| SC4 | C6, C8 | `test/web/server.test.ts`, `test/runviews.test.ts`, `test/web/ui.smoke.test.ts` (checks); QA scenarios on C8 |
| SC5 | C1, C3, C4 | the both-off and failure cases in `test/loop.test.ts` and `test/runs/run.test.ts` (checks) |
| SC6 | C6 | `test/web/evidence.test.ts`, `test/web/server.test.ts` (checks); QA scenarios on C6 |
| SC7 | all | `npm test` (includes `npm run typecheck`) |

### Manual e2e

These are for the user and are not part of the run's verification:

- With a real playwright-cli and Claude, run `duckwright -p --video --screenshot "open example.com and report the heading"`. Confirm `runs/<id>/video.webm` plays and that `screenshots/step-001.png` and the later steps exist.
- Run `duckwright --web`, enable both checkboxes, run a task, and watch the thumbnails appear live and the video play (with seeking) after the run ends.

## 8. Out of scope

- Feeding screenshots to the model; no change to prompts or decisions.
- Rendering images in the terminal.
- Video editing, GIF export, chapters or action overlays (`video-chapter`, `video-show-actions`), and per-action screenshots.
- Evidence in exported specs or `duckwright export`.
- Full-page screenshots, configurable formats or sizes, and recording tabs other than the one playwright-cli records (D26).
- Redacting secrets from images or video (D25).
- Cleaning up or limiting the disk space evidence uses.
- Adding `network` to the web/TUI overrides (it stays as it is today).
