# Video and Screenshot Evidence Options Implementation Plan

**Goal:** Add two off-by-default evidence options, `--screenshot` (one viewport PNG per step) and `--video` (one WebM per run), and show them in history.json, events, the `-p` report, the TUI and the web UI.
**Architecture:** `src/evidence.ts` holds the names and the screenshot/video helpers built on three new `PlaywrightCLI` methods. `Agent` takes a screenshot in `record()` and starts and stops the video around the loop, keeping `evidence` up to date. `run.ts` copies that into `history.json` and `RunOutcome`. `runviews.ts` validates the references for both UIs, and `src/web/evidence.ts` serves the files from inside the run folder.
**Tech Stack:** TypeScript (Node ≥ 22.18, strip-types), `node:test`, Ink (TUI), React + Vite (web UI), playwright-cli.
**Spec:** `docs/superpowers/specs/2026-10-08-video-screenshot-evidence-options-design.md`

## Global Constraints

- Both options default to `false`. With both off, no extra playwright-cli command runs and no file or folder is created.
- Evidence is only for people to look at: the prompts, the model's decisions and the exported spec stay the same (`stepLine`/`buildPrompt` unchanged, export ignores the new keys).
- An evidence failure becomes a warning and never changes `status`, `exitCode` or `success`.
- An `AbortedError` (or any failure while the signal is aborted) during a screenshot propagates as an interrupt. Only non-abort failures become warnings.
- Paths in `history.json` and events are relative to the run folder: `screenshots/step-NNN.png`, `video.webm`.
- `src/runviews.ts` must stay free of node modules.
- The web UI builds evidence URLs only from validated `StepView.screenshot` / `RunView.video` and `encodeURIComponent(runId)`.
- Evidence routes return 404 `{"ok":false,"error":"not found"}` for anything outside `realpath(runsDir)/<runId>/`.
- Live playwright tests (`test/e2e.test.ts`) and the browser smoke test (`test/web/ui.smoke.test.ts`) are not part of this run's verification.

## Review Focus

1. Path traversal on the evidence routes: `/api/runs/../x` is normalised by `new URL` to `/x`, which would fall through to the SPA's `index.html` with a 200. The evidence check must use the raw request path. Pinned in Task 7 (`server_evidence_traversal_404`).
2. Abort during a screenshot must still interrupt the run, stop the video and close the browser. Pinned in Task 3 (`screenshot_abort_propagates_and_stops_video`).
3. The catch path in `run.ts` (fail and interrupt) must still carry the evidence warnings and the video. Pinned in Task 4 (`run_interrupt_keeps_evidence`).
4. A malformed `screenshot`/`video` value from a past run's events must never reach a URL. Pinned in Task 5 (`runviews_rejects_bad_evidence_refs`).
5. Range parsing edge cases (past the end, `bytes=-n`, multi-range). Pinned in Task 7 (`parse_range_cases`).

---

### Task 1: Settings for `video` and `screenshot` (flags, task files, config)

**Files:**
- Modify: `src/args.ts`, `src/taskfile.ts`, `src/config.ts`
- Modify (typecheck fallout, add `video: false, screenshot: false` to `RunArgs` literals): `test/runs/run.test.ts`, `test/twofa.leak.test.ts`
- Test: `test/args.test.ts`, `test/taskfile.test.ts`, `test/config.test.ts`

**Contracts:** C1, C2

**Interfaces:**
- Produces: `RunArgs.video: boolean`, `RunArgs.screenshot: boolean`; `TaskSettings.video?: boolean`, `TaskSettings.screenshot?: boolean`; `KEYS.video = ["video","bool"]`, `KEYS.screenshot = ["screenshot","bool"]`; `settingValue(key: "max-steps" | "model" | "headed" | "snapshot" | "video" | "screenshot", raw: string)`.

**Checks:** `node --test test/args.test.ts test/taskfile.test.ts test/config.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `args.test.ts`:
    - `evidence_flags_default_off`: `parseRunArgs([], skill)` gives `video === false && screenshot === false`.
    - `evidence_flags_last_wins`: `["--video","--no-video","--screenshot"]` gives `video: false, screenshot: true`; `["--no-screenshot","--screenshot"]` gives `screenshot: true`.
    - `evidence_flags_override_settings`: `parseRunArgs(["--no-video"], skill, { video: true })` gives `video: false`.
    - `evidence_flag_rejects_value`: `--video=x` throws `UsageError` with message `argument --video/--no-video: ignored explicit argument 'x'`; `--no-screenshot=1` gives `argument --screenshot/--no-screenshot: ignored explicit argument '1'`.
    - `evidence_help_lines`: `RUN_USAGE` contains `[--video | --no-video] [--screenshot | --no-screenshot]` on the line after `[--network | --no-network]`; `RUN_HELP` contains the exact block from spec §3 (`--video, --no-video   record one video of the whole run to` … `runs/<id>/screenshots/ (default off)`), placed after the `--network` entry.
    - Update any existing deepEqual on the default `RunArgs` to include `video: false, screenshot: false`.
  - `taskfile.test.ts`: front matter `video: true` / `screenshot: false` gives `settings.video === true`, `settings.screenshot === false`. `video: maybe` throws `TaskFileError` `<file>:<line>: video must be true or false, got "maybe"`. Two `screenshot:` lines throw the message containing `"screenshot" is set twice`. `settingValue("video", "true") === true`.
  - `config.test.ts`: `DEFAULT_CONFIG` contains `# network: true\n# video: false\n# screenshot: false\n`. `loadConfig` of a file with `screenshot: true` gives `{ screenshot: true }`.
- [ ] **Step 2: Run it**: `Run: node --test test/args.test.ts test/taskfile.test.ts test/config.test.ts` / `Expected: FAIL (unknown keys, unrecognized arguments)`
- [ ] **Step 3: Implement** in `src/args.ts`: the two `RunArgs` fields, defaults `false`, four `RUN_SPEC.names` entries (displays `--video/--no-video`, `--screenshot/--no-screenshot`), the usage line, the help block, and two branches next to `--network`. In `src/taskfile.ts`: the `TaskSettings` fields, the `KEYS` entries, the widened `settingValue` key union. In `src/config.ts`: the two commented lines after `# network: true`. Then fix the `RunArgs` literals in the listed test files.
- [ ] **Step 4: Run it**: `Run: node --test test/args.test.ts test/taskfile.test.ts test/config.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/args.ts src/taskfile.ts src/config.ts test/args.test.ts test/taskfile.test.ts test/config.test.ts test/runs/run.test.ts test/twofa.leak.test.ts && git commit -m "feat: add video and screenshot settings"`

### Task 2: playwright-cli evidence commands and `src/evidence.ts`

**Files:**
- Modify: `src/pw.ts`
- Create: `src/evidence.ts`
- Test: `test/pw.test.ts`, `test/evidence.test.ts` (new)

**Contracts:** C3, C4 (file naming, error messages)

**Interfaces:**
- Produces in `src/pw.ts`: `PlaywrightCLI.screenshot(path: string): Promise<void>`, `videoStart(path: string): Promise<void>`, `videoStop(): Promise<void>`.
- Produces in `src/evidence.ts`:
  - `SCREENSHOTS_DIR = "screenshots"`, `VIDEO_NAME = "video.webm"`
  - `interface Evidence { video: string | null; warnings: string[] }`
  - `screenshotName(step: number): string`, `screenshotRel(step: number): string`
  - `shortMessage(text: string): string`
  - `takeScreenshot(pw: PlaywrightCLI, workdir: string, step: number, signal?: AbortSignal): Promise<{ rel: string } | { error: string }>`
  - `startVideo(pw: PlaywrightCLI, workdir: string): Promise<string | null>`: the warning, or null when started.
  - `stopVideo(pw: PlaywrightCLI, workdir: string): Promise<{ video: string | null; warning: string | null }>`: never throws.

**Checks:** `node --test test/pw.test.ts test/evidence.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `pw.test.ts` (with `fakeRunner`, session `t`):
    - `screenshot_argv`: argv is `["playwright-cli","-s=t","screenshot","--filename=/x/s.png"]`.
    - `video_start_argv`: `["playwright-cli","-s=t","video-start","/x/video.webm"]`.
    - `video_stop_no_signal_60s`: with a `signal` in the options, argv is `["playwright-cli","-s=t","video-stop"]`, `calls[0].timeoutSec === 60`, `calls[0].signal === undefined`.
    - `evidence_commands_throw_on_nonzero`: each of the three with `{code: 1, stdout: "", stderr: "boom"}` rejects with `PlaywrightError` "boom"; with empty stderr and stdout and code 3, the message is `exit 3`.
  - `evidence.test.ts`:
    - `screenshot_name`: `screenshotName(1) === "step-001.png"`, `screenshotName(1000) === "step-1000.png"`, `screenshotRel(12) === "screenshots/step-012.png"`.
    - `take_screenshot_success`: a fake runner that writes the `--filename` file gives `{ rel: "screenshots/step-001.png" }`, and the file exists under `<workdir>/screenshots/`.
    - `take_screenshot_nonzero_exit`: stderr `"line one\nline two"` gives `{ error: "line one" }`; a 300-char single line gives an error of length 200.
    - `take_screenshot_missing_file`: exit 0 without writing gives `{ error: "no file was written" }`.
    - `take_screenshot_mkdir_failure`: `workdir` is a regular file, so the result is `{ error }` with the fs error message (the `ENOTDIR`/`EEXIST` text), and no throw.
    - `take_screenshot_abort_rethrows`: a runner that throws `AbortedError` rejects with `AbortedError`; a runner that returns code 1 while the passed signal is aborted also rejects with `AbortedError`.
    - `start_video_failure`: a runner with code 1 and stderr `"no ffmpeg"` gives `"video failed to start: no ffmpeg"`; success gives `null`.
    - `stop_video_cases`: stop fails with stderr `"stuck"`, so the result is `{ video: null, warning: "video failed to stop: stuck" }`; stop succeeds with no file, or with a 0-byte file, so the result is `{ video: null, warning: "video was not saved: video.webm is missing or empty" }`; stop succeeds with a non-empty file, so the result is `{ video: "video.webm", warning: null }`.
- [ ] **Step 2: Run it**: `Run: node --test test/pw.test.ts test/evidence.test.ts` / `Expected: FAIL (methods and module missing)`
- [ ] **Step 3: Implement**
  - `pw.ts`: `screenshot` and `videoStart` go through `this.run(...)`. `videoStop` calls `this.runner(argv, null, 60)` without options, like `close`. All three throw `new PlaywrightError(res.stderr || res.stdout || \`exit ${res.code}\`)` on a non-zero exit.
  - `evidence.ts`:
    - `shortMessage` trims the text and takes its first line, trimmed and cut to 200 characters. It gives `"unknown error"` when that is empty.
    - `takeScreenshot` runs `mkdirSync(recursive)` and `pw.screenshot(abs)` inside one try. In the catch it rethrows `AbortedError`, throws `new AbortedError()` when `signal?.aborted`, and otherwise returns `{ error: shortMessage(e.message) }`. It then checks `fs.existsSync(abs)`.
    - `startVideo` rethrows `AbortedError` and turns other errors into `video failed to start: <short>`.
    - `stopVideo` turns any error into `video failed to stop: <short>`, then requires `statSync(...).size > 0`.
- [ ] **Step 4: Run it**: `Run: node --test test/pw.test.ts test/evidence.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/pw.ts src/evidence.ts test/pw.test.ts test/evidence.test.ts && git commit -m "feat: add screenshot and video helpers"`

### Task 3: Agent takes screenshots and records the video

**Files:**
- Modify: `src/loop.ts`, `src/prompt.ts`, `src/events.ts`
- Test: `test/loop.test.ts`, `test/prompt.test.ts`

**Contracts:** C3, C4

**Interfaces:**
- Consumes: `takeScreenshot`, `startVideo`, `stopVideo`, `Evidence` from Task 2.
- Produces:
  - `StepRecord.screenshot?: string`, `StepRecord.screenshotError?: string`
  - `RunOutcome.video?: string`
  - `AgentOptions.video?: boolean`, `AgentOptions.screenshot?: boolean`
  - `Agent.video`, `Agent.screenshot` (readonly booleans), `Agent.evidence: Evidence` (initially `{ video: null, warnings: [] }`)

**Checks:** `node --test test/loop.test.ts test/prompt.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `loop.test.ts`. Add an `EvidencePW extends FakePW` that overrides `screenshot(p)` (writes `p` unless `shotFail` is set; throws `PlaywrightError(shotFail)` or `shotThrow`), `videoStart(p)`, `videoStop()` (writes `<workdir>/video.webm` with `"x"`) and `close()`. Each override pushes `[name, args]` onto `calls`, so the order can be asserted.
  - `evidence_off_runs_nothing`: default options, a 2-step run. No `screenshot`/`video-start`/`video-stop` in `calls`, `<workdir>/screenshots` does not exist, and `agent.evidence` deep-equals `{ video: null, warnings: [] }`.
  - `screenshot_every_step_including_brain_error`: script `[BrainError("x"), dec([["done",["success","ok"]]])]` with `{ screenshot: true }`. Two screenshot calls with paths ending `screenshots/step-001.png` and `step-002.png`. Each `step:end` record has `screenshot === "screenshots/step-00N.png"`, and so does `r.history[i].screenshot`.
  - `screenshot_failure_is_a_warning`: `shotFail = "boom"` gives `r.success === true`, `history[0].screenshotError === "boom"`, no `screenshot` key, and `agent.evidence.warnings` deep-equals `["screenshot failed at step 1: boom"]`.
  - `screenshot_abort_propagates_and_stops_video`: `{ screenshot: true, video: true }` with `shotThrow = new AbortedError()` rejects with `AbortedError`. `calls` order ends `..., "screenshot", "video-stop", "close"`.
  - `video_start_stop_order`: `{ video: true }` on success. The order is `open`, `video-start` (arg `<workdir>/video.webm`), …, `video-stop`, `close`, and `agent.evidence.video === "video.webm"`. The same order holds when `snapError` makes `run()` reject (assert `video-stop` before `close`).
  - `video_start_failure_skips_stop`: `videoStart` throws `PlaywrightError("nope")`. The run still succeeds, there is no `video-stop` call, and `evidence.warnings` deep-equals `["video failed to start: nope"]`.
  - `prompt.test.ts`: `stepLine` of a record with `screenshot` and `screenshotError` set equals `stepLine` of the same record without them.
- [ ] **Step 2: Run it**: `Run: node --test test/loop.test.ts test/prompt.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - `prompt.ts`: the two optional fields.
  - `events.ts`: `RunOutcome.video?: string`.
  - `loop.ts`:
    - `run()` keeps a local `videoStarted` flag. After `open` succeeds and before `state-load`, `if (this.video)` it calls `startVideo` and pushes the warning or sets the flag.
    - The `finally` calls `stopVideo` when the flag is set, setting `evidence.video` and pushing the warning, and then calls `close()`.
    - `record()` becomes `async`. When `this.screenshot` is on, it calls `takeScreenshot(this.pw, this.workdir, rec.step, this.signal)` before `history.push`. It sets `rec.screenshot`, or sets `rec.screenshotError = this.scrub(error)` and pushes `screenshot failed at step N: <error>`.
    - Both call sites `await` it.
- [ ] **Step 4: Run it**: `Run: node --test test/loop.test.ts test/prompt.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/loop.ts src/prompt.ts src/events.ts test/loop.test.ts test/prompt.test.ts && git commit -m "feat: take step screenshots and record run video in the agent"`

### Task 4: Run lifecycle, history.json, past runs and the `-p` report

**Files:**
- Modify: `src/runs/run.ts`, `src/export.ts`, `src/runs/past.ts`, `src/report/plain.ts`
- Test: `test/runs/run.test.ts`, `test/runs/past.test.ts`, `test/report.test.ts`

**Contracts:** C1 (`-p` report), C3, C4

**Interfaces:**
- Consumes: `Agent.evidence`, `Evidence`, `StepRecord.screenshot*`, `RunOutcome.video`, `RunArgs.video/screenshot`.
- Produces:
  - `AgentLike.evidence?: Evidence`
  - `historyJson(task, success, answer, steps, costUsd, history, taskFile = null, video: string | null = null): HistoryData`
  - `HistoryData.video?: string`, `HistoryStep.screenshot?: string`, `HistoryStep.screenshot_error?: string`

**Checks:** `node --test test/runs/run.test.ts test/runs/past.test.ts test/report.test.ts test/export.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `run.test.ts` (fake agents expose `evidence`):
    - `start_run_passes_evidence_options`: with args `{ video: true, screenshot: true }`, `createAgent` receives `opts.video === true && opts.screenshot === true`.
    - `history_json_evidence_keys`: `historyJson(..., [ {…rec, screenshot: "screenshots/step-001.png"}, {…rec, step: 2, screenshotError: "boom"} ], null, "video.webm")` gives `h.video === "video.webm"`, `h.history[0].screenshot === "screenshots/step-001.png"`, `h.history[1].screenshot_error === "boom"`, and no `screenshot` key on step 2.
    - `history_json_no_evidence_keys`: plain records with `video` null give no `video`, `screenshot` or `screenshot_error` key anywhere.
    - `run_pass_carries_evidence`: the agent sets `evidence = { video: "video.webm", warnings: ["screenshot failed at step 1: boom"] }` and succeeds. `outcome.video === "video.webm"`, `outcome.warnings` includes the warning, `outcome.status === "pass"`, and `readHistory(workdir).video === "video.webm"`.
    - `run_fail_carries_evidence`: the agent returns `success: false` with the same evidence. `status === "fail"`, `video` and the warning are set.
    - `run_interrupt_keeps_evidence`: the agent sets its evidence and then throws `AbortedError`. `status === "stop"`, `exitCode === 130`, `outcome.video === "video.webm"`, the warnings include the evidence warning, and history.json has `video`.
    - `run_without_evidence_has_no_video_key`: `"video" in outcome === false`.
  - `past.test.ts`:
    - `events_from_history_carries_screenshot`: a history step with `screenshot` / `screenshot_error` gives a `step:end` record with `screenshot` / `screenshotError`.
    - `outcome_from_history_video`: `video: "video.webm"` gives `outcome.video === "video.webm"`; `video: "../x.webm"` gives no `video` key.
  - `report.test.ts`:
    - `print_video_line`: `outcome({ video: "video.webm" })` gives `out` equal to `["Result: success","Answer: a","Steps: 2  Cost: $0.0213","History: runs/x/history.json","Video: runs/x/video.webm"]`.
    - Without `video`, there is no `Video:` line.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/run.test.ts test/runs/past.test.ts test/report.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - `run.ts`:
    - Pass `video: args.video, screenshot: args.screenshot` to `createAgent`.
    - `historyJson` writes the top-level `video` only when non-null, and the per-step keys only when set.
    - `failure()` gains `warnings: string[] = [], video: string | null = null`, and sets `video` only when non-null.
    - `finish()` and the catch path both read `const ev = agent?.evidence ?? { video: null, warnings: [] }`. They pass `ev.video` to `historyJson`, append `ev.warnings` after the export warnings, and set `outcome.video` when non-null.
  - `export.ts`: the type fields only.
  - `past.ts`: copies the step fields when they are strings, and sets `video` only for exactly `"video.webm"`.
  - `plain.ts`: `Video: ${path.join(path.dirname(o.historyPath), o.video)}` after `History:` when `o.video` and `o.historyPath` are set.
- [ ] **Step 4: Run it**: `Run: node --test test/runs/run.test.ts test/runs/past.test.ts test/report.test.ts test/export.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/run.ts src/export.ts src/runs/past.ts src/report/plain.ts test/runs/run.test.ts test/runs/past.test.ts test/report.test.ts && git commit -m "feat: write evidence into history, outcome and the -p report"`

### Task 5: Shared run views carry validated evidence

**Files:**
- Modify: `src/runviews.ts`
- Test: `test/runviews.test.ts`

**Contracts:** C8 (data side), C9 (data side)

**Interfaces:**
- Produces: `StepView.screenshot: string | null`, `StepView.screenshotError: string | null`, `RunView.workdir: string`, `RunView.video: string | null`.

**Checks:** `node --test test/runviews.test.ts test/web/store.test.ts test/tui/state.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `runviews.test.ts`:
  - `runviews_workdir_and_initial_evidence`: after `start()`, `workdir === "/w"` and `video === null`, and a new step has `screenshot === null && screenshotError === null`.
  - `runviews_step_screenshot`: a `step:end` record with `screenshot: "screenshots/step-001.png"` and `screenshotError: "boom"` sets both.
  - `runviews_run_end_video`: `run:end` with `{...OUTCOME, video: "video.webm"}` gives `video === "video.webm"`.
  - `runviews_rejects_bad_evidence_refs`:
    - `screenshot` values `"../history.json"`, `"screenshots/step-01.png"`, `"screenshots/step-001.png?x"`, `"/etc/passwd"` and `5` give `null`.
    - `screenshotError: 5` gives `null`.
    - `video` values `"x.webm"` and `"../video.webm"` give `null`.
  - `fold_past_carries_evidence`: `foldPast` of events with both gives the same values. The fallback view (no `run:start`) has `workdir === ""` and takes `video` from the outcome.
- [ ] **Step 2: Run it**: `Run: node --test test/runviews.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - Add `SHOT = /^screenshots\/step-\d{3,}\.png$/`.
  - `newRunView` sets `workdir: typeof e.workdir === "string" ? e.workdir : ""` and `video: null`.
  - `step:start` initialises the two step fields to `null`, and `step:end` sets them through type and pattern checks.
  - `run:end` sets `video` only for exactly `"video.webm"`, and the `foldPast` fallback does the same.
- [ ] **Step 4: Run it**: `Run: node --test test/runviews.test.ts test/web/store.test.ts test/tui/state.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runviews.ts test/runviews.test.ts && git commit -m "feat: carry validated evidence references in run views"`

### Task 6: Manager overrides and the overrides API

**Files:**
- Modify: `src/runs/manager.ts`, `src/web/api.ts`
- Modify (typecheck fallout, add `video: false, screenshot: false` to `Effective` literals and `inherited` to `TaskSnapshot` literals): `test/tui/fake-manager.ts`, `test/tui/state.test.ts`, `test/tui/keys.test.ts`, `test/tui/form.test.ts`, `test/runs/manager.test.ts`
- Test: `test/runs/manager.test.ts`, `test/web/api.test.ts`

**Contracts:** C5

**Interfaces:**
- Produces:
  - `Overrides.video?: boolean`, `Overrides.screenshot?: boolean`
  - `Effective.video: boolean`, `Effective.screenshot: boolean`
  - `TaskSnapshot.inherited: Effective`
  - `parseOverrides` accepting `video` / `screenshot`

**Checks:** `node --test test/runs/manager.test.ts test/web/api.test.ts test/tui/*.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `manager.test.ts`:
    - `evidence_overrides_reach_run_args`: `setGlobals({ video: true })` and then `setOverrides(1, { screenshot: true })`. The `RunSpec.args` passed to the fake `startRun` for task 1 has `video === true && screenshot === true`, and another task gets `screenshot === false`.
    - `snapshot_inherited_excludes_task_overrides`: with globals `{ video: true }` and task overrides `{ video: false, screenshot: true }`, `snap.effective` has `video: false, screenshot: true` and `snap.inherited` has `video: true, screenshot: false`.
    - `globals_base_has_evidence`: `globals().base` has `video: false, screenshot: false`, or `true` when argv contains `--video`.
  - `api.test.ts`:
    - `parse_overrides_evidence`: `parseOverrides({ video: true, screenshot: false })` deep-equals `{ video: true, screenshot: false }`.
    - `{ video: "yes" }` gives `"video must be true or false"`, and `{ screenshot: 1 }` gives `"screenshot must be true or false"`.
    - `PUT /api/globals` with `{ video: 1 }` gives 400 `{ ok: false, error: "video must be true or false" }`.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/manager.test.ts test/web/api.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - `manager.ts`:
    - Add the fields to the types and `effectiveOf`.
    - `#argsFor(task, own = true)` applies `video`/`screenshot` from each override set, and skips `task.overrides` when `own` is false.
    - `#snapshot` sets `inherited: effectiveOf(this.#argsFor(task, false))`.
  - `api.ts`: two branches like `headed`.
  - Then fix the listed test literals (`fake-manager.ts`'s `snapshot()` gets `inherited` equal to its `effective`).
- [ ] **Step 4: Run it**: `Run: node --test test/runs/manager.test.ts test/web/api.test.ts test/tui/*.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/manager.ts src/web/api.ts test/runs/manager.test.ts test/web/api.test.ts test/tui/fake-manager.ts test/tui/state.test.ts test/tui/keys.test.ts test/tui/form.test.ts && git commit -m "feat: accept video and screenshot overrides"`

### Task 7: Evidence file routes in the web server

**Files:**
- Create: `src/web/evidence.ts`
- Modify: `src/web/server.ts`, `src/web/index.ts`
- Test: `test/web/evidence.test.ts` (new), `test/web/server.test.ts`

**Contracts:** C6

**Interfaces:**
- Produces in `src/web/evidence.ts`:
  - `RUN_ID = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/`
  - `matchEvidence(pathname: string): { runId: string; rel: string; type: "image/png" | "video/webm" } | null`
  - `resolveEvidence(runsDir: string, runId: string, rel: string): string | null`
  - `parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null`
- Produces: `ServerOptions.runsDir?: string`, `StartWebOptions.runsDir?: string` (default `path.resolve("runs")`).

**Checks:** `node --test test/web/evidence.test.ts test/web/server.test.ts test/web/index.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `evidence.test.ts`:
    - `match_evidence_accepts`:
      - `/api/runs/20261008-034720-demo/screenshots/step-001.png` gives `{ runId: "20261008-034720-demo", rel: "screenshots/step-001.png", type: "image/png" }`.
      - `/api/runs/20261008-034720-demo/video.webm` gives `rel: "video.webm"`, `type: "video/webm"`.
    - `match_evidence_rejects`: each of these gives `null`:
      - `/api/runs/../x`, `/api/runs/20261008-034720-demo/screenshots/..%2Fhistory.json`
      - `/api/runs/20261008-034720-demo/history.json`, `/api/runs/20261008-034720-demo/screenshots/step-01.png`
      - `/api/runs/20261008-034720-demo/screenshots/step-001.png/x`, `/api/runs/bad/video.webm`
      - `/api/runs/20261008-034720-Demo/video.webm`, `/api/runs/20261008-034720-demo/video.webm/`
    - `resolve_evidence`: in a temp `runs/` it gives the real path for an existing file, and `null` for a missing file, for a directory named `step-003.png`, and for `screenshots/step-002.png` symlinked to a file outside the run folder.
    - `parse_range_cases` (size 10):
      - `bytes=0-9` gives `{0,9}`, `bytes=5-` gives `{5,9}`, `bytes=-3` gives `{7,9}` and `bytes=0-99` gives `{0,9}`.
      - `bytes=10-` and `bytes=-0` give `"unsatisfiable"`, and `bytes=0-0` with size 0 also gives `"unsatisfiable"`.
      - `undefined`, `"bytes=abc"`, `"bytes=5-2"`, `"bytes=0-1,3-4"` and `"items=0-1"` give `null`.
  - `server.test.ts`:
    - `before()` creates `<tmp>/runs/20261008-034720-demo/` with `screenshots/step-001.png` (bytes `PNGDATA`), `video.webm` (`0123456789`), `history.json`, and the symlink `screenshots/step-002.png` → `<tmp>/secret.txt`, and passes `runsDir`.
    - `server_evidence_png`: GET with the cookie gives 200, `content-type: image/png`, `content-length: 7`, `cache-control: no-store`, `x-content-type-options: nosniff` and body `PNGDATA`. HEAD gives 200 with an empty body.
    - `server_evidence_video_ranges`:
      - A plain GET gives 200 with `accept-ranges: bytes` and the whole body.
      - `Range: bytes=2-4` gives 206, `content-range: bytes 2-4/10` and body `234`.
      - `Range: bytes=20-` gives 416 with `content-range: bytes */10` and an empty body.
      - `Range: bytes=0-1,3-4` gives 200 and the whole file.
    - `server_evidence_traversal_404`: these paths give 404 with body `{"ok":false,"error":"not found"}`:
      - `/api/runs/../x`
      - `/api/runs/20261008-034720-demo/screenshots/..%2Fhistory.json`
      - `/api/runs/20261008-034720-demo/history.json`
      - the symlinked `step-002.png`
      - the missing `step-009.png`
    - `server_evidence_auth_and_method`: no cookie gives 401 `{"ok":false,"error":"unauthorized"}`, and POST with `changing()` headers gives 405 `{"ok":false,"error":"method not allowed"}`.
- [ ] **Step 2: Run it**: `Run: node --test test/web/evidence.test.ts test/web/server.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - `evidence.ts`: as the interfaces state. `parseRange` accepts only `^bytes=(\d*)-(\d*)$`, with a start greater than the end being malformed. `resolveEvidence` takes `realpathSync` of `runsDir`, requires the target's real path to start with `path.join(realRoot, runId) + path.sep`, and requires `statSync(real).isFile()`.
  - `server.ts`, in `handle`, after the redirect branch and before `if (!isApi)`, takes `const rawPath = raw.split("?")[0]`. If it starts with `/api/runs/`, it returns `serveEvidence(req, res, rawPath)`. Routing on the raw path, not `url.pathname`, is what makes `..` a 404.
  - `serveEvidence` checks in this order:
    - The method, so anything but GET or HEAD gets 405.
    - `matchEvidence` and then `resolveEvidence`, either failing gives 404.
    - For the video, `parseRange` decides 206 or 416.
  - It then writes headers (`Content-Type`, `Content-Length`, `Cache-Control: no-store`, `...SECURITY`, plus `Accept-Ranges: bytes` for the video) and streams with `fs.createReadStream(real, { start, end })`. A stream error sends 500 JSON when headers are unsent, otherwise it destroys `res`. HEAD ends without a body.
  - `index.ts` passes `runsDir` through.
- [ ] **Step 4: Run it**: `Run: node --test test/web/evidence.test.ts test/web/server.test.ts test/web/index.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/web/evidence.ts src/web/server.ts src/web/index.ts test/web/evidence.test.ts test/web/server.test.ts && git commit -m "feat: serve screenshots and run video over the web API"`

### Task 8: Web UI: Evidence options, thumbnails, image dialog and video card

**Files:**
- Create: `web/src/evidence.ts`
- Modify: `web/src/dialogs/OptionsDialog.tsx`, `web/src/OptionsStrip.tsx`, `web/src/Timeline.tsx`, `web/src/MainPane.tsx`, `web/src/store.ts`, `web/src/App.tsx`, `web/src/styles.css`
- Test: `test/web/ui-evidence.test.ts` (new), `test/web/store.test.ts`

**Contracts:** C7, C8

**Interfaces:**
- Consumes: `StepView.screenshot/screenshotError`, `RunView.video`, `TaskSnapshot.inherited`, `Globals.base`, `Overrides.video/screenshot`.
- Produces in `web/src/evidence.ts`:
  - `screenshotUrl(runId: string, rel: string): string`, `videoUrl(runId: string): string`
  - `draftToggle(next: boolean, inherited: boolean): boolean | null`
  - `evidenceSummary(e: { video: boolean; screenshot: boolean }): string`
- Produces: `Dialog` variant `{ kind: "image"; src: string; title: string }`.

**Checks:** `node --test test/web/ui-evidence.test.ts test/web/store.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `ui-evidence.test.ts`:
    - `screenshot_url`: `screenshotUrl("20261008-034720-a b", "screenshots/step-001.png") === "/api/runs/20261008-034720-a%20b/screenshots/step-001.png"`, and `videoUrl("r/1") === "/api/runs/r%2F1/video.webm"`.
    - `draft_toggle`: `draftToggle(true, true) === null`, `draftToggle(true, false) === true` and `draftToggle(false, true) === false`.
    - `evidence_summary`: `evidenceSummary({ video: true, screenshot: false }) === " · video on · screenshots off"`.
  - `store.test.ts`: `image_dialog_action`: `reduce(s, { type: "dialog", value: { kind: "image", src: "/api/runs/x/screenshots/step-001.png", title: "Screenshot: step 1" } }).dialog` deep-equals that value, and `{ type: "dialog", value: null }` clears it.
- [ ] **Step 2: Run it**: `Run: node --test test/web/ui-evidence.test.ts test/web/store.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - `web/src/evidence.ts`: the helpers.
  - `store.ts`: the `Dialog` variant.
  - `App.tsx`: for `d?.kind === "image"`, a `Modal wide title={d.title}` holding `<img className="evidence-full" src={d.src} alt={d.title} />`, with a footer `Close` button.
  - `OptionsDialog.tsx`:
    - The `Draft` gains `video: boolean | null` and `screenshot: boolean | null`, initialised from the overrides or `null`.
    - The inherited values are `task ? task.inherited : g.base`.
    - Between the snapshot field and the hint, add `<fieldset className="evidence"><legend>Evidence</legend>` holding two `<label><input type="checkbox" id="opt-video"> Video</label>` / `opt-screenshot` / `Screenshot`. Each is `checked={draft.k ?? inherited.k}` with `onChange` → `draftToggle`.
    - Save adds a key only when its draft is non-null, and "Reset all" sets both to `null`.
  - `OptionsStrip.tsx`: chips `video` and `screenshot` (`on|off`, ✱ when overridden).
  - `Timeline.tsx`:
    - `StepCard` gets `runId` and `dispatch`.
    - In the step body, when `v.screenshot` is set, it renders `<button className="thumb" aria-label="Open screenshot of step N">` holding `<img loading="lazy" alt="Screenshot after step N" src={screenshotUrl(runId, v.screenshot)}>`. Clicking it dispatches the image dialog titled `Screenshot: step N`. A local `failed` state set by `onError` replaces the button with `<div className="muted">screenshot unavailable</div>`.
    - `v.screenshotError` renders `<div className="muted">screenshot failed: {clean(msg)}</div>`.
  - `MainPane.tsx`: under the Outcome card, `{run?.outcome && run.video ? <VideoCard runId={run.runId} /> : null}`, a card with `<b>Video</b>` and `<video controls preload="metadata" src={videoUrl(runId)} />`. The task summary line appends `evidenceSummary(e)`.
  - `styles.css`: `.thumb` (max-width 320px, border, cursor pointer, padding 0, background none; `img` width 100%), `.evidence-full` (max-width 100%, max-height 80vh), and `fieldset.evidence` (border, padding, margin).
- [ ] **Step 4: Run it**: `Run: node --test test/web/ui-evidence.test.ts test/web/store.test.ts && npm run typecheck` / `Expected: PASS` (typecheck includes `web/tsconfig.json`)
- [ ] **Step 5: Commit**: `git add web/src/evidence.ts web/src/dialogs/OptionsDialog.tsx web/src/OptionsStrip.tsx web/src/Timeline.tsx web/src/MainPane.tsx web/src/store.ts web/src/App.tsx web/src/styles.css test/web/ui-evidence.test.ts test/web/store.test.ts && git commit -m "feat: show evidence options, screenshots and video in the web UI"`

### Task 9: TUI evidence fields and rows, plus README

**Files:**
- Modify: `src/tui/form.ts`, `src/tui/detail.ts`, `src/tui/timeline.ts`, `README.md`
- Test: `test/tui/form.test.ts`, `test/tui/app.test.ts`, `test/tui/state.test.ts` (if the `optionsSelected` clamp test hard-codes 3)

**Contracts:** C9 (and the documentation of C1–C4, D25, D26)

**Interfaces:**
- Consumes: `Effective.video/screenshot`, `RunView.workdir/video`, `StepView.screenshot/screenshotError`.
- Produces: `FieldKey` gains `"video" | "screenshot"`. `FIELD_COUNT === 6`.

**Checks:** `node --test test/tui/*.test.ts`, then `npm test`

- [ ] **Step 1: Write the failing tests**
  - `form.test.ts`:
    - `form_evidence_fields`: `openForm(null, EFF, {})` has field keys `["model","maxSteps","headed","snapshot","video","screenshot"]` and labels ending `"video","screenshot"`.
    - On the `video` field, space toggles `raw` to `"true"` with `overridden: true`, ←/→ toggle it back, ctrl+r restores `effective`, and other input is ignored.
    - `formResult` gives `{ video: true }`.
  - `app.test.ts`:
    - `app_timeline_shows_screenshot_rows`: a run with `run:start` `workdir: "runs/x"`. An expanded step whose `step:end` has `screenshot: "screenshots/step-001.png"` renders `shot  runs/x/screenshots/step-001.png`. One with `screenshotError: "boom"` renders `shot error  boom`.
    - `app_end_banner_video`: `run:end` with `video: "video.webm"` renders `video  runs/x/video.webm` after the `History:` line.
    - `app_detail_lists_evidence_settings`: the idle task detail shows `video` and `screenshot` rows with `false`.
    - The options pane shows `video` and `screenshot` rows.
- [ ] **Step 2: Run it**: `Run: node --test test/tui/form.test.ts test/tui/app.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**
  - `form.ts`:
    - Add the keys to `FRONT_MATTER_KEY` (`video`, `screenshot`), `LABELS` and `ORDER`.
    - The toggle branch becomes `if (cur.key === "headed" || cur.key === "video" || cur.key === "screenshot")`.
  - `detail.ts`: two `SETTINGS` entries.
  - `timeline.ts`:
    - `detailRows` gets `workdir` and adds `[label("shot  "), sanitize(\`${workdir}/${v.screenshot}\`)]`, or `shot error  <msg>` in `role.error`, before the `error` row.
    - `banner(o, run, theme)` adds `row(\`video  ${sanitize(\`${run.workdir}/${run.video}\`)}\`)` after `History:` when `run.video` is set.
  - `README.md`:
    - The options table gains `--video` and `--screenshot` rows (default off), and the front-matter table gains the `video` and `screenshot` keys.
    - The Output section describes `screenshots/step-NNN.png`, `video.webm` and the `screenshot` / `screenshot_error` / `video` history keys.
    - The web and TUI paragraphs mention the Evidence group, the thumbnails, the image dialog and the video player.
    - It notes that screenshots and video can show typed codes or any page data, because the 2FA scrubber cannot redact pixels (D25), and that the video follows the page playwright-cli records, not other tabs (D26).
- [ ] **Step 4: Run it**: `Run: node --test test/tui/*.test.ts && npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/tui/form.ts src/tui/detail.ts src/tui/timeline.ts README.md test/tui/form.test.ts test/tui/app.test.ts test/tui/state.test.ts && git commit -m "feat: show evidence settings and paths in the TUI; document evidence"`

## Manual e2e

- [ ] With a real playwright-cli and Claude, run `duckwright -p --video --screenshot "open example.com and report the heading"`. Confirm that `runs/<id>/video.webm` plays, that `screenshots/step-001.png` and the later steps exist, and that the report prints `Video: runs/<id>/video.webm`.
- [ ] Run `duckwright --web` and enable both checkboxes under Evidence. Run a task and watch the thumbnails appear live, open one full size, and play and seek the video after the run ends. Reload and check that the past run shows the same.
- [ ] Optional: `DUCKWRIGHT_UI_SMOKE=1 npm test` after `npm run build`, with new browser assertions for the Evidence fieldset, the thumbnail and the Video card if you want them automated.
