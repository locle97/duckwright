# Jev backend (`--jev`) design

Ports the approved Python-era design `docs/superpowers/specs/2026-10-03-jev-backend-design.md` to the TypeScript code base. Where the two differ, this document wins.

## Summary

Claude (`claude -p`) is the main cost of a duckwright run. `--jev` adds an opt-in, cheaper brain: TypeSafe's Jev model, which answers typed `choice` questions with a calibrated confidence but cannot write free text. Each step, a per-step router (`HybridBrain`) asks Jev which command to run and on which element ref. When Jev is confident and the move needs no text, the harness builds a one-action `Decision` from Jev's answer and Claude is not called. Otherwise (first step, a nudge, a failed previous step, an unusable target list, low confidence, a move that needs text, a `done`, or any Jev error) Claude decides the step exactly as today, and the step's cost includes the Jev call. The flag reaches every surface a run setting already reaches: CLI flags, task-file and global-config keys, the TUI and web UI options, plan-mode case runs, `history.json` and the plain report.

## Decisions

| Topic | Decision |
| --- | --- |
| Source design | Port the routing rules, API usage, retry policy, errors and output fields from the 2026-10-03 design. Python names become the TS names below (`extract_targets` → `extractTargets`, `StepContext` fields camelCase). |
| Jev API shape | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{"model":"jev-latest","state":…,"questions":{…}}`, as in the old spec. The exact question and answer JSON is fixed in contract C6. All parsing sits in `JevClient`, so a different live shape changes one function. |
| Model | `jev-latest` (constant `JEV_MODEL`). No flag to change it. |
| Prices | `JEV_INPUT_USD_PER_TOKEN = 42e-9`. No output price is published, so `JEV_OUTPUT_USD_PER_TOKEN = 42e-9` (equal to the input price), with a code comment saying it is a conservative placeholder. Cost = `input_tokens × input + output_tokens × output`. |
| Transport | Node 22 built-in `fetch`, injectable for tests. No new dependencies. |
| Timeout | 10 s per HTTP attempt (`JEV_TIMEOUT_MS = 10_000`), via `AbortSignal.timeout`, combined with the run's signal. |
| Retries | 429 and 529 are retried twice: sleep 1000 ms, then 3000 ms (3 attempts in all). The sleep function is injectable and stops early on abort. |
| Abort | If the run's signal is aborted during a Jev call or retry sleep, `JevClient` throws the existing `AbortedError` (not `JevError`), so Ctrl-C and TUI stop behave as they do for Claude. |
| `decide` signature | `decide(prompt: string, grep = true, step?: StepInput)`. `StepInput = { obs: Observation; ctx: StepContext }`. `Brain` ignores `step`. Keeping `grep` second avoids touching every existing `decide` call and test. |
| `Decision` fields | `source?: "claude" \| "jev"` and `jev?: JevRecord \| null` are optional on the type, so existing Decision literals in tests and `parseDecision` keep compiling. Missing means `"claude"` and `null`. |
| Step cost | `StepRecord` gains optional `costUsd?: number`; the loop always sets it (decision cost, or `BrainError.cost` on a brain error). |
| Brain-error record | `BrainError` gains `jev: JevRecord \| null` (default `null`). `HybridBrain` sets it when Claude fails after a Jev call, and the loop copies it into the brain-error step's decision, so `history.json` still shows why the step went to Claude. |
| History window for Jev | Same lines Claude sees: a new exported `historyLines(history, window = HISTORY_WINDOW)` in `src/prompt.ts` (used by `buildPrompt` too) returns the `stepLine`s of the last 15 steps, preceded by `(N earlier steps omitted)` when steps were dropped. |
| Scrubbing | The loop passes `HybridBrain` a `StepInput` whose `task`, `memory`, `historyLines`, `obs.tabs` and `obs.snapshot` have gone through the same `this.scrub` (2FA scrubber) as the Claude prompt. Jev state is JSON, so the XML-tag `neutralise` is not applied (the history lines are already neutralised by `stepLine`). |
| `previousFailed` | True when any result of the last `StepRecord` starts with `error:` or `brain error:`. `skipped:` results are not failures. |
| Jev errors and failure count | `JevError` is caught inside `HybridBrain` and never reaches the loop, so it never counts toward `--max-failures`. `JevAuthError` propagates through the loop (it is not a `BrainError`) and stops the run. |
| 401 handling | `src/runs/run.ts` maps `JevAuthError` to the message `jev error: invalid TYPESAFE_API_KEY`, exit 1, and writes `history.json` with the steps so far. |
| Missing key | `preflight` in `src/cli.ts` fails with `TYPESAFE_API_KEY is not set (needed by --jev)` when `args.jev` is true and `deps.env.TYPESAFE_API_KEY` is missing or blank: exit 2 in print mode (prefixed `<file>: ` in a batch, as other preflight errors), exit 2 at TUI/web start when given on the command line, and the manager's existing preflight-failure path when a task is started from the TUI/web with `jev` toggled on. |
| Key source | `startRun` reads `TYPESAFE_API_KEY` from `RunDeps.env` (default `process.env`), the same object the TOTP secret is read from. The key is trimmed. |
| Negation flag | `--jev` gets a `--no-jev` pair, like `--video/--no-video`, so a command line can turn off `jev: true` from a task file or the config. |
| Threshold validation | Must be a decimal number greater than 0 and at most 1 (`0 < t <= 1`). CLI: `argument --jev-threshold: invalid float value: '<v>'` for a non-number, `argument --jev-threshold: must be greater than 0 and at most 1` for out of range; both exit 2 via `UsageError`. Task file/config: new `Kind` `"threshold"` with message `jev-threshold must be a number greater than 0 and at most 1, got "<v>"` (exit 2 like other front-matter errors). |
| Threshold without `--jev` | Allowed and ignored (the config may set it for later runs). No usage error. |
| Accepted number syntax | `/^\s*(?:\d+(?:\.\d*)?\|\.\d+)\s*$/` (no sign, no exponent, no `inf`/`nan`). |
| UI scope | The TUI options form and web options dialog/strip get a `jev` on/off toggle only. `jev-threshold` is set by flag, task file or config; it is not a UI field. |
| Plan mode | Nothing plan-specific: plan cases run through `startRun`, which builds the brain from `args.jev`, so `--jev` applies to each case's step loop. The planner call (`runPlanner`) stays on Claude. |
| History fields for non-Jev runs | Always written: per step `cost_usd`, `source` (`"claude"`), `jev` (`null`); top level `jev_steps` (0) and `claude_steps`. One shape for all runs. |
| `claude_steps` | `history.length − jev_steps` (brain-error steps count as Claude steps). |
| Report line | `Jev steps: <jev>/<total>` printed by `printOutcome` right after the `Steps:` line, only when the run used `--jev`. `RunOutcome` gains optional `jevSteps?: number`, set only when `args.jev`. TUI/web summaries are unchanged. |
| Option descriptions | Fixed English strings in `src/jev.ts` (C6). Tuning them is follow-up work with the benchmark. |
| Unnamed-target description | `<role> "<name>"`; when the name is empty, `<role> (no name)`. |
| `next_goal` format | Target actions: `jev: <action> <role> "<name>" (<conf>)`; no-target actions: `jev: <action> (<conf>)`. `<action>` is the Jev option id (`click`, `press_enter`, …); `<conf>` is the lower of the confidences used, `toFixed(2)`. |
| Target question when action needs no target | Both questions are always sent in one call; for `press_*` and `go_back` the target answer is recorded but not checked. |
| Benchmark | Out of scope (follow-up; needs a live key). The README marks `--jev` as available but experimental and says its savings are not yet benchmarked. |
| Roadmap | The roadmap item is ticked (`[x]`) with that caveat. |

## Architecture / Components

### New: `src/jev.ts`

Depends on `brain.ts` (types, `BrainError`, `ALLOWED_COMMANDS`), `observe.ts` (type `Observation`), `proc.ts` (`AbortedError`). No other imports.

- **`Target`**: `{ ref: string; role: string; name: string }`.
- **`TARGET_ROLES`**: `["link", "button", "checkbox", "radio", "tab", "menuitem", "option"]`.
- **`MAX_TARGETS = 255`**.
- **`extractTargets(snapshot: string): Target[]`**
  - Reads each line shaped like `- <role> "<name>" [attr] [ref=eN] [cursor=pointer]…`, optionally ending in `:`. The name is optional; inside it `\"` and `\\` are unescaped.
  - Keeps only `TARGET_ROLES`.
  - Drops a line with an empty name unless it carries `[cursor=pointer]`.
  - Keeps snapshot order; a ref seen again is dropped.
  - Lines without `[ref=…]` are ignored.
- **`JevAuthError extends Error`** (`name = "JevAuthError"`, message `invalid TYPESAFE_API_KEY`).
- **`JevError extends Error`** with `cost: number` (`name = "JevError"`).
- **Constants**: `JEV_URL`, `JEV_MODEL = "jev-latest"`, `JEV_TIMEOUT_MS = 10_000`, `JEV_RETRY_DELAYS_MS = [1000, 3000]`, `JEV_INPUT_USD_PER_TOKEN = 42e-9`, `JEV_OUTPUT_USD_PER_TOKEN = 42e-9`.
- **`JevTransport`**: `(url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>`. Default wraps `globalThis.fetch`.
- **`JevClient`**: `new JevClient({ apiKey, model?, timeoutMs?, transport?, sleep?, signal? })`.
  - `ask(state: unknown, questions: Record<string, JevQuestion>): Promise<[Record<string, JevAnswer>, number]>` returns the answers and the cost in USD (C6).
- **`JevRecord`**: `{ action: string | null; action_confidence: number | null; target: string | null; target_confidence: number | null; routed: string }` (snake_case, written to `history.json` as is).
- **`ACTION_OPTIONS`**: the 10 action option ids with their descriptions (C6), and the mapping to an `Action`.
- **`HybridBrain`**: `new HybridBrain({ jev: JevClient; claude: DecideFn; minConfidence?: number })` (default 0.8). Implements `DecideFn`. Routing in [Data flow](#data-flow).

### Changed modules

- **`src/brain.ts`**
  - `Decision` gains `source?: "claude" | "jev"` and `jev?: JevRecord | null` (`JevRecord` type is declared here and re-exported from `jev.ts`, to avoid an import cycle).
  - `StepContext`: `{ step: number; task: string; memory: string; historyLines: string[]; nudged: boolean; previousFailed: boolean }`.
  - `StepInput`: `{ obs: Observation; ctx: StepContext }`.
  - `Brain.decide(prompt, grep = true, _step?: StepInput)`; the third argument is ignored. Decisions from `Brain` carry `source: "claude"`, `jev: null`.
  - `BrainError` gains `jev: JevRecord | null = null`.
  - `DecideFn` stays `Pick<Brain, "decide">`.
- **`src/prompt.ts`**
  - `StepRecord` gains `costUsd?: number`.
  - New `historyLines(history, window = HISTORY_WINDOW): string[]`; `buildPrompt` uses it (output unchanged).
- **`src/loop.ts`** (`Agent.loop`)
  - Builds `StepInput` each step: scrubbed obs (`{ ...obs, tabs: scrub(obs.tabs), snapshot: scrub(obs.snapshot) }`) and `ctx = { step, task: scrub(task), memory: scrub(memory), historyLines: historyLines(history).map(scrub), nudged: nudge !== null, previousFailed }`.
  - Calls `this.brain.decide(prompt, !paste, stepInput)`.
  - Sets `rec.costUsd` on every record. The brain-error record's decision is `{ evaluationPreviousGoal: "", memory, nextGoal: "", actions: [], source: "claude", jev: e.jev }`.
  - Repeat detection, failure counting, `execute()` and its allow-list are unchanged.
- **`src/args.ts`**: `RunArgs` gains `jev: boolean` (default `false`) and `jevThreshold: number` (default `0.8`). New options `--jev`, `--no-jev`, `--jev-threshold`. `RUN_USAGE` and `RUN_HELP` updated (C1).
- **`src/taskfile.ts`**: `TaskSettings` gains `jev`, `jevThreshold`; `KEYS` gains `jev: ["jev", "bool"]`, `"jev-threshold": ["jevThreshold", "threshold"]`; `Kind` gains `"threshold"`; `convert` validates it; `settingValue`'s key union gains `"jev"`.
- **`src/config.ts`**: keys come from `KEYS` automatically. `DEFAULT_CONFIG` gains `# jev: false` and `# jev-threshold: 0.8` after `# snapshot: hybrid`.
- **`src/cli.ts`**: `preflightArgs(deps, args)` returns `TYPESAFE_API_KEY is not set (needed by --jev)` when `preflight(...)` passed, `args.jev` is true and `deps.env.TYPESAFE_API_KEY?.trim()` is empty. `preflight` itself is unchanged. Every caller (single run, batch, TUI/web start, the manager's `preflight` option) already goes through `preflightArgs`.
- **`src/runs/run.ts`**
  - Builds `Brain` as today; when `args.jev`, wraps it: `new HybridBrain({ jev: new JevClient({ apiKey, signal }), claude: brain, minConfidence: args.jevThreshold })`.
  - `historyJson` writes the new per-step and top-level fields (C4).
  - The catch block maps `JevAuthError` to `jev error: invalid TYPESAFE_API_KEY`.
  - `finish` sets `jevSteps` on the outcome when `args.jev`.
- **`src/export.ts`**: `HistoryStep` gains optional `cost_usd`, `source`, `jev`; `HistoryData` gains optional `jev_steps`, `claude_steps` (optional because older files lack them). Export output is unchanged.
- **`src/events.ts`**: `RunOutcome` gains `jevSteps?: number`.
- **`src/report/plain.ts`**: `printOutcome` prints the `Jev steps:` line.
- **`src/runs/manager.ts`**: `Overrides` and `Effective` gain `jev`; `effectiveOf` and `#argsFor` copy it.
- **`src/tui/form.ts`**: `FieldKey` gains `"jev"` (label `jev`, front-matter key `jev`), appended to `ORDER`; toggled like `headed`/`video`/`screenshot`.
- **`src/tui/detail.ts`**: `SETTINGS` gains `["jev", "jev"]`.
- **`src/web/api.ts`**: `parseOverrides` accepts `jev` (boolean).
- **`web/src/OptionsStrip.tsx`**: chip `jev: on|off`.
- **`web/src/dialogs/OptionsDialog.tsx`**: `Draft` gains `jev: string`; an inherit/on/off select labelled `jev` (same widget as `headed`); "Reset all" clears it.
- **`README.md`**: options rows, task-file key rows, globals list, `[!WARNING]`, `history.json` fields, roadmap.

## Contracts

### C1: Run flags (CLI)

- **Surface:** `duckwright [--jev | --no-jev] [--jev-threshold FLOAT] …`, in every mode (`-p`, TUI, `--web`, `-f`, `--plan`).
- **Input:**
  - `--jev`: boolean, default off (or the task file / config value). `--no-jev` sets it off. Later flag wins.
  - `--jev-threshold FLOAT`: optional, default `0.8`; accepted syntax `^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$`; must satisfy `0 < t <= 1`. Also `--jev-threshold=0.9`.
  - Env `TYPESAFE_API_KEY`: required (non-blank after trim) when the effective `jev` is true.
  - Precedence: built-in < config < task file < flags < TUI/web overrides (for `jev`).
- **Output:**
  - Usage line in `RUN_USAGE`, after the `--twofa-timeout` line: `                  [--jev | --no-jev] [--jev-threshold FLOAT]`.
  - Help text in `RUN_HELP`, after `--twofa-timeout`:
    ```
      --jev, --no-jev       cheaper brain: TypeSafe's Jev picks the command and
                            element on steps it is sure of, Claude decides the
                            rest. Needs TYPESAFE_API_KEY. Sends the task, page
                            snapshots and history to TypeSafe (default off)
      --jev-threshold FLOAT
                            with --jev: the confidence Jev needs for its choice
                            to be used, greater than 0 and at most 1 (default
                            0.8)
    ```
  - Print mode with `--jev`: the normal report, plus `Jev steps: <n>/<total>` right after `Steps: … Cost: …`. Exit 0 on success, 1 on failure.
- **Errors:**
  - Non-number threshold → stderr usage + `duckwright: error: argument --jev-threshold: invalid float value: '<v>'`, exit 2.
  - Out-of-range threshold → `duckwright: error: argument --jev-threshold: must be greater than 0 and at most 1`, exit 2.
  - Missing value → `duckwright: error: argument --jev-threshold: expected one argument`, exit 2.
  - `--jev=x` → `duckwright: error: argument --jev/--no-jev: ignored explicit argument 'x'`, exit 2.
  - Effective `jev` true and `TYPESAFE_API_KEY` unset/blank → stderr `TYPESAFE_API_KEY is not set (needed by --jev)` (batch: `<file>: TYPESAFE_API_KEY is not set (needed by --jev)`), exit 2, nothing runs, no run folder. TUI/web given `--jev` at start: same message on stderr, exit 2 before the frontend opens.
  - Jev returns 401 → stderr `jev error: invalid TYPESAFE_API_KEY`, exit 1, `history.json` written with the steps completed before the failing step.
- **Criteria:** SC3, SC4

### C2: Task-file and config keys (File)

- **Surface:** front matter of a task file; `duckwright.conf`.
- **Input:**
  - `jev: true|false` (kind `bool`; message `jev must be true or false, got "<v>"`).
  - `jev-threshold: <number>` (kind `threshold`; same syntax and range as C1).
- **Output:** the run behaves as if the matching flag were given; command-line flags still win.
- **Errors:** invalid value → `<file>:<line>: jev-threshold must be a number greater than 0 and at most 1, got "<v>"` (or the bool message), exit 2 before anything runs. `duckwright init` writes `# jev: false` and `# jev-threshold: 0.8` (commented) after `# snapshot: hybrid`.
- **Criteria:** SC5

### C3: TUI and web run options (UI and API)

- **Surface:** TUI global options pane and per-task `o` form; web UI options strip and options dialog (global and per task); `PUT /api/globals` and `PUT /api/tasks/:id/overrides`; `GET /api/state` (`globals.base.jev`, task `effective.jev`, `inherited.jev`, `overrides.jev`).
- **Input:**
  - TUI: field `jev` (last row), value `true`/`false`, toggled with ←/→/space; ctrl+r restores the effective value.
  - Web dialog: select `jev` with options `inherit (on|off)`, `on`, `off`.
  - API body: `jev?: boolean`.
- **Output:** the next run of the task (or every task, for globals) uses the toggled value. Strip shows `jev: on` / `jev: off`, with ` ✱` when overridden. TUI detail settings list shows `jev  true|false`.
- **Errors:** API `jev` not boolean → 400 `{ ok: false, error: "jev must be true or false" }`. Starting a run with `jev` on and no key → the manager's existing preflight failure path, with message `TYPESAFE_API_KEY is not set (needed by --jev)` (`RunManager.start` returns `{ ok: false, reason }`, sets the task's `error`, and emits an error toast with that message; the web route answers 409 with it).
- **States (UI only):** no new states; the field is on or off.
- **Criteria:** SC5

### C4: `history.json` additions (File)

- **Surface:** `runs/<id>/history.json`.
- **Output:** top-level gains `jev_steps: number` and `claude_steps: number` (after `cost_usd`). Each step gains, after `results`:
  - `cost_usd: number`: this step's cost (Jev + Claude), 0 when nothing was charged.
  - `source: "jev" | "claude"`.
  - `jev: null | { "action": string|null, "action_confidence": number|null, "target": string|null, "target_confidence": number|null, "routed": string }`.
  - `routed` is one of `accepted`, `low_confidence`, `needs_text`, `done`, `error: <JevError message>`.
  - `jev` is `null` when the run did not use `--jev` or the step skipped Jev (step 1, nudged, previous failure, 0 or > 255 targets).
  - On `routed: "error: …"`, the four answer fields are `null`.
  - `target`/`target_confidence` hold Jev's target answer even when the action needs none.
- Example:
  ```json
  "cost_usd": 0.0000012,
  "source": "jev",
  "jev": { "action": "click", "action_confidence": 0.93, "target": "e1236", "target_confidence": 0.88, "routed": "accepted" }
  ```
- **Errors:** none new. `duckwright export` and past-run loading keep accepting files without these fields.
- **Criteria:** SC4

### C5: Library API in `src/jev.ts` and `Brain.decide` (Library)

- **Surface:**
  - `export function extractTargets(snapshot: string): Target[]`
  - `export class JevClient { ask(state, questions): Promise<[Record<string, JevAnswer>, number]> }`
  - `export class HybridBrain { decide(prompt: string, grep?: boolean, step?: StepInput): Promise<[Decision, number]> }`
  - `Brain.decide(prompt: string, grep?: boolean, step?: StepInput)`
- **Input/Output/Errors:** as in [Architecture](#architecture--components), C6 and [Data flow](#data-flow). `HybridBrain.decide` without `step` goes straight to Claude (`jev: null`).
- **Criteria:** SC1, SC2

### C6: Jev HTTP request (API, outbound)

- **Surface:** `POST https://api.typesafe.ai/v1/systemone`.
- **Input (request):** headers `Authorization: Bearer <key>`, `Content-Type: application/json`. Body:
  ```json
  {
    "model": "jev-latest",
    "state": { "task": "…", "memory": "…", "history": ["step 2 | …"], "tabs": "…", "snapshot": "…" },
    "questions": {
      "action": { "type": "choice", "question": "Which single next move best advances the task on this page?", "criteria": { "click": "…", "…": "…" } },
      "target": { "type": "choice", "question": "Which element should that move act on?", "criteria": { "e12": "button \"Submit\"", "…": "…" } }
    }
  }
  ```
  Action criteria (id → description, in this order):

  | Option | Description | Becomes |
  | --- | --- | --- |
  | `click` | Click one element on the page: a link, button, tab, menu item or option. | `click <ref>` |
  | `check` | Tick a checkbox or select a radio button that is not checked yet. | `check <ref>` |
  | `uncheck` | Untick a checkbox that is checked. | `uncheck <ref>` |
  | `hover` | Hover over one element to reveal a menu or tooltip. | `hover <ref>` |
  | `press_enter` | Press the Enter key, for example to submit the focused form. | `press Enter` |
  | `press_tab` | Press the Tab key to move the focus to the next field. | `press Tab` |
  | `press_escape` | Press the Escape key to close a dialog or menu. | `press Escape` |
  | `go_back` | Go back to the previous page in the browser history. | `go-back` |
  | `needs_text` | The next move needs typed text: open a URL, fill or type into a field, pick a select value, or anything not listed here. | Claude |
  | `done` | The task is complete or cannot be completed, and it is time to report the result. | Claude |

- **Output (expected response, 2xx):** `{ "answers": { "<id>": { "choice": string, "confidence": number, "probabilities": { "<option>": number } } }, "usage": { "input_tokens": number, "output_tokens": number } }`. Valid when each asked id has an answer whose `choice` is one of that question's criteria keys and whose `confidence` is a finite number in [0, 1], and both usage counts are finite and ≥ 0. `ask` returns `[answers, cost]`.
- **Errors (thrown by `ask`):**
  - 401 → `JevAuthError("invalid TYPESAFE_API_KEY")`, no retry.
  - 429/529 → retried after 1000 ms then 3000 ms; still failing → `JevError("jev http <status> after 3 attempts", 0)`.
  - 422 → `JevError("jev http 422: <first 200 chars of body, whitespace collapsed>", 0)`.
  - Other non-2xx → `JevError("jev http <status>", 0)`.
  - Timeout → `JevError("jev timeout after 10s", 0)`.
  - Network failure → `JevError("jev network error: <message>", 0)`.
  - Non-JSON or invalid 2xx body → `JevError("jev malformed response: <reason>", cost)`, where `cost` comes from `usage` when that part was valid, else 0.
  - Run signal aborted → `AbortedError`.
- **Criteria:** SC1, SC2

### C7: Plain report line (CLI)

- **Surface:** `printOutcome` output in print mode and batches (per run).
- **Output:** `Jev steps: <jevSteps>/<steps>` on its own line directly after `Steps: <n>  Cost: $<x>`, only for `--jev` runs that reached a normal end (no `error`).
- **Errors:** none.
- **Criteria:** SC4

### C8: README (File)

- **Surface:** `README.md`.
- **Output:**
  - Options table rows after `--twofa-timeout`: `--jev` (default off, `--no-jev` overrides a task file, needs `TYPESAFE_API_KEY`, links to the warning) and `--jev-threshold` (default `0.8`, greater than 0 and at most 1).
  - Task-file key table rows: `jev` | `true` or `false`; `jev-threshold` | a number greater than 0 and at most 1.
  - TUI globals sentence lists `jev`.
  - A `[!WARNING]` next to the `--allow-file-access` one: `--jev` sends the task, every page snapshot it routes, and the step history to TypeSafe's API (`api.typesafe.ai`), including anything visible on logged-in pages; only use it where that is acceptable.
  - Output section: the new `history.json` fields and the `Jev steps:` line.
  - Roadmap: Jev item ticked `[x]`, rewritten in the past tense, with "savings not benchmarked yet".
- **Criteria:** SC6

## Data flow

Per step, in `Agent.loop` (`src/loop.ts`):

1. Observe the page (`observe`), scrub `page/` as today, compute `nudge` and `paste`, build and scrub the Claude prompt (unchanged).
2. Build `StepInput` with scrubbed obs and `ctx` (Decisions table: Scrubbing, `previousFailed`).
3. `brain.decide(prompt, !paste, stepInput)`.

`HybridBrain.decide(prompt, grep, step)`:

1. If `step` is missing, or `ctx.step === 1`, or `ctx.nudged`, or `ctx.previousFailed` → call Claude; return its decision with `source: "claude"`, `jev: null`.
2. `targets = extractTargets(obs.snapshot)`. If `targets.length === 0` or `> 255` → same as 1.
3. Build the request (C6) with `state = { task, memory, history: historyLines, tabs: obs.tabs, snapshot: obs.snapshot }` and call `jev.ask`.
   - `JevAuthError` or `AbortedError` → rethrow.
   - `JevError e` → `record = { action: null, …: null, routed: "error: " + e.message }`, `jevCost = e.cost`, go to step 5.
4. Judge the answer, `a = answers.action`, `t = answers.target`:
   - `a.choice` is `needs_text` → routed `needs_text`. `done` → routed `done`.
   - else if `a.confidence < minConfidence`, or the action takes a target and `t.confidence < minConfidence` → routed `low_confidence`.
   - else → routed `accepted`: return `[{ evaluationPreviousGoal: "", memory: ctx.memory, nextGoal, actions: [action], source: "jev", jev: record }, jevCost]`. Claude is not called.
5. Fallback: call Claude with `(prompt, grep)`.
   - Success → return `[{ ...claudeDecision, source: "claude", jev: record }, jevCost + claudeCost]`.
   - `BrainError e` → `e.cost += jevCost; e.jev = record;` rethrow.

Back in the loop: on success, `rec.costUsd = cost` and the decision (with `source`, `jev`) is scrubbed and executed via `execute()` and its allow-list. On `BrainError`, the brain-error record carries `source: "claude"`, `jev: e.jev`, `costUsd: e.cost`. When Jev answers `done`, Claude writes the `done` action itself (or keeps going).

At the end, `historyJson` writes C4; `finish` counts `source === "jev"` steps into `jevSteps` when `args.jev`; `printOutcome` prints C7.

Security: Jev can only choose from the 8 action options and from refs present in the current snapshot, so injected page text can at worst steer which existing element gets clicked. `execute()` still checks every action.

## Error handling

| Failure | Behavior |
| --- | --- |
| `--jev` with no `TYPESAFE_API_KEY` | Preflight message `TYPESAFE_API_KEY is not set (needed by --jev)`, exit 2, nothing runs (C1, C3). |
| Invalid threshold (flag) | Usage error, exit 2 (C1). |
| Invalid `jev`/`jev-threshold` in task file or config | `<file>:<line>: …`, exit 2 (C2). |
| Jev 401 | `JevAuthError` stops the run: `jev error: invalid TYPESAFE_API_KEY`, exit 1, `history.json` written (C1). In the TUI/web, the run fails with that error. |
| Jev 429/529 | Retried twice (1 s, 3 s); then `JevError` → Claude decides, `routed: "error: jev http <status> after 3 attempts"`. |
| Jev 422, other HTTP error, timeout, network error, malformed body | `JevError` → Claude decides, `routed: "error: …"`, Jev cost (if any) added. Not a brain failure. |
| Claude fails after a Jev call | `BrainError` with Jev cost added and `jev` record; counts as one brain failure as today. |
| Ctrl-C / TUI stop during a Jev call or retry wait | `AbortedError`; run ends `interrupted`, exit 130, as today. |
| Jev picks a ref that execution rejects or that fails | Normal action failure (`error: …`); the next step has `previousFailed` and goes to Claude. |
| Snapshot with 0 or > 255 targets | Claude decides, `jev: null`, no Jev cost. |
| Older `history.json` without the new fields | Export and past-run loading accept it unchanged. |

## Testing

All tests are unit tests with fakes: a fake `JevTransport`, a fake `sleep`, a fake Claude `DecideFn`, and the existing fake runner / fake playwright helpers. No network, no browser.

New `test/jev.test.ts`:

- `extractTargets`: role filtering; unnamed refs kept only with `[cursor=pointer]`; duplicate refs dropped; order kept; escaped quotes in names; lines without refs ignored.
- `JevClient`: request URL, headers and body (model, state, questions); cost math with both prices; 429 then success (sleep called with 1000); 529 three times → `JevError` (sleeps 1000, 3000); 401 → `JevAuthError` with no retry; 422, other status, timeout, network error, non-JSON, invalid answer (unknown choice, confidence out of range), missing usage → `JevError` with the exact messages in C6; abort → `AbortedError`.
- `HybridBrain`, one test per routing case: accepted (click with target; `press_enter` without target); low action confidence; low target confidence; `needs_text`; `done`; step 1; nudged; previous failure; 0 targets; 256 targets; `JevError`; missing `step`. Each asserts which brains were called, the `Decision` (actions, `nextGoal` format, `memory`), `source`, `jev` record and summed cost.
- Claude `BrainError` after a Jev call carries both costs and the `jev` record.
- `JevAuthError` propagates out of `decide`.

Updated existing tests:

- `test/loop.test.ts`: `decide` receives `StepInput` with scrubbed obs/ctx and correct `nudged`/`previousFailed`; `costUsd` on records; brain-error record carries `jev`; a `HybridBrain` whose Jev call fails (`JevError`) and whose Claude succeeds leaves the consecutive-failure count at 0; a `JevAuthError` thrown by the brain propagates out of `Agent.run`.
- `test/args.test.ts`: `--jev`, `--no-jev`, `--jev-threshold` defaults, valid values, each error message; help/usage text.
- `test/taskfile.test.ts`, `test/config.test.ts`: `jev` and `jev-threshold` keys, the threshold error message, `DEFAULT_CONFIG` lines.
- `test/cli.test.ts`: missing key exits 2 (single run, batch prefix, TUI start); a run whose agent throws `JevAuthError` exits 1, prints `jev error: invalid TYPESAFE_API_KEY` and writes `history.json`; `Jev steps:` line.
- `test/report.test.ts`: `printOutcome` prints `Jev steps:` only when `jevSteps` is set.
- `test/runs/*`: `historyJson` new fields (non-Jev defaults and Jev steps); `startRun` builds a `HybridBrain` when `args.jev`; manager overrides/effective `jev`.
- `test/tui/*`: form has the `jev` field and toggles it.
- `test/web/*`: `parseOverrides` accepts `jev` and rejects non-booleans.
- `test/brain.test.ts`: `Brain.decide` ignores the third argument and tags `source: "claude"`.

Check commands: `npm test` (runs `npm run typecheck`, then `node --test` over `test/**/*.test.ts`) and `npm run typecheck`.

| Criterion | Contracts | Proved by |
| --- | --- | --- |
| SC1: confident non-text step → single-action Decision, `source="jev"`, no Claude call | C5, C6 | `test/jev.test.ts` accepted cases (`npm test`) |
| SC2: step 1, nudged, previous failure, 0 / > 255 targets, low confidence, `needs_text`, `done`, `JevError` → Claude with Jev cost added | C5, C6 | `test/jev.test.ts` routing cases (`npm test`) |
| SC3: no key → exit 2; 401 → exit 1 with `history.json` | C1 | `test/cli.test.ts` (`npm test`); QA scenarios in the test plan |
| SC4: `history.json` fields and `Jev steps: n/total` | C1, C4, C7 | `test/runs/*`, `test/report.test.ts`, `test/cli.test.ts` (`npm test`); QA scenarios |
| SC5: task file / config keys, TUI and web toggles | C2, C3 | `test/taskfile.test.ts`, `test/config.test.ts`, `test/tui/*`, `test/web/*`, manager tests (`npm test`); QA scenarios |
| SC6: README flag, warning, roadmap; `npm test` passes | C8 | Review of `README.md`; `npm test` |

E2E tests (`test/e2e.test.ts` or any real browser / real API run) are not part of this run's verification.

### Manual e2e

- With a real `TYPESAFE_API_KEY`, run `duckwright -p --jev "<a navigation-only task>"` and check that some steps show `source: "jev"`, costs are plausible, and the answer is correct. Re-check the live API shape against C6 and the published output price before relying on the cost figures.
- Run once with an invalid key and confirm exit 1 and the `jev error` line.

## Out of scope

- The opt-in benchmark harness and its fixtures (follow-up; needs a live API key).
- Jev writing text (URLs, form values, the final answer).
- A plan-then-execute split (Claude plans, Jev executes).
- Making Jev the default brain.
- Running without Claude installed.
- A UI field for `jev-threshold`; a flag for the Jev model name; showing the step source in the TUI/web timelines; `Jev steps` in TUI/web summaries.
