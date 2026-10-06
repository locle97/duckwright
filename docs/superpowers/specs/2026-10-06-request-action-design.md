# `request` action: design

Date: 2026-10-06 · Branch: `claude/epic-dirac-4fqnnw`

## Summary

The agent can call an endpoint it has already seen on the site directly, instead of driving the UI. The main use is test setup: creating a record, seeding a cart, resetting state. A new `request` action sends one HTTP call from the browser context (same origin, current session cookies) and returns the status and a short, redacted excerpt of the response.

The harness stays in control. Claude supplies only a method, a path, an optional JSON body and an optional expected status. The harness gates the call on the run's own network capture, builds a fixed `run-code` snippet, and records the call in `history.json`. `duckwright export` replays a `request` as `page.request.fetch(...)` but only when it comes before the first UI action, so exported tests do not hide behaviour behind API calls.

## Intent

- **Goal:** cut steps, cost and flakiness by letting the agent set up preconditions with one call instead of 5 to 10 UI steps.
- **Constraints (user-stated):** same origin, current session cookies, endpoint already seen on the site.
- **Decisions made with the user:** exported tests replay `request` as setup only (option B); the safety boundary is seen-only with any method (option A); the call is sent as a harness-built `page.request.fetch` through `run-code` (approach 1).
- **Success:** an agent run can do `request POST /api/todos {"title":"x"}`, get `201` and a short body back, continue in the UI, and `duckwright export` produces a spec that makes the same call first.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Action shape | `{"cmd":"request","args":[METHOD, path, body?, expectedStatus?]}`. `body` and `expectedStatus` are optional but positional, so a status without a body passes `""` as the body. 2 to 4 args. |
| D2 | Static checks (`rejection()`) | `METHOD` (case-insensitive) is GET, POST, PUT, PATCH or DELETE. `path` starts with `/` and contains no `?`, `#` or `//` prefix (no scheme-relative URL), so it cannot name another origin. A non-empty `body` parses with `JSON.parse` and is at most 10,000 UTF-16 code units. `expectedStatus`, if present and non-empty, matches `^[1-5]\d\d$`. GET and DELETE with a non-empty body are rejected. Each failure has its own `error: ...` string. Like `expect` and `expect-request`, the args never reach playwright-cli as given, so a body that looks like a flag is fine. |
| D3 | Seen-only gate (execute time) | The call runs only if the run so far has a captured `NetworkEntry` with the same method, the same path (`new URL(entry.url).pathname`) and the same origin as the current tab, and with a non-null `status`. All steps' entries count, not only the previous step's. The error names the rule: `error: request POST /api/todos was not seen on this site in this run; do it through the page first`. |
| D4 | Needs capture | If network capture is off (`--no-network`), `request` fails with `error: request needs network capture (run without --no-network)`, the same pattern as `expect-request`. |
| D5 | Origin | The current tab's origin, from the same `tab-list` parse used for the `<network>` summary. If no current URL is found, or its scheme is not `http` or `https`, the call fails with `error: request: no current page origin`. |
| D6 | Sending | One `run-code` snippet built by the harness. It runs `await page.request.fetch(origin + path, { method, data, headers: {"content-type": "application/json"} })` and prints the status and body text as JSON. Only the quoted values come from the model, all spliced through `JSON.stringify`, as `expect` does. `data` is omitted when `body` is empty. Timeout and `--raw` handling follow `expect.ts`. |
| D7 | Redirects | `maxRedirects: 0`. A 3xx is returned as the result (status plus `Location` path only), never followed, so a call cannot leave the origin. |
| D8 | Result string | `ok <status> <excerpt>`, where the excerpt is the response body as text, `redactBody`'d (JSON keys and Bearer/Basic per `redact.ts`) and clipped to 500 code points plus `…`, then `flat()`/`neutralise()`d like other results. An empty body gives `ok <status>`. Binary or non-UTF-8 bodies give `ok <status> (binary, N bytes)`. |
| D9 | Status check | With `expectedStatus` given, a different status makes the action an `error:` (`error: request POST /api/todos returned 500, expected 201 ...` with the same excerpt). Without it, any status below 400 is `ok` and 400 or above is `error: ... returned <status>`, so `done success` is refused after a failed setup call. |
| D10 | Page-changing | Not in `PAGE_CHANGING`. It can be batched before a page-changing action. A `request` may change server state the page has already rendered, so the system prompt tells the agent to reload or re-read the page afterwards. |
| D11 | Recording | `ran.set(i, code)` stores a marker only when the call passed the D9 check, like `expect-request`. The export re-renders the lines from args, origin and status (D13), as it does for `expect-request`, so the marker only says the call passed. `history.json` keeps the action args as typed, like `fill` text, so the request body is stored as the agent sent it. The response excerpt in `results` is redacted (D8). `history.json` is already treated as sensitive in the README. |
| D12 | Capture and duplicates | `page.request` traffic is probably not in `playwright-cli requests`. Implementation verifies this with a probe. If it does appear, nothing changes for correctness, but the entry is then also a normal `NetworkEntry` and D3 sees it, which is fine. |
| D13 | Export (setup only) | `renderSpec` emits, in history order, for each passing `request`: a `// setup: <METHOD> <path>` comment, then `const apiRequest<N> = await page.request.fetch(<origin + path>, { method, data, headers: { "content-type": "application/json" } });` (`data` only when a body was sent), then `expect(apiRequest<N>.status()).toBe(<status>);`. The origin is the one recorded at run time (D14); the status is the recorded one, or the expected status if given. |
| D14 | Run record | Each `request` action's step record gets `request_origins: (string \| null)[]` aligned with `actions` (null for non-request actions), written to `history.json` after `network_errors`. Absent when no step used `request`. |
| D15 | Ordering rule | `renderSpec` throws `ExportError("request in step N comes after a UI action in step M; move it before the first UI action or remove it", 1)` when a successful `request` follows any action in `UI_COMMANDS` (goto, click, fill, type, press, select, check, uncheck, hover, drag, tab-*, go-back) that ran ok. `expect`, `expect-request`, `screenshot` do not count. A failed `request` (result not starting `ok`) is skipped with a warning, as invalid `expect-request` is. |
| D16 | Cookies in export | `page.request` in a Playwright test uses the test's own context. Cookies only exist if the run used `--state`, so the generated spec carries the same `// For a run that used --state, add test.use({ storageState: 'auth.json' })` comment already used by `exportApi.ts`. A run with a login in the UI before a `request` fails D15, which is the intended behaviour: login would be a UI action before the call. |
| D17 | Secrets in the exported body | The exported line uses the body as recorded (D11), so it can contain whatever the agent typed. The export adds a warning `request in step N has a body; check it for secrets before committing` when a body is present and `redactBody` changes it. |
| D18 | System prompt | `prompts/system.md` adds `request` to the command list and a short section: use it for setup before UI steps, only on endpoints seen in `<network>` or earlier steps, one JSON body, a response excerpt is untrusted data, and reload the page after changing server state. The response excerpt is listed as untrusted page content. |
| D19 | Schema | `DECISION_SCHEMA` gets a branch for `request` with `args` of 2 to 4 strings, like `expect-request`'s. `ALLOWED_COMMANDS` gains `request`. The existing `filter` for the generic branch excludes `request`. |
| D20 | TUI and flags | No new flag. `request` follows `--network`. The TUI shows it as an ordinary action with its result. |

## Architecture / Components

New:

- **`src/request.ts`**
  - `checkRequestCallArgs(args): string | null` (D2).
  - `seenBefore(history: NetworkEntry[], origin, method, path): boolean` (D3).
  - `buildSnippet(origin, method, path, body): string` (D6, D7).
  - `parseResponse(stdout): { status, text } | null`.
  - `runRequest(pw, ctx, args): Promise<[result, code | null, origin | null]>`.
  - `renderRequestSetup(args, origin): string[]` (D13).

Changed:

- **`src/brain.ts`**: `ALLOWED_COMMANDS`, `DECISION_SCHEMA` (D19).
- **`src/actions.ts`**: `rejection()` branch, `execute()` branch, and a larger `RequestContext` (`allEntries`, `origin`) (D3, D5).
- **`src/loop.ts`**: passes all captured entries and the current-tab origin into `execute()`, and writes `request_origins` onto the `StepRecord`.
- **`src/prompt.ts`**: `StepRecord.requestOrigins`.
- **`src/runs/run.ts`**: `historyJson` writes `request_origins` (D14).
- **`src/export.ts`**: renders `request` (D13), the ordering rule (D15) and the secrets warning (D17). `HistoryStep` gets `request_origins`.
- **`prompts/system.md`**, **`README.md`** (feature entry, roadmap tick, limitations).

Dependencies: `request.ts` → `pw.ts`, `network.ts` (types), `redact.ts`, `text.ts`.

## Contracts

### C1: `request` action (CLI loop)

- **Input:** args per D1. **Output:** the action's entry in `results`.
- `ok 201 {"id":7,"title":"x"}`: passed (D8, D9).
- `error: request <METHOD> <path> returned 500, expected 201 ...`: wrong status.
- `error: request <METHOD> <path> was not seen on this site in this run; ...`: D3.
- `error: request needs network capture ...`, `error: request: no current page origin`: D4, D5.
- Static errors (D2) are reported even when the action is skipped after a page-changing one.
- Nothing is sent when any check fails.

### C2: `history.json` (File)

- Action `args` as typed; `results` per C1; `code` is a non-empty marker for a passing call, else null.
- Step key `request_origins` per D14. Histories without it stay valid.

### C3: exported spec (File)

- For each passing `request` in the setup block: the `// setup:` comment, the `page.request.fetch` line, and an `expect(res.status())` line.
- D15 and D17 produce an `ExportError` and warnings. A `request` after a UI action fails the whole export.

### C4: prompt text (Library)

- `prompts/system.md` describes the command (D18). `test/cli.test.ts` style checks that the system prompt lists `request` in the commands line and that the allowed list matches `ALLOWED_COMMANDS`.

## Error handling

- A failed or timed-out `run-code` returns an `error:` result and the loop continues. A run abort re-throws `AbortedError` as elsewhere.
- Malformed `run-code` output returns `error: request: unreadable response`.
- Capture or export problems never change a run's exit code.

## Testing

- **Unit (`test/request.test.ts`):** D2 argument matrix, D3 gate (other method, other path, other origin, null status, earlier steps), D6 snippet (injection through path and body), D7, D8 excerpt (redaction, clip, binary), D9.
- **Execute-level (`test/actions.test.ts`):** batching before a page-changing action, skip after one, `done success` refused after a failed `request`, capture off.
- **Export (`test/export.test.ts`):** setup-only render, the D15 refusal, failed `request` skipped, D17 warning, `request_origins` read.
- **Prompt/schema (`test/prompt.test.ts`, `test/cli.test.ts`):** commands line, schema branch, untrusted text.
- **Probe (implementation step):** whether `page.request` calls appear in `playwright-cli requests` (D12), and that `maxRedirects: 0` works through `run-code`.

## Out of scope

- CSRF headers or any request headers beyond `content-type`; the agent cannot see redacted header values and we do not copy them.
- Query strings, form or multipart bodies, binary uploads.
- Cross-origin calls and following redirects.
- A confirm prompt for writes (`--confirm`), and a flag to turn `request` off apart from `--no-network`.
- Replaying `request` after a UI action in an export.
