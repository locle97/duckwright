# Replay the exported spec in the Playwright Inspector QA Test Plan

**Goal:** Let the user open a run's `duckwright.spec.ts` from the TUI or the web UI in the Playwright Inspector (`playwright test --debug`), where they can read and step through it.
**Spec:** `docs/superpowers/specs/2026-10-07-replay-spec-playwright-debug-ui-design.md`
**Scope:** Black-box UI/API scenarios against the spec's Contracts (C1 to C7). Unit and integration tests are covered by the implementation and are not repeated here.

## Environment

- **Machine:** a desktop session with a display (Linux with X11/Wayland, macOS or Windows). The Inspector opens a headed browser, so a headless or SSH-only box can only run the error scenarios.
- **Prerequisites:** Node >= 22.18, `claude` and `playwright-cli` on `PATH` (Duckwright refuses to start the TUI or `--web` without them, exit `2`), `curl`, and `jq`.
- **Build:** in the branch checkout (`<repo>` below): `npm install && npm run build`. Then install Playwright's browser once: `cd <repo> && npx playwright install chromium`.
- **QA working folder:** `~/dw-qa` (`<qa>` below). It must have **no** `package.json` and **no** `node_modules`, so the spec's `@playwright/test` import has to resolve through Duckwright's own install. Run every Duckwright command from `<qa>`. Runs are read from and written to `<qa>/runs/`.
- **Start the TUI:** `cd <qa> && node <repo>/dist/bin.js`
- **Start the web UI:** `cd <qa> && node <repo>/dist/bin.js --web --port 4173`. The terminal prints `http://127.0.0.1:4173/?t=<token>`. Open that URL in a browser. Copy `<token>` into the shell variable `TOKEN`.
- **API calls:** every API scenario uses these curl headers (shell variables `TOKEN` and `PORT=4173` set):
  `-H "Cookie: dw_token_$PORT=$TOKEN" -H "Origin: http://127.0.0.1:$PORT"`
  Task ids come from `curl -s -H "Cookie: dw_token_$PORT=$TOKEN" http://127.0.0.1:$PORT/api/state | jq '.tasks[] | {id, name, state, hasSpec}'`.
- **Counting Inspector processes:** `pgrep -f "duckwright.spec.ts --debug" | wc -l` (on Windows, Task Manager: count `node.exe` processes whose command line contains `duckwright.spec.ts --debug`).
- **Reset between scenarios:** quit Duckwright (`q`, then confirm if asked). Close any open Inspector and Playwright browser windows, then make sure `pgrep -f "duckwright.spec.ts --debug"` prints nothing (`pkill -f "duckwright.spec.ts --debug"` if needed). Delete `<qa>/runs/` and recreate the fixture folders from **Test data**. Make sure `<repo>/node_modules/@playwright/test` exists (TS-12 renames it).

## Test data

All fixture run folders live in `<qa>/runs/`. A folder name must start with `YYYYMMDD-HHMMSS-` to be listed as a past run. A past run's task name is derived from its `history.json` `task` text; QA reads the exact name from the History row, or from `name` in `/api/state`. That name stands for `<task name>` in the expected messages below.

**HISTORY-PASS** (`history.json`, passed run):
```json
{"task":"Replay QA pass fixture","task_file":null,"success":true,"answer":"ok","steps":1,"cost_usd":0,"history":[]}
```

**HISTORY-FAIL** (`history.json`, failed run): HISTORY-PASS with `"task":"Replay QA failed fixture"` and `"success":false`.

**SPEC-PASS** (`duckwright.spec.ts`, needs no network):
```ts
import { test, expect } from '@playwright/test';

test("Replay QA pass fixture", async ({ page }) => {
  await page.setContent('<h1>Hello, Linh!</h1>');
  await expect(page.getByRole('heading')).toHaveText("Hello, Linh!");
});
```

**SPEC-FAILS** (`duckwright.spec.ts`, fails at once):
```ts
import { test, expect } from '@playwright/test';

test("Replay QA failing fixture", async ({ page }) => {
  await page.setContent('<h1>Hello</h1>');
  expect(1).toBe(2);
});
```

| Fixture | Folder (`<qa>/runs/…`) | Files |
| --- | --- | --- |
| RUN-PASS | `20261007-090000-replay-pass` | HISTORY-PASS (task `Replay QA pass fixture`) + SPEC-PASS |
| RUN-BADSPEC | `20261007-090100-replay-badspec` | HISTORY-PASS with task `Replay QA badspec fixture` + SPEC-FAILS |
| RUN-NOSPEC | `20261007-090200-replay-nospec` | HISTORY-FAIL only (no spec) |
| RUN-DELETE | `20261007-090300-replay-delete` | HISTORY-PASS with task `Replay QA delete fixture` + SPEC-PASS |
| RUN-APIONLY | `20261007-090400-replay-apionly` | HISTORY-PASS with task `Replay QA apionly fixture` + SPEC-PASS saved as `duckwright.api.spec.ts` (no `duckwright.spec.ts`) |

Other data:
- **TASK-NEVER:** a typed task `Replay QA never run`, added with `i` and never started.
- **TASK-LIVE:** a typed task `Go to https://example.com and report the page heading`, started with `space`, then paused with `p` while its first step is in progress (state `paused`). It stays live until stopped with `s`.
- **TASK-REAL:** a typed task `Go to https://example.com and check that the main heading says Example Domain`. QA starts it and waits for it to pass, so a fresh session run writes `duckwright.spec.ts`. If the agent run fails, run it again until one passes.

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1: TUI key launches `playwright test <spec> --debug`; footer/help list it | C1, C2, C4 | TS-1, TS-2, TS-3, TS-4, TS-15, TS-16, TS-20 |
| SC2: Web "Replay spec" button via authenticated route | C1, C2, C3, C5 | TS-5, TS-6, TS-17, TS-18, TS-19 |
| SC3: No spec / unknown id gives a clear error; nothing spawned | C1, C3, C4, C5 | TS-7, TS-8, TS-9, TS-10, TS-11, TS-14 |
| SC4: Second trigger while open spawns nothing | C1, C3, C4, C5 | TS-13 |
| SC5: Spawn failure reported, no crash | C1, C3, C4, C5 | TS-12, TS-4 |
| SC6: Dependency and README; `npm test` passes | C6, C7 | TS-21, TS-22, TS-23 |

| Contract | Scenarios |
| --- | --- |
| C1 `replaySpec` (through the TUI and the API) | TS-1, TS-4, TS-5, TS-7, TS-8, TS-9, TS-10, TS-11, TS-12, TS-13, TS-14, TS-20 |
| C2 `hasSpec` | TS-2, TS-3, TS-6 |
| C3 `POST /api/tasks/:id/replay` | TS-5, TS-10, TS-11, TS-12, TS-13, TS-17, TS-18, TS-19 |
| C4 TUI `R` key | TS-1, TS-2, TS-3, TS-4, TS-7, TS-8, TS-9, TS-13, TS-15, TS-16, TS-20 |
| C5 Web **Replay spec** button | TS-6, TS-7, TS-8, TS-9, TS-13 |
| C6 Dependency | TS-21, TS-22 |
| C7 README | TS-23 |

## Scenarios

### TS-1: `R` on a passed past run opens its spec in the Inspector, and closing it reports success

**Contract:** C1, C4 · **Criteria:** SC1 · **Type:** UI · **Priority:** P1

**Preconditions:** Clean state with RUN-PASS only. TUI started.

**Steps:**
1. Press `tab` to open the History tab.
2. Select the row for RUN-PASS (`Replay QA pass fixture`).
3. Press `R`.
4. In the Playwright Inspector, click **Resume** (or press F8) until the test finishes and the browser window closes.

**Expected:**
- After step 3 the TUI shows the info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector`.
- A Playwright Inspector window opens showing the SPEC-PASS source, paused before the first line; a Chromium window opens next to it.
- `pgrep -f "duckwright.spec.ts --debug" | wc -l` prints `1` while the Inspector is open.
- The browser shows the heading `Hello, Linh!` once `page.setContent` has run.
- After step 4 the TUI shows the info toast `Playwright Inspector closed for 20261007-090000-replay-pass`.
- The TUI still responds to keys (for example `?` opens help) the whole time.

### TS-2: Footer shows `R replay spec` only for a non-live task with a spec

**Contract:** C2, C4 · **Criteria:** SC1 · **Type:** UI · **Priority:** P1

**Preconditions:** Clean state with RUN-PASS and RUN-NOSPEC. TUI started.

**Steps:**
1. Press `tab` and select RUN-PASS. Read the footer.
2. Select RUN-NOSPEC (`Replay QA failed fixture`). Read the footer.
3. Press `?` and read the help overlay. Close it with `esc`.

**Expected:**
- Step 1: the footer contains `R replay spec`.
- Step 2: the footer does not contain `R replay spec`.
- Step 3: the help overlay lists `R` with the label `replay spec` exactly once.

### TS-3: A freshly passed session run gets the footer hint and replays its own spec

**Contract:** C2, C4, C1 · **Criteria:** SC1 · **Type:** UI · **Priority:** P1

**Preconditions:** Clean state, empty `<qa>/runs/`. TUI started.

**Steps:**
1. Press `i`, type TASK-REAL, press `⏎`.
2. Press `space` to start it. While it is running, read the footer.
3. Wait until the task state is passed. Note the new run folder name `<runId>` (the only folder in `<qa>/runs/`). Read the footer.
4. Press `R`.
5. In the Inspector, click **Resume** until the browser closes.

**Expected:**
- Step 2: the footer does not contain `R replay spec`.
- Step 3: `<qa>/runs/<runId>/duckwright.spec.ts` exists, and the footer contains `R replay spec`.
- Step 4: info toast `opening <runId>/duckwright.spec.ts in the Playwright Inspector`, and the Inspector shows that file's source (a test that goes to `https://example.com`).
- Step 5: info toast `Playwright Inspector closed for <runId>`.

### TS-4: A spec that fails reports its exit code and the folder to debug in

**Contract:** C1, C4 · **Criteria:** SC1, SC5 · **Type:** UI · **Priority:** P2

**Preconditions:** Clean state with RUN-BADSPEC. TUI started.

**Steps:**
1. Press `tab`, select RUN-BADSPEC, press `R`.
2. In the Inspector, click **Resume** until the test fails and the browser closes.

**Expected:**
- Step 1: info toast `opening 20261007-090100-replay-badspec/duckwright.spec.ts in the Playwright Inspector`.
- Step 2: info toast `Playwright exited with code 1 for 20261007-090100-replay-badspec; run "npx playwright test duckwright.spec.ts --debug" in <abs>/runs/20261007-090100-replay-badspec to see why`, where `<abs>` is the absolute path of `<qa>` (for example `/home/qa/dw-qa`).
- Duckwright keeps running.

### TS-5: The API route replays a past run's spec

**Contract:** C3, C1 · **Criteria:** SC2 · **Type:** API · **Priority:** P1

**Preconditions:** Clean state with RUN-PASS. Web UI started on port 4173, the browser tab open on the printed URL. `ID` = the `id` of `Replay QA pass fixture` from `/api/state`.

**Steps:**
1. `curl -s -w '\n%{http_code}\n' -X POST -H "Cookie: dw_token_$PORT=$TOKEN" -H "Origin: http://127.0.0.1:$PORT" http://127.0.0.1:$PORT/api/tasks/$ID/replay`
2. Close the Inspector after clicking **Resume** until the browser closes.

**Expected:**
- Step 1: body `{"ok":true}`, status `200`.
- The Inspector opens with SPEC-PASS.
- The web UI shows the info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector`.
- Step 2: the web UI shows the info toast `Playwright Inspector closed for 20261007-090000-replay-pass`.

### TS-6: The web button is shown with the title that matches `hasSpec`, and opens the Inspector

**Contract:** C5, C2 · **Criteria:** SC2 · **Type:** UI · **Priority:** P1

**Preconditions:** Clean state with RUN-PASS and RUN-NOSPEC. Web UI started and open.

**Steps:**
1. Open the History tab and select `Replay QA pass fixture`. Look at the task card's action row and hover **Replay spec**.
2. Run the `/api/state` command and read `hasSpec` for both fixtures.
3. Select `Replay QA failed fixture` and hover **Replay spec**.
4. Select `Replay QA pass fixture` again and click **Replay spec**.
5. Click **Resume** in the Inspector until the browser closes.

**Expected:**
- Step 1: a button labelled `Replay spec` sits in the action row after **Options**, enabled, with the title `Open duckwright.spec.ts in the Playwright Inspector`.
- Step 2: `hasSpec` is `true` for `Replay QA pass fixture` and `false` for `Replay QA failed fixture`.
- Step 3: the button is shown and enabled (not greyed out), with the title `No spec yet: only a passed run writes duckwright.spec.ts`.
- Step 4: the Inspector opens with SPEC-PASS. The only toast is the server's info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector`; no extra client toast appears.
- Step 5: info toast `Playwright Inspector closed for 20261007-090000-replay-pass`.

### TS-7: A task that never ran gives "has not run yet" (TUI, web, API)

**Contract:** C1, C3, C4, C5 · **Criteria:** SC3 · **Type:** UI / API · **Priority:** P2

**Preconditions:** Clean state, empty `<qa>/runs/`.

**Steps:**
1. Start the TUI. Press `i`, type TASK-NEVER, press `⏎`. Keep it selected; read the footer, then press `R`.
2. Run `pgrep -f "duckwright.spec.ts --debug" | wc -l`. Quit the TUI.
3. Start the web UI. Add TASK-NEVER with `i`. Select it and click **Replay spec**.
4. With `ID` = its id from `/api/state`, run the curl command from TS-5, step 1.

**Expected:**
- Step 1: the footer does not show `R replay spec`. Pressing `R` shows the error toast `Replay QA never run has not run yet` (with `<task name>` as shown in the task row, if Duckwright shortens it).
- Step 2: `0`.
- Step 3: the button is shown; the click shows the error toast `<task name> has not run yet`. No Inspector opens.
- Step 4: status `409`, body `{"ok":false,"error":"<task name> has not run yet"}`.

### TS-8: A failed run without a spec gives "no spec" (TUI, web, API)

**Contract:** C1, C3, C4, C5 · **Criteria:** SC3 · **Type:** UI / API · **Priority:** P1

**Preconditions:** Clean state with RUN-NOSPEC.

**Steps:**
1. Start the TUI, press `tab`, select `Replay QA failed fixture`, press `R`. Run the `pgrep` count. Quit.
2. Start the web UI, select the same past run, click **Replay spec**.
3. Run the curl command from TS-5, step 1 with its id.

**Expected:**
- Step 1: error toast `no spec for run 20261007-090200-replay-nospec: only a passed run writes duckwright.spec.ts`; `pgrep` count `0`.
- Step 2: error toast with the same text. No Inspector opens.
- Step 3: status `409`, body `{"ok":false,"error":"no spec for run 20261007-090200-replay-nospec: only a passed run writes duckwright.spec.ts"}`.

### TS-9: A spec deleted after the screen loaded gives "no spec"

**Contract:** C1, C4, C5, C2 · **Criteria:** SC3 · **Type:** UI · **Priority:** P2

**Preconditions:** Clean state with RUN-DELETE.

**Steps:**
1. Start the TUI, press `tab`, select `Replay QA delete fixture`. Confirm the footer shows `R replay spec`.
2. In another shell, delete `<qa>/runs/20261007-090300-replay-delete/duckwright.spec.ts`.
3. Press `R`. Run the `pgrep` count. Quit.
4. Recreate the spec, start the web UI, select the same run, delete the spec again, click **Replay spec**.

**Expected:**
- Step 3: error toast `no spec for run 20261007-090300-replay-delete: only a passed run writes duckwright.spec.ts`; `pgrep` count `0`.
- Step 4: the same text as an error toast; no Inspector opens.

### TS-10: The API-only spec is never replayed

**Contract:** C1, C3 · **Criteria:** SC3 · **Type:** API · **Priority:** P2

**Preconditions:** Clean state with RUN-APIONLY. Web UI started.

**Steps:**
1. Read `hasSpec` for `Replay QA apionly fixture` in `/api/state`.
2. Run the curl command from TS-5, step 1 with its id.

**Expected:**
- Step 1: `false`.
- Step 2: status `409`, body `{"ok":false,"error":"no spec for run 20261007-090400-replay-apionly: only a passed run writes duckwright.spec.ts"}`. No Inspector opens.

### TS-11: Unknown task id

**Contract:** C3, C1 · **Criteria:** SC3 · **Type:** API · **Priority:** P2

**Preconditions:** Web UI started, any state.

**Steps:**
1. `curl -s -w '\n%{http_code}\n' -X POST -H "Cookie: dw_token_$PORT=$TOKEN" -H "Origin: http://127.0.0.1:$PORT" http://127.0.0.1:$PORT/api/tasks/999999/replay`

**Expected:**
- Body `{"ok":false,"error":"no such task"}`, status `404`. `pgrep` count `0`.

### TS-12: `@playwright/test` missing is reported, Duckwright keeps running

**Contract:** C1, C3, C4 · **Criteria:** SC5 · **Type:** UI / API · **Priority:** P1

**Preconditions:** Clean state with RUN-PASS. Rename `<repo>/node_modules/@playwright/test` to `<repo>/node_modules/@playwright/test.qa-off`.

**Steps:**
1. Start the TUI, press `tab`, select RUN-PASS, press `R`.
2. Press `?`, then `esc`, to check the TUI still responds. Quit.
3. Start the web UI, select RUN-PASS, click **Replay spec**.
4. Run the curl command from TS-5, step 1 with its id.
5. Quit, then rename the folder back to `@playwright/test`.

**Expected:**
- Step 1: error toast `cannot replay: @playwright/test is not installed with Duckwright; reinstall duckwright`. No Inspector opens; `pgrep` count `0`.
- Step 2: help opens and closes; Duckwright has not exited.
- Step 3: the same text as an error toast.
- Step 4: status `409`, body `{"ok":false,"error":"cannot replay: @playwright/test is not installed with Duckwright; reinstall duckwright"}`.

### TS-13: A second trigger while the Inspector is open spawns nothing; after closing, it works again

**Contract:** C1, C3, C4, C5 · **Criteria:** SC4 · **Type:** UI / API · **Priority:** P1

**Preconditions:** Clean state with RUN-PASS.

**Steps:**
1. Start the TUI, press `tab`, select RUN-PASS, press `R`. Wait for the Inspector to open and leave it paused.
2. Press `R` again. Run the `pgrep` count.
3. Close the Inspector (click **Resume** until the browser closes). Wait for the close toast.
4. Press `R` again. Then close the Inspector and quit.
5. Start the web UI, select RUN-PASS, click **Replay spec**, wait for the Inspector, then click **Replay spec** again.
6. Run the curl command from TS-5, step 1 with its id while the Inspector is still open. Run the `pgrep` count.

**Expected:**
- Step 2: error toast `the spec of run 20261007-090000-replay-pass is already open in the Playwright Inspector`; `pgrep` count `1`.
- Step 3: info toast `Playwright Inspector closed for 20261007-090000-replay-pass`.
- Step 4: info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector` and a new Inspector opens.
- Step 5: the second click shows the error toast `the spec of run 20261007-090000-replay-pass is already open in the Playwright Inspector`.
- Step 6: status `409`, body `{"ok":false,"error":"the spec of run 20261007-090000-replay-pass is already open in the Playwright Inspector"}`; `pgrep` count `1`.

### TS-14: A live task cannot be replayed

**Contract:** C1, C3, C4, C5 · **Criteria:** SC3 · **Type:** UI / API · **Priority:** P2

**Preconditions:** Clean state, empty `<qa>/runs/`.

**Steps:**
1. Start the TUI. Create TASK-LIVE (start, then pause with `p`). Read the footer. Press `R`.
2. Press `?` and read the help. Close it, stop the task with `s`, quit.
3. Start the web UI. Create TASK-LIVE there (start, then pause). Look at the selected task's action row.
4. Run the curl command from TS-5, step 1 with its id.
5. Stop the task.

**Expected:**
- Step 1: the footer does not contain `R replay spec`. `R` shows no toast and opens nothing (`pgrep` count `0`).
- Step 2: help still lists `R` `replay spec` once.
- Step 3: no **Replay spec** button.
- Step 4: status `409`, body `{"ok":false,"error":"<task name> is still running; replay its spec when it finishes"}`, with `<task name>` the task's `name` in `/api/state`.

### TS-15: `R` works from the detail view

**Contract:** C4 · **Criteria:** SC1 · **Type:** UI · **Priority:** P3

**Preconditions:** Clean state with RUN-PASS. TUI started.

**Steps:**
1. Press `tab`, select RUN-PASS, press `⏎` to open its details. Read the footer.
2. Press `R`. Close the Inspector afterwards.

**Expected:**
- Step 1: the footer contains `R replay spec`.
- Step 2: info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector` and the Inspector opens.

### TS-16: `R` with no task selected does nothing

**Contract:** C4 · **Criteria:** SC1 · **Type:** UI · **Priority:** P3

**Preconditions:** Clean state, empty `<qa>/runs/`. TUI started with no tasks (Tasks tab empty).

**Steps:**
1. Press `R`.

**Expected:**
- No toast, no Inspector, no change on screen, and the footer does not contain `R replay spec`.

### TS-17: The request body is ignored; the server picks the spec path

**Contract:** C3 · **Criteria:** SC2 · **Type:** API · **Priority:** P2

**Preconditions:** Clean state with RUN-PASS. Web UI started. `ID` = its id.

**Steps:**
1. `curl -s -w '\n%{http_code}\n' -X POST -H "Cookie: dw_token_$PORT=$TOKEN" -H "Origin: http://127.0.0.1:$PORT" -H "Content-Type: application/json" -d '{"path":"/etc/passwd","spec":"../../x.spec.ts"}' http://127.0.0.1:$PORT/api/tasks/$ID/replay`

**Expected:**
- Body `{"ok":true}`, status `200`.
- The Inspector shows SPEC-PASS (`Replay QA pass fixture`), not any other file.
- Info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector`.

### TS-18: Access: callers without the token or with another Origin are refused

**Contract:** C3 · **Criteria:** SC2 · **Type:** API · **Priority:** P2

**Preconditions:** Clean state with RUN-PASS. Web UI started. `ID` = its id.

**Steps:**
1. Without a cookie: `curl -s -w '\n%{http_code}\n' -X POST -H "Origin: http://127.0.0.1:$PORT" http://127.0.0.1:$PORT/api/tasks/$ID/replay`
2. With the cookie and `-H "Origin: http://evil.example"` instead of the right Origin.
3. With the cookie and the right Origin, plus `-H "Host: evil.example:$PORT"`.
4. Run the `pgrep` count.

**Expected:**
- Step 1: status `401`, body `{"ok":false,"error":"unauthorized"}`.
- Step 2: status `403`, body `{"ok":false,"error":"forbidden"}`.
- Step 3: status `403`, body `{"ok":false,"error":"forbidden"}`.
- Step 4: `0`; no toast in the web UI.
- The allowed caller is TS-5.

### TS-19: Wrong method

**Contract:** C3 · **Criteria:** SC2 · **Type:** API · **Priority:** P3

**Preconditions:** Web UI started with RUN-PASS. `ID` = its id.

**Steps:**
1. `curl -s -w '\n%{http_code}\n' -H "Cookie: dw_token_$PORT=$TOKEN" http://127.0.0.1:$PORT/api/tasks/$ID/replay`

**Expected:**
- Status `405`, body `{"ok":false,"error":"method not allowed"}`. No Inspector opens.

### TS-20: The Inspector outlives Duckwright, other runs replay in parallel, and a re-run replays its newest spec

**Contract:** C1, C4 · **Criteria:** SC1 · **Type:** UI · **Priority:** P3

**Preconditions:** Clean state with RUN-PASS and RUN-BADSPEC.

**Steps:**
1. Start the TUI, press `tab`, select RUN-PASS, press `R`. Then select RUN-BADSPEC and press `R`. Run the `pgrep` count.
2. Press Ctrl-C (confirm the quit if asked). Run the `pgrep` count.
3. Close both Inspectors.
4. Reset. Copy the TASK-REAL run folder from TS-3 into `<qa>/runs/` (or do one passed TASK-REAL run), start the TUI, select that past run on History and press `space` to run it again. Wait until it passes; note the new folder `<runId2>`.
5. Press `R`.

**Expected:**
- Step 1: two info toasts (`opening 20261007-090000-replay-pass/…` and `opening 20261007-090100-replay-badspec/…`), two Inspector windows, `pgrep` count `2`.
- Step 2: Duckwright exits; `pgrep` count is still `2` and both Inspector windows stay open. No toast after the exit.
- Step 5: info toast `opening <runId2>/duckwright.spec.ts in the Playwright Inspector` (the new run's folder, not the original past run's).

### TS-21: `@playwright/test` is a runtime dependency

**Contract:** C6 · **Criteria:** SC6 · **Type:** File · **Priority:** P1

**Preconditions:** Branch checkout.

**Steps:**
1. `jq '.dependencies' <repo>/package.json`
2. `cd <repo> && npm ls @playwright/test`

**Expected:**
- Step 1: an object with exactly the keys `@playwright/test`, `ink` and `react`, with `"@playwright/test": "^1.63.0"`.
- Step 2: lists `@playwright/test@1.x` (1.63.0 or newer) as a direct dependency with no `missing` or `invalid` marker.

### TS-22: Installed package runs replay without a global Playwright

**Contract:** C6, C1 · **Criteria:** SC6, SC1 · **Type:** CLI · **Priority:** P2

**Preconditions:** No global Playwright: `npm ls -g @playwright/test playwright` shows neither. `<qa>` contains RUN-PASS and no `node_modules`.

**Steps:**
1. `cd <repo> && npm pack`, then `npm install -g ./duckwright-0.3.2.tgz` (use the file name `npm pack` printed).
2. `cd <qa> && duckwright`, press `tab`, select RUN-PASS, press `R`.
3. Close the Inspector, quit, and `npm uninstall -g duckwright`.

**Expected:**
- Step 2: info toast `opening 20261007-090000-replay-pass/duckwright.spec.ts in the Playwright Inspector`; the Inspector opens with SPEC-PASS (the spec's `@playwright/test` import resolves).

### TS-23: README documents the feature

**Contract:** C7 · **Criteria:** SC6 · **Type:** File · **Priority:** P2

**Preconditions:** Branch checkout.

**Steps:**
1. Open `<repo>/README.md` and read: the TUI key table, the Web mode section, "Turning a run into a regression test", the Features list and the badges.

**Expected:**
- The TUI key table has a row for `R` with `Open the selected run's spec in the Playwright Inspector`.
- The Web mode paragraph mentions the **Replay spec** button and lists `R` among the TUI-only keys.
- "Turning a run into a regression test" step 3 mentions replaying from the TUI/web.
- The process is described: Playwright Inspector, one per run, output discarded, needs a display, and needs Playwright's browser (`npx playwright install chromium` if the close toast shows a non-zero exit).
- The "Minimal dependencies" bullet and the dependencies badge name `@playwright/test` as a runtime dependency for spec replay.

## Regression

### TS-R1: The existing TUI keys still work on a past run

**Contract:** C4 (unchanged keys) · **Criteria:** SC1 · **Type:** UI · **Priority:** P3

**Preconditions:** Clean state with RUN-PASS. TUI started.

**Steps:**
1. Press `?` and read the help.
2. Press `esc`, then `tab`, select RUN-PASS, and press `⏎`.
3. Press `r` (lowercase) and `p` on the selected past run.

**Expected:**
- Step 1: help still lists `i`, `tab`, `P`, `space`, `⏎`, `p`, `s` and `q` with their README descriptions, plus `R` `replay spec` once.
- Step 2: the run's timeline shows, as before.
- Step 3: neither key opens an Inspector or shows a replay toast (`pgrep` count `0`).

### TS-R2: The web task card's existing buttons are unchanged

**Contract:** C5 (action row) · **Criteria:** SC2 · **Type:** UI · **Priority:** P3

**Preconditions:** Clean state with RUN-PASS. Web UI started.

**Steps:**
1. Select RUN-PASS on the History tab and read the action row.
2. Click **Options**.

**Expected:**
- Step 1: the same buttons, in the same order, as the `main` branch build shows for the same run (check once with a `main` build), with **Replay spec** added right after **Options**.
- Step 2: the options panel opens as before; no replay toast and no Inspector.

### TS-R3: `duckwright export` still writes both specs

**Contract:** none (existing surface next to the replayed file) · **Criteria:** SC6 · **Type:** CLI · **Priority:** P3

**Preconditions:** The TASK-REAL run folder `<runId>` from TS-3 in `<qa>/runs/`.

**Steps:**
1. `cd <qa> && node <repo>/dist/bin.js export runs/<runId>`
2. `node <repo>/dist/bin.js export --api runs/<runId>`

**Expected:**
- Step 1 writes `runs/<runId>/duckwright.spec.ts`; step 2 writes `runs/<runId>/duckwright.api.spec.ts`, as described in the README.
- No Inspector opens.

### TS-R4: `npm test` passes

**Contract:** C6 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1

**Preconditions:** Branch checkout after `npm install`.

**Steps:**
1. `cd <repo> && npm test`

**Expected:**
- Exit code `0`; the typecheck and every `node --test` test pass.

## Out of scope

- Unit and integration tests (run as checks during implementation).
- `playwright test --ui` (UI mode) and a mode picker.
- A `duckwright replay` CLI subcommand.
- Tracking or killing the Playwright process when Duckwright quits.
- Replaying `duckwright.api.spec.ts` (TS-10 only checks that it is refused).
- Fixing or re-exporting a missing spec; running specs headless or capturing their results.
- A web keyboard shortcut for replay.
- Detecting a missing display or a missing Playwright browser before spawning.
- Showing "replay open" state in the UIs.
- Whether `@playwright/test` resolves from a folder under a `package.json` with `"type": "module"`: the spec says the outcome is not guaranteed (Error handling, last-but-two row), so there is no expected result to check.
