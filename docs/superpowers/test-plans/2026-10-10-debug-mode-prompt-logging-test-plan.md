# Debug Mode (`--debug`) QA Test Plan

**Goal:** Add a `--debug` option that records, for every step of a run, exactly what was sent to Claude and Jev and what came back, with tokens, cost and latency.
**Spec:** docs/superpowers/specs/2026-10-10-debug-mode-prompt-logging-design.md
**Scope:** Black-box CLI/file scenarios against the spec's Contracts. Unit and integration tests are covered by the implementation and are not repeated here.

## Environment
- Build: `npm install && npm run build`; entry point `node dist/bin.js` (alias `duckwright` below; `npm link` also works). Node >= 22.18.
- Real `claude` CLI logged in and on PATH; Chromium available as for any normal duckwright run.
- Jev scenarios need `TYPESAFE_API_KEY` set to a real key (called `KEY` below). Non-Jev scenarios need no key.
- 2FA scenario needs a test site with TOTP login and its secret (`TOTP_SECRET`), configured as the README describes for 2FA.
- Work in an empty directory `$WORK`; runs are written to `$WORK/runs/<id>/`.
- Reset: `rm -rf $WORK/runs $WORK/duckwright.conf $WORK/*.md` between scenarios unless the scenario says otherwise. Capture streams with `duckwright ... >out.txt 2>err.txt`.

## Test data
- TASK-A: command-line task `"Open https://example.com and tell me the page heading"` (2 or more steps).
- TASK-FILE-ON: `$WORK/on.md` with front matter `debug: true` then the TASK-A text.
- TASK-FILE-OFF: `$WORK/off.md` with front matter `debug: false` then the TASK-A text.
- TASK-FILE-BAD: `$WORK/bad.md` with front matter `debug: maybe`.
- TASK-FILE-DUP: `$WORK/dup.md` with two lines `debug: true`.
- CONF-ON: `$WORK/duckwright.conf` containing `debug: true` (use the config location the README documents; pass it as the README says).
- BATCH: `$WORK/a.md` and `$WORK/b.md`, each a short task.
- LOGIN-TASK: task logging in to the 2FA test site using TOTP.
- Run id: the run folder's base name, e.g. `20261010-101500-brave-otter`.

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C1, C4, C5, C6 | TS-1, TS-2, TS-3, TS-4, TS-12, TS-13 |
| SC2 | C4, C5 | TS-5, TS-6, TS-7 |
| SC3 | C4 | TS-8 |
| SC4 | C4, C5 | TS-9, TS-10 |
| SC5 | C5, C6 | TS-11, TS-R1, TS-R2 |
| SC6 | C1, C2, C3 | TS-14, TS-15, TS-16, TS-17, TS-18, TS-19, TS-20, TS-21 |
| SC7 | C5, C6 | TS-22, TS-23, TS-24 |

## Scenarios

### TS-1: `-p --debug` prints full Claude blocks to stderr and writes the same to debug.log

**Contract:** C1, C4, C6 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P1

**Preconditions:** Clean `$WORK`; TASK-A.

**Steps:**
1. Run `duckwright -p --debug "<TASK-A>" >out.txt 2>err.txt`.
2. Open `err.txt` and `runs/<id>/debug.log`.

**Expected:**
- `err.txt` contains a block headed `===== [debug <run-id>] run =====` followed by `log: <absolute path of runs/<id>/debug.log>`.
- For every step n, a block headed `===== [debug <run-id>] step <n> · claude =====` with lines `argv: [` JSON array (one line), `cwd:`, `mode: grep` or `mode: paste`, `system prompt files:`, `prompt sections:` (rows named per section plus a `total` row, each `<chars> chars  ~<est> tokens (est.)`), `----- prompt (stdin) -----` with the full prompt, `----- response -----` with `exit: 0  wall: <s.ss>s` and the pretty-printed JSON envelope, and `----- usage -----` with the `input tokens:`/`output tokens:`/`cache read:`/`cache write:` line and the `cost: $<4 decimals>  duration_ms:  duration_api_ms:` line.
- The prompt text shown starts with `Step 1/` for step 1 and is not truncated (ends with its closing tag).
- Every block in `err.txt` appears in `debug.log` with identical text (diff of the block text is empty).

### TS-2: System prompts block printed once with full contents

**Contract:** C4 · **Criteria:** SC1 · **Type:** File · **Priority:** P1

**Preconditions:** TS-1's run (at least 2 Claude steps).

**Steps:**
1. Count occurrences of `===== [debug <run-id>] system prompts =====` in `debug.log`.
2. Pick a path from step 1's `system prompt files:` list and compare the block's `----- <path> (<bytes> bytes) -----` section to the file on disk.

**Expected:**
- Exactly one `system prompts` block, located before the first `step 1 · claude` block.
- Its section for the file equals the file's full contents and the byte count equals `wc -c` of the file.
- Every step's `system prompt files:` lists each path as `  <path> (<bytes> bytes)`.

### TS-3: Mode label and prompt section sizes

**Contract:** C4 · **Criteria:** SC1 · **Type:** File · **Priority:** P2

**Preconditions:** TS-1 run.

**Steps:**
1. In `debug.log`, for each Claude block read `argv:` and `mode:`.
2. Read the `prompt sections:` rows of one block.

**Expected:**
- `mode: grep` exactly when the argv contains `--restricted`; otherwise `mode: paste`.
- Section rows include `header` and `task`, in prompt order; `total` chars equal the character count of the text under `----- prompt (stdin) -----`; each `~<est>` equals ceil(chars/4).

### TS-4: Non-JSON or failing Claude call is shown raw

**Contract:** C4 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3

**Preconditions:** Put a stub `claude` script first on PATH that prints `not json` to stdout and `boom` to stderr and exits 1.

**Steps:**
1. Run `duckwright -p --debug "<TASK-A>" >out.txt 2>err.txt`.

**Expected:**
- The step 1 Claude block shows `exit: 1  wall: <s.ss>s`, then `not json` raw, then `----- stderr -----` with `boom`.
- The usage line shows `input tokens: n/a  output tokens: n/a  cache read: n/a  cache write: n/a` and `cost: $n/a`.
- The run fails as it does without `--debug` (same exit code and error text on stdout/stderr apart from debug blocks).

### TS-5: Jev request blocks, answers and usage

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1

**Preconditions:** `TYPESAFE_API_KEY=KEY`; TASK-A.

**Steps:**
1. Run `duckwright -p --jev --debug "<TASK-A>" >out.txt 2>err.txt`.

**Expected:**
- At least one block titled `step <n> · jev request 1` containing `POST <url>`, `headers:` with `Authorization: [REDACTED]`, `----- request body -----` (pretty JSON with state and questions), `----- response -----` with `status: 200  wall: <s.ss>s` and pretty JSON, `----- usage -----` with `input tokens:`, `output tokens:`, `cost: $<4 decimals>`, and an `answers:` list with lines like `  <question id>: <choice> (confidence 0.xxx)`.

### TS-6: Route blocks and fallback reasons

**Contract:** C4 · **Criteria:** SC2 · **Type:** File · **Priority:** P1

**Preconditions:** TS-5 run.

**Steps:**
1. In `debug.log`, read every `step <n> · route` block.

**Expected:**
- Each has `outcome:` (one of `accepted|low_confidence|error|needs_text|done|skipped`), `reason:` and `brain:`.
- Step 1 route: `outcome: skipped`, `reason: step 1 always uses Claude`, `brain: claude`.
- A route with `outcome: accepted` has `brain: jev` and reason `jev chose <action>[ <ref>] (confidence <c.cc>)`; all others have `brain: claude`.
- For a route that is not `accepted`/`skipped`, the route block appears before that step's `claude` block.
- Reasons match the C4 table exactly (e.g. `jev says the next move needs typed text`, `jev says the task is done; Claude writes the answer`).

### TS-7: Jev error and retry are visible; auth error not routed

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** Case A: `TYPESAFE_API_KEY=invalid`. Case B: `TYPESAFE_API_KEY=KEY` with network to the Jev host blocked (e.g. via a firewall rule or `HTTPS_PROXY` to a closed port).

**Steps:**
1. Case A: run `duckwright -p --jev --debug "<TASK-A>" >out.txt 2>err.txt`.
2. Case B: same command.

**Expected:**
- Case A: a `jev request` block shows the 401/403 status and body; no `route` block with `outcome: error` for that failure; the run ends the same way as `--jev` without `--debug`.
- Case B: the request block shows `error: <Error.name>: <message>`, with no usage section; a following `route` block has `outcome: error` and `reason: jev error: <message>`; with several attempts they appear as `jev request 1`, `jev request 2`, ... within the step; the run continues via Claude.

### TS-8: Run summary

**Contract:** C4 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1

**Preconditions:** TS-5 run (with `--jev`) and TS-1 run (without).

**Steps:**
1. Read the last block of the `--jev` run's `err.txt`.
2. Read the last block of the TS-1 run's `debug.log`.

**Expected:**
- Last block is `===== [debug <run-id>] summary =====` with lines `claude: <calls> calls  input <n>  output <n>  cache read <n>  cache write <n> tokens  cost $<fixed4>`, `jev: <requests> requests (<retries> retries)  input <n>  output <n> tokens  cost $<fixed4>`, `routes: accepted <n>  low_confidence <n>  error <n>  needs_text <n>  done <n>  skipped <n>`, `total cost: $<fixed4>`.
- `calls` equals the number of `· claude` blocks; `requests` equals the number of `jev request` blocks; `retries` equals those with k > 1; route counts match the route blocks.
- Total cost equals Claude cost plus Jev cost (to 4 decimals).
- In the run without `--jev` the `jev:` and `routes:` lines are absent.

### TS-9: API key and Authorization never appear

**Contract:** C4, C5 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1

**Preconditions:** `TYPESAFE_API_KEY=KEY` (a distinctive value, e.g. `sk-qa-SECRET123`).

**Steps:**
1. Run `duckwright -p --jev --debug "<TASK-A>" >out.txt 2>err.txt`.
2. `grep -c "sk-qa-SECRET123" out.txt err.txt runs/<id>/debug.log runs/<id>/history.json`.
3. `grep -i "authorization" err.txt`.

**Expected:**
- Count is 0 in `err.txt`, `out.txt` and `debug.log`.
- Every `Authorization` occurrence is followed by `[REDACTED]`; no `Bearer <token>` text is visible.

### TS-10: TOTP secret and 2FA codes never appear

**Contract:** C4, C5 · **Criteria:** SC4 · **Type:** CLI · **Priority:** P1

**Preconditions:** LOGIN-TASK on the 2FA test site with `TOTP_SECRET` configured.

**Steps:**
1. Run `duckwright -p --debug "<LOGIN-TASK>" >out.txt 2>err.txt`.
2. Note the 6-digit codes the run used (from the site or the run's own output where they are not hidden).
3. Search `err.txt` and `debug.log` for `TOTP_SECRET` and for each code.

**Expected:**
- Neither the secret nor any issued code appears in `err.txt` or `debug.log` (a redaction marker appears in their place).

### TS-11: Full page snapshots and prompts are not truncated

**Contract:** C4 · **Criteria:** SC1, SC5 · **Type:** File · **Priority:** P3

**Preconditions:** A run against a page with a long snapshot (e.g. a long Wikipedia article) with `--debug`.

**Steps:**
1. Compare the `total` chars row of a step with the length of the text under `----- prompt (stdin) -----`.

**Expected:**
- Equal; the prompt contains the closing tag of its last section; no `...` truncation marker added by debug.

### TS-12: Batch run writes one debug.log per run with run id in each header

**Contract:** C4, C5, C6 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P2

**Preconditions:** BATCH.

**Steps:**
1. Run `duckwright -p --debug a.md b.md >out.txt 2>err.txt`.

**Expected:**
- Two run folders, each with its own `debug.log`.
- Every block header in each log has that run's own id (`===== [debug <run-id>] ...`); a log never contains the other run's id.
- `err.txt` contains both runs' blocks, each header naming its run.

### TS-13: Aborted run keeps blocks and writes summary

**Contract:** C5 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3

**Preconditions:** TASK-A.

**Steps:**
1. Start `duckwright -p --debug "<TASK-A>"`; press Ctrl-C after the first Claude block appears.

**Expected:**
- `debug.log` contains the blocks so far and ends with a `summary` block.

### TS-14: `--debug` accepted as flag, default off

**Contract:** C1 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1

**Preconditions:** No task-file or config `debug`.

**Steps:**
1. Run `duckwright -p "<TASK-A>"` and check for `runs/<id>/debug.log`.
2. Run `duckwright -p --debug "<TASK-A>"` and check again.

**Expected:**
- Step 1: no `debug.log`. Step 2: `debug.log` exists.

### TS-15: `--no-debug` overrides task file

**Contract:** C1, C2 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1

**Preconditions:** TASK-FILE-ON.

**Steps:**
1. Run `duckwright -p on.md`; note whether `debug.log` exists.
2. Run `duckwright -p --no-debug on.md`.

**Expected:**
- Step 1: `debug.log` exists and stderr has debug blocks (task-file key works).
- Step 2: no `debug.log`, no debug blocks.

### TS-16: Flag overrides task file `debug: false`

**Contract:** C1, C2 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P2

**Preconditions:** TASK-FILE-OFF.

**Steps:**
1. Run `duckwright -p --debug off.md`.

**Expected:**
- `debug.log` exists with debug blocks.

### TS-17: Config key and precedence

**Contract:** C3 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1

**Preconditions:** CONF-ON; TASK-FILE-OFF.

**Steps:**
1. Run `duckwright -p "<TASK-A>"` with CONF-ON in effect.
2. Run `duckwright -p off.md` with CONF-ON.
3. Run `duckwright -p --no-debug "<TASK-A>"` with CONF-ON.

**Expected:**
- Step 1: `debug.log` exists. Step 2: none (task file beats config). Step 3: none (flag beats config).

### TS-18: Last of `--debug` / `--no-debug` wins

**Contract:** C1 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P2

**Steps:**
1. Run `duckwright -p --no-debug --debug "<TASK-A>"`.
2. Run `duckwright -p --debug --no-debug "<TASK-A>"`.

**Expected:**
- Step 1: `debug.log` created. Step 2: not created.

### TS-19: `--debug=x` is rejected

**Contract:** C1 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P2

**Steps:**
1. Run `duckwright -p --debug=x "<TASK-A>"`; capture exit code and stderr.

**Expected:**
- Exit code 2; stderr contains `duckwright: error: argument --debug/--no-debug: ignored explicit argument 'x'`; no run folder is created.

### TS-20: Invalid and duplicate task-file `debug`

**Contract:** C2 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P2

**Preconditions:** TASK-FILE-BAD, TASK-FILE-DUP.

**Steps:**
1. Run `duckwright -p bad.md`.
2. Run `duckwright -p dup.md`.

**Expected:**
- Step 1: exit 2; stderr line `<file>:<line>: ...` naming `debug`, in the same message format the existing bool key `jev` gives for an invalid value (compare with a file containing `jev: maybe`).
- Step 2: exit 2; stderr contains `dup.md:<line>: "debug" is set twice`.

### TS-21: Help, usage, README, init template

**Contract:** C1, C3 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P2

**Steps:**
1. Run `duckwright --help` and read the usage and options.
2. Run `duckwright init` in an empty directory and read the created config.
3. Read `README.md`.

**Expected:**
- Usage has the line `                  [--debug | --no-debug]` directly after the `[--jev | --no-jev] [--jev-threshold FLOAT]` line.
- Help has, after `--jev-threshold`, the entry `--debug, --no-debug   log every prompt sent to Claude and Jev, the raw responses, tokens, cost and timing to runs/<id>/debug.log, and with -p also to stderr (default off). The log holds full page snapshots; credentials are redacted` (line wrapping as in the spec).
- Config template contains `# env: staging` immediately followed by the line `# debug: false`.
- README has a `--debug` row in the options table and the usage synopsis, a `debug` row in the task-file key table, a `debug.log` bullet in Output, and a "Debug mode" subsection with a sample block and the caution about full page snapshots.

### TS-22: TUI mode with `--debug` writes only the file

**Contract:** C5, C6 · **Criteria:** SC7 · **Type:** CLI · **Priority:** P1

**Preconditions:** TASK-A; an interactive terminal (or a pty capture) for the TUI.

**Steps:**
1. Run `duckwright --debug "<TASK-A>"` (no `-p`) in the TUI, run the task to completion, quit, and capture the terminal's scrollback after exit.
2. Open `runs/<id>/debug.log`.

**Expected:**
- `debug.log` exists with the run header, Claude blocks and summary.
- No `===== [debug` text appears on the console after exit, and no debug text on stderr.

### TS-23: Web mode with `--debug` writes only the file

**Contract:** C5, C6 · **Criteria:** SC7 · **Type:** CLI · **Priority:** P1

**Preconditions:** Web mode started as the README documents, with `--debug`.

**Steps:**
1. Start a web-mode run of TASK-A with `--debug` and finish it.
2. Inspect the server process's stdout/stderr and `runs/<id>/debug.log`.

**Expected:**
- `debug.log` exists with blocks; the process's console output contains no `===== [debug` text.

### TS-24: Unwritable debug.log warns once, run continues

**Contract:** C5 · **Criteria:** SC7, SC1 · **Type:** CLI · **Priority:** P2

**Preconditions:** Make `runs/<id>/debug.log` unwritable, e.g. create the run dir's `debug.log` as a directory is not possible beforehand, so instead run with `runs` on a filesystem where, after the run folder is created, a pre-created `debug.log`-named read-only mount is used; if not feasible, run as a user and `chattr +i` a pre-made run folder (record the method used).

**Steps:**
1. Run `duckwright -p --debug "<TASK-A>" >out.txt 2>err.txt`.

**Expected:**
- `err.txt` contains exactly one line starting `warning: debug log: cannot write <path>: `.
- Debug blocks continue to appear on stderr; exit code and stdout equal a run without `--debug`.

## Regression

### TS-R1: Debug off leaves output and files unchanged

**Contract:** C5, C6 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1

**Preconditions:** TASK-A, deterministic site content.

**Steps:**
1. Run `duckwright -p "<TASK-A>" >out1.txt 2>err1.txt`.
2. List the run folder.

**Expected:**
- No `debug.log` in the folder; `err1.txt` contains no `[debug` text; stdout/stderr contain only what the pre-change version prints (compare against a run from the base commit if available).

### TS-R2: stdout and history.json identical with and without `--debug`

**Contract:** C6 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P1

**Preconditions:** Same task, stable page. Normalise timestamps, run ids, costs, durations.

**Steps:**
1. Run `duckwright -p "<TASK-A>" >out_off.txt`.
2. Run `duckwright -p --debug "<TASK-A>" >out_on.txt 2>/dev/null`.
3. Compare the stdout files and the two `history.json` files after normalisation; check `events.jsonl` exists in both.

**Expected:**
- stdout files identical after normalisation; `history.json` has the same keys and structure in both; no debug-related content in either stdout; `events.jsonl` exists in both.

### TS-R3: Existing options still work with `--jev` off

**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P3

**Steps:**
1. Run `duckwright -p --jev --no-jev --network "<TASK-A>"`.

**Expected:**
- Runs as before; no `debug.log`; `history.json` has `jev_steps` of 0.

### TS-R4: Existing test suite

**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2

**Steps:**
1. Run `npm test` and `npm run typecheck`.

**Expected:**
- Both exit 0 with all existing tests passing.

## Out of scope
- Unit and integration tests (run as checks during implementation)
- Debug output in the TUI or web UI, and a debug field in the TUI/web options form
- Changes to prompts, routing thresholds or the decision loop
- A prompt-diff or analysis tool, token estimation beyond chars/4, replaying logged prompts
- Logging the `--plan` planner's Claude call
- Log rotation or size limits
