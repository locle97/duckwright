# Debug Mode Prompt Logging Implementation Plan

**Goal:** Add a boolean `debug` run setting (`--debug` / `--no-debug`, task-file and config key) that logs every Claude call and Jev request of a run to `runs/<id>/debug.log` (and to stderr in `-p` mode), with redaction and a totals summary.
**Architecture:** A new `src/debuglog.ts` holds `DebugLog` plus two wrappers, `debugRunner` (around the injected `Runner`) and `debugTransport` (around `JevTransport`). `HybridBrain` gets one optional `onRoute` callback. `src/runs/run.ts` wires them only when `args.debug`; the agent loop and `Brain` are unchanged.
**Tech Stack:** TypeScript on Node (stdlib only), `node --test`.
**Spec:** docs/superpowers/specs/2026-10-10-debug-mode-prompt-logging-design.md

## Global Constraints
- Node standard library only; no new dependencies.
- With debug off: no `debug.log`, no console output, identical `history.json`, `events.jsonl`, stdout and exit codes.
- Nothing debug-related goes to stdout; the console sink is `deps.stderr` in print mode only (TUI and web write only the file).
- Every line written (file and console) passes through one `redact`: known secret values (trimmed `TYPESAFE_API_KEY` when non-empty) -> `[REDACTED]`; then the run's 2FA `Scrubber.scrub`; then `redactText` from `src/redact.ts`. Jev headers go through `redactHeaders` first. `redactBody` is NOT applied to envelopes or Jev bodies (it masks `*_tokens`).
- Prompts and responses are never truncated. Section size estimate is `Math.ceil(chars / 4)`, printed as `~N tokens (est.)`.
- A missing or non-finite usage number prints `n/a`.
- Every logger entry point catches its own exceptions; wrappers return or rethrow exactly what the inner runner/transport did.
- `fs.appendFileSync` per block; first write failure emits one warning `debug log: cannot write <path>: <message>` via `onWarning`, then file writes stop (console and run continue).
- Block header is `===== [debug <run-id>] <title> =====`, subheadings `----- <name> -----`, each block ends with a blank line; `<run-id>` is the run folder's base name.
- The `--plan` planner call is not logged. No TUI/web options-form change.
- Cost format is `$` + `fixed4(x)` from `src/text.ts`; Jev cost = `input_tokens * JEV_INPUT_USD_PER_TOKEN + output_tokens * JEV_OUTPUT_USD_PER_TOKEN`.
- Precedence: default < config `debug:` < task-file `debug:` < command-line flag.

## Review Focus
1. Secrets (API key, TOTP secret, issued 2FA code, `Bearer xyz`) leaking into file or console from prompt, envelope, headers or Jev body: pinned in Task 3 (redaction test) and Task 4 (Jev body/headers).
2. `*_tokens` usage fields accidentally masked by key-based redaction: pinned in Task 3 usage test.
3. A logger or write failure changing a run's result: pinned in Task 3 (write failure, wrapper rethrow) and Task 5.
4. Debug-off behaviour changing (`debug.log` created, `history.json` differing): pinned in Task 5.
5. Route reasons and their evaluation order drifting from `HybridBrain`'s checks: pinned in Task 2.

---

### Task 1: `debug` setting (flag, task-file key, config key)

**Files:**
- Modify: `src/args.ts`, `src/taskfile.ts`, `src/config.ts`
- Modify (add `debug: false` to `RunArgs` literals so typecheck passes): `test/twofa.leak.test.ts`, `test/runs/run.test.ts`
- Test: `test/args.test.ts`, `test/taskfile.test.ts`, `test/config.test.ts`

**Contracts:** C1, C2, C3

**Interfaces:**
- Consumes: existing `RunArgs`, `TaskSettings`, `KEYS`, `RUN_SPEC`, `DEFAULT_CONFIG`.
- Produces: `RunArgs.debug: boolean` (default `false`); `TaskSettings.debug: boolean`; `KEYS.debug = ["debug", "bool"]`.

**Checks:** `node --test test/args.test.ts test/taskfile.test.ts test/config.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (mirror the existing `--jev` tests in each file)
  - args: default `debug === false`; `--debug` -> true; `--no-debug` overrides a settings/task-file `debug: true`; `--debug --no-debug` -> false and `--no-debug --debug` -> true; `--debug=x` exits 2 with message `argument --debug/--no-debug: ignored explicit argument 'x'`; `RUN_USAGE` contains `"                  [--debug | --no-debug]\n"` directly after the `[--jev | --no-jev] [--jev-threshold FLOAT]` line; `RUN_HELP` contains the exact C1 help entry directly after the `--jev-threshold` entry.
  - taskfile: `debug: true` parses to `debug === true`; invalid value gives the same bool error format as `jev:` but naming `debug`; `debug` set twice gives `<file>:<line>: "debug" is set twice`.
  - config: `debug: true` in a config is picked up below task file and flags; `DEFAULT_CONFIG` contains `"# env: staging\n# debug: false\n"`.
- [ ] **Step 2: Run it**: `Run: node --test test/args.test.ts test/taskfile.test.ts test/config.test.ts` / `Expected: FAIL` (no `debug` setting).
- [ ] **Step 3: Implement**: in `args.ts` add `debug` to `RunArgs`, default `false`, map `--debug`/`--no-debug` to `"--debug/--no-debug"` in `RUN_SPEC.names`, handle like `--jev`/`--no-jev` (line ~335), add the usage line and help text from C1; in `taskfile.ts` add `debug: boolean` to `TaskSettings` and `debug: ["debug", "bool"]` to `KEYS`; widen the bool-key union type at taskfile.ts line ~185 to include `"debug"`; in `config.ts` add `# debug: false` after `# env: staging`. Add `debug: false` to the two test `RunArgs` literals.
- [ ] **Step 4: Run it**: `Run: node --test test/args.test.ts test/taskfile.test.ts test/config.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/args.ts src/taskfile.ts src/config.ts test/args.test.ts test/taskfile.test.ts test/config.test.ts test/twofa.leak.test.ts test/runs/run.test.ts && git commit -m "feat: add debug setting"`

### Task 2: `fetchTransport` export and `HybridBrain` `onRoute`

**Files:**
- Modify: `src/jev.ts`
- Test: `test/jev.test.ts`

**Contracts:** C4 (Route block reasons)

**Interfaces:**
- Consumes: existing `HybridBrain`, `JevTransport`.
- Produces: `export const fetchTransport: JevTransport` (renamed `defaultTransport`, same body); `export interface RouteInfo { step: number; outcome: "accepted" | "low_confidence" | "error" | "needs_text" | "done" | "skipped"; reason: string }`; `HybridBrain` constructor option `onRoute?: (r: RouteInfo) => void`.

**Checks:** `node --test test/jev.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/jev.test.ts`, reusing its existing fake Jev/Claude and step fixtures. Collect `RouteInfo`s via `onRoute` and assert exact `{outcome, reason}`:
  - skipped: `no step context` (no `step` arg; `step` in `RouteInfo` is `0`), `step 1 always uses Claude`, `repeat nudge in the prompt`, `previous step failed`, `no clickable targets on the page`, `too many targets (<n> > 255)`.
  - error: `jev error: <JevError message>`; needs_text: `jev says the next move needs typed text`; done: `jev says the task is done; Claude writes the answer`.
  - low_confidence: `action confidence 0.50 < threshold 0.80`; `target <ref> is not on the page`; `target confidence 0.50 < threshold 0.80`.
  - accepted: `jev chose click <ref> (confidence 0.90)` with c = min of the confidences; and `jev chose press_enter (confidence 0.90)` for a no-target action.
  - ordering: `onRoute` is called before the fake Claude `decide` for every Claude-routed case.
  - parity: decisions and costs are deep-equal with and without `onRoute`; a throwing `onRoute` does not break `decide` (callback wrapped in try/catch).
  - `fetchTransport` is exported (`typeof === "function"`).
- [ ] **Step 2: Run it**: `Run: node --test test/jev.test.ts` / `Expected: FAIL` (no `onRoute`, no `fetchTransport`).
- [ ] **Step 3: Implement** in `src/jev.ts`: rename `defaultTransport` to exported `fetchTransport` (update the one use). Add a private `route(step, outcome, reason)` that calls `onRoute` in try/catch, and call it at each exit of `decide()` in the existing check order (before `viaClaude`/return). Use `step?.ctx.step ?? 0`. For `low_confidence` pick the reason by the same condition order as the existing branch: action below threshold, else target not found, else target below threshold. Format confidences with `toFixed(2)`.
- [ ] **Step 4: Run it**: `Run: node --test test/jev.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/jev.ts test/jev.test.ts && git commit -m "feat: report hybrid routing and export fetchTransport"`

### Task 3: `DebugLog`, section parser and `debugRunner`

**Files:**
- Create: `src/debuglog.ts`
- Test: `test/debuglog.test.ts`

**Contracts:** C4 (run header, system prompts, Claude call, Summary), C5 (write failure), C6 (text identical to file)

**Interfaces:**
- Consumes: `Runner`, `ProcResult` (`src/proc.ts`); `RunEvents`/`RunEvent` (`src/events.ts`); `redactText`, `redactHeaders`, `REDACTED` (`src/redact.ts`); `fixed4` (`src/text.ts`); `RouteInfo`, `JEV_INPUT_USD_PER_TOKEN`, `JEV_OUTPUT_USD_PER_TOKEN` (`src/jev.ts`).
- Produces:
  - `class DebugLog` with constructor options `{ runId: string; file: string; console?: (text: string) => void; secrets?: string[]; scrub?: (text: string) => string; readFile?: (p: string) => string; now?: () => number; onWarning?: (m: string) => void }`; methods `attach(events: RunEvents): void`, `claudeCall(info: ClaudeCallInfo): void`, `jevRequest(info: JevRequestInfo): void`, `route(info: RouteInfo): void`, `write(block: string): void`, `now(): number`. `ClaudeCallInfo`/`JevRequestInfo` are exported interfaces designed here (argv, cwd, stdin, result or error, wall seconds; method, url, headers, body, status, text or error, wall seconds). `jevRequest` and `route` are fully implemented in Task 4; in this task they exist as stubs that do nothing.
  - `debugRunner(inner: Runner, log: DebugLog): Runner`
  - `promptSections(prompt: string): { name: string; chars: number }[]` (last entry `total`)
  - `estimateTokens(chars: number): number`

**Checks:** `node --test test/debuglog.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/debuglog.test.ts` (temp dir via `tmpDir` from `test/helpers.ts`, fake runner, injected clock):
  - `estimateTokens(10) === 3`. `promptSections(buildPrompt(...))` for paste mode (with environment, network, nudge) and file mode returns each section named by its tag (`task`, `environment`, `memory`, `tabs`, `history`, `network`, `page_snapshot` / `page_snapshot_file`), first line as `header`, nudge as `other`, in prompt order, and `total` equals the prompt length.
  - Creating `DebugLog` writes the file with exactly the run header block (`log: <absolute path>`); header lines carry the run id.
  - `debugRunner` returns the inner `ProcResult` object unchanged (`strictEqual`) and rethrows the inner error unchanged (`strictEqual` on the error); the block contains: the argv JSON line, `cwd:` (or `(inherited)`), `mode: grep` when argv has `--restricted` else `mode: paste`, system prompt file lines `<path> (<bytes> bytes)`, the section table, the full prompt verbatim, `exit: 0  wall: 1.50s` (clock 1500 ms apart), the pretty-printed envelope, `input tokens: 10  output tokens: 5  cache read: 3  cache write: 2` (proves `*_tokens` not masked), `cost: $0.0123`, `duration_ms`, `duration_api_ms`. `debugRunner` forwards the runner's full argument list to the inner runner (a recording fake asserts `argv`, `stdin`, `timeoutSec` and `opts` with `cwd` and `signal` are passed through by identity/deep-equal, including the 3-argument call with no `opts`). Missing/non-finite usage prints `n/a`; an envelope without `total_cost_usd` prints `cost: $n/a`; non-JSON stdout printed raw with usage `n/a`; stderr section only when non-empty; exit `-1` prints `exit: -1 (timeout)`; thrown error prints `error: <Error.name>: <message>` and no usage section.
  - Title is `step <n> · claude`, with `n` from the latest `step:start` event and `0` before any.
  - System prompts block (title `system prompts`) is written once across two calls, before the first call block, with full contents; an unreadable file prints `(cannot read: <message>)`.
  - Redaction: a fake API key (via `secrets`), a TOTP secret and an issued code (via a real `Scrubber`'s `scrub`) placed in the prompt, envelope and stderr never appear in the file or console text; `Bearer xyz` in a response becomes redacted.
  - Summary on `run:end` (emit via a `RunEvents`): `claude: 2 calls  input 30  output 15  cache read 6  cache write 4 tokens  cost $0.0300`, `total cost: $...`; `(usage missing on 1 calls)` suffix when a call lacked a field; `jev` and `routes` lines absent when none recorded.
  - Write failure (file in a missing directory): exactly one `onWarning("debug log: cannot write <path>: <message>")`, console output still receives every block, no throw.
  - Console text equals file text block by block.
- [ ] **Step 2: Run it**: `Run: node --test test/debuglog.test.ts` / `Expected: FAIL` (module missing).
- [ ] **Step 3: Implement** `src/debuglog.ts`. `redact(text)` applies secrets (skip empty), then `scrub`, then `redactText`. `write` redacts once, appends to file unless disabled, calls console; all in try/catch. `debugRunner` is `(argv, stdin, timeoutSec, opts) => ...` matching `Runner` in `src/proc.ts`: it records `log.now()` before and after `await inner(argv, stdin, timeoutSec, opts)` (passing all four arguments unchanged), calls `log.claudeCall` inside try/catch, and returns/rethrows exactly the inner outcome. `cwd` for the block comes from `opts?.cwd`. Real code facts checked against `src/brain.ts`: argv is `["claude","-p",...]`; grep mode adds `--restricted` and is called with `{cwd, signal}`, paste mode has `--tools ""`, no `--restricted` and `{signal}` only; `--append-system-prompt-file` values are absolute in grep mode and as given in paste mode; the envelope carries `total_cost_usd`, `is_error`, `result`, `structured_output` (the `usage.*`, `duration_ms`, `duration_api_ms` names are confirmed only by the manual e2e). Parse the envelope with `JSON.parse` in try/catch; usage from `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`; cost from `total_cost_usd`. System prompt files are the values following each `--append-system-prompt-file` in argv, read via `readFile` (default `fs.readFileSync(p, "utf8")`), bytes via `Buffer.byteLength`. `promptSections` splits the first line as `header`, matches `<tag>\n...\n</tag>` blocks (tag section includes its tags), any other non-blank text is `other`, and `total` is `prompt.length`. Keep running totals for the summary (Claude calls/tokens/cost/missing, Jev requests/retries/tokens/cost, route counts) so Task 4 only fills in `jevRequest`/`route`; write the summary block in `attach`'s `run:end` handler with the exact C4 layout.
- [ ] **Step 4: Run it**: `Run: node --test test/debuglog.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/debuglog.ts test/debuglog.test.ts && git commit -m "feat: add DebugLog and debugRunner"`

### Task 4: `debugTransport`, Jev request and route blocks

**Files:**
- Modify: `src/debuglog.ts`
- Test: `test/debuglog.test.ts`

**Contracts:** C4 (Jev request, Route, Summary `jev` and `routes` lines)

**Interfaces:**
- Consumes: `DebugLog`, `JevRequestInfo` (Task 3); `JevTransport` and `RouteInfo` (`src/jev.ts`).
- Produces: `debugTransport(inner: JevTransport, log: DebugLog): JevTransport`; working `DebugLog.jevRequest` and `DebugLog.route`.

**Checks:** `node --test test/debuglog.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** (fake transport):
  - `debugTransport` returns the same `status` and a `text()` yielding the same text as the inner response; a thrown inner error is rethrown unchanged and logged as `error: <Error.name>: <message>` with no usage section.
  - Block title `step <n> · jev request <k>`: `k` increments per attempt within a step (retry visible) and resets on `step:start`. Contents: `POST <url>`, `headers:` line with `Authorization: [REDACTED]`, pretty request body, `status: 200  wall: 0.25s`, pretty response, `input tokens: 100  output tokens: 20  cost: $...` (computed from the Jev price constants), and `answers:` lines like `action: click (confidence 0.900)`; `answers:` omitted when none valid; non-JSON response printed raw with usage `n/a`.
  - Redaction: the API key in the `Authorization` header value and in the body, and `Bearer xyz` in the response, never appear.
  - Route block: `outcome:`, `reason:`, `brain: jev` only for `accepted`, else `claude`; title `step <n> · route`.
  - Summary adds `jev: 3 requests (1 retries)  input ... output ... tokens  cost $...` and `routes: accepted 1  low_confidence 0  error 0  needs_text 0  done 0  skipped 1` lines; `total cost` = Claude + Jev.
- [ ] **Step 2: Run it**: `Run: node --test test/debuglog.test.ts` / `Expected: FAIL` (stubs, no `debugTransport`).
- [ ] **Step 3: Implement** `debugTransport` (read the inner `res.text()` once, record via `log.jevRequest` in try/catch, return `{ status, text: async () => text }`) and fill in `jevRequest`/`route` blocks and totals. Retries = requests beyond the first within a step. Headers printed as `name: value` pairs joined by `, ` after `redactHeaders`.
- [ ] **Step 4: Run it**: `Run: node --test test/debuglog.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/debuglog.ts test/debuglog.test.ts && git commit -m "feat: log Jev requests and routing"`

### Task 5: Wire into `startRun` and the CLI

**Files:**
- Modify: `src/runs/run.ts`, `src/cli.ts`
- Test: `test/runs/run.test.ts`, `test/cli.test.ts`

**Contracts:** C5, C6

**Interfaces:**
- Consumes: `DebugLog`, `debugRunner`, `debugTransport` (Tasks 3-4); `fetchTransport`, `HybridBrain` `onRoute` (Task 2).
- Produces: `RunDeps.debugConsole?: (text: string) => void`; test seams `RunDeps.runner?: Runner` and `RunDeps.jevTransport?: JevTransport` (the inner Claude runner and Jev transport; default `runProcess` / `fetchTransport`; also the only way tests keep `Brain` and `JevClient` off real `claude` and `fetch`).

**Checks:** `node --test test/runs/run.test.ts test/cli.test.ts`, `npm test`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - run.test.ts (fake agent via `createAgent`, `runsDir` in a temp dir): with `args.debug` true, `runs/<id>/debug.log` exists, begins with the run header, ends with the summary block, and every text passed to `debugConsole` concatenated equals the file content; with `debug` true and no `debugConsole`, the file is still written; with `debug` false, no `debug.log` exists and `history.json` is byte-identical to the debug-on run's `history.json`; a `debug.log` that cannot be written (pre-create `debug.log` as a directory) yields exactly one `onWarning` containing `debug log: cannot write` and the run outcome is unchanged. Jev wiring: set `args.jev` true, `deps.env = { TYPESAFE_API_KEY: "sk-test-key" }`, `deps.runner` a fake returning a valid Claude envelope, and `deps.jevTransport` a fake returning a valid Jev response (reuse the fixtures in `test/jev.test.ts`). The fake `createAgent` calls `opts.brain.decide(prompt, true, stepInput)` for a step-2 input with clickable targets (so Jev is asked), then once for step 1 (skipped, goes to Claude). Assert the file has a `jev request` block, a `route` block with `outcome: accepted` and one with `outcome: skipped`, a `claude` block, that the fake transport saw the real `Authorization` header (the seam is passed through), and that `sk-test-key` appears nowhere in the file or in `debugConsole` text. With `args.jev` false and debug on, `deps.jevTransport` is never called. With debug off, the injected `runner` and `jevTransport` are still used (called with the unwrapped behaviour) and no `debug.log` exists.
  - cli.test.ts: `-p --debug` sends debug blocks to the injected `stderr` while stdout lines equal those of the same run without `--debug`; without `--debug` nothing debug-related reaches stderr; the TUI path with `--debug` prints no debug text to stderr or stdout: use the existing fake `loadTui` pattern (`test/cli.test.ts` ~lines 850-870, `startTui({ manager })`) with `isTTY: () => true` and a `createAgent` that calls `opts.brain.decide`-free fake result; `interactiveMain` builds its `startRun` deps explicitly without `debugConsole`, so assert that after the run completes no stderr/stdout line contains `[debug `. The file side is covered by the run.test.ts case.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/run.test.ts test/cli.test.ts` / `Expected: FAIL` (no wiring).
- [ ] **Step 3: Implement** in `src/runs/run.ts`: add `debugConsole`, `runner` and `jevTransport` to `RunDeps` (import `Runner` from `src/proc.ts`, `JevTransport` from `src/jev.ts`); in `execute()` move `createTwoFactor(...)` above the `Brain` construction (no other change); when `args.debug`, build `DebugLog({ runId: path.basename(workdir), file: path.join(workdir, "debug.log"), console: deps.debugConsole, secrets: [trimmed TYPESAFE_API_KEY if non-empty], scrub: twofa.scrubber.scrub (bound), onWarning: deps.onWarning })`, `log.attach(events)`, and pass `runner: debugRunner(deps.runner ?? runProcess, log)` to `Brain`, `transport: debugTransport(deps.jevTransport ?? fetchTransport, log)` to `JevClient`, `onRoute: (r) => log.route(r)` to `HybridBrain`; when off, pass `runner: deps.runner` and `transport: deps.jevTransport` (undefined by default, so `Brain`/`JevClient` use their own defaults) and no `onRoute` (import `runProcess` from `src/proc.ts`). Do not add these seams to `CliDeps`. In `src/cli.ts` `runOne`, add `debugConsole: args.debug ? deps.stderr : undefined` to the `startRun` deps. `interactiveMain` is untouched.
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS` (whole suite, including typecheck).
- [ ] **Step 5: Commit**: `git add src/runs/run.ts src/cli.ts test/runs/run.test.ts test/cli.test.ts && git commit -m "feat: wire debug logging into runs"`

### Task 6: README

**Files:**
- Modify: `README.md`
- Test: `test/packaging.test.ts` (existing; confirm it still passes)

**Contracts:** C1, C2, C3, C5 (documentation)

**Interfaces:** None.

**Checks:** `npm test`, `npm run typecheck`

- [ ] **Step 1: Write the failing test**: none is natural for prose; instead run `Run: grep -n "jev" README.md` to find the usage synopsis, options table, task-file key table and Output list to mirror.
- [ ] **Step 2: Run it**: `Run: grep -c "debug.log" README.md` / `Expected: 0`.
- [ ] **Step 3: Implement**: add `[--debug | --no-debug]` to the usage synopsis, a `--debug, --no-debug` options-table row (text as in C1 help), a `debug` row in the task-file key table, a `debug.log` bullet in Output, and a "Debug mode" subsection with a short sample Claude block and a caution that the log contains full page snapshots (credentials are redacted but page content is not).
- [ ] **Step 4: Run it**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add README.md && git commit -m "docs: document --debug"`

## Manual e2e
- [ ] Run `duckwright -p --debug "<task>"` against a real site with the real `claude` CLI, and once with `--jev` and a real `TYPESAFE_API_KEY`; read `runs/<id>/debug.log` and confirm the envelope field names (`usage.*`, `total_cost_usd`, `duration_ms`, `duration_api_ms`) and Jev response fields match the live CLI and API, and that no credential appears.
