# Exploration mode (`duckwright explore <url>`) QA Test Plan

**Goal:** `duckwright explore <url>` wanders a site with no fixed task, reports broken links, console errors and dead-end flows, and can write task files for the flows that worked.
**Spec:** docs/superpowers/specs/2026-10-10-exploration-mode-explore-design.md
**Scope:** Black-box CLI/file scenarios against the spec's Contracts. Unit and integration tests are covered by the implementation and are not repeated here.

## Environment
- Start: `npm ci && npm run build`, then run `node dist/bin.js explore <url> [options]` (the `duckwright` bin) from a scratch directory `$WORK` (task files are written under `$WORK/tasks/`). Real runs need `claude` and `playwright-cli` on PATH and a working model login.
- Site under test: a local site served by `python3 -m http.server 8000` from `$WORK/site` (fixtures below) at `http://localhost:8000/`. Use `--headed` off (default).
- Accounts / auth: none for the fixture site. The agent is a real model, so its flow list varies. The agent answer cannot be dictated, so QA uses the fixture site so the expected findings are deterministic (failed requests, console errors) and checks the flow sections against the agent's own answer in `history.json` (`answer` field). Where a scenario says "agent answer unreadable", QA uses `--max-steps 1` so the run ends without `done`.
- Reset: `rm -rf $WORK/tasks` and `rm -rf` the run folders printed by earlier runs between scenarios; restart the http server.

## Test data
- **SITE**: files in `$WORK/site`:
  - `index.html`: links to `/about.html`, `/missing.html` (does not exist, so 404), `/dead.html`, and `/errors.html`; an `<img src="/gone.png">` (404).
  - `about.html`: heading "About us", link back to `/`.
  - `dead.html`: heading "Dead end", a form with a button that does nothing, no links.
  - `errors.html`: inline script `console.error("boom from errors page")`.
- **URL_OK** = `http://localhost:8000/`
- **BAD_URLS**: `ftp://localhost/`, `localhost:8000`, `not a url`, `file:///etc/hosts`.
- **CONFIG**: a `duckwright` config file (the repo's usual config location) containing `max-steps: 12`.
- **TASKFILE**: any existing task file `$WORK/t.md`.

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C1, C3, C4, C5 | TS-1, TS-2, TS-3, TS-4, TS-5, TS-6 |
| SC2 | C2, C4, C5 | TS-7, TS-8, TS-9, TS-10 |
| SC3 | C3, C4, C5 | TS-11, TS-12, TS-13 |
| SC4 | C6 | TS-14, TS-15, TS-16, TS-17 |
| SC5 | C1 | TS-18, TS-19, TS-20, TS-21, TS-22, TS-25 |
| SC6 | C1 | TS-23 |
| SC7 | README | TS-24 |
| Regression | Surfaces that must not change | TS-26, TS-27, TS-28 |

## Scenarios

### TS-1: Explore run prints and saves the report
**Contract:** C1, C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; `$WORK` empty.
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

### TS-4: Default step budget is 40
**Contract:** C1, C3 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; CONFIG present in the config location (max-steps 12).
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --debug` and read the step lines / the `<task>` and step counter (`Step N/M`) in the run's logged prompt.
**Expected:**
- The budget shown is `M = 40`, not 12.

### TS-5: --max-steps overrides the default
**Contract:** C1 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 10 --debug`.
**Expected:**
- The budget shown is `Step N/10`. The run stops by step 10 at the latest.

### TS-6: The exploration task text reaches the agent
**Contract:** C3 · **Criteria:** SC1 · **Type:** File · **Priority:** P2
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 3`.
2. Read the `task` field of `<run dir>/history.json`.
**Expected:**
- It begins `Explore the website at http://localhost:8000/ like a curious first-time visitor.`, contains `Stay on the host localhost:8000.`, `Start with goto http://localhost:8000/.`, the line `You do not need expect checks in this task.`, the JSON example `{"flows":[{"title":"Search products",...`, and the words `ok`, `dead-end`, `broken`.

### TS-7: Failed requests are reported
**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 8`. (The agent loads `/`, which requests `/gone.png`; if the agent follows the `missing.html` link, that too.)
**Expected:**
- Section `## Broken links and failed requests (<n>)` contains a line `- GET http://localhost:8000/gone.png → 404 <status text>  (step 1)` (steps listed ascending, `(steps N, M)` if several). Same entry appears in `explore.json` `failed_requests` with `status: 404`.

### TS-8: Console errors are reported and grouped
**Contract:** C2, C4, C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/errors.html --max-steps 4`.
**Expected:**
- `## Console errors (<n>)` has one line containing `boom from errors page` with its step list (each message appears once even if seen on several steps).
- `history.json` steps that saw it have a `console_errors` array containing it.

### TS-9: Findings survive an unreadable answer
**Contract:** C4, C5 · **Criteria:** SC2, SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/errors.html --max-steps 1`.
**Expected:**
- Exit code 1 (budget reached). The report still lists the `boom from errors page` console error and any failed requests.
- `explore.json` `answer_error` is non-null; the report contains `The agent's answer could not be read as a flow list: <answer_error>.` right after the `Run:` line, and both flow sections read `None.`

### TS-10: Aborted requests and 2xx/3xx are not listed; --no-network
**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 4`; check the section lists only requests with status >= 400 or no response (no 200 entries for `/`, `/about.html`).
2. Run again with `--no-network`.
**Expected:**
- Step 1: no 2xx/3xx entries.
- Step 2: heading is `## Broken links and failed requests (-)` with the body `Network capture was off (--no-network), so requests were not checked.`; `explore.json` `network_checked` is `false`.

### TS-11: Flows are classified
**Contract:** C4, C5 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/`.
2. Compare the `answer` in `history.json` with `explore.json`.
**Expected:**
- Each flow in the answer with `status` `dead-end` or `broken` is in `broken_flows` and under `## Dead ends and broken flows`, shown as `### <title> (<status>)` with `- Start:`, `- Steps: 1. …; 2. …`, `- Expected:`, `- Notes:` (omitted when empty).
- Each `ok` flow is in `working_flows` and under `## Flows that worked` as `### <title>` (no Notes line).
- `start_url` values are absolute.

### TS-12: Empty sections say None.
**Contract:** C5 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/about.html --max-steps 3` (a page with no errors; if an agent finds none).
**Expected:**
- Any section with zero items has `(0)` in the heading and the single body line `None.`

### TS-13: Unreadable answer is not fatal
**Contract:** C1, C4 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --max-steps 1`.
**Expected:**
- Report printed, `explore.md`/`explore.json` written, `answer_error` is `no JSON object in the answer` (when the run ended without `done`), exit code is the run's code (1), no crash or extra stderr error.

### TS-14: --write-tasks writes task files for ok flows
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1
**Preconditions:** SITE served; `$WORK/tasks` absent.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --write-tasks`.
**Expected:**
- If `working_flows` is non-empty: folder `tasks/explore-localhost-8000/` contains one `NN-<slug>.md` per working flow (NN from `01`, answer order), none for dead-end/broken flows.
- Each file starts `---`, `# From duckwright explore http://localhost:8000/ (run <run_dir>)`, `max-steps: 25`, `---`, then `# <title>`, `Open <start_url>.`, optional `Steps:` list, and ends `Check that: <expected>`.
- Stdout after the `Data:` line: `Tasks: <n> task file(s) in <folder>/`, `  <path>` per file, `Run them with: duckwright -p -f <folder>/`.

### TS-15: Generated task files run
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** TS-14 produced a folder.
**Steps:**
1. Run `node dist/bin.js -p -f tasks/explore-localhost-8000/`.
**Expected:**
- Every file is loaded as a task (no task-file parse error) and the batch starts, using 25 max steps.

### TS-16: Existing folder is never overwritten
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P2
**Preconditions:** `tasks/explore-localhost-8000/` exists with a marker file `keep.txt`.
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/ --write-tasks` again.
**Expected:**
- New files go to `tasks/explore-localhost-8000-2/` (then `-3` on a further clash); `keep.txt` and the old files are unchanged.

### TS-17: No working flows
**Contract:** C6 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1
**Steps:**
1. In a fresh `$WORK`, run `node dist/bin.js explore http://localhost:8000/ --max-steps 1 --write-tasks`.
**Expected:**
- Stdout ends with `Tasks: no working flows, no task files written`; no `tasks/` folder is created.

### TS-18: No URL
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1
**Steps:**
1. Run `node dist/bin.js explore`.
**Expected:**
- Exit code 2; stderr shows the usage line `usage: duckwright explore [-h] [--write-tasks] [run options] url` then `duckwright explore: error: give a URL to explore`. No run folder created.

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
- Each exits 2 with, respectively: `explore takes a URL, not --file`; `--plan cannot be used with explore`; `--web cannot be used with explore`; `--past does not apply to explore`, `--port does not apply to explore`, `--max-parallel does not apply to explore`, `--theme does not apply to explore`. All prefixed `duckwright explore: error: ` and preceded by the usage line.

### TS-21: Task text, extra positional, bad option values
**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `explore http://localhost:8000/ "log in"`.
2. Run `explore http://localhost:8000/ --max-steps abc`.
3. Run `explore http://localhost:8000/ --write-tasks=yes`.
4. Run `explore http://localhost:8000/ --bogus`.
**Expected:**
- All exit 2. Step 1: `unrecognized arguments: log in`. Step 3: `argument --write-tasks: ignored explicit argument 'yes'`. Steps 2 and 4: the main command's own message for that error, prefixed `duckwright explore: error: `.

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
**Steps:**
1. Run `node dist/bin.js explore http://localhost:8000/` to a successful `done success` (retry if the agent fails).
**Expected:**
- Output has no `Test:` line; no `duckwright.spec.ts` (or other test export) appears in the run folder or `$WORK`.

### TS-24: README
**Contract:** README · **Criteria:** SC7 · **Type:** File · **Priority:** P2
**Steps:**
1. Open `README.md`.
2. Run `npm test`.
**Expected:**
- Usage block has `duckwright explore URL [--write-tasks] [options]`; a `### Exploration mode` section after Plan mode covers the 40-step default, same-host and no-destructive rules, report files and sections, `--write-tasks` and `duckwright -p -f tasks/explore-<host>/`, no test export, exit codes, console capture only for explore; Output section mentions `explore.md`, `explore.json`, `console_errors`; the roadmap Exploration mode item is `- [x]`.
- `npm test` exits 0 (typecheck + all tests, at least the 1467 baseline).

### TS-25: Exit codes and write failure
**Contract:** C1 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3
**Steps:**
1. Start a run and press Ctrl-C mid-run.
2. Run with `--write-tasks` in a read-only `$WORK` (`chmod a-w`) after a successful run.
**Expected:**
- Step 1: exit 130 and a report is still printed from `history.json`.
- Step 2: stderr `explore: cannot write task files: <message>` (or `cannot write report` if the run folder is also unwritable) and exit 1 instead of 0.

## Regression

### TS-26: Main command and `-- explore`
**Contract:** Surfaces that must not change · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2
**Steps:**
1. Run `node dist/bin.js -p -- explore` (a task named "explore").
**Expected:**
- It runs as a normal task named "explore": no `explore.md`/`explore.json`, no exploration report.

### TS-27: Normal run keeps export and history shape
**Contract:** C2, surfaces that must not change · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1
**Steps:**
1. Run `node dist/bin.js -p "open http://localhost:8000/errors.html and check the heading"` to a successful end.
**Expected:**
- A `Test:` line and the regression test export are still produced; no step in `history.json` has a `console_errors` key; no `console error` capture occurs.

### TS-28: Other subcommands and help
**Contract:** Surfaces that must not change · **Criteria:** SC7 · **Type:** CLI · **Priority:** P3
**Steps:**
1. Run `node dist/bin.js -h`, `node dist/bin.js export --help`, `node dist/bin.js plan --help`, `node dist/bin.js init --help`.
**Expected:**
- Each works as before the change (exit 0, same help as on the base commit).

## Out of scope
- Unit and integration tests (run as checks during implementation)
- Harness-side dead-end detection; task files for dead-end/broken flows; crawling without the agent; HTML report; TUI/web/MCP integration
- Harness-enforced same-host restriction or destructive-action blocking
- Console capture for non-explore runs; `env:`/`state:` in generated task files; custom run-folder label
- Confirming the exact `playwright-cli console error` output format against a newer version (the spec's manual e2e)
