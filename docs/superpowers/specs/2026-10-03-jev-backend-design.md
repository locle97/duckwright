# Jev backend (`--jev`) design

Status: approved design, not scheduled. Revisit before implementation: re-check the Jev API and pricing, which are early-access and may have changed.

## Goal

Claude (`claude -p`) is the main cost of a `pw_agent` run. `--jev` adds a cheaper brain, TypeSafe AI's [Jev](https://typesafe.ai/), that decides the steps it can and passes the rest to Claude.

Success is measured by a benchmark (see [Benchmark](#benchmark)). On the same tasks, `--jev` must pass at least as many runs as Claude alone, at a mean cost at least 50% lower.

Out of scope:

- Jev writing text: URLs, form values, the final answer.
- A plan-then-execute split, where Claude writes a plan and Jev executes it.
- Making Jev the default brain.
- Running without Claude installed.

## Background: what Jev can and cannot do

Jev is a "System One" model, in limited early access since 15 September 2026. It does not generate text. It answers typed questions about an input `state` and returns a calibrated confidence for each answer.

- API: `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`.
- Request body: `{"model": "jev-latest", "state": ..., "questions": {"<id>": Question}}`. Several questions can go in one call.
- `state` is a string, a JSON object, or an array of text. Images are not supported.
- Question types: `choice` (pick one of up to 255 options, defined per request in `criteria`), `score` and `noul`.
- A `choice` answer returns the chosen option, a probability per option, and a `confidence` from 0 to 1.
- The response includes `usage.input_tokens` and `usage.output_tokens`.
- Errors: 401 (bad key), 422 (invalid body), 429 (rate limit), 529 (overloaded). The docs recommend retrying 429 and 529 with exponential backoff.
- Pricing: $42 per billion input tokens. The docs do not list an output price.

Jev cannot produce the free text a full `Decision` needs. So it can choose the command and the target ref, but never a `goto` URL, `fill` text, or a `done` answer.

Sources: [typesafe.ai](https://typesafe.ai/), [announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [API reference](https://docs.typesafe.ai/api.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), [State](https://docs.typesafe.ai/concepts/state.md).

## Approach: per-step router

Each step, Jev is asked first. When it is confident and the next move needs no text, the harness builds the `Decision` from Jev's answers. Otherwise Claude decides the step exactly as it does today.

Two alternatives were rejected:

- Claude plans and Jev executes. This needs a plan format, progress tracking, and re-planning. Revisit it only if the benchmark shows the router saves too little.
- Jev only maps Claude's description of a target to a ref. Claude still runs every step, so the savings are small.

## Architecture

### New module: `pw_agent/jev.py`

It uses the standard library only (`urllib.request`, `json`), so the runtime keeps zero dependencies.

- `Target(ref: str, role: str, name: str)`
- `extract_targets(snapshot: str) -> list[Target]`
  - Parses snapshot lines such as `- button "Submit" [ref=e12] [cursor=pointer]`.
  - Keeps the roles `link`, `button`, `checkbox`, `radio`, `tab`, `menuitem`, `option`.
  - Drops a target that has neither a name nor `[cursor=pointer]`.
  - Keeps snapshot order and removes duplicate refs.
- `JevClient(api_key, model="jev-latest", timeout=10, transport=<urllib POST>)`
  - `ask(state, questions) -> tuple[dict, float]` returns the `answers` map and the cost in USD.
  - Retries 429 and 529 twice, sleeping 1 s and then 3 s. The sleep function is injectable for tests.
  - Raises `JevAuthError` on 401.
  - Raises `JevError(msg, cost)` on every other failure: 422, other non-2xx, timeout, network error, malformed response, or 429/529 after the retries.
- Price constants:
  - `JEV_INPUT_USD_PER_TOKEN = 42e-9`
  - `JEV_OUTPUT_USD_PER_TOKEN`: set from console.typesafe.ai during implementation.
  - Cost is `input_tokens × input price + output_tokens × output price`.
- `HybridBrain(jev: JevClient, claude: Brain, min_confidence: float = 0.8)`
  - `decide(prompt, obs, ctx) -> tuple[Decision, float]` implements the routing rules below.

### Changes to existing modules

- `brain.py`
  - `Decision` gains `source: str = "claude"` and `jev: dict | None = None`, the routing record described under [Output](#output).
  - `Brain.decide(prompt, obs=None, ctx=None)` ignores `obs` and `ctx`.
- `loop.py`
  - Calls `self.brain.decide(prompt, obs, ctx)`.
  - `ctx` is a small `StepContext(step, task, memory, history_lines, nudged, previous_failed)`, so `HybridBrain` does not re-parse the prompt.
  - `previous_failed` is true when any result of the previous `StepRecord` starts with `error:` (a failed or rejected action) or `brain error:` (a failed Claude call). It reuses the result strings the loop already records. `skipped:` results are not failures.
  - Nothing else changes: repeat detection, failure counting, and `execute()` with its allow-list.
  - `max_failures` still counts only Claude `BrainError`s.
  - `JevAuthError` propagates and stops the run.
- `__main__.py`
  - Adds `--jev` and `--jev-threshold FLOAT` (default `0.8`).
  - With `--jev`, preflight also requires the environment variable `TYPESAFE_API_KEY` (exit 2 if it is missing), and the brain is `HybridBrain(JevClient(key), Brain(...), threshold)`.
  - `JevAuthError` exits 1 with `jev error: invalid TYPESAFE_API_KEY` and still writes `history.json`.
  - Prints `Jev steps: <jev>/<total>` after `Steps:`.

## Routing rules

`HybridBrain.decide` goes straight to Claude, without calling Jev, when:

1. `ctx.step == 1`. The run starts at `about:blank`, so the first step is always a `goto`.
2. `ctx.nudged` is true. The repeat nudge needs a different approach, which Jev cannot plan.
3. `ctx.previous_failed` is true. Claude reads the error and recovers.
4. `extract_targets(obs.snapshot)` returns 0 targets or more than 255.

Otherwise it makes one Jev call:

- `state`: `{"task": ..., "memory": ..., "history": [...], "tabs": obs.tabs, "snapshot": obs.snapshot}`. `history` is the same 15-line window Claude gets.
- Question `action` (`choice`). Each option has a one-line description in `criteria`.

  | Option | Becomes |
  | --- | --- |
  | `click`, `check`, `uncheck`, `hover` | that command with `[target]` |
  | `press_enter`, `press_tab`, `press_escape` | `press Enter` / `press Tab` / `press Escape` |
  | `go_back` | `go-back` |
  | `needs_text` | Claude decides the step |
  | `done` | Claude decides the step |

- Question `target` (`choice`): one option per target, keyed by ref, described as `<role> "<name>"`.

Jev's answer is accepted only when all of these hold:

- `action` confidence ≥ `min_confidence`.
- `action` is not `needs_text` or `done`.
- If the action needs a target, `target` confidence ≥ `min_confidence`.

An accepted answer becomes a `Decision` with exactly one action:

- `source="jev"`.
- `evaluation_previous_goal=""`.
- `memory` is `ctx.memory`, unchanged.
- `next_goal` is `jev: <action> <role> "<name>" (<confidence>)`, using the lower of the two confidences.

Any other answer, or a `JevError`, means Claude decides the step. In that case:

- The step's cost is Jev's cost plus Claude's.
- The `Decision` has `source="claude"` and keeps the `jev` routing record.
- A `JevError` is not counted as a brain failure.
- If Claude then raises `BrainError`, the Jev cost is added to `e.cost` before re-raising.

When Jev answers `done`, Claude writes `done success|failure <answer>`, because only Claude can produce the answer. Claude may also disagree and keep going.

Security: Jev only picks from the allowed commands and from refs that are on the page. So injected page text can at worst steer which existing element gets clicked. `execute()` still checks every action against the allow-list.

## Output

Each step in `history.json` gains these fields:

```json
"source": "jev",
"cost_usd": 0.0000012,
"jev": {
  "action": "click", "action_confidence": 0.93,
  "target": "e1236", "target_confidence": 0.88,
  "routed": "accepted"
}
```

- `routed` is one of `accepted`, `low_confidence`, `needs_text`, `done`, or `error: <message>`.
- `jev` is `null` when the step skipped Jev (routing rules 1–4) or when the run did not use `--jev`.
- `cost_usd` per step needs `StepRecord` to carry the step cost, set by the loop.
- The top-level object gains `jev_steps` and `claude_steps`.

README updates:

- A `--jev` and `--jev-threshold` row in the options table.
- A `[!WARNING]` that `--jev` sends the task, page snapshots, and history to TypeSafe's API, including anything visible on authenticated pages.
- Move the roadmap item to done.

## Testing

Unit tests need no network or browser and use the existing fake-runner style.

`tests/test_jev.py`:

- `extract_targets`:
  - role filtering;
  - unnamed refs kept only with `[cursor=pointer]`;
  - duplicate refs removed;
  - order kept.
- `JevClient` with a fake transport and sleep:
  - request URL, headers, and body;
  - cost math;
  - 429 then success;
  - 529 three times → `JevError`;
  - 401 → `JevAuthError`;
  - 422, timeout, and malformed JSON → `JevError`.
- `HybridBrain`, one test per routing case:
  - accepted;
  - low `action` confidence;
  - low `target` confidence;
  - `needs_text`;
  - `done`;
  - step 1;
  - nudge;
  - previous failure;
  - 0 targets;
  - 256 targets;
  - `JevError` → Claude.

  Each test asserts which brain was called, the resulting `Decision`, its `source` and `jev`, and the summed cost.
- Claude raising `BrainError` after a Jev call carries both costs.

Existing tests: update them for the new `decide` signature, the `Decision` fields, the `history.json` fields, and the `--jev` preflight.

## Benchmark

`tests/bench/` is opt-in and never runs in CI:

```bash
PW_AGENT_BENCH=1 TYPESAFE_API_KEY=... python3 -m pytest tests/bench -s
```

Fixtures go in `tests/fixtures/`:

| Fixture | Task | Exercises |
| --- | --- | --- |
| `multipage.html` (+ linked pages) | Click through a 3-level link maze and report the value at the end | Jev's best case: navigation only |
| `settings.html` | Turn on two checkboxes, click Save, report the confirmation text | Toggles, plus a final Claude `done` |
| `form.html` (existing) | Fill in and submit the form, report the greeting | Mostly Claude: guards against regressions |

- Each task runs 3 times with Claude only and 3 times with `--jev`.
- The benchmark prints, per task and in total: pass count, mean cost, mean wall time, and the Jev step share.
- It writes the table to `runs/bench-<timestamp>.json`.

Acceptance:

- Across all 9 runs per mode, the `--jev` pass count is ≥ the Claude-only pass count.
- The mean `--jev` cost is ≤ 50% of the mean Claude-only cost.

If either target fails, tune `--jev-threshold` and the option descriptions, then re-run. Don't document `--jev` as ready until both targets pass.
