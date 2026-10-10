# Exploration mode (`duckwright explore <url>`) QA Test Plan

**Goal:** `duckwright explore <url>` wanders a site with no fixed task, reports broken links, console errors and dead-end flows, and can write task files for the flows that worked.
**Spec:** docs/superpowers/specs/2026-10-10-exploration-mode-explore-design.md
**Scope:** Black-box CLI/file scenarios against the spec's Contracts. Unit and integration tests are covered by the implementation and are not repeated here.

## Environment
- Start: `npm ci && npm run build`, then run `node dist/bin.js explore <url> [options]` (the `duckwright` bin) from a scratch directory `$WORK`. Run folders appear under `$WORK/runs/`, task files under `$WORK/tasks/`. `playwright-cli` must be on PATH. A real `claude` login is needed only for the scenarios marked **real agent** (TS-1, TS-2, TS-3 smoke); every other scenario uses the scripted `claude` stub below, so results are deterministic.
- Site under test: `python3 -m http.server 8000` run from `$WORK/site` (fixtures below) at `http://localhost:8000/`. Browser is headless (default).
- Config location: the global config is `$XDG_CONFIG_HOME/duckwright/duckwright.conf` (flat `key: value` lines). In every scenario export `XDG_CONFIG_HOME=$WORK/xdg` so QA controls it; with no file there, no config applies.
- Scripted agent (**STUB**): an executable `$WORK/stub/claude` (Node script, `chmod +x`) put first on PATH (`PATH=$WORK/stub:$PATH`). It behaves as the `claude -p --output-format json` CLI: `--version` prints `2.0.0 (Claude Code)`; any other call reads stdin, increments a counter file `$WORK/stub/n`, and prints one JSON envelope `{"total_cost_usd":0,"is_error":false,"structured_output":{"evaluationPreviousGoal":"","memory":"","nextGoal":"","actions":[...]}}` where `actions` is:
  - call 1 (and every call when `STUB_NEVER_DONE=1`): `[{"cmd":"goto","args":["$STUB_URL"]}]`
  - later calls: `[{"cmd":"done","args":["success","<contents of file $STUB_ANSWER>"]}]`; if `STUB_HOOK` is set, the stub first runs that shell command (cwd `$WORK`) on the done call.
  `$STUB_URL` defaults to `http://localhost:8000/`. Reset the counter (`rm -f $WORK/stub/n`) before each run.
- Reset between scenarios: `rm -rf $WORK/tasks $WORK/runs $WORK/xdg $WORK/stub/n`; keep the http server running.

## Test data
- **SITE** (`$WORK/site`):
  - `index.html`: links to `/about.html`, `/missing.html` (does not exist, 404), `/dead.html`, `/errors.html`; an `<img src="/gone.png">` (404).
  - `about.html`: heading "About us", link back to `/`. No console errors, no failed requests.
  - `dead.html`: heading "Dead end", a form with a button that does nothing.
  - `errors.html`: inline script `console.error("boom from errors page")`.
  - `short.html`: `console.error("short-END")`.
  - `long501.html`: `console.error("L" + "x".repeat(497) + "END")` (a 501-character message).
  - `errs50.html`: `for (let i = 1; i <= 50; i++) console.error("e" + i)`.
  - `errs51.html`: same loop to 51.
- **URL_OK** = `http://localhost:8000/`
- **BAD_URLS**: `ftp://localhost/`, `localhost:8000`, `not a url`, `file:///etc/hosts`.
- **CONFIG12**: `$WORK/xdg/duckwright/duckwright.conf` containing the single line `max-steps: 12`.
- **TASKFILE**: any task file `$WORK/t.md`.
- **Scripted answers** (`$STUB_ANSWER` files in `$WORK/answers/`):
  - **A_MIX**: `{"flows":[` F1 `{"title":"Read about us","start_url":"/about.html","steps":["Open the About link","Read the heading"],"expected":"Heading About us is visible","status":"ok","notes":""}`, F2 `{"title":"Bare flow","start_url":"http://localhost:8000/","steps":[],"expected":"","status":"ok","notes":""}`, F3 `{"title":"Multi\nline title","start_url":"http://localhost:8000/about.html","steps":["step one\nsecond line"],"expected":"line a\nline b","status":"ok","notes":""}`, F4 `{"title":"Dead page","start_url":"/dead.html","steps":["Click the button"],"expected":"Something happens","status":"dead-end","notes":"Button does nothing"}`, F5 `{"title":"Missing page","start_url":"/missing.html","steps":["Click Missing"],"expected":"A page","status":"broken","notes":""}`, then two invalid items `{"title":"","start_url":"/","status":"ok"}` and `{"title":"Bad status","start_url":"/","status":"weird"}` `]}`.
  - **A_NOJSON**: `all done, nothing to report`
  - **A_BADJSON**: `{"flows": [}`
  - **A_NOFLOWS**: `{"items":[]}`
  - **A_EMPTY**: `{"flows":[]}`

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C1, C3, C4, C5 | TS-1, TS-2, TS-3, TS-4, TS-5, TS-6 |
| SC2 | C2, C4, C5 | TS-7, TS-8, TS-9, TS-10, TS-29, TS-30, TS-31 |
| SC3 | C3, C4, C5 | TS-11, TS-12, TS-13, TS-32, TS-33, TS-34, TS-35 |
| SC4 | C6 | TS-14, TS-15, TS-16, TS-17, TS-36, TS-37 |
| SC5 | C1 | TS-18, TS-19, TS-20, TS-21, TS-22, TS-25, TS-38, TS-39, TS-40, TS-41, TS-42, TS-43, TS-44 |
| SC6 | C1 | TS-23 |
| SC7 | README | TS-24 |
| Regression | Surfaces that must not change | TS-26, TS-27, TS-28 |

## Scenarios

### TS-1: Explore run prints and saves the report (real agent)
**Contract:** C1, C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; `$WORK` clean; real `claude` login; no STUB on PATH.
**Steps:**
1. In `$WORK`, run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Step lines are printed, then `Result:`, `Answer:`, `Steps: … Cost: …`, `History:` lines, no `Test:` line, a blank line, then markdown starting `# Exploration report: http://localhost:8000/`.
- The markdown has, in order, the headings `## Broken links and failed requests (<n>)`, `## Console errors (<n>)`, `## Dead ends and broken flows (<n>)`, `## Flows that worked (<n>)`.
- The last lines are `Report: <run dir>/explore.md` and `Data: <run dir>/explore.json`; both files exist.
- Exit code equals the `Result` (0 for `done success`).

### TS-2: explore.md matches the printed report
**Contract:** C5 · **Criteria:** SC1 · **Type:** File · **Priority:** P1
**Preconditions:** TS-1 finished.
**Steps:**
1. Compare `<run dir>/explore.md` with the markdown block printed after the blank line in TS-1.
**Expected:**
- The text is identical. The second line of the report reads `Run: <run_dir>  Steps: <steps>  Cost: $<4 decimals>  Result: <success|failure>`.

### TS-3: explore.json has exactly the C4 keys
**Contract:** C4 · **Criteria:** SC1 · **Type:** File · **Priority:** P1
**Preconditions:** TS-1 finished.
**Steps:**
1. Read `<run dir>/explore.json`.
**Expected:**
- Valid JSON, 2-space indent, trailing newline.
- Keys exactly: `version` (1), `url` ("http://localhost:8000/"), `run_dir`, `success`, `steps`, `cost_usd`, `network_checked` (true), `failed_requests`, `console_errors`, `answer_error`, `dropped_flows`, `broken_flows`, `working_flows`.
- `success`, `steps`, `cost_usd` equal the same fields in the run's `history.json`.

### TS-4: Default step budget is 40 even with a config max-steps
**Contract:** C1, C3 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; CONFIG12 present; STUB on PATH with `STUB_NEVER_DONE=1`.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
2. Read `steps` in the run's `history.json`.
**Expected:**
- The run stops after exactly 40 steps (`steps` is 40, not 12); exit code 1; the report is printed with `Steps: 40`.

### TS-5: --max-steps overrides the default
**Contract:** C1 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2
**Preconditions:** as TS-4 (CONFIG12 present, `STUB_NEVER_DONE=1`).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 10`.
**Expected:**
- `history.json` `steps` is 10; exit code 1; the report line reads `Steps: 10`.

### TS-6: The exploration task text reaches the agent
**Contract:** C3 · **Criteria:** SC1 · **Type:** File · **Priority:** P2
**Preconditions:** STUB with `STUB_ANSWER` = A_EMPTY.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
2. Read the `task` field of `<run dir>/history.json`.
**Expected:**
- It equals the C3 text with `<URL>` = `http://localhost:8000/` and `<HOST>` = `localhost:8000`; in particular it begins `Explore the website at http://localhost:8000/ like a curious first-time visitor.`, contains `Stay on the host localhost:8000.`, `Start with goto http://localhost:8000/.`, `You do not need expect checks in this task.`, the JSON example `{"flows":[{"title":"Search products",...`, and the words `ok`, `dead-end`, `broken`.

### TS-7: Failed requests are reported
**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; STUB (`STUB_URL` = URL_OK, `STUB_ANSWER` = A_EMPTY).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Section `## Broken links and failed requests (1)` (or more) contains `- GET http://localhost:8000/gone.png → 404 <status text>  (step 1)`. Same entry in `explore.json` `failed_requests` with `status: 404`, `steps: [1]`.
- No entry for 2xx/3xx requests such as `GET http://localhost:8000/`.

### TS-8: Console errors are reported and grouped
**Contract:** C2, C4, C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; STUB (`STUB_URL` = `http://localhost:8000/errors.html`, `STUB_ANSWER` = A_EMPTY).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/errors.html`.
**Expected:**
- `## Console errors (1)` has one line containing `boom from errors page` with `(step 1)`.
- In `history.json` step 1 has a `console_errors` array containing it; `explore.json` `console_errors` has `{message, steps: [1]}`.

### TS-9: Findings survive an unreadable answer
**Contract:** C4, C5 · **Criteria:** SC2, SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; STUB with `STUB_NEVER_DONE=1`, `STUB_URL` = errors.html.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/errors.html --max-steps 1`.
**Expected:**
- Exit code 1. The report still lists `boom from errors page`.
- `explore.json` `answer_error` is `no JSON object in the answer`; the report has `The agent's answer could not be read as a flow list: no JSON object in the answer.` right after the `Run:` line, and both flow sections read `None.`

### TS-10: 2xx/3xx not listed; --no-network
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2
**Preconditions:** STUB (URL_OK, A_EMPTY).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`; read the first section.
2. Run again with `--no-network`.
**Expected:**
- Step 1: only requests with status >= 400 or no response are listed.
- Step 2: heading `## Broken links and failed requests (-)` with body `Network capture was off (--no-network), so requests were not checked.`; `explore.json` `network_checked` is `false`.

### TS-11: Flows are classified
**Contract:** C4, C5 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** STUB (URL_OK, `STUB_ANSWER` = A_MIX).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- `explore.json` `broken_flows` has F4 then F5 (statuses `dead-end`, `broken`); `working_flows` has F1, F2, F3 in answer order; `start_url` values are absolute (F1 `http://localhost:8000/about.html`, F4 `http://localhost:8000/dead.html`, F5 `http://localhost:8000/missing.html`).
- `## Dead ends and broken flows (2)` shows `### Dead page (dead-end)` with `- Start: http://localhost:8000/dead.html`, `- Steps: 1. Click the button`, `- Expected: Something happens`, `- Notes: Button does nothing`; and `### Missing page (broken)` with no `Notes:` line.
- `## Flows that worked (3)` shows `### Read about us` with `- Steps: 1. Open the About link; 2. Read the heading` and `- Expected: Heading About us is visible`, and no Notes line.

### TS-12: Empty sections say None.
**Contract:** C5 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2
**Preconditions:** STUB (`STUB_URL` = `http://localhost:8000/about.html`, `STUB_ANSWER` = A_EMPTY).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/about.html`.
**Expected:**
- Exit 0. All four headings end in `(0)` and each section body is the single line `None.`. `explore.json` `answer_error` is `null`, `dropped_flows` 0.

### TS-13: Unreadable answer is not fatal
**Contract:** C1, C4 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** STUB with `STUB_NEVER_DONE=1`.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 1`.
**Expected:**
- Report printed, `explore.md`/`explore.json` written, `answer_error` is `no JSON object in the answer`, exit code 1 (the run's code), no stderr error line.

### TS-14: --write-tasks writes task files for ok flows
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; `$WORK/tasks` absent; STUB (URL_OK, A_MIX).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --write-tasks`.
**Expected:**
- Folder `tasks/explore-localhost-8000/` holds exactly `01-read-about-us.md`, `02-bare-flow.md`, `03-multi-line-title.md` (none for F4/F5).
- `01-read-about-us.md` is exactly: `---`, `# From duckwright explore http://localhost:8000/ (run <run_dir>)`, `max-steps: 25`, `---`, `# Read about us`, blank, `Open http://localhost:8000/about.html.`, blank, `Steps:`, `1. Open the About link`, `2. Read the heading`, blank, `Check that: Heading About us is visible`.
- Stdout after the `Data:` line: `Tasks: 3 task file(s) in tasks/explore-localhost-8000/`, then `  <path>` for each file, then `Run them with: duckwright -p -f tasks/explore-localhost-8000/`. Exit 0.

### TS-15: Generated task files load
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** TS-14 produced the folder; STUB (with a plain done answer `ok`) on PATH.
**Steps:**
1. Run `node dist/bin.js -p -f tasks/explore-localhost-8000/`.
**Expected:**
- All three files are accepted as tasks (no task-file parse error on stderr) and the batch starts; each run's step budget is 25 (run with `STUB_NEVER_DONE=1`: each `history.json` `steps` is 25).

### TS-16: Existing folder is never overwritten; -2 and -3
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** `tasks/explore-localhost-8000/` exists with marker `keep.txt`; STUB (URL_OK, A_MIX).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --write-tasks`.
2. Run the same command again.
**Expected:**
- Step 1: new files in `tasks/explore-localhost-8000-2/`; Step 2: in `tasks/explore-localhost-8000-3/`. `keep.txt` and the original folder's files are unchanged. The `Tasks:` line names the new folder with trailing `/`.

### TS-17: No working flows
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1
**Preconditions:** fresh `$WORK`; STUB with `STUB_NEVER_DONE=1`.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 1 --write-tasks`.
**Expected:**
- Stdout ends with `Tasks: no working flows, no task files written`; no `tasks/` folder is created; exit 1 (the run's code).

### TS-18: No URL
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1
**Steps:**
1. Run `node dist/bin.js explore`.
**Expected:**
- Exit code 2; stderr shows `usage: duckwright explore [-h] [--write-tasks] [run options] url` then `duckwright explore: error: give a URL to explore`. No run folder created.

### TS-19: Non-http URL
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1
**Steps:**
1. For each of BAD_URLS run `node dist/bin.js explore "<url>"`.
**Expected:**
- Each exits 2 with `duckwright explore: error: not an http(s) URL: <url>`.

### TS-20: Conflicting options
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1
**Steps:**
1. Run `explore http://localhost:8000/ -f $WORK/t.md`.
2. Run `explore http://localhost:8000/ --plan`.
3. Run `explore http://localhost:8000/ --web`.
4. Run `explore http://localhost:8000/ --past`, then `--port 1`, `--max-parallel 2`, `--theme dark`.
**Expected:**
- Each exits 2 with, respectively: `explore takes a URL, not --file`; `--plan cannot be used with explore`; `--web cannot be used with explore`; `--past does not apply to explore`, `--port does not apply to explore`, `--max-parallel does not apply to explore`, `--theme does not apply to explore`. All prefixed `duckwright explore: error: ` and preceded by the usage line. (If `--plan` / `--past` need a value in the parser and the bare flag is reported as a missing value instead, retry with a value, e.g. `--plan x`, `--past 1`.)

### TS-21: Task text, extra positional, bad option values
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `explore http://localhost:8000/ "log in"`.
2. Run `explore http://localhost:8000/ --max-steps abc`.
3. Run `explore http://localhost:8000/ --write-tasks=yes`.
4. Run `explore http://localhost:8000/ --bogus`.
**Expected:**
- All exit 2, each preceded by the usage line, with stderr final line: 1 `duckwright explore: error: unrecognized arguments: log in`; 2 `duckwright explore: error: argument --max-steps: invalid int value: 'abc'`; 3 `duckwright explore: error: argument --write-tasks: ignored explicit argument 'yes'`; 4 `duckwright explore: error: unrecognized arguments: --bogus`.

### TS-22: Help and version
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `node dist/bin.js explore -h`.
2. Run `node dist/bin.js explore --version`.
**Expected:**
- Step 1: exit 0, stdout equals the `EXPLORE_HELP` text in the spec C1 character for character.
- Step 2: exit 0, stdout `duckwright <version>`.

### TS-23: No regression-test export
**Contract:** C1 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1
**Preconditions:** STUB (URL_OK, A_MIX).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/` to `done success`.
**Expected:**
- Exit 0, output has no `Test:` line; no `duckwright.spec.ts` (or other test export) in the run folder or `$WORK`.

### TS-24: README
**Contract:** README · **Criteria:** SC7 · **Type:** File · **Priority:** P2
**Steps:**
1. Open `README.md`.
**Expected:**
- Usage block has `duckwright explore URL [--write-tasks] [options]`; a `### Exploration mode` section after Plan mode covers the 40-step default, same-host and no-destructive rules, report files and sections, `--write-tasks` and `duckwright -p -f tasks/explore-<host>/`, no test export, exit codes, console capture only for explore; Output section mentions `explore.md`, `explore.json`, `console_errors`; the roadmap Exploration mode item is `- [x]`.

### TS-25: Interrupt exits 130 with a report
**Contract:** C1 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3
**Preconditions:** STUB with `STUB_NEVER_DONE=1`.
**Steps:**
1. Start `node dist/bin.js explore http://localhost:8000/`, wait for the first step line, send SIGINT (Ctrl-C).
**Expected:**
- Exit 130; a report is still printed from `history.json` with `Report:` and `Data:` lines.

### TS-26: Main command and `-- explore`
**Contract:** Surfaces that must not change · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2
**Preconditions:** STUB with `STUB_NEVER_DONE=1`.
**Steps:**
1. Run `node dist/bin.js -p --max-steps 1 -- explore`.
**Expected:**
- It runs as a normal task named "explore": no `explore.md`/`explore.json` in the run folder, no exploration report on stdout.

### TS-27: Normal run keeps export and history shape
**Contract:** C2, surfaces that must not change · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; real agent (no STUB), or STUB that finishes with `done success` after `goto http://localhost:8000/errors.html`.
**Steps:**
1. Run `node dist/bin.js -p "open http://localhost:8000/errors.html and check the heading"` to a successful end.
**Expected:**
- A `Test:` line is printed and the regression test export file exists; no step in `history.json` has a `console_errors` key.

### TS-28: Other subcommands and help
**Contract:** Surfaces that must not change · **Criteria:** SC7 · **Type:** CLI · **Priority:** P3
**Steps:**
1. Run `node dist/bin.js -h`, `node dist/bin.js export --help`, `node dist/bin.js plan --help`, `node dist/bin.js init --help`.
**Expected:**
- Each works as before the change (exit 0, same help as on the base commit).

### TS-29: Console message clip at 500 code points
**Contract:** C2 · **Criteria:** SC2 · **Type:** File · **Priority:** P2
**Preconditions:** STUB (`STUB_URL` = `http://localhost:8000/long501.html`, A_EMPTY).
**Steps:**
1. Run `explore http://localhost:8000/long501.html`; read step 1 `console_errors` in `history.json`.
2. Repeat with `STUB_URL` = `http://localhost:8000/short.html`.
**Expected:**
- Step 1: one message of exactly 500 code points that does not end in `END` (the 501-character message was clipped).
- Step 2: one message containing `short-END`, unclipped.

### TS-30: At most 50 console messages per step
**Contract:** C2 · **Criteria:** SC2 · **Type:** File · **Priority:** P2
**Preconditions:** STUB with `STUB_URL` set per step.
**Steps:**
1. Run with `STUB_URL` = `errs50.html`; count `history[0].console_errors`.
2. Run with `STUB_URL` = `errs51.html`; count again.
**Expected:**
- Step 1: 50 entries (`e1` … `e50`). Step 2: 50 entries (not 51); `explore.json` `console_errors` has at most 50 messages.

### TS-31: Console capture failure is a warning only
**Contract:** C2 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2
**Preconditions:** a wrapper `$WORK/stub/playwright-cli` placed before the real one on PATH: for any call whose first argument is `console` it writes `boom` to stderr and exits 1; every other call execs the real `playwright-cli` with the same arguments. STUB (URL_OK, A_EMPTY).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- stderr contains `warning: console capture failed at step 1: boom`. Exit 0 (outcome unchanged), report printed, `history.json` step 1 has no `console_errors` key.

### TS-32: Invalid JSON in the answer
**Contract:** C4, C5 · **Criteria:** SC3 · **Type:** File · **Priority:** P2
**Preconditions:** STUB (URL_OK, `STUB_ANSWER` = A_BADJSON).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Exit 0 (agent finished with `done success`). `answer_error` starts with `invalid JSON: ` followed by the JSON parser's message; the report paragraph reads `The agent's answer could not be read as a flow list: invalid JSON: <message>.`; both flow sections `None.`.

### TS-33: Answer without a flows list
**Contract:** C4, C5 · **Criteria:** SC3 · **Type:** File · **Priority:** P2
**Preconditions:** STUB (URL_OK, `STUB_ANSWER` = A_NOFLOWS), then again with A_NOJSON.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/` with A_NOFLOWS.
2. Run again with A_NOJSON.
**Expected:**
- Step 1: `answer_error` is `no "flows" list in the answer`; report paragraph `The agent's answer could not be read as a flow list: no "flows" list in the answer.`
- Step 2: `answer_error` is `no JSON object in the answer`. Both exit 0.

### TS-34: Dropped flows are counted and reported
**Contract:** C4, C5 · **Criteria:** SC3 · **Type:** File · **Priority:** P2
**Preconditions:** STUB (URL_OK, A_MIX).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- `explore.json` `dropped_flows` is 2, `answer_error` is `null`; the report has the line `2 flow(s) in the answer were unreadable and left out.` directly after the `Run:` line. The 5 valid flows are still present.

### TS-35: Empty Steps/Expected/Notes lines are omitted in the report
**Contract:** C5 · **Criteria:** SC3 · **Type:** File · **Priority:** P3
**Preconditions:** TS-34 output.
**Steps:**
1. Read the `### Bare flow` block (F2) and the `### Missing page (broken)` block (F5) in `explore.md`.
**Expected:**
- Bare flow has only `- Start: http://localhost:8000/` (no `Steps:`, no `Expected:`). Missing page has `Start`, `Steps`, `Expected` and no `Notes:` line.

### TS-36: Task file fallbacks and single-line fields
**Contract:** C6 · **Criteria:** SC4 · **Type:** File · **Priority:** P2
**Preconditions:** TS-14 output.
**Steps:**
1. Read `02-bare-flow.md` and `03-multi-line-title.md`.
**Expected:**
- `02-bare-flow.md` has no `Steps:` block and its last line is `Check that: the flow finishes without an error page.`
- `03-multi-line-title.md`: the `# ` title line, the step line and the `Check that:` line are each a single line (the newlines in "Multi\nline title", "step one\nsecond line" and "line a\nline b" are collapsed); no stray text line appears between the title and `Open …`.
- Every file in the folder loads: `node dist/bin.js -p -f tasks/explore-localhost-8000/` shows no task-file parse error.

### TS-37: Task file write failure
**Contract:** C6 · **Criteria:** SC4, SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** `$WORK/tasks` exists as a regular file (`touch $WORK/tasks`); STUB (URL_OK, A_MIX, which gives working flows).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --write-tasks`.
**Expected:**
- stderr has `explore: cannot write task files: <message>`; the report and `Report:`/`Data:` lines are still printed; exit code 1 although the run was `done success`.

### TS-38: Invalid config file
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** `$WORK/xdg/duckwright/duckwright.conf` contains the single line `not a config line`.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Exit 2; stderr is one non-empty line (the config error message; its exact text is not fixed by the spec); no `runs/` folder is created.

### TS-39: Invalid TOTP secret
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `DUCKWRIGHT_TOTP_SECRET='!!not-base32!!' node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Exit 2; stderr is the single line `DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret`; no `runs/` folder is created.

### TS-40: Preflight failure (claude not on PATH)
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `env PATH=<directory containing only the node binary> <absolute path to node> dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Exit 2; stderr is the single line `claude CLI not found on PATH (install Claude Code)`; no `runs/` folder is created.

### TS-41: Run folder cannot be created
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** `$WORK/runs` exists as a regular file (`touch $WORK/runs`); STUB on PATH.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- Exit 1; an error is printed on stderr; no report markdown on stdout, no `Report:`/`Data:` lines, no `explore.md` anywhere.

### TS-42: history.json unreadable after the run (best effort)
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P3
**Preconditions:** STUB (URL_OK, A_EMPTY) with `STUB_HOOK` set to a background loop that waits for `$WORK/runs/*/history.json` to appear and then overwrites it with `{`. This races with the CLI; repeat up to 5 times until the failure shows.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- stderr has `explore: cannot read history: <message>`; no report markdown, no `Report:`/`Data:` lines; exit 1 (the run itself was `done success`). If the race never triggers, record the scenario as not reproducible (it is covered by the implementer's unit tests).

### TS-43: Report write failure
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Preconditions:** STUB (URL_OK, A_EMPTY) with `STUB_HOOK` = `mkdir "$(ls -d runs/*/ | tail -1)explore.md"` (makes `explore.md` a directory inside the run folder before the report is written).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
**Expected:**
- The report markdown is still printed to stdout; stderr has `explore: cannot write report: <message>`; exit 1 although the run was `done success`.

### TS-44: Write failure does not change a failing exit code
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P3
**Preconditions:** `$WORK/tasks` exists as a regular file; STUB with `STUB_NEVER_DONE=1`.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 1 --write-tasks`.
**Expected:**
- Exit 1 (unchanged); with no working flows the stdout ends `Tasks: no working flows, no task files written` and no write is attempted.

## Out of scope
- Unit and integration tests (run as checks during implementation, including `npm test`)
- Harness-side dead-end detection; task files for dead-end/broken flows; crawling without the agent; HTML report; TUI/web/MCP integration
- Harness-enforced same-host restriction or destructive-action blocking
- Console capture for non-explore runs; `env:`/`state:` in generated task files; custom run-folder label
- Confirming the exact `playwright-cli console error` output format against a newer version (the spec's manual e2e)
