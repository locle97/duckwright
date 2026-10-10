# Debug mode: prompt and response logging (`--debug`)

## Summary

Duckwright drives a browser by asking Claude (`claude -p`) and, with `--jev`, TypeSafe's Jev for a decision every step. Today a developer cannot see what was actually sent or what came back, so tuning the prompts is guesswork. This change adds a boolean `debug` run setting (`--debug` / `--no-debug`, the `debug` task-file key, the `debug` config key). When on, every Claude call and every Jev HTTP request of a run is written as a human-readable block: the exact argv, the system prompt files, the full user prompt with per-section sizes, the raw response, parsed token usage, cost and latency, and, with `--jev`, why each step went to Jev or Claude. A totals summary closes the run. Blocks go to `runs/<id>/debug.log`, and in print mode (`-p`) also to stderr. Credentials are redacted. With debug off, nothing changes: no file, no output, identical `history.json`. The capture works by wrapping the injected `Runner` and `JevTransport` and by one optional routing callback on `HybridBrain`; the agent loop and the decision logic are unchanged.

## Decisions

| Topic | Decision |
| --- | --- |
| Flag shape | `--debug` / `--no-debug`, boolean, default `false`, parsed exactly like `--jev` / `--no-jev` (brief assumption). |
| Precedence | Built-in default < config `debug:` < task-file `debug:` < command-line flag, the existing order (brief assumption). |
| Token counts | Claude: from the envelope's `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`). Jev: from the response body's `usage` (`input_tokens`, `output_tokens`). A field that is missing or not a finite number prints `n/a` (brief assumption). |
| Section size estimate | `Math.ceil(chars / 4)`, always printed as `~N tokens (est.)` (brief assumption). |
| System prompt files | Their full contents are printed once per run, in a `system prompts` block before the first Claude call's block. Every Claude call block lists each file's path and size in bytes (brief assumption). |
| Log location and format | `runs/<id>/debug.log`, plain UTF-8 text, next to `history.json` (brief assumption). |
| Claude capture | A `Runner` wrapper (`debugRunner`) passed to `Brain` as its `runner`; `Brain` and `Agent` code are unchanged (brief assumption). |
| Jev capture | A `JevTransport` wrapper (`debugTransport`) passed to `JevClient` as its `transport`; it wraps the real fetch transport, which is exported from `src/jev.ts` as `fetchTransport` (currently the private `defaultTransport`). Each HTTP attempt is its own block, so retries are visible. |
| Routing capture | `HybridBrain` gains one optional constructor option, `onRoute?: (r: RouteInfo) => void`, called once per `decide()` before Claude is called (or before returning Jev's decision). Undefined by default, so behaviour without debug is identical. |
| Routing outcomes | The brief's `accepted`, `low_confidence`, `error`, `needs_text`, `done`, plus `skipped` for steps where Jev is never asked (step 1, repeat nudge, previous step failed, no targets, too many targets). Without `skipped`, the reason Claude was used on those steps would be invisible. |
| Batch runs | One `debug.log` per run (each run has its own folder). Every block's header names the run id (the run folder's base name), so interleaved stderr from a batch is attributable (brief assumption). |
| Size limit | None; prompts and responses are never truncated (brief assumption). |
| Step attribution | The logger subscribes to the run's `RunEvents` and takes the step number from the latest `step:start` event. No loop change is needed. |
| Prompt sections | Parsed from the prompt text: the first line (`Step N/M`) is `header`; each `<tag>\n...\n</tag>` block built by `buildPrompt` is a section named by its tag (`task`, `environment`, `memory`, `tabs`, `history`, `network`, `page_snapshot` or `page_snapshot_file`); any other non-blank text (the repeat nudge) is `other`, and the blank separators between sections count toward `total` only. Sizes count the whole section including its tags. |
| Mode label | `grep` when the argv contains `--restricted` (tools enabled, snapshot read from file), otherwise `paste`. |
| Latency | Wall-clock time measured by the wrapper with an injected clock (`now()`, default `performance.now`), printed in seconds with 2 decimals. Claude's own `duration_ms` and `duration_api_ms` from the envelope are printed too when present. |
| Redaction | Every line written (console and file) passes through one `redact` function: (1) each known secret value (the trimmed `TYPESAFE_API_KEY` when non-empty) is replaced by `[REDACTED]`; (2) the run's 2FA `Scrubber.scrub` (TOTP secret, issued codes); (3) `redactText` from `src/redact.ts` (Bearer/Basic credentials). Jev request headers are printed through `redactHeaders` first, so `Authorization` shows `[REDACTED]`. |
| Key-based body redaction | `redactBody`'s secret-key walk is **not** applied to envelopes or Jev bodies: `isSecretKey` matches `token`, so it would mask every `*_tokens` usage field, defeating the feature. The value-based steps above already remove the credentials the brief names. |
| 2FA scrubber ordering | In `src/runs/run.ts`, `createTwoFactor(...)` moves above the `Brain` construction so the logger can use its scrubber. It has no side effects at construction, so behaviour is unchanged. |
| Console target | Print mode only: `RunDeps` gains `debugConsole?: (text: string) => void`; `runOne` in `src/cli.ts` passes `deps.stderr` when `args.debug`. TUI and web never pass it, so they only write the file. |
| Write strategy | `fs.appendFileSync` per block (crash-safe, ordered, simple). The file is created when the logger is created, with a `run` header block. |
| Log write failure | First failure emits one warning through `onWarning`, then file writes stop for that run; console output and the run continue. |
| Logger errors | Every logger entry point catches its own exceptions; a wrapper always returns or rethrows exactly what the inner runner/transport did. Debug can never change a run's outcome. |
| Argv display | Printed as one JSON array line (`JSON.stringify(argv)`): unambiguous, and the `--json-schema` value stays on one line. |
| Response display | Claude stdout and Jev response text are pretty-printed with `JSON.stringify(parsed, null, 2)` when they parse as JSON, else printed raw. Jev request body likewise. |
| Cost display | `$` + `fixed4(x)` from `src/text.ts`, the format used everywhere else. Jev cost = `input_tokens * JEV_INPUT_USD_PER_TOKEN + output_tokens * JEV_OUTPUT_USD_PER_TOKEN`, same as `JevClient`. |
| Planner | `--plan` mode's planner call is not logged; the brief covers run steps only. |
| TUI options form | Not extended with a debug field; the brief excludes TUI changes. TUI/web runs still honour `--debug`, config and task-file `debug`. |
| `duckwright init` template | Gains `# debug: false` as the line after `# env: staging`. |

## Architecture / Components

### `src/debuglog.ts` (new)

One module, Node standard library only.

- `class DebugLog` — owns one run's log.
  - Constructor options: `{ runId: string; file: string; console?: (text: string) => void; secrets?: string[]; scrub?: (text: string) => string; readFile?: (p: string) => string; now?: () => number; onWarning?: (m: string) => void }`.
  - `attach(events: RunEvents): void` — subscribes; tracks the current step from `step:start`; on `run:end` writes the summary block.
  - `claudeCall(info)` / `jevRequest(info)` / `route(info)` — record one block each and update totals.
  - `write(block: string)` — redacts, appends to file, sends to console.
- `function debugRunner(inner: Runner, log: DebugLog): Runner` — times the call, records argv, cwd, stdin prompt, result (or thrown error), then returns/rethrows unchanged.
- `function debugTransport(inner: JevTransport, log: DebugLog): JevTransport` — records URL, method, headers, body, status, response text and duration; returns a response object whose `text()` yields the same text already read (the inner `text()` is read once by the wrapper).
- `function promptSections(prompt: string): { name: string; chars: number }[]` — the section parser.
- `function estimateTokens(chars: number): number` — `Math.ceil(chars / 4)`.

### `src/jev.ts` (modified)

- Export the real transport as `fetchTransport` (rename of `defaultTransport`; same body).
- `export interface RouteInfo { step: number; outcome: "accepted" | "low_confidence" | "error" | "needs_text" | "done" | "skipped"; reason: string }`.
- `HybridBrain` constructor accepts `onRoute?: (r: RouteInfo) => void` and calls it at each routing exit, before calling Claude. Reasons are the exact strings in the Routing block contract (C4).

### `src/args.ts`, `src/taskfile.ts`, `src/config.ts` (modified)

- `RunArgs.debug: boolean`, default `false`; `--debug` / `--no-debug` added to `RUN_SPEC.names` as `"--debug/--no-debug"`; a new usage line and help entry (C1).
- `TaskSettings.debug`, and `KEYS.debug = ["debug", "bool"]`; the config inherits it via `RUN_KEYS`.
- `DEFAULT_CONFIG` gains `# debug: false` after `# env: staging`.

### `src/runs/run.ts` (modified)

- `RunDeps.debugConsole?: (text: string) => void`.
- In `execute()`: move `createTwoFactor` above the brain. When `args.debug`, create `DebugLog` with `runId = path.basename(workdir)`, `file = path.join(workdir, "debug.log")`, `console = deps.debugConsole`, `secrets = [TYPESAFE_API_KEY trimmed]` (when non-empty), `scrub = twofa.scrubber.scrub`, `onWarning = deps.onWarning`; call `log.attach(events)`; pass `runner: debugRunner(runProcess, log)` to `Brain`, `transport: debugTransport(fetchTransport, log)` to `JevClient`, and `onRoute: (r) => log.route(r)` to `HybridBrain`. When off, none of these are passed.

### `src/cli.ts` (modified)

- `runOne` passes `debugConsole: args.debug ? deps.stderr : undefined` to `startRun`. Nothing else in cli changes. `interactiveMain` passes nothing.

### `README.md` (modified)

- Usage synopsis and options table row for `--debug`; `debug` row in the task-file key table; a `debug.log` bullet in Output; a short "Debug mode" subsection with a sample block and a caution that the log holds full page snapshots.

## Contracts

### C1: `--debug` / `--no-debug` flag (CLI)

- **Surface:** `duckwright [-p] --debug ...`, `duckwright --no-debug ...`
- **Input:** boolean flag, no value. Default off. Last of `--debug` / `--no-debug` on the command line wins. Overrides task-file and config `debug`.
- **Output:** `RUN_USAGE` gains the line `"                  [--debug | --no-debug]\n"` directly after the `[--jev | --no-jev] [--jev-threshold FLOAT]` line. `RUN_HELP` gains, after the `--jev-threshold` entry:
  ```
    --debug, --no-debug   log every prompt sent to Claude and Jev, the raw
                          responses, tokens, cost and timing to
                          runs/<id>/debug.log, and with -p also to stderr
                          (default off). The log holds full page snapshots;
                          credentials are redacted
  ```
  Exit codes unchanged.
- **Errors:** `--debug=x` → exit 2, `duckwright: error: argument --debug/--no-debug: ignored explicit argument 'x'` (existing boolean-flag handling).
- **Criteria:** SC1, SC6

### C2: `debug` task-file key (File)

- **Surface:** front matter `debug: true|false` in a task file.
- **Input:** a bool value in the same syntax `jev:` accepts.
- **Output:** sets the run's `debug`; overridden by `--debug` / `--no-debug`.
- **Errors:** an invalid value → exit 2 with the existing bool message format for that key, `<file>:<line>: ...` naming `debug`; set twice → `<file>:<line>: "debug" is set twice`.
- **Criteria:** SC6

### C3: `debug` config key (File)

- **Surface:** `debug: true|false` in `duckwright.conf`; `duckwright init` writes `# debug: false` after `# env: staging`.
- **Input/Output/Errors:** as C2, with the config file named in errors; below task files and flags.
- **Criteria:** SC6

### C4: Debug block format (File and console text)

Every block starts with a header line `===== [debug <run-id>] <title> =====` and ends with a blank line. Subheadings are `----- <name> -----`. `<run-id>` is the run folder's base name, e.g. `20261010-101500-login`. The text below is exact; `<…>` are values.

**Run header** (written once when the log is created; title `run`):
```
===== [debug <run-id>] run =====
log: <absolute path of debug.log>
```

**System prompts** (once, before the first Claude call block; title `system prompts`), one entry per `--append-system-prompt-file` value in argv order:
```
----- <path> (<bytes> bytes) -----
<full file contents>
```
An unreadable file prints `(cannot read: <message>)` as its contents.

**Claude call** (title `step <n> · claude`):
```
argv: <JSON array>
cwd: <cwd or "(inherited)">
mode: <grep|paste>
system prompt files:
  <path> (<bytes> bytes)
prompt sections:
  <name padded to 18>  <chars> chars  ~<est> tokens (est.)
  total               <chars> chars  ~<est> tokens (est.)
----- prompt (stdin) -----
<full prompt, verbatim>
----- response -----
exit: <code>  wall: <s.ss>s
<pretty JSON envelope, or raw stdout>
----- stderr -----          (only when stderr is non-empty)
<stderr>
----- usage -----
input tokens: <n|n/a>  output tokens: <n|n/a>  cache read: <n|n/a>  cache write: <n|n/a>
cost: $<fixed4|n/a>  duration_ms: <n|n/a>  duration_api_ms: <n|n/a>
```
A timeout (exit `-1`) prints `exit: -1 (timeout)`. When the runner throws (abort, spawn error) the response section is `error: <Error.name>: <message>` and there is no usage section. `<n>` before the first `step:start` is `0`.

**Jev request** (title `step <n> · jev request <k>`, `k` counting 1.. within the step, so `k > 1` is a retry):
```
POST <url>
headers: <name>: <value>, ...       (through redactHeaders)
----- request body -----
<pretty JSON>
----- response -----
status: <status>  wall: <s.ss>s
<pretty JSON, or raw text>
----- usage -----
input tokens: <n|n/a>  output tokens: <n|n/a>  cost: $<fixed4|n/a>
answers:
  <question id>: <choice> (confidence <0.000>)
```
`answers:` lists each entry of the response's `answers` object that has a string `choice` and numeric `confidence`; it is omitted when there are none. A transport failure replaces the response section with `error: <Error.name>: <message>` and omits usage.

**Route** (title `step <n> · route`):
```
outcome: <accepted|low_confidence|error|needs_text|done|skipped>
reason: <reason>
brain: <jev|claude>
```
`brain` is `jev` only for `accepted`. Exact reasons:

| Outcome | Reason |
| --- | --- |
| skipped | `no step context` · `step 1 always uses Claude` · `repeat nudge in the prompt` · `previous step failed` · `no clickable targets on the page` · `too many targets (<n> > 255)` |
| error | `jev error: <JevError message>` |
| needs_text | `jev says the next move needs typed text` |
| done | `jev says the task is done; Claude writes the answer` |
| low_confidence | `action confidence <a.aa> < threshold <t.tt>` when the action is below; else `target <ref> is not on the page`; else `target confidence <b.bb> < threshold <t.tt>` |
| accepted | `jev chose <action>[ <ref>] (confidence <c.cc>)` with `c` = min of the confidences used |

Checks are evaluated in the order listed for `skipped` and `low_confidence`, matching `HybridBrain`'s existing order. A `JevAuthError` is not routed (it ends the run as today), so no route block is written for it.

**Summary** (written on `run:end`; title `summary`):
```
claude: <calls> calls  input <n>  output <n>  cache read <n>  cache write <n> tokens  cost $<fixed4>
jev: <requests> requests (<retries> retries)  input <n>  output <n> tokens  cost $<fixed4>
routes: accepted <n>  low_confidence <n>  error <n>  needs_text <n>  done <n>  skipped <n>
total cost: $<fixed4>
```
Token sums add only numeric values; when any call lacked a field, the line ends with `  (usage missing on <k> calls)`. The `jev` and `routes` lines appear only when at least one Jev request or route was recorded. Claude cost sums `total_cost_usd` of parseable envelopes; `total cost` = Claude + Jev.

- **Errors:** none visible beyond C5's warning.
- **Criteria:** SC1, SC2, SC3, SC4

### C5: `runs/<id>/debug.log` (File)

- **Surface:** `runs/<id>/debug.log`, plain UTF-8.
- **Who:** created only when the run's `debug` is true; never otherwise.
- **Output:** the C4 blocks in the order they happened, appended as they happen; always in every mode (`-p`, batch, TUI, web).
- **Errors:** a write failure → one warning `debug log: cannot write <path>: <message>` (printed by `-p` as `warning: debug log: cannot write ...`; shown as an error notice in TUI/web), then no further file writes for that run; the run's outcome and exit code are unaffected.
- **Criteria:** SC1, SC4, SC5, SC7

### C6: Debug console output (CLI)

- **Surface:** stderr of `duckwright -p --debug ...` (single and batch runs).
- **Output:** exactly the text written to `debug.log`, block by block, through `deps.stderr`. Nothing debug-related is written to stdout; stdout is byte-identical to a run without `--debug`. Without `-p` (TUI or web), nothing debug-related is printed to the console.
- **Errors:** none.
- **Criteria:** SC1, SC5, SC7

### Surfaces that must not change

`history.json` shape and contents, `events.jsonl`, stdout of `-p`, exit codes, `duckwright export`, and every existing option's behaviour.

## Data flow

1. `parseRunArgs` resolves `args.debug` from defaults < config < task file < flags.
2. `cli.runOne` (print mode) passes `debugConsole = deps.stderr` when `args.debug`; TUI/web pass none.
3. `startRun` makes the run folder; `execute()` creates the 2FA object, then (debug on) `DebugLog`, which creates `debug.log` with the run header and subscribes to `events`.
4. `Brain` is built with `runner = debugRunner(runProcess, log)`; with `--jev`, `JevClient` with `transport = debugTransport(fetchTransport, log)` and `HybridBrain` with `onRoute`.
5. Each step: `Agent` emits `step:start` (logger updates the step) and calls `brain.decide`.
   - With Jev: `HybridBrain` decides the route; `onRoute` writes the route block (before any Claude call). Each Jev HTTP attempt passes through `debugTransport`, which writes a request block.
   - Claude: `debugRunner` calls `runProcess`, then writes (once per run) the system prompts block and the call block with sections, prompt, envelope and usage, and returns the identical `ProcResult`.
6. Every block passes through `redact` (secret values → scrubber → `redactText`) and is appended to the file and sent to the console sink.
7. On `run:end`, the logger writes the summary block.

## Error handling

| Failure | Behaviour |
| --- | --- |
| `debug.log` cannot be created or appended | One warning via `onWarning` (`debug log: cannot write <path>: <message>`), file writes stop; console continues; run unaffected (C5). |
| A system prompt file cannot be read | `(cannot read: <message>)` in the system prompts block; run unaffected. |
| Claude exits non-zero or times out | Block shows exit code (`-1 (timeout)`), raw stdout and stderr; `Brain` raises its usual `BrainError`. |
| Claude stdout is not JSON | Printed raw; usage fields `n/a`; not counted in Claude cost. |
| Runner throws (abort, spawn error) | Block shows `error: <name>: <message>`; the error is rethrown unchanged. |
| Jev transport throws (timeout, network) | Request block shows the error; rethrown unchanged; `JevClient` behaves as today. |
| Jev response not JSON or without usage | Printed raw; usage `n/a`. |
| A logger method throws internally | Caught inside the logger; the wrapped call's result is unaffected. |
| Run aborted (Ctrl-C) | Blocks so far stay in the file; `run:end` still writes the summary. |

## Testing

Checks: `npm test` (runs `npm run typecheck`, then `node --test "test/**/*.test.ts"`) and `npm run typecheck`.

Unit and integration tests (fake runner, fake transport, temp run dirs, injected clock):

- `test/debuglog.test.ts`
  - `promptSections` on a `buildPrompt` output (paste and file modes, with environment, network and nudge) names every section in prompt order, and `total` equals the prompt length; `estimateTokens(10) === 3`.
  - `debugRunner` returns the inner `ProcResult` unchanged and rethrows inner errors unchanged; the block contains the argv JSON, `mode: grep` / `mode: paste`, the full prompt, the pretty envelope, parsed usage, `$` cost and `wall:`; missing usage prints `n/a`; timeout prints `exit: -1 (timeout)`.
  - System prompts block is written once across two calls, with full contents; unreadable file prints `(cannot read: ...)`.
  - `debugTransport` returns identical status and text; each attempt is `jev request <k>` with `k` incrementing within a step and resetting on `step:start`; `Authorization` shows `[REDACTED]`; answers and usage lines.
  - Redaction: a fake API key, a TOTP secret and an issued 2FA code placed in the prompt, envelope, headers and Jev body never appear in console text or file; a `Bearer xyz` in a response is redacted.
  - Summary totals from known calls (Claude tokens/cost, Jev requests/retries/tokens/cost, route counts, `usage missing on k calls`).
  - A write failure (file path in a missing directory) produces exactly one warning and console output continues.
  - Header lines carry the run id.
- `test/jev.test.ts`: `HybridBrain` with `onRoute` reports each outcome and exact reason (all `skipped` reasons, `error`, `needs_text`, `done`, the three `low_confidence` reasons, `accepted`); `onRoute` is called before the Claude fake; decisions and costs are identical with and without `onRoute`.
- `test/args.test.ts`: default false, `--debug`, `--no-debug` overriding settings, last wins, `--debug=x` error, usage/help text.
- `test/taskfile.test.ts`, `test/config.test.ts`: the `debug` key parses; `DEFAULT_CONFIG` contains `# env: staging\n# debug: false\n`.
- `test/runs/` (startRun with a fake agent/brain and `runsDir` in a temp dir): debug on creates `debug.log` with the run header and summary and sends the same text to `debugConsole`; debug off creates no `debug.log` and `history.json` equals the debug-on run's `history.json`.
- `test/cli.test.ts`: `-p --debug` sends debug blocks to `stderr` and stdout lines equal those of the same run without `--debug`; TUI path with `--debug` passes no console sink.

| Criterion | Contracts | Proved by |
| --- | --- | --- |
| SC1 | C1, C4, C5, C6 | `debuglog.test.ts` Claude block tests; runs and cli tests (stderr = file text); QA scenarios in the test plan |
| SC2 | C4, C5 | `debuglog.test.ts` Jev block tests; `jev.test.ts` routing reasons; QA scenarios |
| SC3 | C4 | `debuglog.test.ts` summary test; QA scenario |
| SC4 | C4, C5 | `debuglog.test.ts` redaction test; review of every write path through `redact` |
| SC5 | C5, C6 | runs test (no file, identical `history.json`), cli test (identical stdout), full existing suite passing via `npm test` |
| SC6 | C1, C2, C3 | args, taskfile and config tests; review of README |
| SC7 | C5, C6 | cli test (no console sink outside `-p`), runs test (file written without console); QA scenario |

### Manual e2e

- Run `duckwright -p --debug "<task>"` against a real site with a real `claude` CLI, and once with `--jev` and a real `TYPESAFE_API_KEY`, and read `debug.log` to confirm envelope field names match the live CLI and API.

## Out of scope

- Debug output in the TUI or web UI (those modes only write `debug.log`), and a debug field in the TUI/web options form.
- Any change to prompts, routing thresholds or the decision loop's behaviour.
- A prompt-diff or analysis tool, token estimation beyond chars/4, and replaying logged prompts.
- Changing `history.json`'s shape.
- Logging the `--plan` planner's Claude call.
- Log rotation or size limits.
