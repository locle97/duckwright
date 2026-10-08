# Video and Screenshot Evidence Options QA Test Plan

**Goal:** Add `--video` and `--screenshot` options so a run records visual evidence (a screenshot per step, one video per run) that the user can review afterwards, with the best experience in web mode.
**Spec:** `docs/superpowers/specs/2026-10-08-video-screenshot-evidence-options-design.md`
**Scope:** Black-box CLI, file, event, HTTP and UI scenarios against the spec's Contracts (C1 to C9). Unit and integration tests are covered by the implementation and are not repeated here.

## Environment

Every scenario runs a real browser through a real `playwright-cli`. Only `claude` is replaced by a scripted stub, so runs are deterministic and free. A thin `playwright-cli` wrapper logs every call and can inject failures, no-ops or delays. Both are found through `PATH`, which is how Duckwright finds `claude` and `playwright-cli`.

- **Tools:** Node >= 22.18, `bash`, `jq`, `curl`, `file` (or any tool that prints PNG dimensions), and a browser (Chrome or Firefox) with DevTools. `playwright-cli` installed as README -> Prerequisites describes, in a version whose `playwright-cli --help` lists `screenshot`, `video-start` and `video-stop`. A desktop session with a display is needed only for TS-14 (headed) and for watching the video.
- **Build gate:** in the branch checkout (`$REPO`), run `npm ci && npm run build`. Then `export DW="node $REPO/dist/bin.js"`.
- **QA workspace:** `export QA_WORK=/tmp/dw-ev QA_DIR=/tmp/dw-ev/out XDG_CONFIG_HOME=/tmp/dw-ev/xdg`, then `mkdir -p $QA_WORK/bin $QA_WORK/scripts $QA_WORK/tasks $QA_WORK/fixtures $QA_DIR $XDG_CONFIG_HOME/duckwright` and `cd $QA_WORK`. Run every `$DW` command from `$QA_WORK`, so runs land in `$QA_WORK/runs/` (the web server's evidence folder is `runs/` in the current directory, D14). `XDG_CONFIG_HOME` keeps your real `duckwright.conf` out of the way.
- **Real playwright-cli:** `export QA_REAL_PW="$(command -v playwright-cli)"` **before** changing `PATH`. Then `export PATH="$QA_WORK/bin:$PATH"`.
- **Fixture server:** `node $QA_WORK/qa-server.mjs` in a second terminal. It serves `http://localhost:8765`.
- **Run a script (print mode):** `QA_SCRIPT=$QA_WORK/scripts/<NAME> $DW -p "QA <NAME>" --session qa-ev --max-steps 6 [flags]`. The stub answers step N with `scripts/<NAME>/N.json`.
- **Locate the run:** after a reset there is one run, so `RUN=$(ls -d $QA_WORK/runs/2*/)` (ends with `/`). `RID=$(basename $RUN)`.
- **Start the web UI:** `$DW --web --port 4173 [flags]` from `$QA_WORK`, with the same `QA_SCRIPT` exported. It prints `http://127.0.0.1:4173/?t=<token>`. Open that URL in the browser and set `TOKEN=<token> PORT=4173` in the shell.
- **API calls:** `C="Cookie: dw_token_$PORT=$TOKEN"`, `O="Origin: http://127.0.0.1:$PORT"`, `B=http://127.0.0.1:$PORT`. Task ids: `curl -s -H "$C" $B/api/state | jq '.tasks[] | {id, name, state}'`.
- **Start the TUI:** `QA_SCRIPT=... $DW [flags]` in a terminal at least 120x40.
- **Accounts / auth:** none for the CLI. The web UI uses the per-launch token above.
- **Reset (before every scenario):** quit any running Duckwright (`q`, or Ctrl-C). Then `rm -rf $QA_WORK/runs $QA_DIR/* $XDG_CONFIG_HOME/duckwright/duckwright.conf && unset QA_PW_FAIL QA_PW_OUT QA_PW_EXIT QA_PW_NOOP QA_PW_SLEEP_ON QA_PW_SLEEP QA_PW_EMPTY_VIDEO QA_CLAUDE_SLEEP`. If a run was interrupted, run `playwright-cli -s=qa-ev close`. Scenarios that need **EVID-RUN** then restore it (Test data).

## Test data

### `bin/claude` (stub; `chmod +x`)

```bash
#!/usr/bin/env bash
# QA stub for `claude -p`: saves the prompt and replays scripted decisions.
# The step counter restarts after a `done`, so sequential runs in one session each start at 1.
set -u
n=$(( $(cat "$QA_DIR/claude.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$QA_DIR/claude.count"
cat > "$QA_DIR/prompt-$n.txt"
[ -n "${QA_CLAUDE_SLEEP:-}" ] && sleep "$QA_CLAUDE_SLEEP"
if [ ! -e "$QA_SCRIPT/$n.json" ]; then echo "qa brain failure" >&2; exit 1; fi
grep -q '"done"' "$QA_SCRIPT/$n.json" && rm -f "$QA_DIR/claude.count"
printf '{"type":"result","is_error":false,"total_cost_usd":0,"structured_output":%s}\n' "$(cat "$QA_SCRIPT/$n.json")"
```

### `bin/playwright-cli` (wrapper; `chmod +x`)

```bash
#!/usr/bin/env bash
# QA wrapper: logs each call (without the -s= flag), injects failures/no-ops/delays on request, else runs the real CLI.
set -u
sub="${*:2}"
printf '%s\n' "$sub" >> "$QA_DIR/pw-calls.log"
if [ -n "${QA_PW_FAIL:-}" ] && [[ "$sub" =~ $QA_PW_FAIL ]]; then
  printf '%b' "${QA_PW_OUT-qa injected failure\n}" >&2; exit "${QA_PW_EXIT:-1}"
fi
if [ -n "${QA_PW_NOOP:-}" ] && [[ "$sub" =~ $QA_PW_NOOP ]]; then exit 0; fi
if [ -n "${QA_PW_SLEEP_ON:-}" ] && [[ "$sub" =~ $QA_PW_SLEEP_ON ]]; then sleep "${QA_PW_SLEEP:-0}"; fi
if [ "${QA_PW_EMPTY_VIDEO:-}" = 1 ] && [ "$sub" = "video-stop" ]; then
  "$QA_REAL_PW" "$@"; d=$(ls -dt "$QA_WORK"/runs/2*/ | head -1); : > "${d}video.webm"; exit 0
fi
exec "$QA_REAL_PW" "$@"
```

Knobs: `QA_PW_FAIL` is a bash regex on the command after the session flag (`^screenshot `, `^video-start `, `^video-stop$`). A match prints `QA_PW_OUT` (default `qa injected failure` + newline; set it to `''` for no output) to stderr and exits `QA_PW_EXIT` (default 1). `QA_PW_NOOP` matches commands that exit 0 without doing anything. `QA_PW_SLEEP_ON` + `QA_PW_SLEEP` delay a command. `QA_PW_EMPTY_VIDEO=1` runs the real `video-stop` and then truncates `video.webm` to 0 bytes.

### `qa-server.mjs`

```js
import http from "node:http";
const page = (t, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><link rel="icon" href="data:,"></head><body><h1>${t}</h1>${extra}</body></html>`;
const pages = {
  "/one.html": page("QA One"),
  "/two.html": page("QA Two"),
  "/tall.html": page("QA Tall", '<div style="height:5000px;background:linear-gradient(red,blue)"></div>'),
};
http.createServer((req, res) => {
  const body = pages[new URL(req.url, "http://x").pathname];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "nf");
}).listen(8765);
```

### Decision files

Each `scripts/<NAME>/N.json` is `{"evaluation_previous_goal":"","memory":"","next_goal":"qa","actions":[<action>]}` with one action:
- `goto X` -> `{"cmd":"goto","args":["http://localhost:8765/X"]}`
- `done` -> `{"cmd":"done","args":["success","qa done"]}`

| Script | 1.json | 2.json | 3.json | Notes |
| --- | --- | --- | --- | --- |
| `A` | goto `one.html` | goto `two.html` | done | 3 steps, passes |
| `T` | goto `tall.html` | done | | 2 steps |
| `E` | *(none)* | | | empty folder: every brain call fails, the run fails |
| `TEN` | goto `one.html` | goto `two.html` | goto `one.html` | 4.json to 9.json alternate `two.html`/`one.html`, 10.json is done: 10 steps |

### Task files

- `tasks/video-on.md`: `---` / `video: true` / `---` / `QA task video on`
- `tasks/both-on.md`: `---` / `video: true` / `screenshot: true` / `---` / `QA task both on`
- `tasks/bad-video.md`: `---` / `video: maybe` / `---` / `QA bad`. The bad value is on line 2.
- `tasks/bad-shot.md`: `---` / `screenshot: 1` / `---` / `QA bad`. Line 2.
- `tasks/dup-video.md`: `---` / `video: true` / `video: false` / `---` / `QA dup`.
- `qa-state.json`: `{"cookies":[],"origins":[]}`.

### Run fixtures (for C6 and C8)

- **EVID-RUN:** made once. After a reset, run Script `A` with `--video --screenshot` (as in TS-2), then `mv $RUN $QA_WORK/fixtures/20261008-090000-qa-evidence`. **Restore** with `mkdir -p runs && cp -a fixtures/20261008-090000-qa-evidence runs/`. Then `EV=$QA_WORK/runs/20261008-090000-qa-evidence`, `ERID=20261008-090000-qa-evidence`, `SIZE=$(stat -c %s $EV/video.webm)`, `PSIZE=$(stat -c %s $EV/screenshots/step-001.png)`.
- **MALFORMED-RUN:** `runs/20261008-091000-qa-malformed/history.json` only (no `events.jsonl`):
  ```json
  {"task":"QA malformed evidence","task_file":null,"success":true,"answer":"ok","steps":1,"cost_usd":0,"video":"../../etc/passwd","history":[{"step":1,"evaluation_previous_goal":"","memory":"","next_goal":"qa","actions":[],"results":[],"screenshot":"../history.json"}]}
  ```
  If the past-run loader rejects this shape, copy step 1 of EVID-RUN's `history.json` instead and set only its `screenshot` to `"../history.json"` and the top-level `video` to `"../../etc/passwd"`.

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C1, C3, C4 | TS-2, TS-3, TS-4, TS-5, TS-12, TS-13, TS-14, TS-20, TS-39 |
| SC2 | C1, C2, C9 | TS-6, TS-7, TS-8, TS-9, TS-10, TS-11, TS-38 |
| SC3 | C5, C7, C9 | TS-27, TS-28, TS-29, TS-30, TS-31, TS-32, TS-33, TS-38 |
| SC4 | C6, C8 | TS-21, TS-22, TS-30, TS-34, TS-35, TS-36, TS-37 |
| SC5 | C1, C3, C4 | TS-1, TS-14, TS-15, TS-16, TS-17, TS-18, TS-19, TS-20, TS-40, TS-41, TS-42 |
| SC6 | C6 | TS-23, TS-24, TS-25, TS-26, TS-37 |
| SC7 | all | TS-0 |

| Contract | Scenarios |
| --- | --- |
| C1 CLI flags | TS-1, TS-2, TS-3, TS-5, TS-6, TS-7, TS-8, TS-9, TS-42 |
| C2 task file / config keys | TS-9, TS-10, TS-11 |
| C3 screenshots | TS-2, TS-3, TS-4, TS-12, TS-14, TS-15, TS-16, TS-17, TS-20, TS-40 |
| C4 video | TS-2, TS-5, TS-13, TS-14, TS-18, TS-19, TS-20 |
| C5 overrides API | TS-27, TS-28, TS-31, TS-32 |
| C6 evidence routes | TS-21 to TS-26, TS-34 |
| C7 web Evidence group | TS-29 to TS-33 |
| C8 web timeline and video | TS-34 to TS-37 |
| C9 TUI | TS-38, TS-39 |

## Scenarios

### TS-0: Build gate: typecheck and test suite pass

**Contract:** all · **Criteria:** SC7 · **Type:** CLI · **Priority:** P1

**Preconditions:** clean checkout of the branch, `npm ci` done.

**Steps:**
1. In `$REPO`, run `npm run typecheck; echo "exit=$?"`.
2. Run `npm test; echo "exit=$?"`.

**Expected:**
- Both print `exit=0`. The live e2e test (`test/e2e.test.ts`) is reported as skipped, not failed.

### TS-1: Both options off by default: nothing extra runs or is written

**Contract:** C1, C3, C4 · **Criteria:** SC5, SC2 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; no `duckwright.conf`.

**Steps:**
1. Run Script `A` with no evidence flags. Note the exit code.
2. Run `grep -cE '^(screenshot|video-)' $QA_DIR/pw-calls.log`.
3. Run `ls $RUN`.
4. Run `jq 'has("video"), [.history[] | has("screenshot") or has("screenshot_error")] | any' $RUN/history.json`.
5. Run `jq -c 'select(.type=="step:end") | .record | [has("screenshot"), has("screenshotError")]' $RUN/events.jsonl` and `jq -c 'select(.type=="run:end") | .outcome | has("video")' $RUN/events.jsonl`.

**Expected:**
- Exit code `0`; stdout has a `History:` line and **no** `Video:` line; stderr has no `warning:` line mentioning screenshot or video.
- Step 2 prints `0`.
- `ls` shows neither `screenshots` nor `video.webm`.
- Step 4 prints `false` then `false`.
- Step 5 prints `[false,false]` for every step, and `false` for `run:end`.

### TS-2: `--video --screenshot` in print mode writes and links all evidence

**Contract:** C1, C3, C4 · **Criteria:** SC1 · **Type:** CLI, File, Event · **Priority:** P1

**Preconditions:** reset.

**Steps:**
1. Run Script `A` with `--video --screenshot`. Save stdout and stderr.
2. Run `ls $RUN/screenshots` and `file $RUN/screenshots/*.png`.
3. Run `jq -c '.history[] | {step, screenshot}' $RUN/history.json` and `jq '.video' $RUN/history.json`.
4. Run `jq -c 'select(.type=="step:end") | .record | {step, screenshot}' $RUN/events.jsonl` and `jq -c 'select(.type=="run:end") | .outcome.video' $RUN/events.jsonl`.
5. Run `stat -c %s $RUN/video.webm` and open `$RUN/video.webm` in the browser (drag the file into a tab).
6. Open `$RUN/screenshots/step-001.png` and `step-002.png`.

**Expected:**
- Exit code `0`. Stdout has `History: runs/<id>/history.json` immediately followed by the line `Video: runs/<id>/video.webm` (the same folder). No `warning:` line on stderr.
- `screenshots/` holds exactly `step-001.png`, `step-002.png`, `step-003.png` (one per entry in `history`, including the `done` step); `file` reports `PNG image data` for each.
- `history.json` steps 1 to 3 have `"screenshot": "screenshots/step-001.png"`, `"screenshots/step-002.png"`, `"screenshots/step-003.png"`; top-level `"video"` is `"video.webm"`.
- The `step:end` records carry the same `screenshot` values; `run:end` outcome `video` is `"video.webm"`.
- `video.webm` is larger than 0 bytes and plays; it shows the page heading `QA One` and later `QA Two`.
- `step-001.png` shows the heading `QA One`; `step-002.png` shows `QA Two`.

### TS-3: Screenshot only, without video

**Contract:** C1, C3 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset.

**Steps:**
1. Run Script `A` with `--screenshot`.
2. Run `grep -cE '^video-' $QA_DIR/pw-calls.log`, `grep -cE '^screenshot --filename=' $QA_DIR/pw-calls.log`, `ls $RUN`, `jq 'has("video")' $RUN/history.json`.

**Expected:**
- Exit `0`, no `Video:` line.
- `0` video calls; `3` screenshot calls, each with an absolute `--filename=` ending in `/screenshots/step-00N.png`, and none containing `--full-page`.
- `ls` shows `screenshots` and no `video.webm`; `has("video")` is `false`.

### TS-4: Screenshot is the viewport, not the full page

**Contract:** C3 · **Criteria:** SC1 · **Type:** File · **Priority:** P3

**Preconditions:** reset; fixture server running.

**Steps:**
1. Run Script `T` with `--screenshot`.
2. Run `file $RUN/screenshots/step-001.png`.

**Expected:**
- The image height is the browser viewport height, well under 5000 px (the page is over 5000 px tall). The top of the gradient and the heading `QA Tall` are visible.

### TS-5: Video only, without screenshots; command order

**Contract:** C1, C4 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; `qa-state.json` exists.

**Steps:**
1. Run Script `A` with `--video --state qa-state.json`.
2. Run `cat $QA_DIR/pw-calls.log`.
3. Run `ls $RUN` and `jq '.video' $RUN/history.json`.

**Expected:**
- Exit `0`; stdout has `Video: runs/<id>/video.webm`.
- In the log, the first `open` line is immediately followed by `video-start <abs path>/runs/<id>/video.webm`, then `state-load ...`. `video-stop` appears exactly once, after the last step's commands and immediately before `close`. No `screenshot` line.
- `ls` shows `video.webm` and no `screenshots`; `.video` is `"video.webm"`.

### TS-6: Last flag of a pair wins

**Contract:** C1 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run Script `A` with `--screenshot --no-screenshot --no-video --video`.
2. Run `ls $RUN`.

**Expected:**
- `ls` shows `video.webm` and no `screenshots` folder. `grep -c '^screenshot' $QA_DIR/pw-calls.log` prints `0`.

### TS-7: A value on the flag is a usage error

**Contract:** C1 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run `$DW -p "x" --video=x; echo "exit=$?"`.
2. Run `$DW -p "x" --screenshot=1; echo "exit=$?"`.
3. Run `$DW -p "x" --no-video=0; echo "exit=$?"`.

**Expected:**
- Step 1 stderr ends with `duckwright: error: argument --video/--no-video: ignored explicit argument 'x'`, `exit=2`.
- Step 2: `duckwright: error: argument --screenshot/--no-screenshot: ignored explicit argument '1'`, `exit=2`.
- Step 3: `duckwright: error: argument --video/--no-video: ignored explicit argument '0'`, `exit=2`.
- No `runs/` folder is created.

### TS-8: `--help` documents both options

**Contract:** C1 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P3

**Steps:**
1. Run `$DW --help`.

**Expected:**
- The usage contains the line `[--video | --no-video] [--screenshot | --no-screenshot]` right after the line with `--network`.
- The options list, after the `--network` entry, contains exactly:
  ```
    --video, --no-video   record one video of the whole run to
                          runs/<id>/video.webm (default off)
    --screenshot, --no-screenshot
                          save a screenshot of the page after every step to
                          runs/<id>/screenshots/ (default off)
  ```

### TS-9: Task-file and config keys, with precedence

**Contract:** C2, C1 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset. Write `$XDG_CONFIG_HOME/duckwright/duckwright.conf` with the single line `screenshot: true`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/A $DW -p -f tasks/video-on.md --session qa-ev --max-steps 6`. Run `ls $RUN`.
2. Reset (keep the config file: re-create it after the reset). Run the same command with `--no-screenshot --no-video` added. Run `ls $RUN`.
3. Reset; write the config as `video: true` and `screenshot: false`. Run `QA_SCRIPT=$QA_WORK/scripts/A $DW -p -f tasks/both-on.md --session qa-ev --max-steps 6`. Run `ls $RUN`.

**Expected:**
- Step 1: `ls` shows `screenshots` (from the config) and `video.webm` (from the task file).
- Step 2: `ls` shows neither (flags override file and config).
- Step 3: `ls` shows both (the task file's `screenshot: true` overrides the config's `false`).

### TS-10: Invalid and duplicate keys

**Contract:** C2 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run `$DW -p -f tasks/bad-video.md; echo "exit=$?"`.
2. Run `$DW -p -f tasks/bad-shot.md; echo "exit=$?"`.
3. Run `$DW -p -f tasks/dup-video.md; echo "exit=$?"`.
4. Write the config as the single line `screenshot: maybe` and run `$DW -p "x"; echo "exit=$?"`.

**Expected:**
- Step 1 stderr contains `bad-video.md:2: video must be true or false, got "maybe"`, `exit=2`.
- Step 2 stderr contains `bad-shot.md:2: screenshot must be true or false, got "1"`, `exit=2`.
- Step 3 stderr contains `"video" is set twice`, `exit=2`.
- Step 4 stderr contains `duckwright.conf:1: screenshot must be true or false, got "maybe"`, `exit=2`.
- No run folder is created in any case.

### TS-11: `duckwright init` writes the commented keys

**Contract:** C2 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset (no config file).

**Steps:**
1. Run `$DW init`.
2. Run `grep -n -A2 '^# network: true' $XDG_CONFIG_HOME/duckwright/duckwright.conf`.

**Expected:**
- The line after `# network: true` is `# video: false`, then `# screenshot: false`.
- All the other default keys the template had before are still present (e.g. `# model:`, `# headed: false`).

### TS-12: Step number padding at 10 steps

**Contract:** C3 · **Criteria:** SC1 · **Type:** File · **Priority:** P3

**Preconditions:** reset.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/TEN $DW -p "QA TEN" --session qa-ev --max-steps 12 --screenshot`.
2. Run `ls $RUN/screenshots | sort`.

**Expected:**
- Exactly `step-001.png` ... `step-009.png`, `step-010.png` (10 files, three-digit padded); step 10 in `history.json` has `"screenshot": "screenshots/step-010.png"`.

### TS-13: Works headed as well as headless

**Contract:** C4, C3 · **Criteria:** SC1, SC5 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; a desktop session.

**Steps:**
1. Run Script `A` with `--headed --video --screenshot`.

**Expected:**
- A browser window is visible during the run. Exit `0`, `Video: runs/<id>/video.webm`, three screenshots, same `history.json` keys as TS-2.

### TS-14: Failed run still records evidence, including brain-error steps

**Contract:** C3, C4 · **Criteria:** SC5, SC1 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run Script `E` with `--video --screenshot`. Note the exit code.
2. Run `jq '.success, (.history | length), [.history[].screenshot], .video' $RUN/history.json` and `ls $RUN/screenshots | wc -l`.
3. Run `jq -c 'select(.type=="run:end") | .outcome | {status, video}' $RUN/events.jsonl`.

**Expected:**
- Exit `1`. `success` is `false`.
- Every history entry has a `screenshot` value `screenshots/step-NNN.png` matching its step number; the PNG count equals the history length.
- `.video` is `"video.webm"`; `run:end` shows `{"status":"fail","video":"video.webm"}`.

### TS-15: Screenshot failure is a warning, not a failure

**Contract:** C3 · **Criteria:** SC5 · **Type:** CLI, File, Event · **Priority:** P2

**Preconditions:** reset; `export QA_PW_FAIL='^screenshot '`.

**Steps:**
1. Run Script `A` with `--screenshot`.
2. Run `jq -c '.history[] | {step, screenshot, screenshot_error}' $RUN/history.json`.
3. Run `jq -c 'select(.type=="run:end") | .outcome | {status, warnings}' $RUN/events.jsonl`.
4. Run `jq -c 'select(.type=="step:end") | .record.screenshotError' $RUN/events.jsonl`.

**Expected:**
- Exit `0`.
- stderr contains `warning: screenshot failed at step 1: qa injected failure`, and the same for steps 2 and 3.
- Each step has no `screenshot` key (jq prints `null`) and `"screenshot_error": "qa injected failure"`. No `screenshots/step-*.png` file exists.
- `run:end` status `pass`, `warnings` includes `screenshot failed at step 1: qa injected failure`, `... step 2: ...`, `... step 3: ...`.
- Each `step:end` record's `screenshotError` is `"qa injected failure"`.

### TS-16: Screenshot error message rules

**Contract:** C3 · **Criteria:** SC5 · **Type:** File · **Priority:** P2

**Preconditions:** reset before each sub-run. `export QA_PW_FAIL='^screenshot '`.

**Steps:**
1. `export QA_PW_OUT="$(printf 'a%.0s' {1..250})\nsecond line\n"`. Run Script `A` with `--screenshot`. Run `jq -r '.history[0].screenshot_error' $RUN/history.json | awk '{print length($0)}'`.
2. Reset. `export QA_PW_OUT="$(printf 'b%.0s' {1..200})\n"`. Repeat; print the value and its length.
3. Reset. `export QA_PW_OUT='' QA_PW_EXIT=3`. Repeat; print `.history[0].screenshot_error`.
4. Reset; `unset QA_PW_FAIL QA_PW_OUT QA_PW_EXIT`; `export QA_PW_NOOP='^screenshot '`. Repeat; print `.history[0].screenshot_error`.

**Expected:**
- Step 1: the value is 200 `a` characters (length `200`), no `second line`.
- Step 2: 200 `b` characters (length `200`, kept whole).
- Step 3: `exit 3`; stderr has `warning: screenshot failed at step 1: exit 3`.
- Step 4: `no file was written`; stderr has `warning: screenshot failed at step 1: no file was written`.
- Every run exits `0`.

### TS-17: Screenshot folder cannot be created

**Contract:** C3 · **Criteria:** SC5 · **Type:** File · **Priority:** P3

**Preconditions:** reset.

**Steps:**
1. Start Script `A` with `--screenshot` and `QA_CLAUDE_SLEEP=5` set (the first step's decision takes 5 s). As soon as `runs/<id>/` appears, run `touch "$(ls -d $QA_WORK/runs/2*/)screenshots"` (a plain file where the folder should go).
2. Wait for the run to end and read `.history[0].screenshot_error`.

**Expected:**
- Exit `0`. Each step has a `screenshot_error` holding the file-system error text (for example containing `EEXIST` or `ENOTDIR`), and stderr has a matching `warning: screenshot failed at step 1: ...` line.

### TS-18: Video start, stop and empty-file failures are warnings

**Contract:** C4 · **Criteria:** SC5 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset before each sub-run.

**Steps:**
1. `export QA_PW_FAIL='^video-start '`. Run Script `A` with `--video`. Check `grep -c '^video-stop' $QA_DIR/pw-calls.log` and `jq 'has("video")' $RUN/history.json`.
2. Reset; `export QA_PW_FAIL='^video-stop$'`. Run Script `A` with `--video`. Check the last two lines of `pw-calls.log` and `has("video")`.
3. Reset; `unset QA_PW_FAIL`; `export QA_PW_EMPTY_VIDEO=1`. Run Script `A` with `--video`. Check `has("video")`.

**Expected:**
- Step 1: exit `0`; stderr `warning: video failed to start: qa injected failure`; `0` `video-stop` calls; `false`; no `Video:` line.
- Step 2: exit `0`; stderr `warning: video failed to stop: qa injected failure`; the log ends with `video-stop` then `close`; `false`; no `Video:` line.
- Step 3: exit `0`; stderr `warning: video was not saved: video.webm is missing or empty`; `false`; no `Video:` line; `run:end` outcome has no `video`.

### TS-19: `video-stop` timeout is 60 s

**Contract:** C4 · **Criteria:** SC5 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset before each sub-run. `export QA_PW_SLEEP_ON='^video-stop$'`.

**Steps:**
1. `export QA_PW_SLEEP=45`. Run Script `A` with `--video`. Check `jq '.video' $RUN/history.json`.
2. Reset; `export QA_PW_SLEEP=75`. Run the same; time it with `time`.

**Expected:**
- Step 1 (over the 30 s default, under 60 s): `.video` is `"video.webm"`, no warning.
- Step 2: the run ends roughly 60 s after the last step, exit `0`; stderr has one line starting `warning: video failed to stop:`; `history.json` has no `video` key; the log shows `close` after `video-stop`.

### TS-20: Interrupt (Ctrl-C) still saves the video and recorded evidence

**Contract:** C3, C4 · **Criteria:** SC5, SC1 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `export QA_PW_SLEEP_ON='^screenshot ' QA_PW_SLEEP=20`.

**Steps:**
1. Run Script `A` with `--video --screenshot` in the foreground. While step 2's screenshot is pending (about 25 s in, after `step-001.png` exists), press Ctrl-C once.
2. Note the exit code; run `tail -3 $QA_DIR/pw-calls.log`, `jq '.video, [.history[].screenshot]' $RUN/history.json`, `jq -c 'select(.type=="run:end") | .outcome | {status, exitCode, video}' $RUN/events.jsonl`.

**Expected:**
- Exit `130`.
- The log has `video-stop` followed by `close`.
- `.video` is `"video.webm"` and `video.webm` is non-empty and plays; step 1's `screenshot` is `screenshots/step-001.png`.
- `run:end` is `{"status":"stop","exitCode":130,"video":"video.webm"}`.

### TS-21: Evidence routes serve a screenshot and the video

**Contract:** C6 · **Criteria:** SC4 · **Type:** API · **Priority:** P1

**Preconditions:** reset; restore EVID-RUN; start the web UI (no flags).

**Steps:**
1. `curl -s -D - -o /tmp/dw-ev/out/s.png -H "$C" $B/api/runs/$ERID/screenshots/step-001.png`, then `cmp /tmp/dw-ev/out/s.png $EV/screenshots/step-001.png`.
2. `curl -s -I -H "$C" $B/api/runs/$ERID/screenshots/step-001.png`.
3. `curl -s -D - -o /tmp/dw-ev/out/v.webm -H "$C" $B/api/runs/$ERID/video.webm`, then `cmp` with `$EV/video.webm`.
4. `curl -s -I -H "$C" $B/api/runs/$ERID/video.webm`.

**Expected:**
- Step 1: `200`, `Content-Type: image/png`, `Content-Length: $PSIZE`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, the existing `Content-Security-Policy`; `cmp` prints nothing.
- Step 2: same status and headers, no body.
- Step 3: `200`, `Content-Type: video/webm`, `Content-Length: $SIZE`, `Accept-Ranges: bytes`, `Cache-Control: no-store`; `cmp` prints nothing.
- Step 4: same headers, no body.

### TS-22: Video range requests

**Contract:** C6 · **Criteria:** SC4 · **Type:** API · **Priority:** P2

**Preconditions:** as TS-21.

**Steps:**
1. `curl -s -D - -o r1 -H "$C" -H "Range: bytes=0-9" $B/api/runs/$ERID/video.webm`; `wc -c r1`.
2. Same with `Range: bytes=5-`.
3. Same with `Range: bytes=-3`.
4. Same with `Range: bytes=$SIZE-` (one past the last byte).
5. Same with `Range: bytes=abc`.
6. Same with `Range: bytes=0-1,4-5`.
7. Same as step 1 on `.../screenshots/step-001.png`.

**Expected:**
- Step 1: `206`, `Content-Range: bytes 0-9/$SIZE`, 10 bytes equal to the file's first 10.
- Step 2: `206`, `Content-Range: bytes 5-<SIZE-1>/$SIZE`, `SIZE-5` bytes.
- Step 3: `206`, `Content-Range: bytes <SIZE-3>-<SIZE-1>/$SIZE`, 3 bytes equal to the file's last 3.
- Step 4: `416`, `Content-Range: bytes */$SIZE`, empty body.
- Steps 5 and 6: `200`, the whole file (`$SIZE` bytes).
- Step 7: `200`, the whole PNG (`$PSIZE` bytes), no `Content-Range`.

### TS-23: Paths outside the patterns or run folder are 404

**Contract:** C6 · **Criteria:** SC6 · **Type:** API · **Priority:** P1

**Preconditions:** as TS-21. Also `cp $EV/screenshots/step-001.png $EV/screenshots/step-01.png`, and `cp $EV/screenshots/step-001.png $EV/screenshots/step-1000.png`.

**Steps:** for each path, run `curl -s --path-as-is -w ' %{http_code}\n' -H "$C" "$B<path>"`:
1. `/api/runs/../x`
2. `/api/runs/$ERID/screenshots/..%2Fhistory.json`
3. `/api/runs/$ERID/screenshots/../history.json`
4. `/api/runs/$ERID/history.json`
5. `/api/runs/$ERID/events.jsonl`
6. `/api/runs/$ERID/screenshots/step-01.png` (file exists, name too short)
7. `/api/runs/$ERID/screenshots/step-001.jpg`
8. `/api/runs/$ERID/screenshots/x/step-001.png`
9. `/api/runs/$ERID/video.webm/extra`
10. `/api/runs/QA_bad/video.webm`
11. `/api/runs/%2e%2e/video.webm`
12. `/api/runs/$ERID/screenshots/step-999.png` (missing file)
13. `/api/runs/20261008-095959-nope/video.webm` (missing run)
14. `/api/runs/$ERID/screenshots/step-1000.png`

**Expected:**
- Steps 1 to 13 each print `{"ok":false,"error":"not found"} 404`; no file contents leak.
- Step 14 prints PNG bytes and `200` (four-digit step names are valid).

### TS-24: Symlinks out of the run folder and non-files are refused

**Contract:** C6 · **Criteria:** SC6 · **Type:** API · **Priority:** P2

**Preconditions:** as TS-21. `ln -s /etc/hostname $EV/screenshots/step-900.png`; `ln -s $QA_WORK/fixtures/20261008-090000-qa-evidence/video.webm $EV/screenshots/step-901.png`; `mkdir $EV/screenshots/step-902.png`; create a second copy `cp -a $EV runs/20261008-090500-qa-dirvideo && rm runs/20261008-090500-qa-dirvideo/video.webm && mkdir runs/20261008-090500-qa-dirvideo/video.webm`.

**Steps:**
1. GET `/api/runs/$ERID/screenshots/step-900.png`.
2. GET `/api/runs/$ERID/screenshots/step-901.png`.
3. GET `/api/runs/$ERID/screenshots/step-902.png`.
4. GET `/api/runs/20261008-090500-qa-dirvideo/video.webm`.

**Expected:**
- Every step returns `404` `{"ok":false,"error":"not found"}`.

### TS-25: Only authorized callers reach evidence routes

**Contract:** C6 · **Criteria:** SC6 · **Type:** API · **Priority:** P2

**Preconditions:** as TS-21.

**Steps:**
1. `curl -s -w ' %{http_code}' $B/api/runs/$ERID/video.webm` (no cookie).
2. `curl -s -w ' %{http_code}' -H "Cookie: dw_token_$PORT=wrong" $B/api/runs/$ERID/screenshots/step-001.png`.
3. `curl -s -o /dev/null -w '%{http_code}' -H "$C" -H "Host: evil.example:$PORT" $B/api/runs/$ERID/video.webm`.
4. `curl -s -o /dev/null -w '%{http_code}' -H "$C" $B/api/runs/$ERID/video.webm` (allowed caller).

**Expected:**
- Steps 1 and 2: `{"ok":false,"error":"unauthorized"} 401`.
- Step 3: `403`.
- Step 4: `200`.

### TS-26: Wrong methods are refused

**Contract:** C6 · **Criteria:** SC6 · **Type:** API · **Priority:** P2

**Preconditions:** as TS-21.

**Steps:**
1. `curl -s -w ' %{http_code}' -X POST -H "$C" -H "$O" $B/api/runs/$ERID/video.webm`.
2. `curl -s -w ' %{http_code}' -X DELETE -H "$C" -H "$O" $B/api/runs/$ERID/screenshots/step-001.png`.
3. `ls $EV/screenshots/step-001.png`.

**Expected:**
- Steps 1 and 2: `{"ok":false,"error":"method not allowed"} 405`.
- The file still exists.

### TS-27: Overrides API accepts evidence booleans

**Contract:** C5 · **Criteria:** SC3 · **Type:** API · **Priority:** P1

**Preconditions:** reset; start the web UI (no flags); add one task in the UI (`i`, type `QA web A`, Enter); note its id as `TID`.

**Steps:**
1. `curl -s -X PUT -H "$C" -H "$O" -H 'Content-Type: application/json' -d '{"video":true,"screenshot":false}' $B/api/globals`.
2. `curl -s -H "$C" $B/api/state | jq -c '.globals | {o: .overrides, b: {video: .base.video, screenshot: .base.screenshot}}'`.
3. `curl -s -X PUT ... -d '{"screenshot":true}' $B/api/tasks/$TID/overrides`.
4. `curl -s -H "$C" $B/api/state | jq -c ".tasks[] | select(.id==$TID) | {overrides, e: {video: .effective.video, screenshot: .effective.screenshot}, i: {video: .inherited.video, screenshot: .inherited.screenshot}}"`.
5. `curl -s -X PUT ... -d '{}' $B/api/globals`, then step 2 again.

**Expected:**
- Steps 1 and 3: `{"ok":true}` (status 200).
- Step 2: `{"o":{...,"video":true,"screenshot":false},"b":{"video":false,"screenshot":false}}`.
- Step 4: `overrides` contains `"screenshot":true` and no `video`; `e` is `{"video":true,"screenshot":true}`; `i` is `{"video":true,"screenshot":false}` (globals included, task's own override left out).
- Step 5: `o` has neither `video` nor `screenshot`.

### TS-28: Overrides API rejects non-booleans and unknown tasks

**Contract:** C5 · **Criteria:** SC3 · **Type:** API · **Priority:** P2

**Preconditions:** as TS-27.

**Steps:**
1. PUT `/api/globals` with `{"video":"yes"}`.
2. PUT `/api/globals` with `{"screenshot":1}`.
3. PUT `/api/tasks/$TID/overrides` with `{"video":null}`.
4. PUT `/api/tasks/99999/overrides` with `{"video":true}`.
5. PUT `/api/globals` with `{"headed":"x"}` (regression).

**Expected:**
- Step 1: `400` `{"ok":false,"error":"video must be true or false"}`.
- Step 2: `400` `{"ok":false,"error":"screenshot must be true or false"}`.
- Step 3: `400` `{"ok":false,"error":"video must be true or false"}`.
- Step 4: `404` with error `no such task`.
- Step 5: `400` `{"ok":false,"error":"headed must be true or false"}`.
- `/api/state` globals overrides are unchanged by steps 1 to 3.

### TS-29: Global options dialog shows the Evidence group

**Contract:** C7 · **Criteria:** SC3 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; no config; start the web UI (no flags); open the URL.

**Steps:**
1. Open the Global options dialog.
2. Inspect the group with DevTools.

**Expected:**
- Between the snapshot mode field and the hint text there is a group with the legend `Evidence` holding two checkboxes labelled `Video` and `Screenshot`, ids `opt-video` and `opt-screenshot`, both unchecked.
- The options strip shows the chips `video: off` and `screenshot: off`, without ✱.

### TS-30: Turning evidence on in the web UI applies to the next run

**Contract:** C7, C5, C3, C4, C6, C8 · **Criteria:** SC3, SC4 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; `export QA_SCRIPT=$QA_WORK/scripts/A`; start the web UI (no flags); open the URL; DevTools Network tab open.

**Steps:**
1. Open the Global options dialog, check `Video` and `Screenshot`, click Save.
2. Look at the strip and the task card line. Run `curl -s -H "$C" $B/api/state | jq -c '.globals.overrides'`.
3. Add task `QA web A` (`i`, type, Enter) and start it from its card.
4. When it finishes, run `ls $QA_WORK/runs/2*/`.

**Expected:**
- The PUT to `/api/globals` has a body with `"video":true` and `"screenshot":true`; the dialog closes.
- The strip shows `video: on ✱` and `screenshot: on ✱`. The task card's settings line ends with ` · video on · screenshots on`.
- `globals.overrides` has `"video":true,"screenshot":true`.
- The run folder has `screenshots/step-001.png` to `step-003.png` and `video.webm`.

### TS-31: Checkbox inherit semantics and Reset all

**Contract:** C7, C5 · **Criteria:** SC3 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; write the config with `video: true`; start the web UI (no flags).

**Steps:**
1. Open Global options. Observe both boxes.
2. Uncheck `Video`, Save. Check the strip and `globals.overrides` via `/api/state`.
3. Reopen, check `Video` (back to the inherited value), Save. Check the strip and `globals.overrides`.
4. Reopen, check `Screenshot`, uncheck `Video`, then click `Reset all` and Save. Check `globals.overrides`.

**Expected:**
- Step 1: `Video` checked, `Screenshot` unchecked; strip `video: on` and `screenshot: off`, no ✱.
- Step 2: strip `video: off ✱`; `globals.overrides.video` is `false`.
- Step 3: the PUT body has no `video` key; `globals.overrides` has no `video`; strip `video: on` without ✱.
- Step 4: after Reset all both boxes show the inherited values (`Video` checked, `Screenshot` unchecked); `globals.overrides` has neither key.

### TS-32: Per-task Evidence options show inherited values and override them

**Contract:** C7, C5 · **Criteria:** SC3 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; `export QA_SCRIPT=$QA_WORK/scripts/A`; start the web UI; in Global options check `Screenshot` and Save; add task `QA web B` (`i`, type, Enter), id `TID`.

**Steps:**
1. Open the task's Options dialog.
2. Uncheck `Screenshot`, check `Video`, Save.
3. Read `/api/state` for task `TID`: `overrides`, `effective`, `inherited`.
4. Start the task; when done, `ls` its run folder.

**Expected:**
- Step 1: the dialog has the `Evidence` group; `Screenshot` is checked (inherited from globals) and `Video` unchecked.
- Step 2: the dialog closes; the task card line ends with ` · video on · screenshots off`.
- Step 3: `overrides` has `"video":true,"screenshot":false`; `effective` has `video: true, screenshot: false`; `inherited` has `video: false, screenshot: true`.
- Step 4: `video.webm` exists, no `screenshots` folder.

### TS-33: Saving fails: dialog stays open with the server's error

**Contract:** C7 · **Criteria:** SC3 · **Type:** UI · **Priority:** P3

**Preconditions:** as TS-32 before step 1, task not running.

**Steps:**
1. Open the task's Options dialog and check `Video`.
2. In a shell, `curl -s -X DELETE -H "$C" -H "$O" $B/api/tasks/$TID`.
3. Click Save in the dialog.

**Expected:**
- The dialog stays open and its error paragraph shows `no such task`.

### TS-34: Live run: thumbnails per step, Video card only after the end

**Contract:** C8, C6 · **Criteria:** SC4 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; `export QA_SCRIPT=$QA_WORK/scripts/A QA_CLAUDE_SLEEP=6`; start `$DW --web --port 4173 --video --screenshot`; open the URL; add task `QA live` and start it; select it with Follow on. DevTools Console open.

**Steps:**
1. While steps run, watch the live (expanded) step.
2. While the run is live, look under the Result area.
3. After the run ends, look again.
4. Play the video and drag the seek bar to the middle.

**Expected:**
- After each step ends, its body shows a thumbnail button holding an `<img>` with `alt="Screenshot after step N"` (N = the step), `loading="lazy"`, src `/api/runs/<runId>/screenshots/step-00N.png`, at most 320 px wide.
- While live, no `Video` card exists.
- After `run:end`, a card titled `Video` appears under the Result card, holding `<video controls preload="metadata">` with src `/api/runs/<runId>/video.webm`.
- The video plays and seeks (DevTools Network shows a `206` for the video). The Console shows no Content-Security-Policy violation for images or media.

### TS-35: Full-size screenshot dialog

**Contract:** C8 · **Criteria:** SC4 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; restore EVID-RUN; start the web UI; History tab; select `QA A` past run (EVID-RUN's task); expand step 2 (`E` expands all).

**Steps:**
1. Click step 2's thumbnail.
2. Press Esc.
3. Tab to step 1's thumbnail and press Enter; close with the Close button.
4. Tab to step 1's thumbnail and press Space; press Esc.

**Expected:**
- Step 1: a dialog titled `Screenshot: step 2` opens with the full-size image (heading `QA Two` visible), no wider than the window and at most 80% of its height.
- Step 2: the dialog closes; the timeline is still shown.
- Steps 3 and 4: a dialog titled `Screenshot: step 1` opens and closes the same way.

### TS-36: Past run shows thumbnails and the video straight away

**Contract:** C8 · **Criteria:** SC4 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; restore EVID-RUN; start the web UI.

**Steps:**
1. In History, select EVID-RUN's run and expand all steps.
2. Remove `$EV/events.jsonl`, restart the web UI, and repeat step 1 (history.json fallback).

**Expected:**
- Step 1: run steps 1, 2 and 3 each show a thumbnail with `alt="Screenshot after step N"`; a `Video` card with a playable `<video controls preload="metadata">` is shown under the Result card at once.
- Step 2: the same thumbnails and Video card are shown.

### TS-37: Error, unavailable, off and malformed states in the timeline

**Contract:** C8 · **Criteria:** SC4, SC6 · **Type:** UI · **Priority:** P2

**Preconditions:** reset. Make two runs one after the other (no reset between), then restore EVID-RUN and add MALFORMED-RUN:
- `QA_PW_FAIL='^screenshot ' QA_SCRIPT=$QA_WORK/scripts/A $DW -p "QA SHOTFAIL" --session qa-ev --max-steps 6 --screenshot` (run SHOTFAIL).
- `QA_SCRIPT=$QA_WORK/scripts/A $DW -p "QA OFF" --session qa-ev --max-steps 6` (run OFF).
- Then `rm $EV/screenshots/step-002.png`.
Start the web UI with DevTools Network open.

**Steps:**
1. Select SHOTFAIL in History; expand all.
2. Select OFF; expand all.
3. Select EVID-RUN; expand all.
4. Select MALFORMED-RUN (`QA malformed evidence`); expand all; filter Network by `/api/runs/`.

**Expected:**
- Step 1: each step shows the muted line `screenshot failed: qa injected failure`; no thumbnail.
- Step 2: no thumbnail, no `screenshot failed` line, no `Video` card.
- Step 3: step 2's thumbnail is replaced by the muted text `screenshot unavailable`; steps 1 and 3 still show thumbnails; the Video card is still shown.
- Step 4: no thumbnail, no `Video` card, and no request to any `/api/runs/...` URL.

### TS-38: TUI evidence settings

**Contract:** C9 · **Criteria:** SC2, SC3 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; `export QA_SCRIPT=$QA_WORK/scripts/A`; start the TUI with no flags; add a task `QA tui` with the TUI's add-task key (listed under `?`), without starting it.

**Steps:**
1. Press `O` (global options); find the `video` and `screenshot` rows.
2. On `video`, press space; on `screenshot`, press `→`; then on `screenshot` press `←`.
3. On `video`, press ctrl+r.
4. Select the task, press `o`; set `screenshot` to `true`; save.
5. Look at the idle task detail.

**Expected:**
- Step 1: rows `video` and `screenshot` show `false`, listed after the existing fields.
- Step 2: `video` shows `true`; `screenshot` toggles to `true` then back to `false`.
- Step 3: `video` returns to `false` (no override).
- Step 4: the form has `video` and `screenshot` rows toggling the same way.
- Step 5: the detail lists `video` `false` and `screenshot` `true`.

### TS-39: TUI shows screenshot and video paths

**Contract:** C9 · **Criteria:** SC1 · **Type:** UI · **Priority:** P3

**Preconditions:** reset; `export QA_SCRIPT=$QA_WORK/scripts/A`.

**Steps:**
1. Run `$DW --video --screenshot "QA tui run"`; when it ends, press `e` to expand all steps.
2. Quit. Reset. `export QA_PW_FAIL='^screenshot '`; run `$DW --screenshot "QA tui fail"`; press `e`.

**Expected:**
- Step 1: each expanded step shows `shot  <abs workdir>/screenshots/step-00N.png`; the result lines include `video  <abs workdir>/video.webm`. No image is drawn.
- Step 2: each step shows `shot error  qa injected failure` in red; no `video` row.

## Regression

### TS-40: Evidence never reaches the model's prompts

**Contract:** C3 (out-of-scope guard) · **Criteria:** SC5 · **Type:** File · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run Script `A` with `--video --screenshot`.
2. Run `grep -lE 'screenshots/|step-00[0-9]\.png|video\.webm|screenshot_error|screenshotError' $QA_DIR/prompt-*.txt`.

**Expected:**
- Step 2 prints nothing.

### TS-41: `duckwright export` ignores evidence

**Contract:** C3, C4 (out-of-scope guard) · **Criteria:** SC5 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; run Script `A` with `--video --screenshot`.

**Steps:**
1. Run `$DW export $RUN; echo "exit=$?"`.
2. Run `grep -cE 'screenshots/|video\.webm' $RUN/duckwright.spec.ts`.

**Expected:**
- `exit=0`, the spec is written; step 2 prints `0`. The spec has the same `goto` steps as one exported from a run without evidence flags.

### TS-42: Existing flags, network capture and web routes are unchanged

**Contract:** C1, C6 · **Criteria:** SC5 · **Type:** CLI, API · **Priority:** P3

**Preconditions:** reset.

**Steps:**
1. Run `$DW -p x --headed=1; echo "exit=$?"`.
2. Run Script `A` with `--video --screenshot --no-network`, then `ls $RUN`.
3. Start the web UI; `curl -s -o /dev/null -w '%{http_code}' -H "$C" $B/api/state`; `curl -s -o /dev/null -w '%{http_code}' -H "$C" $B/`.

**Expected:**
- Step 1: `duckwright: error: argument --headed/--no-headed: ignored explicit argument '1'`, `exit=2` (format unchanged).
- Step 2: `ls` shows `screenshots` and `video.webm` and no `network` folder.
- Step 3: `200` and `200`.

## Out of scope

- Unit and integration tests (run as checks during implementation)
- Feeding screenshots to the model (only TS-40 checks that it does not happen)
- Rendering images in the terminal
- Video editing, GIF export, chapters, action overlays, per-action screenshots
- Evidence in exported specs or `duckwright export` (only TS-41 checks it is ignored)
- Full-page screenshots, configurable formats or sizes, recording tabs other than the recorded one (D26)
- Redacting secrets from images or video (D25)
- Disk-space limits or cleanup of evidence
- `network` as a web/TUI override
- Screenshot timeout (30 s) and step numbers of 1000 or more in a real run (covered by unit tests; TS-23 checks the route accepts `step-1000.png`)
