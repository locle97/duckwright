# Network capture with redaction: design

Date: 2026-10-06 · Branch: `duckor/network-capture-redacted-history` · Brief: `.duckor/flow/20261006-114324-network-capture-redacted-history/brief.md`

## Summary

Duckwright drives a browser through `playwright-cli` and records each step in `runs/<id>/history.json`. Today it records nothing about the HTTP traffic the page makes. This change adds per-step network capture. After each step's actions run, the harness asks `playwright-cli` for the API-like requests the page made (fetch/XHR and failed loads, playwright-cli's default list), fetches each request's headers and bodies, redacts secrets, and writes them out. Each step record in `history.json` gains a `network` array of short entries. Each entry's `id` names a folder, `runs/<id>/network/<request id>/`, that holds the redacted request and response. The next prompt shows the agent a `<network>` section with one line per call its last actions triggered. Capture is on by default and can be turned off with `--no-network` or `network: false` in a task file. A capture failure never fails the run. It is recorded on the step and the loop goes on.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | When capture runs | Once per step, right after `execute()` returns and before the step is recorded, including the step whose actions end with `done`. It ends with `requests --clear`. (Brief assumption) |
| D2 | Initial clear | After `open` (and after `state-load` when `--state` is given), the agent runs `requests --clear` once, so the initial `about:blank` and state load are not attributed to step 1. If that clear fails, its error (`"initial requests --clear: <message>"`) is held as a pending error and goes into the `network_errors` of the **first step whose actions ran** (the first step that is not a brain-error step), ahead of that step's own errors. If no step ever runs actions (every step is a brain error, or the run stops before any step executes), the pending error is dropped: it is recorded nowhere. (Brief assumption) |
| D3 | Brain-error steps | A step whose brain call failed (no actions ran) runs `requests --clear` only. Its record gets no `network` and no `network_errors` keys. A failed clear there is ignored. A pending D2 error is not consumed by a brain-error step; it waits for the next step whose actions ran. (Brief assumption) |
| D4 | Request ids | Run-unique sequence numbers in capture order, zero-padded to 4 digits: `0001`, `0002`, … After `9999`, the number simply grows (`10000`); `String(n).padStart(4, "0")`. The counter lives on the `Agent` for the whole run. (Brief assumption) |
| D5 | Folder layout | `<workdir>/network/<id>/`, with the fixed files `request.json`, `response.json`, `request-body.txt`, and `response-body.txt` or `response-body.bin`. Body files exist only when the body exists and is non-empty. (Brief assumption, names fixed here) |
| D6 | Which playwright-cli commands | `requests` (no `--static`, no `--json`), then per listed request `request <n>`, then `request-body <n>` and `response-body <n> --filename=<abs>` only when the `request <n>` output has the matching hint line (C6: a line starting with `Run \`` that contains `` `request-body <n>` `` / `` `response-body <n>` ``), then `requests --clear`. The request folder `network/<id>/` is created (`mkdir -p`) right after `request <n>` and before any body command runs, so `response-body <n> --filename=...` always has an existing target directory. `request-headers` / `response-headers` are not used: `request <n>` already prints both header blocks. |
| D7 | Output format parsed | Plain text, not `--json`. A leading `### Result` line is stripped. The list is parsed line by line with the regex in C6. Lines that don't match (the `Note:` line, blank lines) are ignored. A list with no matching lines means zero calls. |
| D8 | Text vs binary response body | `response-body <n>` is always called with `--filename=<request folder>/response-body.raw`; the request folder already exists at that point (D6). If creating the folder fails, that is a `"write <id>: <message>"` error, no body command is run for that request, and the entry is still kept in `network`. The probe confirms playwright-cli writes that file for text and binary bodies alike, with exact bytes, and prints only a link line on stdout, so stdout is ignored. After a successful exit the file's bytes are read: valid UTF-8 (fatal decode) with no NUL byte means text, which is redacted and written to `response-body.txt`; anything else is renamed to `response-body.bin` unchanged. If the file is missing after a successful exit, that is a capture error (`"response-body <n>: no file written"`) and no response body file is written; there is no stdout fallback. `response-body.raw` never survives a capture: it is deleted or renamed in a `finally`. |
| D9 | Binary bodies | Binary response bodies are copied in as is, not redacted (they can't be searched for text secrets). Request bodies are always treated as text read from `request-body <n>` stdout. Known limitation (not probed): for a binary request body (e.g. a file upload) playwright-cli may print a file path or mangled text instead of the bytes; whatever stdout holds is redacted and written to `request-body.txt` as is. Documented in the README. |
| D10 | No truncation, no per-step cap | Full bodies are written, and every listed request is captured. (Brief) |
| D11 | Redaction marker | `[REDACTED]`, written literally (not URL-encoded) everywhere, including inside URL queries and form bodies. |
| D12 | Secret header names | Case-insensitive. Exact names `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, or a name containing any of `token`, `secret`, `auth`, `session`, `api-key`, `api_key`, `apikey`, `password`, `csrf`, `xsrf`. The whole value becomes `[REDACTED]`. The `auth` substring rule also matches the HTTP/2 pseudo-header `:authority` (and e.g. `x-author`), so its value is redacted; this over-redaction is accepted. (Brief list, plus the `_`/no-separator spellings of api-key and `xsrf`) |
| D13 | Secret keys (JSON, form, query) | A key is normalised by lowercasing it and removing `-` and `_`. It is secret if the normalised key **contains** any of `password`, `passwd`, `secret`, `token`, `apikey`, `csrf`, `xsrf`, `credential`, `privatekey`, `sessionid`, `cookie`, or **equals** any of `auth`, `authorization`, `session`, `sid`, `pin`, `otp`. Exact match for the short words avoids false hits like `author`. The value is replaced whatever its type (string, number, object, array). |
| D14 | Bearer/Basic in text | `Bearer <token>`: the word `bearer` (case-insensitive, at a word boundary), whitespace, then a non-empty token of token68 chars (`[A-Za-z0-9\-._~+/]+` plus optional trailing `=`s), so short tokens like `Bearer abc123` are caught. Over-redacting prose such as "bearer of" is accepted. Becomes `Bearer [REDACTED]`, keeping the original word. `Basic <creds>`: the word `basic` (case-insensitive), whitespace, then a base64 token (`[A-Za-z0-9+/]{4,}={0,2}`), redacted only if it decodes to text containing `:`. This avoids hitting prose like "Basic Plan". Applied to every text body and every header value that isn't already wholly redacted. |
| D15 | JSON body handling | If the text body parses with `JSON.parse` to an object or array, keys are redacted recursively (D13). If anything changed, the body is re-serialised with `JSON.stringify(value)` (compact); if nothing changed, the original text is kept byte for byte. D14 then runs on the result. Bodies that aren't JSON skip this step. |
| D16 | Form body handling | When the message's own `content-type` header (request headers for the request body, response headers for the response body) contains `application/x-www-form-urlencoded`, the body is split on `&`, each part at its first `=`. The key is decoded (`+` becomes a space, then `decodeURIComponent`; on a decode error the raw key is used) and tested with D13. Secret values become `[REDACTED]`, and other parts are kept byte for byte. |
| D17 | URL query handling | The same pair rule as D16 applies to the part of a URL between the first `?` and the first `#`. Used on every captured URL (entries, `request.json`) and on the values of the `referer` and `location` headers. The fragment and path are kept. |
| D18 | Order of redaction | Everything is redacted in memory before any file is written, any record is built, or anything is emitted as an event. Raw data exists only in local variables, plus the short-lived `response-body.raw` (D8). |
| D19 | history.json shape | Step-level keys stay snake_case: `network` (array, present whenever capture ran for an executed step, `[]` when there were no calls) and `network_errors` (array of strings, present only when non-empty). Entry keys follow the brief: `id`, `method`, `url`, `status`, `statusText`, `type`, `durationMs`. |
| D20 | Failed loads and status source | The `requests` list line is the only source of `status` and `statusText` (in C1 entries and in `response.json`). The `request <n>` General `status:` field is ignored; `request <n>` supplies only `type`, `durationMs`, `mimeType` and the headers. Outcome rule for the list line (C6): `[<digits>] <text>` gives `status` = the number and `statusText` = the text. `[FAILED] <text>` (a failed load, e.g. `[FAILED] net::ERR_UNSAFE_PORT`) gives `status: null` and `statusText` = the text with the `[FAILED] ` prefix stripped (`net::ERR_UNSAFE_PORT`). Any other outcome gives `status: null` and `statusText` = the outcome trimmed. Failed loads have no `response-body` hint, so no response body is fetched. |
| D21 | Error recording | Any failure of a capture command (non-zero exit, timeout, runner exception other than `AbortedError`) or of a file write adds a string to the step's `network_errors` and capture continues where it can. `AbortedError` is re-thrown (Ctrl-C still stops the run). Message format is in C1. |
| D22 | Where the agent can't read | `network/` is a sibling of `page/`. In grep mode Claude's tools are confined to `page/`, so the agent never reads network files. It sees only the `<network>` summary. |
| D23 | Summary relative paths | The "current page" is the URL of the current tab in this step's `tab-list` output (format `- <N>: (current) [<title>](<url>)`): the first line matching `^- \d+: \(current\) ` (first match wins), and the last `http(s)://` URL on that line, with trailing `)` and `]` trimmed. When a call's origin equals that URL's origin, the summary shows path + query; otherwise, or when no current URL is found, it shows the full (redacted) URL. |
| D24 | Summary line format | `<METHOD> <url> → <status> <statusText>`, trimmed. With `status: null`: `<METHOD> <url> → <statusText>`, or `→ (no response)` if `statusText` is empty. The URL part is clipped to 200 code points plus `…`. Lines are `flat()`-ed and `neutralise()`-d. At most 10 call lines, then `…and N more`. |
| D25 | Which step the summary shows | Only the immediately previous record (`history.at(-1)`), and only if its `network` array is non-empty. No section otherwise (step 1, previous brain error, zero calls, capture off). |
| D26 | Untrusted tag escaping | `neutralise()`'s tag list gains `network`, so page text can't close or open a `<network>` block. |
| D27 | System prompt | `prompts/system.md` explains `<network>` in one sentence and lists it among untrusted page content. |
| D28 | Flag and setting | `--network` / `--no-network` (negatable boolean, default **on**), task-file key `network: true|false`, with the same precedence as `export` (built-in default < file < flag). |
| D29 | TUI | No new field in the TUI options form and no display of network data. TUI runs inherit `network` from argv and task-file settings through `parseRunArgs`, so capture is on there too by default. |
| D30 | Agent default | `AgentOptions.network` defaults to `false`, so direct `Agent` users (existing tests) see no new playwright-cli calls. `startRun` passes `args.network`, which defaults to `true`. |
| D31 | Tabs and navigation limits | Only what `playwright-cli requests` reports is captured: the current tab, since its last page load. Calls dropped by a mid-step navigation, or made in other tabs, are lost. Documented in the README. If a `requests --clear` fails, the next step may list the same calls again; that is accepted. |
| D32 | Header representation | Headers are stored as an ordered array `[{ "name": string, "value": string }]`, in printed order, names as printed. Duplicates are kept. |
| D33 | `request <n>` parse leniency | Missing sections or fields give `null` (scalars) or `[]` (headers). A malformed details block is not an error. |
| D34 | Export and past runs | `export.ts` and `runs/past.ts` validation stay as they are: they already ignore unknown step keys. `HistoryStep` gains the two optional keys for typing only. |

## Architecture / Components

New modules (Node standard library only):

- **`src/redact.ts`**: pure functions, no I/O.
  - `REDACTED = "[REDACTED]"`
  - `isSecretHeader(name)`, `isSecretKey(key)` (D12, D13)
  - `redactHeaders(headers: Header[]): Header[]`: wholly redacts secret headers, runs D14 on the others, and runs D17 on `referer` and `location`.
  - `redactUrl(url: string): string` (D17)
  - `redactText(text: string): string` (D14)
  - `redactBody(text: string, contentType: string | null): string`: D15 or D16, then D14.
- **`src/network.ts`**: parsing and capture.
  - Types `Header`, `NetworkEntry` (C2), `ListedRequest`, `RequestDetails`.
  - `NETWORK_DIR = "network"`, `networkDir(workdir)`, `requestId(n)`.
  - `parseRequestList(stdout): ListedRequest[]`, `parseRequestDetails(stdout): RequestDetails` (C6). These are pure.
  - `clearRequests(pw): Promise<string | null>`: returns an error message or null, and re-throws `AbortedError`.
  - `captureStep(pw, workdir, step, nextId): Promise<{ entries: NetworkEntry[]; errors: string[]; nextId: number }>`: runs the D6 sequence, redacts, and writes the folders. It never throws except `AbortedError`.
  - `networkSummary(entries, tabs): string | null`: the `<network>` body (D23–D25), or null when there are no entries.

Changed modules:

- **`src/loop.ts`**: `AgentOptions.network?: boolean` (default false). In `run()`, the initial clear (D2). In `loop()`, after `execute()`, `captureStep`, with its result put on the `StepRecord`. On a brain error, clear only (D3). Holds `nextNetworkId`.
- **`src/prompt.ts`**: `StepRecord` gains `network?: NetworkEntry[]` and `networkErrors?: string[]`. `buildPrompt` adds the `<network>` section from `networkSummary(history.at(-1)?.network ?? [], obs.tabs)`, placed after `<history>` and before the nudge and the page snapshot. `stepLine` is unchanged.
- **`src/text.ts`**: `HARNESS_TAG` adds `network` (D26).
- **`src/runs/run.ts`**: `historyJson` writes `network` / `network_errors` when present on the record (D19). `startRun` passes `network: args.network` to `createAgent`.
- **`src/export.ts`**: `HistoryStep` gains optional `network?: NetworkEntry[]` and `network_errors?: string[]` (types only).
- **`src/args.ts`**: `RunArgs.network: boolean` (default `true`), the `--network`/`--no-network` names, `RUN_USAGE` and `RUN_HELP` text (C4).
- **`src/taskfile.ts`**: `TaskSettings.network?: boolean`, `KEYS.network = ["network", "bool"]`.
- **`prompts/system.md`**: the `<network>` explanation (C5).
- **`README.md`**: feature docs and the roadmap tick (C7).

Dependencies: `network.ts` → `pw.ts`, `proc.ts` (`AbortedError`), `redact.ts`, `text.ts`. `redact.ts` depends on nothing. `loop.ts` → `network.ts`. `prompt.ts` → `network.ts` (types + `networkSummary`).

## Contracts

### C1: `history.json` step network fields (File)

- **Surface:** `runs/<id>/history.json`, each element of `history`.
- **Input:** produced by a run with network capture on (the default).
- **Output:** for each step whose actions ran (not a brain-error step), when capture is on:
  - `network`: array (possibly empty) of entries, in `requests` list order:
    - `id`: string, run-unique, `"0001"`, `"0002"`, … (D4)
    - `method`: string, as printed (e.g. `"POST"`)
    - `url`: string, full URL with secret query values replaced by `[REDACTED]` (D17)
    - `status`: number, or `null` for a load with no HTTP status (D20)
    - `statusText`: string (e.g. `"Created"`; for a failed load the error with `[FAILED] ` stripped, e.g. `"net::ERR_UNSAFE_PORT"`; `""` when none was printed) (D20)
    - `type`: string or `null` (from `request <n>` General `type:`, e.g. `"fetch"`)
    - `durationMs`: integer or `null`, from General `duration:`. The trimmed value must match `^(\d+(?:\.\d+)?)(ms|s)$`; the number is multiplied by 1 for `ms` and by 1000 for `s`, then rounded with `Math.round` (e.g. `2ms` → `2`, `1.5ms` → `2`, `0.25s` → `250`, `1.2345s` → `1235`). Anything that doesn't match (missing, `-`, `2 ms`, `1m`) → `null`.
  - `network_errors`: array of strings, present only when at least one capture error occurred in that step. Each string is `"<command>: <message>"`, where `<command>` is the playwright-cli command and its arguments joined by spaces, without the `--filename` flag (e.g. `"requests"`, `"request 3"`, `"response-body 3"`, `"requests --clear"`), and `<message>` is the trimmed stderr, or else stdout, clipped to 300 code points (`"timeout"` on a timeout). A thrown error uses its `message`. A file-write failure is `"write <id>: <message>"`. The D2 initial-clear failure is `"initial requests --clear: <message>"`, put first in the `network_errors` of the first step whose actions ran; it is dropped if no step's actions ever run (D2).
  - Keys appear after `results`, in the order `network`, `network_errors`. All other step keys are unchanged.
- With capture off, or on brain-error steps: neither key is present.
- Histories without these keys stay valid for `duckwright export` and for the TUI's past runs.
- **Errors:** capture errors never change the run's exit code or outcome. They appear only in `network_errors`.
- **Criteria:** SC1, SC2, SC4, SC5, SC6

### C2: per-request folder (File)

- **Surface:** `runs/<id>/network/<request id>/`
- **Output:** created for each entry in C1 `network`:
  - `request.json`: `{ "id": string, "step": number, "method": string, "url": string /* redacted */, "headers": [{ "name": string, "value": string }] /* redacted */ }`
  - `response.json`: `{ "status": number|null, "statusText": string, "type": string|null, "mimeType": string|null, "durationMs": number|null, "headers": [{ "name": string, "value": string }] /* redacted */ }`
  - `request-body.txt`: the redacted request body (UTF-8). Only when the `request <n>` output has the `request-body` hint and the body is non-empty.
  - `response-body.txt`: the redacted text response body. Or, instead, `response-body.bin`: the binary response body, byte-for-byte (D8, D9). Only when the hint is present and the body is non-empty.
  - JSON files are written with `JSON.stringify(x, null, 2)`.
  - `status` / `statusText` in `response.json` always come from the `requests` list line (D20), never from `request <n>`.
  - When `request <n>` fails, `request.json` and `response.json` are still written from the list line (headers `[]`, `type`/`mimeType`/`durationMs` `null`), and no body is fetched.
- Header redaction: the value of a header matching D12 is exactly `[REDACTED]`. Other values have D14 applied, and `referer`/`location` also D17.
- Body redaction: D15/D16, then D14.
- With capture off, no `network/` folder is created.
- **Errors:** a write failure → `network_errors` entry `"write <id>: <message>"`; the run continues.
- **Criteria:** SC1, SC2, SC4

### C3: `<network>` prompt section (Library: the prompt text sent to `claude -p`)

- **Surface:** the prompt built by `buildPrompt` for step N > 1.
- **Input:** the previous record's `network` entries and the current observation's `tabs`.
- **Output:** when the previous record has at least one entry, this section, placed after `</history>` and before any nudge and the page snapshot section:
  ```
  <network>
  POST /api/login → 201 Created
  GET https://cdn.other.com/x.json → 200 OK
  GET /missing → 404 Not Found
  GET http://localhost:1/dead → net::ERR_UNSAFE_PORT
  …and 3 more
  </network>
  ```
  - One line per entry in capture order, formatted per D24, at most 10 lines, then `…and N more` (N = entries − 10) when there are more than 10.
  - Path + query (redacted) for same-origin calls per D23, full redacted URL otherwise.
  - No headers, no bodies, no ids.
  - Every line has `flat()` and `neutralise()` applied (D26).
- No section when the previous record has no entries, has no `network` key, or there is no previous record.
- **Criteria:** SC2, SC3, SC4

### C4: `--network` / `--no-network` flag (CLI)

- **Surface:** `duckwright "<task>" [--network | --no-network]`, also with `-f` and `--tui`.
- **Input:** a negatable boolean; default on. The last one given wins. Neither flag takes a value; `--network=x` fails with `argument --network/--no-network: ignored explicit argument 'x'`, exit 2.
- **Output:** `RunArgs.network` is `true` (default or `--network`) or `false` (`--no-network`). `RUN_USAGE` gains `[--network | --no-network]` on the `[--export | --no-export]` line. `RUN_HELP` gains:
  ```
    --network, --no-network
                          record the API calls the page makes each step,
                          redacted, under runs/<id>/network (default on)
  ```
  placed after the `--export` entry.
- **Errors:** the existing argparse-style usage errors only.
- **Criteria:** SC4

### C5: task-file `network` key (File)

- **Surface:** task-file front matter `network: true|false`.
- **Input:** `true` or `false`. Anything else → `TaskFileError` `<file>:<line>: network must be true or false, got "<v>"`, exit 2 before anything runs.
- **Output:** sets the default for `RunArgs.network`; a CLI flag still overrides it. Accepted in `@`-mentioned files in the TUI as well.
- **Criteria:** SC4

### C6: playwright-cli output parsing contract (Library: internal adapter to an external tool, pinned to playwright-cli 0.1.22)

- **Surface:** how `src/network.ts` reads `playwright-cli` stdout, based on `probe-notes.md`.
- **Input/Output:**
  - Prefix: if the first line is `### Result`, it is dropped.
  - `requests`: each line matching `^(\d+)\. \[([^\]]+)\] (\S+) => (.*)$` gives `{ n, method, url, outcome }`. `outcome` is parsed by the D20 rule: if it matches `^\[(\d+)\] ?(.*)$`, status = int and statusText = group 2 trimmed; else if it matches `^\[FAILED\] ?(.*)$`, status `null` and statusText = group 1 trimmed; else status `null` and statusText = outcome trimmed. Other lines are ignored. `n` is the printed number (it counts static requests too, so numbers may skip) and is used as is for `request <n>` and the body commands.
  - `request <n>`: sections are found by header lines whose trimmed text is `General`, `Request headers` or `Response headers`. Inside a section, each non-empty indented line is trimmed and split at the first `:` that is not at position 0 (so an HTTP/2 pseudo-header like `:authority: x` keeps its name `:authority`); name and value are trimmed. A line with an empty value (`x-foo:`) or no space after the colon (`x-foo:bar`) is kept, with value `""` or `"bar"`. A line with no such colon is skipped. In General, `status:` is ignored (D20: the list line is the source of status), `duration:` is parsed per C1, and `type:` / `mimeType:` are taken as strings. Lines whose trimmed text starts with `Run \`` end the last section. Hint detection: only a line whose trimmed text starts with `Run \`` counts; it is a request-body hint if it contains `` `request-body <n>` `` and a response-body hint if it contains `` `response-body <n>` `` (with `<n>` the requested number). A header value or other line that merely contains those words is not a hint.
  - `request-body <n>`: stdout without the prefix is the body. One trailing `\n` is removed.
  - `response-body <n> --filename=<path>`: see D8. `<path>` is inside the request folder, which is created before this command runs (D6).
  - `requests --clear`: output ignored, exit code checked.
- **Errors:** a non-zero exit of any command → C1 `network_errors`.
- **Criteria:** SC1, SC5

### C7: README documentation (File)

- **Surface:** `README.md`.
- **Output:** the `--network` row in the options table (default `on`), `[--[no-]network]` in the usage block, a `network` row in the task-file keys table, a `network/` bullet in Output that describes the folder layout and files (C2), the `network` / `network_errors` step keys, a caution that captured bodies can still hold secrets the patterns miss, the D31 limits, and the D9 binary request body limitation. The roadmap item **Network capture** goes from `[ ]` to `[x]`.
- **Criteria:** SC6 (review)

Unchanged surfaces: `duckwright export` output, TUI screens, the plain console report, `events.jsonl` format (its `step:end.record` simply carries the new optional fields, already redacted).

## Data flow

1. `startRun` parses args (`network` default true, task file, then flags) and calls `createAgent({ ..., network: args.network })`.
2. `Agent.run()`: `open`, then optional `state-load`. If `network`: `clearRequests(pw)`; a failure message is kept on the `Agent` as `pendingErrors = ["initial requests --clear: …"]`.
3. Each step: observe (`tab-list`, snapshot). `buildPrompt` adds `<network>` from `history.at(-1)` and `obs.tabs`. The brain decides.
   - Brain error: if `network`, `clearRequests` (result ignored). The record has no network keys.
   - Otherwise: `execute(actions)`. If `network`: `captureStep(pw, workdir, step, nextId)`:
     1. `requests`, parsed into a list. On failure: error, empty list.
     2. For each listed request: `id = requestId(nextId++)`; `request <n>` → details (on failure: error, details from the list line only); `mkdir -p network/<id>` (on failure: `write <id>` error, skip the body commands); `request-body <n>` if hinted; `response-body <n> --filename=<dir>/response-body.raw` if hinted.
     3. Redact the URL, headers and bodies in memory (`redact.ts`).
     4. Write `request.json`, `response.json` and the body files into the existing folder. Remove or rename `response-body.raw`.
     5. Build the `NetworkEntry`.
     6. `requests --clear` (on failure: error).
   - The record is `{ step, decision, results, codes, network: entries, networkErrors?: [...pendingErrors, ...errors] }`. `pendingErrors` is consumed (and then emptied) by the first step whose actions ran; brain-error steps leave it untouched. If the run ends with `pendingErrors` still non-empty, it is dropped.
4. `record()` emits `step:end` (into `events.jsonl` and the history collected by `run.ts`).
5. At the end, `historyJson` serialises `network` / `network_errors` (C1).

## Error handling

| Failure | Behavior |
|---|---|
| `requests` exits non-zero or times out | `network_errors += "requests: <msg>"`, `network: []`, then still try `requests --clear` |
| `request <n>` fails | Error recorded; the entry and its folder are built from the list line only (C2); bodies are skipped |
| `request-body <n>` / `response-body <n>` fails | Error recorded; that body file is not written; the entry is kept |
| `response-body <n>` exits 0 but writes no file | Error `"response-body <n>: no file written"`; no response body file; the entry is kept |
| `response-body.raw` can't be read, renamed or deleted | Error `"write <id>: <msg>"`; best-effort delete in `finally` |
| Writing a folder or file fails (disk, permissions) | Error `"write <id>: <msg>"`; that entry stays in `network` |
| `requests --clear` fails after a step | Error recorded; the next step may re-list the same calls (D31) |
| Initial clear fails | Error put first in the `network_errors` of the first step whose actions ran; dropped if no step's actions ever run (D2) |
| Clear after a brain error fails | Ignored |
| Runner throws `AbortedError` (Ctrl-C, stop key) | Re-thrown: the run stops as today (exit 130, history written) |
| Runner throws anything else (e.g. spawn error) | Treated as that command's failure (error recorded) |
| Unparseable `requests` / `request <n>` output | No error: zero calls, or null/empty fields (D7, D33) |
| Body looks like JSON but `JSON.parse` fails | Treated as plain text (D14 only) |
| Malformed `%` escape in a form/query key | The raw key is tested; no error |

None of these change the run's outcome or exit code (SC5).

## Testing

All tests run with `node --test` on fakes; no real browser, no network. Checks: `npm test` (which runs `npm run typecheck` and then every `test/**/*.test.ts`) and `npm run typecheck`.

- `test/redact.test.ts`: D12 header names (each exact name, each substring, case-insensitivity, a non-secret header kept); D13 keys (contains-list, equals-list, `author` kept); nested JSON objects and arrays, non-string values, unchanged JSON kept byte for byte; form bodies (secret replaced, other pairs byte-identical, `+`/`%` keys); URL queries (fragment kept, no query unchanged); Bearer (case variants, `Bearer abc123` redacted, a bare `bearer` with no token kept); Basic (`dXNlcjpwYXNz` redacted, "Basic Plan" kept).
- `test/network.test.ts`: `parseRequestList` on the probe-notes samples (with and without `### Result`, the `Note:` line, a failed-load line giving `null` / `net::ERR_UNSAFE_PORT`, non-contiguous numbers, empty output); `parseRequestDetails` on the probe sample (status, duration, type, mimeType, both header blocks, hint detection (only lines starting with `Run \``; a header value containing `response-body 3` is not a hint), `duration:` values `2ms`, `1.5ms`, `0.25s` and a non-matching value, General `status:` ignored in favour of the list line, missing sections, a failed-load block with no duration/mimeType and no response-body hint, `x-foo:` and `x-foo:bar` lines, a `:authority` pseudo-header); `requestId`; `captureStep` with a fake `PlaywrightCLI` subclass, covering the exact command sequence (the folder exists before `response-body` runs; a failed `mkdir` skips body commands), folder files and their JSON, redaction in every file, text vs binary response body (the fake writes the `--filename` file), a missing file after exit 0 recorded as an error, each failure row in Error handling, `AbortedError` propagation, and no `response-body.raw` left; `networkSummary`, covering same-origin vs cross-origin, the `- 0: (current) [title](url)` tab line, first match wins, a non-current line containing the word "current", no current tab, null status, the 10-line cap and `…and N more`, URL clipping, and `neutralise` of `</network>`.
- `test/loop.test.ts`: with `network: true`, the call order (`open`, `requests --clear`, then per step `tab-list`, snapshot, actions, `requests`, …, `requests --clear`); capture after a `done` step; brain-error steps clear only; ids continue across steps; a failing `requests` doesn't stop the loop and lands in `networkErrors`; a failing initial clear lands first in the first executed step's `networkErrors`, skipping a preceding brain-error step, and is dropped when no step executes; with the default (`network` unset/false), no `requests*` calls at all.
- `test/prompt.test.ts`: `<network>` placement and absence cases (C3); `neutralise` handles `network`.
- `test/text.test.ts`: `neutralise("</network>")`.
- `test/args.test.ts`: default `true`, `--no-network`, last-wins, task-file setting overridden by a flag, the `--network=x` error, help text contains the C4 lines.
- `test/taskfile.test.ts`: `network: false` parsed; a bad value gives the C5 message.
- `test/runs/run.test.ts`: `historyJson` emits `network` / `network_errors` only when present; `startRun` passes `network` to `createAgent`.
- `test/export.test.ts`: the `greet` fixture with `network` arrays (and `network_errors`) added gives the identical `expected.spec.ts`. `test/runs/past.test.ts`: such a history still loads.

| Criterion | Contracts | Proved by |
|---|---|---|
| SC1 network array + per-request folder | C1, C2, C6 | `network.test.ts` (`captureStep`), `loop.test.ts`, `run.test.ts`; QA scenarios |
| SC2 secrets never written or shown | C1, C2, C3 | `redact.test.ts`, `network.test.ts` (every file scanned for the raw secrets), `prompt.test.ts`; QA scenarios |
| SC3 `<network>` summary, cap 10 + more | C3 | `network.test.ts` (`networkSummary`), `prompt.test.ts`; QA scenarios |
| SC4 off switch | C1, C2, C3, C4, C5 | `args.test.ts`, `taskfile.test.ts`, `loop.test.ts` (no `requests*` calls), `run.test.ts`; QA scenarios |
| SC5 capture failure doesn't fail the run | C1, C6 | `network.test.ts` failure rows, `loop.test.ts`; QA scenarios |
| SC6 nothing else changes | C1, C7 | `export.test.ts`, `past.test.ts`, the whole suite via `npm test` and `npm run typecheck`; README by review |

### Manual e2e

Not part of this run's verification. For the user, against a real browser with playwright-cli 0.1.22: run a task against a page that does `fetch('/api/login', { headers: { Authorization: 'Bearer …' }, body: '{"password":"…"}' })`, then check `history.json`, `runs/<id>/network/0001/` and the next prompt's `<network>` section. (The `response-body --filename`, failed-load and `tab-list` formats were already confirmed by the second probe in `probe-notes.md`.) Optionally check what `request-body` prints for a binary upload (D9 limitation).

## Out of scope

- `expect-request` assertions, API test export, a `request` action in the loop.
- Showing network calls in the TUI or the plain console report, and a TUI options-form field for `network`.
- Redacting values typed into form fields in actions/decisions (the separate "Secret redaction" item).
- Capturing successful static resources (`--static`), and a real `.har` file.
- Any change to `duckwright export` output.
- Redacting binary bodies; capturing other tabs, or calls lost to mid-step navigation.
- Faithful capture of binary request bodies (D9 limitation).
- Using `--json` output or `request-headers` / `response-headers`.
