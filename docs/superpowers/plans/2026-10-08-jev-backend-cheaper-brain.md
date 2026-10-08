# Jev backend (`--jev`) Implementation Plan

**Goal:** Add an opt-in `--jev` per-step router that lets TypeSafe's Jev pick confident, text-free moves and falls back to Claude for everything else, reachable from every run-setting surface.
**Architecture:** A new `src/jev.ts` holds target extraction, an HTTP `JevClient` and a `HybridBrain` that implements the existing `DecideFn`. `Agent.loop` passes a scrubbed `StepInput` as a third `decide` argument and records a per-step cost; `startRun` wraps `Brain` in `HybridBrain` when `args.jev`. Flags, task-file/config keys, manager overrides, the TUI/web toggles, `history.json`, the plain report and the README carry the setting and its results.
**Tech Stack:** TypeScript on Node 22 (type stripping), `node:test`, built-in `fetch`, React (web UI), Ink (TUI).
**Spec:** `docs/superpowers/specs/2026-10-08-jev-backend-cheaper-brain-design.md`

## Global Constraints

- Node 22 built-in `fetch`, injectable for tests. No new dependencies.
- `JEV_MODEL = "jev-latest"`; no flag to change it.
- `JEV_INPUT_USD_PER_TOKEN = 42e-9`, `JEV_OUTPUT_USD_PER_TOKEN = 42e-9` (code comment: conservative placeholder, no output price published). Cost = `input_tokens × input + output_tokens × output`.
- 10 s per HTTP attempt (`JEV_TIMEOUT_MS = 10_000`) via `AbortSignal.timeout`, combined with the run's signal.
- 429 and 529 are retried twice: sleep 1000 ms, then 3000 ms (3 attempts in all). Sleep is injectable and stops early on abort.
- Run signal aborted during a Jev call or retry sleep → `AbortedError` (not `JevError`).
- `JevError` never reaches the loop and never counts toward `--max-failures`; `JevAuthError` propagates and stops the run.
- Threshold accepted syntax `/^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/`, range `0 < t <= 1`. Threshold without `--jev` is allowed and ignored.
- Precedence: built-in < config < task file < flags < TUI/web overrides (for `jev`).
- `history.json` always carries per-step `cost_usd`, `source`, `jev` and top-level `jev_steps`, `claude_steps`, for every run. Older files without them still load and export.
- The planner call (`runPlanner`) stays on Claude. TUI/web summaries are unchanged. No `jev-threshold` UI field.
- All tests are unit tests with fakes. No network, no browser. No e2e test is written or run.

## Review Focus

1. `JevClient` must tell run abort (→ `AbortedError`) from timeout (→ `JevError("jev timeout after 10s")`) from network failure; pinned by the abort/timeout/network tests in Task 2.
2. A `JevError` must never bump the loop's consecutive-failure count, while `JevAuthError` must escape `Agent.run` and become `jev error: invalid TYPESAFE_API_KEY`, exit 1, with `history.json` written; pinned in Task 4 (loop) and Task 8 (cli).
3. Everything Jev sees (`task`, `memory`, `historyLines`, `obs.tabs`, `obs.snapshot`) must go through the 2FA scrubber; pinned by the scrubbed-`StepInput` test in Task 4.
4. Threshold boundaries: `t === minConfidence` is accepted; `0`, `1.5`, `-0.5`, `1e-1`, `nan` are rejected with the exact messages; pinned in Tasks 3, 5, 6.
5. `history.json` shape for non-Jev runs (`source: "claude"`, `jev: null`, `jev_steps: 0`) and the brain-error step carrying `jev` from `BrainError`; pinned in Tasks 4 and 7.

---

### Task 1: Core types, `Brain.decide` third argument, `historyLines`

**Files:**
- Modify: `src/brain.ts`, `src/prompt.ts`
- Test: `test/brain.test.ts`, `test/prompt.test.ts`

**Contracts:** C5 (the `Brain.decide` part)

**Interfaces:**
- Produces (in `src/brain.ts`):
  - `export interface JevRecord { action: string | null; action_confidence: number | null; target: string | null; target_confidence: number | null; routed: string }`
  - `Decision` gains `source?: "claude" | "jev"; jev?: JevRecord | null`
  - `export interface StepContext { step: number; task: string; memory: string; historyLines: string[]; nudged: boolean; previousFailed: boolean }`
  - `export interface StepInput { obs: Observation; ctx: StepContext }` (`import type { Observation } from "./observe.ts"`)
  - `Brain.decide(prompt: string, grep = true, _step?: StepInput): Promise<[Decision, number]>`; returned decisions carry `source: "claude", jev: null`
  - `BrainError` gains public `jev: JevRecord | null = null` (constructor signature unchanged)
- Produces (in `src/prompt.ts`):
  - `StepRecord` gains `costUsd?: number`
  - `export function historyLines(history: StepRecord[], window = HISTORY_WINDOW): string[]`

**Checks:** `node --test test/brain.test.ts test/prompt.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**
  - `test/brain.test.ts` `"decide ignores the step argument and tags source claude"`: with the existing fake runner returning a valid envelope, `await brain.decide("p", true, { obs: {tabs:"",snapshot:"",truncated:false,lines:0,chars:0}, ctx: {step:2,task:"t",memory:"",historyLines:[],nudged:false,previousFailed:false} })` returns a decision with `source === "claude"`, `jev === null`, and the runner argv/prompt equal those of a call without the third argument.
  - `"BrainError has jev null by default"`: `new BrainError("x", 1).jev === null`.
  - `test/prompt.test.ts` `"historyLines returns stepLines of the last window"`: 17 records → 16 lines, the first `"(2 earlier steps omitted)"`, the rest equal `stepLine` of records 3..17; 0 records → `[]`; `historyLines(h, 0)` with 3 records → `["(3 earlier steps omitted)"]`.
  - `"buildPrompt output unchanged"`: existing buildPrompt tests keep passing (no edit).
- [ ] **Step 2: Run it**: `Run: node --test test/brain.test.ts test/prompt.test.ts` / `Expected: FAIL (historyLines not exported, source undefined)`
- [ ] **Step 3: Implement** the types above; `Brain.decide` returns `[{ ...parseDecision(so), source: "claude", jev: null }, cost]`; `historyLines` is the slice/omitted logic lifted out of `buildPrompt`, which now calls it (`window > 0 ? history.slice(-window) : []` kept).
- [ ] **Step 4: Run it**: `Run: node --test test/brain.test.ts test/prompt.test.ts && npm run typecheck` / `Expected: PASS` (fix any existing test that deep-equals a `Brain.decide` result by adding `source: "claude", jev: null`)
- [ ] **Step 5: Commit**: `git add src/brain.ts src/prompt.ts test/brain.test.ts test/prompt.test.ts && git commit -m "feat: add step input and jev record types to brain"`

---

### Task 2: `src/jev.ts` part 1: `extractTargets` and `JevClient`

**Files:**
- Create: `src/jev.ts`
- Test: `test/jev.test.ts`

**Contracts:** C5 (`extractTargets`, `JevClient`), C6

**Interfaces:**
- Consumes: `JevRecord` (re-export with `export type { JevRecord } from "./brain.ts"`), `AbortedError` from `src/proc.ts`.
- Produces:
  - `export interface Target { ref: string; role: string; name: string }`
  - `export const TARGET_ROLES = ["link", "button", "checkbox", "radio", "tab", "menuitem", "option"] as const`, `export const MAX_TARGETS = 255`
  - `export function extractTargets(snapshot: string): Target[]`
  - `export const JEV_URL = "https://api.typesafe.ai/v1/systemone"`, `JEV_MODEL = "jev-latest"`, `JEV_TIMEOUT_MS = 10_000`, `JEV_RETRY_DELAYS_MS = [1000, 3000]`, `JEV_INPUT_USD_PER_TOKEN = 42e-9`, `JEV_OUTPUT_USD_PER_TOKEN = 42e-9`
  - `export class JevAuthError extends Error` (`name = "JevAuthError"`, message `"invalid TYPESAFE_API_KEY"`)
  - `export class JevError extends Error { cost: number; constructor(msg: string, cost = 0) }` (`name = "JevError"`)
  - `export interface JevQuestion { type: "choice"; question: string; criteria: Record<string, string> }`
  - `export interface JevAnswer { choice: string; confidence: number; probabilities?: Record<string, number> }`
  - `export type JevTransport = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>`
  - `export type JevSleep = (ms: number, signal?: AbortSignal) => Promise<void>`
  - `export class JevClient { readonly apiKey: string; readonly model: string; constructor(o: { apiKey: string; model?: string; timeoutMs?: number; transport?: JevTransport; sleep?: JevSleep; signal?: AbortSignal }); ask(state: unknown, questions: Record<string, JevQuestion>): Promise<[Record<string, JevAnswer>, number]> }`

**Checks:** `node --test test/jev.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/jev.test.ts` (fake transport records calls and returns a scripted list of `{status, body}`; fake sleep records `ms`):
  - `extractTargets`:
    - `"keeps only target roles in order"`: snapshot lines `- heading "H" [ref=e1]`, `- link "Home" [ref=e2] [cursor=pointer]:`, `  - button "Go" [ref=e3]`, `- textbox "Q" [ref=e4]`, `- checkbox "Agree" [checked] [ref=e5]` → `[{ref:"e2",role:"link",name:"Home"},{ref:"e3",role:"button",name:"Go"},{ref:"e5",role:"checkbox",name:"Agree"}]`.
    - `"unnamed kept only with cursor pointer"`: `- button [ref=e6] [cursor=pointer]` kept with `name: ""`; `- button [ref=e7]` and `- link "" [ref=e8]` dropped.
    - `"duplicate refs dropped"`: second `[ref=e2]` line ignored.
    - `"escaped quotes and backslashes unescaped"`: `- button "Say \"hi\" \\ now" [ref=e9]` → name `Say "hi" \ now`.
    - `"lines without ref ignored"`: `- button "X"` → `[]`.
  - `JevClient` (all with `transport` and `sleep` fakes):
    - `"request url, headers and body"`: one call to `JEV_URL`, `method: "POST"`, headers `{ Authorization: "Bearer k", "Content-Type": "application/json" }`, `JSON.parse(body)` deep-equals `{ model: "jev-latest", state, questions }`.
    - `"cost uses both prices"`: usage `{input_tokens: 1000, output_tokens: 10}` → cost `1000*42e-9 + 10*42e-9`; answers returned as given.
    - `"429 then success"`: sleeps `[1000]`, 2 transport calls, resolves.
    - `"529 three times"`: rejects `JevError` message `"jev http 529 after 3 attempts"`, cost 0, sleeps `[1000, 3000]`, 3 calls.
    - `"401 is JevAuthError without retry"`: `instanceof JevAuthError`, message `"invalid TYPESAFE_API_KEY"`, 1 call, no sleeps.
    - `"422 body excerpt"`: body `"bad\n\n  input " + "x".repeat(300)` → message `"jev http 422: " + "bad input " + "x".repeat(190)` (whitespace runs collapsed to one space, trimmed, first 200 chars).
    - `"other status"`: 500 → `"jev http 500"`, no retry.
    - `"timeout"`: transport rejects with `new DOMException("t", "TimeoutError")` → `"jev timeout after 10s"`, cost 0.
    - `"network error"`: transport rejects `new TypeError("fetch failed")` → `"jev network error: fetch failed"`.
    - `"non-JSON body"`: 200 `"<html>"` → `"jev malformed response: not JSON"`, cost 0.
    - `"unknown choice"`: valid usage, `answers.action.choice = "fly"` → `"jev malformed response: bad choice for \"action\""`, cost from usage.
    - `"confidence out of range"`: `confidence: 1.5` → `"jev malformed response: bad confidence for \"action\""`, cost from usage.
    - `"missing answer"`: `answers` lacks `target` → `"jev malformed response: missing answer \"target\""`.
    - `"missing usage"`: no `usage` → `"jev malformed response: bad usage"`, cost 0.
    - `"abort before call"`: pre-aborted `signal` → `AbortedError`, 0 transport calls.
    - `"abort during retry sleep"`: 429, fake sleep aborts the controller then resolves → `AbortedError`, 1 transport call.
    - `"abort during call"`: transport aborts the controller then rejects with `signal.reason` → `AbortedError` (not `JevError`).
- [ ] **Step 2: Run it**: `Run: node --test test/jev.test.ts` / `Expected: FAIL (module src/jev.ts not found)`
- [ ] **Step 3: Implement** in `src/jev.ts`:
  - `extractTargets`: per line match `/^\s*- (\w+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*):?\s*$/`; ref from `/\[ref=([^\]]+)\]/` in the attribute group; pointer from `[cursor=pointer]`; unescape name with `.replace(/\\(["\\])/g, "$1")`; filter roles, empty names, seen refs.
  - `JevClient.ask`: loop attempts 0..2. Before each attempt throw `AbortedError` if `signal?.aborted`. Per attempt `const timeout = AbortSignal.timeout(timeoutMs)`, pass `AbortSignal.any([timeout, signal].filter(Boolean))`. On transport rejection: run signal aborted → `AbortedError`; else `timeout.aborted` or `e.name === "TimeoutError"` → `JevError(\`jev timeout after ${timeoutMs / 1000}s\`)`; else `JevError(\`jev network error: ${e.message}\`)`. Status 401 → `JevAuthError`; 429/529 → if attempts left, `await sleep(JEV_RETRY_DELAYS_MS[i], signal)` then throw `AbortedError` if aborted, else continue; after the last → `jev http <status> after 3 attempts`. 422 and other non-2xx as above. 2xx: parse JSON, validate `usage` first (cost), then each id in `questions`: answer object, `choice` in `Object.keys(criteria)`, `confidence` finite in [0,1]. Default sleep resolves early when the signal aborts. Default transport wraps `globalThis.fetch`.
- [ ] **Step 4: Run it**: `Run: node --test test/jev.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/jev.ts test/jev.test.ts && git commit -m "feat: add jev target extraction and http client"`

---

### Task 3: `src/jev.ts` part 2: `HybridBrain` routing

**Files:**
- Modify: `src/jev.ts`
- Test: `test/jev.test.ts`

**Contracts:** C5 (`HybridBrain`), C6 (question and criteria texts)

**Interfaces:**
- Consumes: `extractTargets`, `JevClient.ask`, `JevError`, `JevAuthError` (Task 2); `Decision`, `DecideFn`, `StepInput`, `BrainError`, `JevRecord`, `Action` (Task 1).
- Produces:
  - `export const ACTION_QUESTION = "Which single next move best advances the task on this page?"`, `export const TARGET_QUESTION = "Which element should that move act on?"`
  - `export const ACTION_OPTIONS: Readonly<Record<string, { description: string; cmd: string | null; args: readonly string[]; target: boolean }>>` with keys in this order and descriptions verbatim from spec C6: `click` (cmd `click`, target), `check` (`check`, target), `uncheck` (`uncheck`, target), `hover` (`hover`, target), `press_enter` (`press`, `["Enter"]`), `press_tab` (`press`, `["Tab"]`), `press_escape` (`press`, `["Escape"]`), `go_back` (`go-back`, `[]`), `needs_text` (null), `done` (null). A target action becomes `{ cmd, args: [ref] }`; a no-target one `{ cmd, args: [...args] }`.
  - `export function targetDescription(t: Target): string` → `` `${role} "${name}"` `` or `` `${role} (no name)` `` when `name === ""`.
  - `export class HybridBrain implements DecideFn { readonly jev: Pick<JevClient, "ask">; readonly claude: DecideFn; readonly minConfidence: number; constructor(o: { jev: Pick<JevClient, "ask">; claude: DecideFn; minConfidence?: number }); decide(prompt: string, grep = true, step?: StepInput): Promise<[Decision, number]> }` (default `minConfidence` 0.8)

**Checks:** `node --test test/jev.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/jev.test.ts` (fake jev records `ask` args and returns `[answers, 0.001]` or throws; fake claude records `(prompt, grep)` and returns `[claudeDec, 0.5]` or throws). Base step: `ctx = { step: 2, task: "T", memory: "M", historyLines: ["step 1 | …"], nudged: false, previousFailed: false }`, snapshot with `- button "Submit" [ref=e12]` and `- link "" [ref=e13] [cursor=pointer]`.
  - `"accepted click with target"`: action click 0.93, target e12 0.88 → claude not called; decision `{ evaluationPreviousGoal: "", memory: "M", nextGoal: 'jev: click button "Submit" (0.88)', actions: [{cmd:"click",args:["e12"]}], source: "jev", jev: { action:"click", action_confidence:0.93, target:"e12", target_confidence:0.88, routed:"accepted" } }`, cost 0.001. Asserts the `ask` call: `state` deep-equals `{ task:"T", memory:"M", history:["step 1 | …"], tabs, snapshot }`; `questions.action` `{ type:"choice", question: ACTION_QUESTION, criteria }` with `Object.keys(criteria)` equal to the 10 ids in order and `criteria.click === "Click one element on the page: a link, button, tab, menu item or option."`; `questions.target.criteria` deep-equals `{ e12: 'button "Submit"', e13: "link (no name)" }`.
  - `"accepted press_enter ignores low target"`: press_enter 0.9, target e13 0.1 → `actions: [{cmd:"press",args:["Enter"]}]`, `nextGoal: "jev: press_enter (0.90)"`, record keeps `target:"e13", target_confidence:0.1`, routed `accepted`.
  - `"confidence equal to threshold is accepted"`: both 0.8 with default threshold → `source: "jev"`.
  - `"low action confidence"`: 0.79 → claude called once with `(prompt, grep)`; result `{ ...claudeDec, source:"claude", jev:{…, routed:"low_confidence"} }`, cost 0.501.
  - `"low target confidence"`: click 0.95, target 0.5 → routed `low_confidence`, claude decides.
  - `"needs_text"` → routed `needs_text`; `"done"` → routed `done`; both go to claude with summed cost.
  - `"step 1"`, `"nudged"`, `"previous failure"`, `"no targets"` (snapshot with no target lines), `"256 targets"` (256 distinct button lines), `"missing step"` (`decide(prompt, false)` with no step): jev not called, claude called with the same `grep`, decision `source:"claude", jev:null`, cost 0.5.
  - `"JevError falls back"`: ask throws `new JevError("jev http 500", 0.002)` → record `{ action:null, action_confidence:null, target:null, target_confidence:null, routed:"error: jev http 500" }`, cost 0.502.
  - `"claude BrainError after jev"`: low confidence, claude throws `new BrainError("boom", 0.5)` → rejects with that BrainError, `cost === 0.501`, `jev.routed === "low_confidence"`.
  - `"JevAuthError propagates"` and `"AbortedError propagates"`: ask throws → `decide` rejects with the same class; claude not called.
  - `"custom threshold"`: `minConfidence: 0.95`, click 0.93 → `low_confidence`.
- [ ] **Step 2: Run it**: `Run: node --test test/jev.test.ts` / `Expected: FAIL (HybridBrain not exported)`
- [ ] **Step 3: Implement** `HybridBrain.decide` following the spec's Data flow steps 1–5; `<conf>` in `nextGoal` is `Math.min` of the confidences used (action only for no-target actions), `toFixed(2)`; target lookup by `t.choice` in the extracted targets and the description from `targetDescription`.
- [ ] **Step 4: Run it**: `Run: node --test test/jev.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/jev.ts test/jev.test.ts && git commit -m "feat: add jev hybrid brain routing"`

---

### Task 4: Agent loop passes `StepInput` and records step cost

**Files:**
- Modify: `src/loop.ts`
- Test: `test/loop.test.ts`

**Contracts:** C5 (loop side), C4 (record fields the loop produces)

**Interfaces:**
- Consumes: `StepInput`, `StepContext`, `BrainError.jev` (Task 1), `historyLines` (Task 1), `HybridBrain`, `JevError`, `JevAuthError` (Tasks 2–3).
- Produces: every `StepRecord` from `Agent.loop` has `costUsd` set; brain-error records' decision is `{ evaluationPreviousGoal: "", memory, nextGoal: "", actions: [], source: "claude", jev: e.jev }`.

**Checks:** `node --test test/loop.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/loop.test.ts` (extend `FakeBrain.decide` to record a third `step` argument in `steps: (StepInput | undefined)[]`):
  - `"decide receives StepInput"`: 2-step run; step 1 input has `ctx.step === 1`, `ctx.task === "t"`, `ctx.memory === ""`, `ctx.historyLines` deep-equals `[]`, `nudged false`, `previousFailed false`, `obs.snapshot` equals the fake snapshot; step 2 `historyLines` deep-equals `historyLines(history.slice(0,1))`.
  - `"StepInput is scrubbed"`: with a 2FA scrubber whose secret appears in task, snapshot and tabs (follow the existing twofa scrub tests' setup), the secret occurs in none of `ctx.task`, `ctx.memory`, `ctx.historyLines`, `obs.tabs`, `obs.snapshot`.
  - `"nudged flag"`: after 3 identical decisions the 4th input has `ctx.nudged === true`.
  - `"previousFailed flag"`: a step whose result starts with `error:` → next `previousFailed true`; brain error step (`brain error:`) → next `true`; a `skipped:` result only → `false`.
  - `"costUsd on records"`: success records have `costUsd === 0.5`; a `new BrainError("x", 0.25)` step record has `costUsd === 0.25` and decision `source === "claude"`, `jev === null`.
  - `"brain error record carries jev"`: brain throws a `BrainError` with `jev = { …, routed: "low_confidence" }` → that record's `decision.jev` deep-equals it.
  - `"JevError does not count as a failure"`: `maxFailures: 1`, brain is `new HybridBrain({ jev: { ask: async () => { throw new JevError("jev http 500", 0) } }, claude: new FakeBrain([dec([["click",["e1"]]]), dec([["done",["success","ok"]]])]) })` with a snapshot containing `- button "B" [ref=e1]` → run succeeds with answer `"ok"`, no `brain error:` result.
  - `"JevAuthError stops the run"`: brain throws `new JevAuthError()` on step 1 → `agent.run()` rejects with `JevAuthError`, browser still closed.
- [ ] **Step 2: Run it**: `Run: node --test test/loop.test.ts` / `Expected: FAIL (third argument undefined, costUsd missing)`
- [ ] **Step 3: Implement** in `Agent.loop`: compute `previousFailed` from `history.at(-1)?.results`; build `stepInput` as in spec "Changed modules / src/loop.ts" using `this.scrub`; call `this.brain.decide(prompt, !paste, stepInput)`; set `costUsd` on both record kinds; `failures`, repeat detection and `execute()` unchanged.
- [ ] **Step 4: Run it**: `Run: node --test test/loop.test.ts && npm run typecheck` / `Expected: PASS` (update existing deep-equal assertions on records to include `costUsd` where needed)
- [ ] **Step 5: Commit**: `git add src/loop.ts test/loop.test.ts && git commit -m "feat: pass step input to the brain and record step cost"`

---

### Task 5: `--jev`, `--no-jev`, `--jev-threshold` flags

**Files:**
- Modify: `src/args.ts`, `src/taskfile.ts` (only to add the shared `THRESHOLD_RE` export and the two `TaskSettings` fields)
- Test: `test/args.test.ts`

**Contracts:** C1 (parsing, usage, help, usage errors)

**Interfaces:**
- Produces: `RunArgs.jev: boolean` (default `false`), `RunArgs.jevThreshold: number` (default `0.8`); `TaskSettings` gains `jev?: boolean; jevThreshold?: number`; `export const THRESHOLD_RE = /^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/` in `src/taskfile.ts`.

**Checks:** `node --test test/args.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/args.test.ts`:
  - `"jev defaults"`: `parseRunArgs(["t"], "s")` → `jev false`, `jevThreshold 0.8`.
  - `"jev and no-jev, later wins"`: `["--jev","t"]` → true; `["--jev","--no-jev","t"]` → false; settings `{ jev: true }` + `["--no-jev","t"]` → false.
  - `"jev-threshold values"`: `--jev-threshold 0.9` → 0.9; `--jev-threshold=1` → 1; `--jev-threshold .5` → 0.5; `--jev-threshold " 0.7 "` → 0.7; threshold without `--jev` parses with no error.
  - `"jev-threshold invalid float"`: each of `abc`, `1e-1`, `nan`, `inf`, `-0.5` throws `UsageError` with message `` `argument --jev-threshold: invalid float value: '${v}'` ``.
  - `"jev-threshold out of range"`: `0`, `0.0`, `1.5` → `"argument --jev-threshold: must be greater than 0 and at most 1"`.
  - `"jev-threshold missing value"`: `["--jev-threshold"]` → `"argument --jev-threshold: expected one argument"`.
  - `"jev explicit argument"`: `["--jev=x","t"]` → `"argument --jev/--no-jev: ignored explicit argument 'x'"`.
  - `"usage and help mention jev"`: `RUN_USAGE` contains the line `"                  [--jev | --no-jev] [--jev-threshold FLOAT]\n"` immediately after the `[--twofa-timeout SEC]` line; `RUN_HELP` contains the exact C1 help block immediately after the `--twofa-timeout` entry.
- [ ] **Step 2: Run it**: `Run: node --test test/args.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: add names to `RUN_SPEC` (`"--jev"`/`"--no-jev"` → `"--jev/--no-jev"`, `"--jev-threshold"`), add `--jev-threshold` to `VALUE_OPTIONS`, validate with `THRESHOLD_RE` then `n > 0 && n <= 1`; defaults before `...settings`; usage/help text per C1.
- [ ] **Step 4: Run it**: `Run: node --test test/args.test.ts && npm run typecheck` / `Expected: PASS` (update any existing exact help/usage assertion)
- [ ] **Step 5: Commit**: `git add src/args.ts src/taskfile.ts test/args.test.ts && git commit -m "feat: add --jev and --jev-threshold flags"`

---

### Task 6: `jev` and `jev-threshold` task-file and config keys

**Files:**
- Modify: `src/taskfile.ts`, `src/config.ts`
- Test: `test/taskfile.test.ts`, `test/config.test.ts`

**Contracts:** C2

**Interfaces:**
- Consumes: `THRESHOLD_RE`, `TaskSettings.jev/jevThreshold` (Task 5).
- Produces: `KEYS.jev = ["jev", "bool"]`, `KEYS["jev-threshold"] = ["jevThreshold", "threshold"]`; `Kind` gains `"threshold"`; `settingValue` key union gains `"jev"`.

**Checks:** `node --test test/taskfile.test.ts test/config.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `test/taskfile.test.ts` `"jev keys"`: front matter `jev: true` + `jev-threshold: 0.9` → `settings` `{ jev: true, jevThreshold: 0.9 }`.
  - `"jev-threshold invalid"`: each of `abc`, `0`, `1.5`, `1e-1` on line 3 → `TaskFileError` message `` `${p}:3: jev-threshold must be a number greater than 0 and at most 1, got "${v}"` ``.
  - `"jev invalid bool"`: `jev: yes` → `` `${p}:2: jev must be true or false, got "yes"` ``.
  - `"settingValue jev"`: `settingValue("jev", "true") === true`.
  - `test/config.test.ts` `"config accepts jev keys"`: a conf with `jev: true` and `jev-threshold: 0.5` loads to `{ jev: true, jevThreshold: 0.5 }`; `"default config lists jev"`: `DEFAULT_CONFIG.includes("# snapshot: hybrid\n# jev: false\n# jev-threshold: 0.8\n")`.
- [ ] **Step 2: Run it**: `Run: node --test test/taskfile.test.ts test/config.test.ts` / `Expected: FAIL (unknown setting "jev")`
- [ ] **Step 3: Implement** the `KEYS` entries, the `"threshold"` branch in `convert`, the `settingValue` union, and the two commented `DEFAULT_CONFIG` lines.
- [ ] **Step 4: Run it**: `Run: node --test test/taskfile.test.ts test/config.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/taskfile.ts src/config.ts test/taskfile.test.ts test/config.test.ts && git commit -m "feat: add jev keys to task files and config"`

---

### Task 7: `startRun` builds `HybridBrain`; `history.json` fields; report line

**Files:**
- Modify: `src/runs/run.ts`, `src/export.ts`, `src/events.ts`, `src/report/plain.ts`
- Test: `test/runs/run.test.ts`, `test/report.test.ts`, `test/export.test.ts`

**Contracts:** C1 (401 mapping), C4, C7

**Interfaces:**
- Consumes: `HybridBrain`, `JevClient`, `JevAuthError` (Tasks 2–3); `RunArgs.jev/jevThreshold` (Task 5); `StepRecord.costUsd`, `Decision.source/jev` (Task 1).
- Produces: `RunOutcome.jevSteps?: number`; `HistoryStep` gains `cost_usd?: number; source?: "claude" | "jev"; jev?: JevRecord | null`; `HistoryData` gains `jev_steps?: number; claude_steps?: number`; `historyJson` signature unchanged.

**Checks:** `node --test test/runs/run.test.ts test/report.test.ts test/export.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `test/runs/run.test.ts` (let `setup` accept an optional `env` put on `deps.env`):
    - `"startRun builds HybridBrain with --jev"`: `args.jev = true, jevThreshold: 0.9`, `env { TYPESAFE_API_KEY: " k " }` → `opts.brain instanceof HybridBrain`, `brain.minConfidence === 0.9`, `(brain.jev as JevClient).apiKey === "k"`, `brain.claude instanceof Brain`; with `jev: false` → `opts.brain instanceof Brain`.
    - `"history json jev fields, non-jev run"`: one record with no `costUsd`/`source` → step has keys in order `…, "results", "cost_usd", "source", "jev"` with values `0, "claude", null`; top-level keys `…, "cost_usd", "jev_steps", "claude_steps", …` with `0, 1`.
    - `"history json jev fields, jev run"`: records `[ {source:"jev", jev:{action:"click",action_confidence:0.93,target:"e1236",target_confidence:0.88,routed:"accepted"}, costUsd:0.0000012}, {source:"claude", jev:null, costUsd:0.5}, brain-error record {source:"claude", jev:{…routed:"error: jev http 500"…}} ]` → `jev_steps 1`, `claude_steps 2`, step 1 matches the C4 example exactly.
    - `"jev auth error maps to message"`: agent emits one `step:end` then throws `new JevAuthError()` → outcome `error === "jev error: invalid TYPESAFE_API_KEY"`, `exitCode 1`, `history.json` has 1 step.
    - `"outcome jevSteps only with --jev"`: `--jev` run with one jev record → `outcome.jevSteps === 1`; non-jev run → `"jevSteps" in outcome === false`.
  - `test/report.test.ts` `"printOutcome jev steps line"`: outcome with `jevSteps: 3, steps: 5` → out lines include `"Jev steps: 3/5"` directly after the `Steps:` line; without `jevSteps` no such line; with `error` set nothing but the error.
  - `test/export.test.ts` `"export accepts history with jev fields"`: an exportable fixture with the new per-step and top-level fields added exports the same spec text as without them.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/run.test.ts test/report.test.ts test/export.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: in `execute`, when `args.jev` wrap the `Brain` as in spec ("Changed modules / src/runs/run.ts") with `apiKey = ((deps.env ?? process.env).TYPESAFE_API_KEY ?? "").trim()` and the run `signal`; `historyJson` adds `jev_steps`/`claude_steps` after `cost_usd` (`claude_steps = history.length - jev_steps`) and per step `cost_usd: r.costUsd ?? 0, source: r.decision.source ?? "claude", jev: r.decision.jev ?? null` right after `results`; catch block adds `else if (e instanceof JevAuthError) message = "jev error: invalid TYPESAFE_API_KEY"` after the abort and Playwright checks; `finish` spreads `jevSteps` when `args.jev`; `printOutcome` prints the line after `Steps:` when `o.jevSteps !== undefined`.
- [ ] **Step 4: Run it**: `Run: node --test test/runs/run.test.ts test/report.test.ts test/export.test.ts && npm run typecheck` / `Expected: PASS` (update existing deep-equal `historyJson` expectations in `test/runs/*.test.ts` and `test/cli.test.ts` with the new fields)
- [ ] **Step 5: Commit**: `git add src/runs/run.ts src/export.ts src/events.ts src/report/plain.ts test/runs/run.test.ts test/report.test.ts test/export.test.ts test/cli.test.ts && git commit -m "feat: wire jev into runs, history.json and the report"`

---

### Task 8: Missing-key preflight and CLI behaviour

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Contracts:** C1 (key errors, 401 exit, report line end to end)

**Interfaces:**
- Consumes: `RunArgs.jev` (Task 5), `JevAuthError` (Task 2), `RunOutcome.jevSteps` (Task 7).
- Produces: `preflightArgs(deps, args)` returns `"TYPESAFE_API_KEY is not set (needed by --jev)"` when `preflight` passed, `args.jev` and `!deps.env.TYPESAFE_API_KEY?.trim()`.

**Checks:** `node --test test/cli.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests** in `test/cli.test.ts` (harness `env()`; its default `env: {}` has no key):
  - `"jev without key exits 2"`: `main(["-p","--jev",...e.argv], e.deps())` → 2, `e.err` includes `"TYPESAFE_API_KEY is not set (needed by --jev)"`, `runDirs(e.tmp)` empty.
  - `"jev blank key exits 2"`: `env: { TYPESAFE_API_KEY: "  " }` → 2.
  - `"jev without key in a batch"`: two task files, one with front matter `jev: true` → 2, stderr `` `${file}: TYPESAFE_API_KEY is not set (needed by --jev)` ``, nothing runs.
  - `"jev without key at tui start"`: `main(["--jev", ...e.argv], e.deps({ isTTY: () => true, loadTui: fake.load }))` → 2, message on stderr, `fake.load` never called.
  - `"no jev, no key needed"`: `-p` run without `--jev` and `env: {}` succeeds as before.
  - `"jev auth error exits 1 with history"`: `env: { TYPESAFE_API_KEY: "k" }`, agent emits one `step:end` then throws `new JevAuthError()` → exit 1, stderr includes `"jev error: invalid TYPESAFE_API_KEY"`, `history(e.tmp).history.length === 1`.
  - `"jev steps line"`: `-p --jev` with key, agent returns `result(true, [jevRec])` where `jevRec.decision.source = "jev"` → stdout includes `"Jev steps: 1/1"` right after the `Steps:` line; same run without `--jev` prints no `Jev steps:` line.
- [ ] **Step 2: Run it**: `Run: node --test test/cli.test.ts` / `Expected: FAIL (runs start without key)`
- [ ] **Step 3: Implement** the check in `preflightArgs` only; `preflight` and its callers unchanged.
- [ ] **Step 4: Run it**: `Run: node --test test/cli.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/cli.ts test/cli.test.ts && git commit -m "feat: require TYPESAFE_API_KEY for --jev"`

---

### Task 9: `jev` in manager overrides, TUI and web UI

**Files:**
- Modify: `src/runs/manager.ts`, `src/tui/form.ts`, `src/tui/detail.ts`, `src/web/api.ts`, `web/src/OptionsStrip.tsx`, `web/src/dialogs/OptionsDialog.tsx`
- Test: `test/runs/manager.test.ts`, `test/tui/form.test.ts`, `test/web/api.test.ts`

**Contracts:** C3

**Interfaces:**
- Consumes: `RunArgs.jev` (Task 5), `settingValue("jev", …)` (Task 6).
- Produces: `Overrides.jev?: boolean`, `Effective.jev: boolean`; TUI `FieldKey` gains `"jev"` (label `jev`, front-matter key `jev`, last in `ORDER`); `parseOverrides` accepts `jev`.

**Checks:** `node --test test/runs/manager.test.ts test/tui/form.test.ts test/web/api.test.ts`, `npm run typecheck`

- [ ] **Step 1: Write the failing tests**:
  - `test/runs/manager.test.ts` `"jev override reaches run args"`: `setGlobals({ jev: true })` → `effectiveArgs(id).jev === true` and `list()[0].effective.jev === true`; task `setOverrides(id, { jev: false })` wins → false; `globals().base.jev === false` with argv `[]`; argv `["--jev"]` → base `true`.
  - `"jev on without key fails preflight"`: `preflight: (a) => (a.jev ? "TYPESAFE_API_KEY is not set (needed by --jev)" : null)`, `setOverrides(id, { jev: true })`, `start(id)` → `{ ok: false, reason: "TYPESAFE_API_KEY is not set (needed by --jev)" }`, the task's `error` is that message, an error toast/notify with it is emitted (follow `manager_preflight_failure_keeps_idle`).
  - `test/tui/form.test.ts` `"form jev field"`: `openForm(null, {…, jev: false}, {})` last field has `key "jev"`, `label "jev"`, `raw "false"`; space/left/right toggle to `"true"` and back; ctrl+r restores `"false"`; `formResult` → `{ ok: true, overrides: { jev: true } }` after one toggle.
  - `test/web/api.test.ts` `"parseOverrides jev"`: `{ jev: true }` → `{ jev: true }`; `{ jev: "yes" }` → `"jev must be true or false"`; `PUT /api/globals` with `{ jev: 1 }` → 400 `{ ok: false, error: "jev must be true or false" }`.
- [ ] **Step 2: Run it**: `Run: node --test test/runs/manager.test.ts test/tui/form.test.ts test/web/api.test.ts` / `Expected: FAIL`
- [ ] **Step 3: Implement**: add `jev` to `Overrides`, `Effective`, `effectiveOf`, `#argsFor`; TUI form (toggle branch with `headed`/`video`/`screenshot`) and `detail.ts` `SETTINGS` `["jev","jev"]`; add `"jev"` to the `["video","screenshot"]` boolean loop in `parseOverrides`; `OptionsStrip` chip `chip("jev", eff.jev ? "on" : "off", o.jev !== undefined)` after `screenshot`; `OptionsDialog` `Draft.jev: string` initialised `onOff(overrides.jev)`, `onOffSelect("jev", "jev", effective.jev)` after the snapshot select (widen its key type to `"headed" | "jev"`), save `if (draft.jev !== "") o.jev = draft.jev === "on"`, "Reset all" sets `jev: ""`. Fix fakes and literals elsewhere (`test/tui/fake-manager.ts`, web store tests) that typecheck flags.
- [ ] **Step 4: Run it**: `Run: node --test test/runs/manager.test.ts test/tui/form.test.ts test/web/api.test.ts && npm run typecheck` / `Expected: PASS`
- [ ] **Step 5: Commit**: `git add src/runs/manager.ts src/tui/form.ts src/tui/detail.ts src/web/api.ts web/src/OptionsStrip.tsx web/src/dialogs/OptionsDialog.tsx test/runs/manager.test.ts test/tui/form.test.ts test/web/api.test.ts <any fake/test file touched for typecheck> && git commit -m "feat: add jev toggle to the TUI and web options"`

---

### Task 10: README

**Files:**
- Modify: `README.md`

**Contracts:** C8

**Interfaces:** None

**Checks:** `npm test`, `npm run typecheck`

- [ ] **Step 1: Edit** `README.md` per C8: usage synopsis (around line 113) gains `[--[no-]jev] [--jev-threshold FLOAT]`; options-table rows after `--twofa-timeout` for `--jev` (default off, `--no-jev` overrides a task file or config, needs `TYPESAFE_API_KEY`, links to the warning; marked available but experimental, savings not yet benchmarked) and `--jev-threshold` (default `0.8`, greater than 0 and at most 1); task-file key rows `jev` | `true` or `false` and `jev-threshold` | a number greater than 0 and at most 1; TUI globals sentence lists `jev`; a `[!WARNING]` next to the `--allow-file-access` one with the C8 text; Output section: per-step `cost_usd`, `source`, `jev` (with `routed` values) and top-level `jev_steps`/`claude_steps`, plus the `Jev steps:` line; Roadmap item ticked `[x]`, past tense, "savings not benchmarked yet".
- [ ] **Step 2: Run the full suite**: `Run: npm test` / `Expected: PASS`
- [ ] **Step 3: Commit**: `git add README.md && git commit -m "docs: document --jev"`

## Manual e2e

- [ ] With a real `TYPESAFE_API_KEY`, run `duckwright -p --jev "<a navigation-only task>"` and check that some steps show `source: "jev"`, costs are plausible, and the answer is correct. Re-check the live API shape against C6 and the published output price before relying on the cost figures.
- [ ] Run once with an invalid key and confirm exit 1 and the `jev error` line.
