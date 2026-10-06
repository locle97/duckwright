# Network Capture with Redaction Implementation Plan

**Goal:** After each executed step, capture the page's API-like requests via `playwright-cli`, redact secrets, write them to `runs/<id>/network/<id>/`, add a `network` array to each `history.json` step, and show the agent a `<network>` summary of its last step's calls.
**Architecture:** Two new modules: `src/redact.ts` (pure redaction, no I/O, no imports) and `src/network.ts` (pure parsers of `playwright-cli` text output, the per-step `captureStep` that runs commands and writes files, and the `networkSummary` prompt text). `src/loop.ts` calls them around `execute()`; `prompt.ts`, `text.ts`, `runs/run.ts`, `export.ts`, `args.ts`, `taskfile.ts`, `prompts/system.md` and `README.md` get small additions.
**Tech Stack:** TypeScript (Node >= 22.18, type stripping), `node:test`, `node:fs`, no new dependencies.
**Spec:** `docs/superpowers/specs/2026-10-06-network-capture-redacted-history-design.md`

## Global Constraints

- All tests run with `node --test` on fakes; no real browser, no network.
- Node standard library only for new modules. `redact.ts` depends on nothing.
- `[REDACTED]`, written literally (not URL-encoded) everywhere, including inside URL queries and form bodies.
- Everything is redacted in memory before any file is written, any record is built, or anything is emitted as an event. Raw data exists only in local variables, plus the short-lived `response-body.raw`.
- Any failure of a capture command (non-zero exit, timeout, runner exception other than `AbortedError`) or of a file write adds a string to the step's `network_errors` and capture continues where it can. `AbortedError` is re-thrown.
- Capture errors never change the run's exit code or outcome.
- `AgentOptions.network` defaults to `false`; `RunArgs.network` defaults to `true`.
- With capture off, or on brain-error steps: neither `network` nor `network_errors` is present, and with capture off no `network/` folder is created.
- `duckwright export` output, TUI screens, the console report and the `events.jsonl` format are unchanged.
- Split all `playwright-cli` stdout into lines with `/\r?\n/`. The General `status:` line of `request <n>` is ignored: `RequestDetails` has no status field (D20).

## Review Focus

1. **Secrets leaking into any written file or the prompt (SC2).** Pinned in Task 3 by `capture_no_raw_secret_in_any_file` (walks every file under `network/` and asserts none of the raw secrets appear) and in Task 1 by the per-rule tests.
2. **`response-body.raw` lifecycle (D8).** Folder exists before `response-body` runs; missing file after exit 0 is an error; `.raw` never survives. Pinned in Task 3 by `capture_folder_exists_before_response_body`, `capture_response_body_no_file_written`, `capture_no_raw_left_behind`.
3. **Hint detection is strict (C6).** Only lines whose trimmed text starts with `` Run ` `` count; a header value containing `response-body 3` is not a hint. Pinned in Task 2 by `details_hint_only_from_run_lines`.
4. **Status comes only from the list line (D20).** Pinned in Task 2 by `list_failed_load` and in Task 3 by `capture_status_from_list_line`.
5. **Pending initial-clear error (D2/D3).** Skips brain-error steps, lands first in the first executed step, is dropped if none executes. Pinned in Task 5 by `network_initial_clear_error_skips_brain_error_step` and `network_initial_clear_error_dropped`.

---

### Task 1: Redaction module

**Files:**
- Create: `src/redact.ts`
- Test: `test/redact.test.ts`

**Contracts:** C1 (url), C2 (header and body redaction rules) — D11–D17

**Interfaces:**
- Consumes: nothing
- Produces (all exported from `src/redact.ts`):
  - `REDACTED = "[REDACTED]"`
  - `interface Header { name: string; value: string }`
  - `isSecretHeader(name: string): boolean` (D12)
  - `isSecretKey(key: string): boolean` (D13)
  - `redactText(text: string): string` (D14)
  - `redactUrl(url: string): string` (D17)
  - `redactBody(text: string, contentType: string | null): string` (D16 if form, else D15; then D14)
  - `redactHeaders(headers: Header[]): Header[]` (new array; order, names and duplicates preserved)

**Checks:** `node --test test/redact.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/redact.test.ts`:
  - `secret_header_exact_names`: `isSecretHeader` true for `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, and for `Authorization` / `COOKIE` (case-insensitive).
  - `secret_header_substrings`: true for `x-auth-token`, `x-client-secret`, `x-session-id`, `x-my-api-key`, `x-api_key`, `x-apikey`, `x-password`, `x-csrf-token`, `x-xsrf-token`, `:authority`, `x-author`; false for `content-type`, `accept`, `user-agent`.
  - `secret_key_contains_and_equals`: `isSecretKey` true for `password`, `user_password`, `passwd`, `client_secret`, `access_token`, `api-key`, `apiKey`, `csrf`, `xsrfToken`, `credentials`, `private_key`, `session_id`, `cookie`, `auth`, `Authorization`, `session`, `sid`, `pin`, `OTP`; false for `author`, `user`, `pinned`, `sidebar`, `sessions_count`, `email`.
  - `json_body_nested`: `redactBody('{"user":"a","password":"hunter2","nested":{"token":"t1"},"list":[{"apiKey":123},{"pin":{"x":1}}]}', "application/json")` equals `'{"user":"a","password":"[REDACTED]","nested":{"token":"[REDACTED]"},"list":[{"apiKey":"[REDACTED]"},{"pin":"[REDACTED]"}]}'` (compact `JSON.stringify`).
  - `json_body_unchanged_kept_byte_for_byte`: `'{ "user" : "a" }'` returned identical (spacing preserved).
  - `json_body_invalid_is_text`: `'{"password": "x"'` (unparseable) returned unchanged; `'{bad Bearer abc123'` becomes `'{bad Bearer [REDACTED]'`.
  - `json_scalar_not_walked`: `'"password"'` and `'42'` returned unchanged.
  - `form_body`: `redactBody("user=a&password=hunter2&x=%41", "application/x-www-form-urlencoded; charset=UTF-8")` → `"user=a&password=[REDACTED]&x=%41"`; `"my+token=1&pass%77ord=2&%E0%A4%A=3&flag"` → `"my+token=[REDACTED]&pass%77ord=[REDACTED]&%E0%A4%A=3&flag"` (`+` decodes to space, `%77`→`w`, malformed escape uses raw key and is kept, a part with no `=` kept).
  - `form_rule_needs_content_type`: `redactBody("password=x", null)` and with `"text/plain"` → unchanged.
  - `url_query`: `redactUrl("https://h/p?token=abc&q=1#frag?password=x")` → `"https://h/p?token=[REDACTED]&q=1#frag?password=x"`; `redactUrl("https://h/p")` unchanged; `redactUrl("https://h/p#a?token=1")` unchanged (no `?` before `#`).
  - `bearer`: `redactText("Authorization: Bearer abc123")` → `"Authorization: Bearer [REDACTED]"`; `"bearer eyJ.a-b_c~d+e/f=="` → `"bearer [REDACTED]"`; `"BEARER x"` → `"BEARER [REDACTED]"`; `"a bearer"` (no token) unchanged.
  - `basic`: `redactText("Basic dXNlcjpwYXNz")` → `"Basic [REDACTED]"`; `"basic Plan"` and `"Basic Plan includes"` unchanged; `"Basic aGVsbG8="` (decodes to `hello`, no colon) unchanged.
  - `headers`: `redactHeaders([{name:"Authorization",value:"Bearer x"},{name:"X-Trace",value:"Bearer abc"},{name:"Referer",value:"https://h/?sid=9&a=1"},{name:"location",value:"/next?token=z"},{name:"Accept",value:"*/*"},{name:"accept",value:"x"}])` → values `["[REDACTED]","Bearer [REDACTED]","https://h/?sid=[REDACTED]&a=1","/next?token=[REDACTED]","*/*","x"]`, names unchanged, duplicates kept, input array not mutated.
- [ ] **Step 2: Run it**: `Run: node --test test/redact.test.ts` / `Expected: FAIL (cannot find module ../src/redact.ts)`
- [ ] **Step 3: Implement** `src/redact.ts`. Notes beyond the signatures:
  - `isSecretKey`: normalise with `key.toLowerCase().replace(/[-_]/g, "")`; contains-list `password, passwd, secret, token, apikey, csrf, xsrf, credential, privatekey, sessionid, cookie`; equals-list `auth, authorization, session, sid, pin, otp`.
  - Shared private `redactPairs(s: string): string` used by D16 and D17: split on `&`, split each part at its first `=`; a part with no `=` is kept unchanged (never redacted, never dropped); otherwise decode the key with `decodeURIComponent(key.replace(/\+/g, " "))`, falling back to the raw key on error; secret → `<raw key>=[REDACTED]`, else the part unchanged; rejoin with `&`.
  - `redactUrl`: `q = url.indexOf("?")`, `h = url.indexOf("#")`; only when `q !== -1 && (h === -1 || q < h)` apply `redactPairs` to `url.slice(q + 1, h === -1 ? undefined : h)`.
  - `redactText` regexes:
    ```ts
    const BEARER = /\b(bearer)(\s+)[A-Za-z0-9\-._~+/]+=*/gi;            // → `$1$2[REDACTED]`
    const BASIC = /\b(basic)(\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9+/=])/gi;
    // BASIC replaced only when Buffer.from(token, "base64").toString("utf8").includes(":")
    ```
  - `redactBody`: if `contentType?.toLowerCase().includes("application/x-www-form-urlencoded")` → `redactPairs`; else try `JSON.parse`; when the result is a non-null object (object or array) walk it recursively, replacing the value of every `isSecretKey` key with `REDACTED`; re-serialise with `JSON.stringify(value)` only if something changed, else keep the original text. Then `redactText` on the result.
  - `redactHeaders`: secret name → value `REDACTED`; otherwise `redactUrl` first when the lowercased name is `referer` or `location`, then `redactText`.
- [ ] **Step 4: Run it**: `Run: node --test test/redact.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/redact.ts test/redact.test.ts && git -C <worktree> commit -m "feat: add secret redaction helpers"`

---

### Task 2: playwright-cli output parsers

**Files:**
- Create: `src/network.ts`
- Test: `test/network.test.ts`

**Contracts:** C6 (parsing), C1 (`id`, `status`, `statusText`, `durationMs`)

**Interfaces:**
- Consumes: `Header` from `src/redact.ts`
- Produces (exported from `src/network.ts`):
  - `export type { Header } from "./redact.ts"`
  - `interface NetworkEntry { id: string; method: string; url: string; status: number | null; statusText: string; type: string | null; durationMs: number | null }`
  - `interface ListedRequest { n: number; method: string; url: string; status: number | null; statusText: string }` (url raw, unredacted)
  - `interface RequestDetails { type: string | null; mimeType: string | null; durationMs: number | null; requestHeaders: Header[]; responseHeaders: Header[]; hasRequestBody: boolean; hasResponseBody: boolean }` — no status field
  - `NETWORK_DIR = "network"`, `networkDir(workdir: string): string` (`path.join(workdir, NETWORK_DIR)`)
  - `requestId(n: number): string` (`String(n).padStart(4, "0")`)
  - `stripResult(stdout: string): string` — drops a first line equal to `### Result` (and its `\r?\n`); otherwise returns stdout unchanged
  - `parseDuration(value: string): number | null` (C1 rule)
  - `parseRequestList(stdout: string): ListedRequest[]`
  - `parseRequestDetails(stdout: string, n: number): RequestDetails` — deliberately adds the `n` parameter to the spec's `parseRequestDetails(stdout)`: hint detection must match `` `request-body <n>` `` / `` `response-body <n>` `` for this request's own number, and `n` is only known to the caller. The function stays pure.

**Checks:** `node --test test/network.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/network.test.ts`, with the probe samples as constants:
  ```ts
  const LIST = "### Result\n2. [POST] http://localhost:8765/api/login => [201] Created\n\nNote: 1 static request not shown, run with --static option to see it.\n";
  const DETAILS = "### Result\n#2 [POST] http://localhost:8765/api/login\n\n  General\n    status:    [201] Created\n    duration:  2ms\n    type:      fetch\n    mimeType:  application/json\n\n  Request headers\n    authorization: Bearer abc123\n    content-type: application/json\n\n  Response headers\n    content-type: application/json\n\nRun `request-body 2` to read the request body.\nRun `response-body 2` to read the response body.\n";
  const FAILED = "### Result\n#4 [GET] http://localhost:1/dead\n\n  General\n    status:    [FAILED] net::ERR_UNSAFE_PORT\n    type:      fetch\n\n  Request headers\n    accept: */*\n";
  ```
  - `request_id`: `requestId(1)` = `"0001"`, `requestId(9999)` = `"9999"`, `requestId(10000)` = `"10000"`.
  - `list_probe_sample`: `parseRequestList(LIST)` deep-equals `[{ n: 2, method: "POST", url: "http://localhost:8765/api/login", status: 201, statusText: "Created" }]`; same result without the `### Result` line and with `\r\n` line endings.
  - `list_failed_load`: `"4. [GET] http://localhost:1/dead => [FAILED] net::ERR_UNSAFE_PORT"` → `{ n: 4, method: "GET", url: "http://localhost:1/dead", status: null, statusText: "net::ERR_UNSAFE_PORT" }`.
  - `list_other_outcomes`: `"5. [GET] http://h/x => [204]"` → status 204, statusText `""`; `"6. [GET] http://h/y => pending "` → status null, statusText `"pending"`.
  - `list_non_contiguous_and_empty`: lines numbered `2`, `5` keep `n` 2 and 5 in order; `parseRequestList("")` and `parseRequestList("### Result\n")` → `[]`.
  - `duration_values`: `parseDuration("2ms")`=2, `"1.5ms"`=2, `"0.25s"`=250, `"1.2345s"`=1235, `" 2ms "`=2; `"-"`, `"2 ms"`, `"1m"`, `""` → null.
  - `details_probe_sample`: `parseRequestDetails(DETAILS, 2)` deep-equals `{ type: "fetch", mimeType: "application/json", durationMs: 2, requestHeaders: [{name:"authorization",value:"Bearer abc123"},{name:"content-type",value:"application/json"}], responseHeaders: [{name:"content-type",value:"application/json"}], hasRequestBody: true, hasResponseBody: true }` (no `status` key: `assert.equal("status" in d, false)`).
  - `details_failed_load`: `parseRequestDetails(FAILED, 4)` → `durationMs: null`, `mimeType: null`, `type: "fetch"`, `responseHeaders: []`, `hasResponseBody: false`, `hasRequestBody: false`.
  - `details_hint_only_from_run_lines`: a response header line `    x-note: run response-body 3 later` and a line `  Run \`response-body 4\` to read` with `n = 3` → `hasResponseBody: false`; the line `` Run `response-body 3` to read the response body. `` with `n = 3` → true; `` Run `request-body 3` `` only → `hasRequestBody: true, hasResponseBody: false`.
  - `details_header_line_shapes`: request headers `    :authority: example.com`, `    x-foo:`, `    x-bar:baz`, `    nocolon` → `[{name:":authority",value:"example.com"},{name:"x-foo",value:""},{name:"x-bar",value:"baz"}]`.
  - `details_missing_sections`: `parseRequestDetails("", 1)` and `parseRequestDetails("garbage\n", 1)` → all scalars null, both header arrays `[]`, both flags false; no throw.
  - `details_run_line_ends_section`: a `    x-after: 1` line after the `Run \`` line is not added to response headers.
- [ ] **Step 2: Run it**: `Run: node --test test/network.test.ts` / `Expected: FAIL (cannot find module ../src/network.ts)`
- [ ] **Step 3: Implement** the parsers in `src/network.ts`:
  - List line regex `^(\d+)\. \[([^\]]+)\] (\S+) => (.*)$`; outcome: `^\[(\d+)\] ?(.*)$` → int + trimmed text; else `^\[FAILED\] ?(.*)$` → null + trimmed text; else null + `outcome.trim()`.
  - `parseDuration`: trimmed value must match `^(\d+(?:\.\d+)?)(ms|s)$`; `Math.round(num * (unit === "s" ? 1000 : 1))`.
  - `parseRequestDetails`: iterate lines of `stripResult(stdout).split(/\r?\n/)`. A line whose trimmed text is `General`, `Request headers` or `Response headers` opens that section. A line whose trimmed text starts with `` Run ` `` closes the current section and is checked for `` `request-body ${n}` `` / `` `response-body ${n}` ``. Inside a section, a non-empty line starting with whitespace is trimmed and split at the first `:` with index > 0 (`line.indexOf(":", 1)`); skip when there is none; name and value trimmed. In General, keys `duration` → `parseDuration`, `type`, `mimeType` → strings; every other key (including `status`) ignored.
- [ ] **Step 4: Run it**: `Run: node --test test/network.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/network.ts test/network.test.ts && git -C <worktree> commit -m "feat: parse playwright-cli request output"`

---

### Task 3: Per-step capture (`clearRequests`, `captureStep`)

**Files:**
- Modify: `src/network.ts`
- Test: `test/network.test.ts`

**Contracts:** C1 (`network`, `network_errors` strings), C2 (folder and files), C6 (command sequence)

**Interfaces:**
- Consumes: Task 1 `redactUrl`, `redactHeaders`, `redactBody`; Task 2 parsers, `requestId`, `networkDir`, `stripResult`; `PlaywrightCLI.run(cmd, args)` from `src/pw.ts`; `AbortedError` from `src/proc.ts`; `codePointLength`/`sliceCodePoints` from `src/text.ts`
- Produces:
  - `clearRequests(pw: PlaywrightCLI): Promise<string | null>` — runs `requests --clear`; returns null on exit 0, else the full error string `"requests --clear: <message>"`; re-throws `AbortedError`
  - `captureStep(pw: PlaywrightCLI, workdir: string, step: number, nextId: number): Promise<{ entries: NetworkEntry[]; errors: string[]; nextId: number }>` — never throws except `AbortedError`

**Checks:** `node --test test/network.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/network.test.ts`, using a `ScriptPW extends PlaywrightCLI` whose `run(cmd, args)` records `[cmd, ...args]` into `calls` and delegates to a per-test handler `(cmd, args) => ProcResult | Promise<ProcResult>` (may throw). Its default `response-body` handler records `fs.existsSync(path.dirname(file))` and writes the bytes configured for that `n` to the `--filename=<abs>` path. The happy-path script: `requests` → two lines `2. [POST] http://app.test/api/login?token=qs1 => [201] Created` and `4. [GET] http://localhost:1/dead => [FAILED] net::ERR_UNSAFE_PORT`; `request 2` → details with request headers `authorization: Bearer hdr1`, `content-type: application/json`, response headers `set-cookie: sid=ck1`, `content-type: application/json`, both hints; `request 4` → `FAILED` (no hints); `request-body 2` → `### Result\n{"user":"a","password":"pw1"}\n`; `response-body 2` writes `{"token":"rt1","ok":true}`.
  - `capture_command_sequence`: `calls` equals `[["requests"],["request","2"],["request-body","2"],["response-body","2","--filename=<workdir>/network/0001/response-body.raw"],["request","4"],["requests","--clear"]]`.
  - `capture_entries_and_ids`: called with `nextId = 7` → entries ids `"0007"`, `"0008"`, result `nextId` 9; entry 1 deep-equals `{ id: "0007", method: "POST", url: "http://app.test/api/login?token=[REDACTED]", status: 201, statusText: "Created", type: "fetch", durationMs: 2 }`; entry 2 has `status: null`, `statusText: "net::ERR_UNSAFE_PORT"`; `errors` `[]`.
  - `capture_folder_files`: called as `captureStep(pw, workdir, 3, 7)` (step 3, first id 7); `network/0007/` holds exactly `request.json`, `response.json`, `request-body.txt`, `response-body.txt`; `request.json` parses to `{ id: "0007", step: 3, method: "POST", url: "...?token=[REDACTED]", headers: [{name:"authorization",value:"[REDACTED]"},{name:"content-type",value:"application/json"}] }`; `response.json` to `{ status: 201, statusText: "Created", type: "fetch", mimeType: "application/json", durationMs: 2, headers: [{name:"set-cookie",value:"[REDACTED]"},{name:"content-type",value:"application/json"}] }`; files equal `JSON.stringify(x, null, 2)`; `request-body.txt` = `{"user":"a","password":"[REDACTED]"}`; `response-body.txt` = `{"token":"[REDACTED]","ok":true}`. `network/0008/` holds only `request.json` and `response.json`.
  - `capture_no_raw_secret_in_any_file`: recursively read every file under `network/`; none contains `qs1`, `hdr1`, `ck1`, `pw1` or `rt1`; the returned entries' JSON contains none either.
  - `capture_status_from_list_line`: `request 2` details print `status: [500] Boom` while the list says `[201] Created` → entry and `response.json` have 201 / `"Created"`.
  - `capture_binary_response`: `response-body 2` writes `Buffer.from([0x89,0x50,0x4e,0x47,0x00,0x01])` → `response-body.bin` byte-identical, no `.txt`; also invalid UTF-8 without NUL (`Buffer.from([0xff,0xfe,0x41])`) → `.bin`.
  - `capture_empty_bodies_no_files`: `request-body` stdout `### Result\n` and an empty `.raw` file → no `request-body.txt`, no `response-body.*`, no `.raw`.
  - `capture_folder_exists_before_response_body`: the fake recorded `true` for the dir existence.
  - `capture_mkdir_failure_skips_bodies`: pre-create a regular file at `<workdir>/network/0001` → `calls` has no `request-body`/`response-body`; `errors` has exactly one string starting `"write 0001: "`; both entries are still returned.
  - `capture_request_json_write_fails`: pre-create a directory at `<workdir>/network/0001/request.json` (so `mkdir` of `0001` succeeds but writing the file fails with `EISDIR`) → `errors` contains exactly one string starting `"write 0001: "`; the entry `0001` is still returned; `response.json`, `request-body.txt` and `response-body.txt` are still written in `0001/` (each file write is independent).
  - `capture_response_json_write_fails`: same with a directory at `<workdir>/network/0001/response.json` → one `"write 0001: "` error, entry kept, `request.json` still written.
  - `capture_raw_read_fails`: the `response-body 2` handler creates `response-body.raw` as a directory (`fs.mkdirSync`) and exits 0 → `errors` contains one string starting `"write 0001: "`; no `response-body.txt`/`.bin`; no `response-body.raw` left; the entry is kept.
  - `capture_raw_rename_fails`: pre-create a non-empty directory `<workdir>/network/0001/response-body.bin/x/`; the handler writes the binary bytes → `errors` contains one string starting `"write 0001: "`; no `response-body.raw` left; the entry is kept.
  - `capture_response_body_no_file_written`: handler exits 0 without writing → `errors` contains `"response-body 2: no file written"`; no `response-body.*` file.
  - `capture_no_raw_left_behind`: after every scenario above, no `response-body.raw` exists anywhere under `network/`.
  - `capture_requests_fails`: `requests` → `{code: 1, stdout: "", stderr: " boom \n"}` → entries `[]`, errors `["requests: boom"]`, and `requests --clear` still called last.
  - `capture_request_n_fails`: `request 2` → `{code:1, stdout:"oops", stderr:""}` → error `"request 2: oops"`; entry kept with `type: null`, `durationMs: null`; `request.json` headers `[]`; `response.json` `{status:201,statusText:"Created",type:null,mimeType:null,durationMs:null,headers:[]}`; no body commands for 2.
  - `capture_body_commands_fail`: `request-body 2` exit 1 stderr `"rb"` and `response-body 2` exit 1 stderr `"sb"` → errors `["request-body 2: rb", "response-body 2: sb"]`, no body files, entry kept.
  - `capture_timeout_and_throw`: `request 2` → `{code:-1, stdout:"", stderr:"timeout"}` gives `"request 2: timeout"`; a handler throwing `new Error("spawn ENOENT")` for `request 4` gives `"request 4: spawn ENOENT"`.
  - `capture_message_clipped`: stderr of 400 `"x"` → message is 300 code points.
  - `capture_clear_fails`: `requests --clear` exit 1 stderr `"nope"` → last error `"requests --clear: nope"`.
  - `capture_aborted_propagates`: handler throws `new AbortedError()` on `request 2` → `captureStep` rejects with `AbortedError`; same for `clearRequests`.
  - `clear_requests_result`: exit 0 → `null`; exit 1 stderr `"x"` → `"requests --clear: x"`.
- [ ] **Step 2: Run it**: `Run: node --test test/network.test.ts` / `Expected: FAIL (captureStep is not exported)`
- [ ] **Step 3: Implement** in `src/network.ts`:
  - Private `runCmd(pw, cmd, args, label, errors): Promise<string | null>` returning stdout on exit 0, else pushing `"<label>: <message>"` and returning null. Message = trimmed stderr, else trimmed stdout, clipped to 300 code points; a thrown non-`AbortedError` uses `e.message`. `label` is the command and its args joined by spaces without `--filename` (`"response-body 2"`).
  - Per listed request, in order: `id = requestId(nextId++)`; `request <n>` → `parseRequestDetails`, or on failure an empty details object (null scalars, `[]` headers, no hints); `fs.mkdirSync(dir, { recursive: true })` (on failure push `"write <id>: <e.message>"`, skip both body commands and all file writes for this request); `request-body <n>` if `hasRequestBody` (body = `stripResult(stdout)` minus one trailing `\r?\n`); `response-body <n> --filename=<dir>/response-body.raw` if `hasResponseBody`.
  - Response body after exit 0, inside `try … finally` that best-effort (own `try/catch`, error ignored) `fs.rmSync(raw, { force: true, recursive: true })` (`recursive` so a `.raw` that is a directory is also removed): missing file → `"response-body <n>: no file written"`; empty → nothing; `new TextDecoder("utf-8", { fatal: true })` succeeds and no `0x00` byte → write `redactBody(text, responseContentType)` to `response-body.txt`; else `fs.renameSync(raw, "response-body.bin")`. Read/rename errors (e.g. `EISDIR`) → `"write <id>: <message>"`, entry kept.
  - Content type for a body = value of the first header (in that message's own unredacted headers) whose lowercased name is `content-type`, else null.
  - Write `request.json`, `response.json` (shapes from C2, status/statusText from the list line) and `request-body.txt` when the body is non-empty. Each file write is in its own `try/catch`: a failed write pushes `"write <id>: <message>"` and the remaining files for that request are still attempted; the entry is kept.
  - Entry: `{ id, method, url: redactUrl(listed.url), status, statusText, type, durationMs }`.
  - Finally `clearRequests(pw)`; push its error if non-null.
- [ ] **Step 4: Run it**: `Run: node --test test/network.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/network.ts test/network.test.ts && git -C <worktree> commit -m "feat: capture and redact each step's network calls"`

---

### Task 4: `<network>` prompt section

**Files:**
- Modify: `src/network.ts`, `src/text.ts`, `src/prompt.ts`, `prompts/system.md`
- Test: `test/network.test.ts`, `test/text.test.ts`, `test/prompt.test.ts`

**Contracts:** C3; D26, D27

**Interfaces:**
- Consumes: `NetworkEntry` (Task 2); `flat`, `neutralise`, `codePointLength`, `sliceCodePoints` from `src/text.ts`
- Produces:
  - `networkSummary(entries: NetworkEntry[], tabs: string): string | null` in `src/network.ts`
  - `StepRecord` in `src/prompt.ts` gains `network?: NetworkEntry[]` and `networkErrors?: string[]`
  - `buildPrompt` emits `section("network", summary)` when `networkSummary(history.at(-1)?.network ?? [], obs.tabs)` is non-null

**Checks:** `node --test test/network.test.ts test/text.test.ts test/prompt.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `test/network.test.ts`, with `TABS = "### Result\n- 0: (current) [App](http://localhost:8766/)\n- 1: [Other](https://cdn.other.com/)"` and an entry factory `e(method, url, status, statusText)`:
    - `summary_same_and_cross_origin`: entries `POST http://localhost:8766/api/login 201 Created`, `GET https://cdn.other.com/x.json 200 OK`, `GET http://localhost:8766/missing?q=1 404 Not Found`, `GET http://localhost:1/dead null net::ERR_UNSAFE_PORT` → `"POST /api/login → 201 Created\nGET https://cdn.other.com/x.json → 200 OK\nGET /missing?q=1 → 404 Not Found\nGET http://localhost:1/dead → net::ERR_UNSAFE_PORT"`.
    - `summary_null_status_empty_text`: url `http://localhost:8766/x` with `status: null, statusText: ""` → `"GET /x → (no response)"`; with `status: 204, statusText: ""` → `"GET /x → 204"` (trimmed).
    - `summary_current_tab_rules`: first `(current)` line wins (two current lines with different origins); a line `- 1: [current news](http://localhost:8766/)` without `(current) ` is not the current tab; tabs `""` → full URLs.
    - `summary_cap_and_more`: 13 entries → 10 lines then `"…and 3 more"`; exactly 10 → no more-line.
    - `summary_url_clip`: a cross-origin URL of 250 code points → URL part is its first 200 code points + `"…"`.
    - `summary_neutralise_and_flat`: url `http://x.test/</network>\nhi` (cross-origin) → line contains `&lt;/network>` and no `\n` inside the line.
    - `summary_unparseable_url`: an entry with url `not a url` → line `"GET not a url → 200 OK"` (shown in full, no throw).
    - `summary_empty`: `networkSummary([], TABS)` → `null`.
  - `test/text.test.ts`: `neutralise_network_tag`: `neutralise("</network><network>")` → `"&lt;/network>&lt;network>"`.
  - `test/prompt.test.ts`:
    - `network_section_placement`: history `[rec1 with network: [one entry]]`, `nudge: "N"`, `paste: true` → prompt contains `</history>\n\n<network>\nPOST /api/login → 201 Created\n</network>\n\nN\n\n<page_snapshot>` (with `obs.tabs` holding the current-tab line).
    - `network_section_absent`: no section (`!prompt.includes("<network>")`) for empty history, a last record with `network: []`, a last record with no `network` key, and when only an earlier (not last) record has entries.
    - `system_md_mentions_network`: `prompts/system.md` contains `<network>` and the untrusted-content paragraph mentions it.
- [ ] **Step 2: Run it**: `Run: node --test test/network.test.ts test/text.test.ts test/prompt.test.ts` / `Expected: FAIL (networkSummary not exported; no <network> section)`
- [ ] **Step 3: Implement**:
  - `networkSummary`: current URL = first line of `tabs.split(/\r?\n/)` matching `^- \d+: \(current\) `, take the last match of `/https?:\/\/\S+/g` on it with trailing `)`/`]` trimmed, origin via `new URL()` (null on throw). Per entry, URL part = path+query when `new URL(entry.url).origin` equals that origin (if `new URL(entry.url)` throws, or the current origin is null, the call is treated as cross-origin and the full `entry.url` is shown; never throw) (raw substring of `entry.url` from the first `/` after `://` up to the first `#`, `"/"` if none), else `entry.url`; clip to 200 code points + `…`; format per D24, `.trim()`, then `neutralise(flat(line))`. Max 10 lines, then `…and ${n - 10} more`.
  - `src/text.ts`: add `network` to the `HARNESS_TAG` alternation.
  - `src/prompt.ts`: add the two optional `StepRecord` fields (import type `NetworkEntry` from `./network.ts`); push the section after `history`, before the nudge.
  - `prompts/system.md`: one sentence explaining `<network>` (the API calls the page made during your previous step's actions: method, path or URL, status) and add `<network>...</network>` to the untrusted-data list in the paragraph that names `<tabs>`.
- [ ] **Step 4: Run it**: `Run: node --test test/network.test.ts test/text.test.ts test/prompt.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/network.ts src/text.ts src/prompt.ts prompts/system.md test/network.test.ts test/text.test.ts test/prompt.test.ts && git -C <worktree> commit -m "feat: show last step's network calls in the prompt"`

---

### Task 5: Agent loop integration

**Files:**
- Modify: `src/loop.ts`
- Test: `test/loop.test.ts`

**Contracts:** C1 (which steps get keys, pending initial-clear error); D1–D4, D30

**Interfaces:**
- Consumes: `clearRequests`, `captureStep` (Task 3); `StepRecord.network` / `networkErrors` (Task 4)
- Produces: `AgentOptions.network?: boolean` (default `false`); `Agent.network: boolean` (readonly)

**Checks:** `node --test test/loop.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/loop.test.ts`. Add a `NetPW extends FakePW` whose `run` returns per-command scripted results (`requests` output queue, `requests --clear` exit-code queue, `tab-list` → the default stdout) so each step lists one request `1. [GET] http://h/a => [200] OK` and `request 1` returns details with no hints.
  - `network_call_order`: `network: true`, brain script `[click e1, done]` over two steps → call commands are `open`, `requests --clear`, then per step `tab-list`, …actions…, `requests`, `request 1`, `requests --clear` (assert the subsequence and that `requests` comes after the step's last action and before the next `tab-list`).
  - `network_state_load_then_clear`: with `state: "s.json"` the order starts `open`, `state-load`, `requests --clear`.
  - `network_done_step_captured`: the `done` step's record has `network` with one entry.
  - `network_ids_continue_across_steps`: step 1 entry id `"0001"`, step 2 `"0002"`; folder `network/0002/request.json` exists in `workdir`.
  - `network_brain_error_clear_only`: a `BrainError` step: `requests --clear` is called, no `requests` list call for that step, and its record has neither `network` nor `networkErrors` (`"network" in rec === false`).
  - `network_requests_failure_recorded`: `requests` exits 1 stderr `"boom"` → loop continues to the next step; that record has `network: []`, `networkErrors: ["requests: boom"]`; result outcome unchanged.
  - `network_no_errors_key_when_clean`: a clean step has no `networkErrors` key.
  - `network_initial_clear_error_skips_brain_error_step`: first `requests --clear` exits 1 stderr `"x"`; step 1 is a brain error, step 2 executes and its `requests` fails with `"boom"` → step 2 `networkErrors` is `["initial requests --clear: x", "requests: boom"]`; step 3 has no `"initial …"` entry.
  - `network_initial_clear_error_dropped`: initial clear fails and every step is a brain error until `maxFailures` → no record has `networkErrors`.
  - `network_off_by_default`: without `network`, no call's command starts with `requests` or `request`, and no `network/` folder exists in `workdir`.
  - `network_aborted_propagates`: `requests` throws `AbortedError` → `run()` rejects with `AbortedError` and `close()` was called.
- [ ] **Step 2: Run it**: `Run: node --test test/loop.test.ts` / `Expected: FAIL (no requests calls; network option ignored)`
- [ ] **Step 3: Implement** in `src/loop.ts`: fields `network`, private `nextNetworkId = 1`, private `pendingNetworkErrors: string[] = []`. In `run()`, after `open`/`stateLoad`, when `network`: `const err = await clearRequests(this.pw); if (err) this.pendingNetworkErrors = [`initial ${err}`];`. In `loop()`, brain-error branch: when `network`, `await clearRequests(this.pw)` (result ignored) before `this.record(...)`. After `execute()`, when `network`: `captureStep(this.pw, this.workdir, step, this.nextNetworkId)`, store `nextId`, merge `[...pendingNetworkErrors, ...errors]`, empty `pendingNetworkErrors`, and record `{ step, decision, results, codes, network: entries, ...(errs.length ? { networkErrors: errs } : {}) }`.
- [ ] **Step 4: Run it**: `Run: node --test test/loop.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/loop.ts test/loop.test.ts && git -C <worktree> commit -m "feat: capture network after each executed step"`

---

### Task 6: `--network` flag and task-file key

**Files:**
- Modify: `src/args.ts`, `src/taskfile.ts`
- Test: `test/args.test.ts`, `test/taskfile.test.ts`, `test/runs/run.test.ts` (only its base `RunArgs` literal, which must gain `network: true` to keep typechecking)

**Contracts:** C4, C5; D28, D29

**Interfaces:**
- Consumes: nothing new
- Produces: `RunArgs.network: boolean` (default `true`); `TaskSettings.network?: boolean`; `KEYS.network = ["network", "bool"]`

**Checks:** `node --test test/args.test.ts test/taskfile.test.ts test/cli.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `test/args.test.ts`: add `network: true` to both whole-`RunArgs` `deepEqual` literals: `defaults` (~line 17) and `every option` (~line 28; no `--network` flag is passed there, so the value is the default `true`). A repo search (`grep -rn "maxParallel: null\|allowFileAccess:" test`) finds only these two plus the `test/runs/run.test.ts` base literal; the `TaskSettings` comparisons in `test/taskfile.test.ts` (lines ~46, ~57) are on parsed partial settings with no `network` key, and the TUI `Effective` literals are a different type the spec leaves unchanged, so none of them change. Add `network_default_on` (`parseRunArgs(["t"], skill).args.network === true`), `no_network` (`["t","--no-network"]` → false), `network_last_wins` (`["t","--no-network","--network"]` → true; reversed → false), `network_task_file_overridden` (`parseRunArgs(["t","--network"], skill, { network: false })` → true; `parseRunArgs(["t"], skill, { network: false })` → false), `network_explicit_value_error` (`["t","--network=x"]` throws `UsageError` with message `argument --network/--no-network: ignored explicit argument 'x'`), `help_mentions_network` (`RUN_HELP` contains `"  --export, --no-export\n"` … followed later by `"  --network, --no-network\n                        record the API calls the page makes each step,\n                        redacted, under runs/<id>/network (default on)\n"`, located after the `--export` entry and before `--snapshot-hybrid`; `RUN_USAGE` contains `"[--export | --no-export] [--network | --no-network]"`).
  - `test/taskfile.test.ts`: `network_key_parsed` (`network: false` front matter → `settings.network === false`); `network_key_bad_value` (`network: maybe` → `TaskFileError` whose message ends with `network must be true or false, got "maybe"` and starts with `<file>:<line>: `).
  - `test/runs/run.test.ts`: add `network: true` to the base `RunArgs` literal at line ~21 (no new test here yet).
- [ ] **Step 2: Run it**: `Run: node --test test/args.test.ts test/taskfile.test.ts` / `Expected: FAIL (unrecognized arguments: --no-network)`
- [ ] **Step 3: Implement**: in `src/args.ts` add `network: boolean` to `RunArgs`, `network: true` to the defaults literal (before `...settings`), `"--network"`/`"--no-network"` → `"--network/--no-network"` in `RUN_SPEC.names`, the boolean branch `args.network = name === "--network"`, the usage and help text above. In `src/taskfile.ts` add `network: boolean` to `TaskSettings` and `network: ["network", "bool"]` to `KEYS`. Do not change `settingValue`'s key union (D29).
- [ ] **Step 4: Run it**: `Run: node --test test/args.test.ts test/taskfile.test.ts test/cli.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/args.ts src/taskfile.ts test/args.test.ts test/taskfile.test.ts test/runs/run.test.ts && git -C <worktree> commit -m "feat: add --network/--no-network and task-file network key"`

---

### Task 7: history.json fields and wiring through `startRun`

**Files:**
- Modify: `src/runs/run.ts`, `src/export.ts`
- Test: `test/runs/run.test.ts`, `test/export.test.ts`, `test/runs/past.test.ts`

**Contracts:** C1 (serialisation, key order, back-compat); D19, D34

**Interfaces:**
- Consumes: `StepRecord.network` / `networkErrors` (Task 4); `AgentOptions.network` (Task 5); `RunArgs.network` (Task 6); `NetworkEntry` type
- Produces: `HistoryStep.network?: NetworkEntry[]`, `HistoryStep.network_errors?: string[]` in `src/export.ts` (types only)

**Checks:** `node --test test/runs/run.test.ts test/export.test.ts test/runs/past.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `test/runs/run.test.ts`:
    - `history_json_network_keys`: a record with `network: [entry]` and `networkErrors: ["requests: boom"]` → the step object's `Object.keys` end with `["results", "network", "network_errors"]` and the values equal the inputs.
    - `history_json_network_empty_no_errors`: `network: []`, no `networkErrors` → `network: []` present, no `network_errors` key.
    - `history_json_no_network_keys`: a record without either field → neither key.
    - `start_run_passes_network`: `setup(createAgent, { network: false })` → the captured `AgentOptions.network === false`; default setup → `true`.
  - `test/export.test.ts`: `spec_ignores_network_fields`: load `test/fixtures/export/greet/history.json`, add `network: [{ id: "0001", method: "GET", url: "http://h/", status: 200, statusText: "OK", type: "fetch", durationMs: 1 }]` and `network_errors: ["requests: x"]` to every step, write it to a temp run dir, `renderSpec(loadHistory(dir).data).spec` equals the fixture's `expected.spec.ts`.
  - `test/runs/past.test.ts`: `past_loads_history_with_network`: a run folder whose history steps carry `network` and `network_errors` is listed (not counted as invalid).
- [ ] **Step 2: Run it**: `Run: node --test test/runs/run.test.ts test/export.test.ts test/runs/past.test.ts` / `Expected: FAIL (history_json_network_keys, start_run_passes_network)`
- [ ] **Step 3: Implement**: in `historyJson`, after `results`, spread `...(r.network ? { network: r.network } : {})` then `...(r.networkErrors?.length ? { network_errors: [...r.networkErrors] } : {})`. In `execute()` pass `network: args.network` to `deps.createAgent`. In `src/export.ts` add the two optional fields to `HistoryStep` (`import type { NetworkEntry } from "./network.ts"`); no logic change.
- [ ] **Step 4: Run it**: `Run: node --test test/runs/run.test.ts test/export.test.ts test/runs/past.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git -C <worktree> add src/runs/run.ts src/export.ts test/runs/run.test.ts test/export.test.ts test/runs/past.test.ts && git -C <worktree> commit -m "feat: write network fields to history.json"`

---

### Task 8: README documentation and full suite

**Files:**
- Modify: `README.md`

**Contracts:** C7

**Interfaces:**
- Consumes: the behavior of Tasks 1–7
- Produces: none

**Checks:** `npm test`, `npm run typecheck`

- [ ] **Step 1: Edit `README.md`** (no test; reviewed by hand):
  - Usage block: `[--allow-file-access] [--[no-]export]` line gains ` [--[no-]network]`.
  - Options table: after `--export`, row `| \`--network\` | on | Record the API calls the page makes each step, redacted, under \`runs/<id>/network/\` (see [Output](#output)); \`--no-network\` turns it off or overrides a task file |`.
  - Task-file keys table: after `export`, row `| \`network\` | \`true\` or \`false\` |`.
  - Output: a `network/` bullet describing `network/<id>/` with `request.json`, `response.json`, `request-body.txt`, `response-body.txt` or `response-body.bin` (C2 shapes; body files only when non-empty; binary responses copied unredacted); the `history.json` bullet mentions each step's `network` entries (`id`, `method`, `url`, `status`, `statusText`, `type`, `durationMs`) and `network_errors`.
  - A caution that redaction is pattern-based and captured bodies can still hold secrets it misses; treat `network/` like `history.json`.
  - Limits: only the current tab since its last page load is captured, calls lost to a mid-step navigation or made in other tabs are not; a failed clear may list calls again next step (D31); binary request bodies (uploads) may be recorded as whatever `playwright-cli` prints (D9).
  - Roadmap: `- [ ] **Network capture**` → `- [x] **Network capture**`.
- [ ] **Step 2: Run the full suite**: `Run: npm test` / `Expected: PASS (typecheck plus every test file)`
- [ ] **Step 3: Commit**: `git -C <worktree> add README.md && git -C <worktree> commit -m "docs: document network capture"`

## Manual e2e

Not part of this run's verification. For the user, against a real browser with playwright-cli 0.1.22:

- [ ] Run a task against a page that does `fetch('/api/login', { headers: { Authorization: 'Bearer …' }, body: '{"password":"…"}' })`, then check `history.json` (`network` entries), `runs/<id>/network/0001/` (all four files redacted) and the next prompt's `<network>` section.
- [ ] Optionally check what `request-body` prints for a binary upload (D9 limitation).
