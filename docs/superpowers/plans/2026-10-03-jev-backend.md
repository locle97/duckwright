# Jev Backend (`--jev`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--jev`, a per-step router that lets TypeSafe's Jev pick text-free browser actions when it is confident and hands every other step to Claude, so runs pass as often as Claude alone at under half the cost.

**Architecture:** A new `pw_agent/jev.py` holds the snapshot target parser, a stdlib HTTP client for Jev, and `HybridBrain`, which wraps the existing Claude `Brain` behind the same `decide()` call. The loop passes the observation and a small `StepContext` to the brain, records each step's cost and routing, and `__main__` wires up the flag, the API key check and the new `history.json` fields. An opt-in benchmark compares both modes.

**Tech Stack:** Python ≥3.11 standard library (`urllib.request`, `json`, `re`), pytest, jsonschema (dev only); `claude` CLI and `@playwright/cli` as today.

**Spec:** `docs/superpowers/specs/2026-10-03-jev-backend-design.md`

## Global Constraints

- Runtime dependencies stay empty (`pyproject.toml` `dependencies = []`). `jev.py` uses only `urllib.request` and `json` for HTTP.
- Endpoint `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, model `"jev-latest"`.
- API key comes only from the environment variable `TYPESAFE_API_KEY`.
- `JEV_INPUT_USD_PER_TOKEN = 42e-9`. `JEV_OUTPUT_USD_PER_TOKEN = 0.0`: docs.typesafe.ai/models.md (checked 2026-10-03) says "Charged per input token. Output tokens are free."
- A `choice` question has at most 255 options.
- `JevClient` timeout `10` s; retries 429 and 529 twice, sleeping `1` s then `3` s.
- `--jev-threshold` default `0.8`.
- Jev never produces text: no `goto` URL, `fill`/`type` text, or `done` answer comes from Jev.
- `--jev` is never the default, and Claude is still required (preflight keeps checking for `claude`).
- Unit tests make no network calls and start no browser.
- Pinned API shapes (from docs.typesafe.ai/api.md, checked 2026-10-03), used by Tasks 3 and 4:
  - Question: `{"type": "choice", "instructions": "<text>", "criteria": {"<option>": "<description>"}}`.
  - Response: `{"model": "jev-1.13.0", "answers": {"<id>": {"type": "choice", "choice": "<option>", "probabilities": {...}, "confidence": 0.81}}, "usage": {"input_tokens": 318, "output_tokens": 34}}`.

## Review Focus

1. **Jev returns an answer the harness cannot use** (a `target` ref that is not in the option list, a missing `confidence`, a missing question id): the step must go to Claude with `routed` `error: ...`, never crash the run or click a ref that is not on the page. Test in Task 4.
2. **Element names containing quotes or `[ref=...]` text** (for example `button "Say \"hi\" [ref=e99]" [ref=e9]`): `extract_targets` must return the real ref `e9` and the unescaped name. Test in Task 2.
3. **Jev keeps clicking the same element**: after three identical Jev steps the loop's repeat nudge must send step 4 to Claude. Test in Task 4 (Agent-level).
4. **The key is revoked mid-run** (401 on step 5): the run exits 1 with `jev error: invalid TYPESAFE_API_KEY` and `history.json` still holds the earlier steps. Test in Task 5.
5. **Bad flag values**: `--jev-threshold 1.5` or an empty `TYPESAFE_API_KEY=""` must exit 2 with a message before a browser opens, not silently route everything to Claude or send an empty bearer token. Test in Task 5.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `pw_agent/brain.py` | modify | `Decision.source`/`.jev`, `StepContext`, `Brain.decide(prompt, obs, ctx)` |
| `pw_agent/prompt.py` | modify | `history_lines()` shared by the prompt and `StepContext`; `StepRecord.cost` |
| `pw_agent/loop.py` | modify | build `StepContext`, pass `obs`/`ctx`, record step cost |
| `pw_agent/jev.py` | create | `Target`, `extract_targets`, `JevClient`, errors, prices, `HybridBrain` |
| `pw_agent/__main__.py` | modify | `--jev`, `--jev-threshold`, key preflight, `JevAuthError` exit, `history.json` fields, `Jev steps:` line |
| `README.md` | modify | options rows, data warning, roadmap |
| `tests/test_brain.py`, `tests/test_prompt.py`, `tests/test_loop.py`, `tests/test_main.py` | modify | new signature and fields |
| `tests/test_jev.py` | create | parser, client, router tests |
| `tests/bench/` | create | opt-in benchmark and its summary math |
| `tests/fixtures/multipage*.html`, `tests/fixtures/settings.html` | create | benchmark pages |

Setup once: `python3 -m pip install -e '.[dev]'` (pytest is not preinstalled).

---

### Task 1: Brain interface, step context, and step cost

**Files:**
- Modify: `pw_agent/brain.py` (`Decision`, new `StepContext`, `Brain.decide`)
- Modify: `pw_agent/prompt.py` (`StepRecord`, new `history_lines`, `build_prompt`)
- Modify: `pw_agent/loop.py` (`_loop`)
- Test: `tests/test_brain.py`, `tests/test_prompt.py`, `tests/test_loop.py`

**Interfaces:**
- Produces:
  - `Decision(evaluation_previous_goal, memory, next_goal, actions, source: str = "claude", jev: dict | None = None)`
  - `@dataclass StepContext(step: int, task: str, memory: str, history_lines: list[str], nudged: bool, previous_failed: bool)` in `brain.py` (lives there so `jev.py` imports it without importing `loop.py`).
  - `Brain.decide(prompt: str, obs: Observation | None = None, ctx: StepContext | None = None) -> tuple[Decision, float]`; `obs` and `ctx` are ignored. Type `obs` as `object | None` or use a `TYPE_CHECKING` import; `observe.py` must not gain an import of `brain.py`.
  - `history_lines(history: list[StepRecord], window: int = HISTORY_WINDOW) -> list[str]` in `prompt.py`: exactly the lines `build_prompt` puts in `<history>`, including the `(N earlier steps omitted)` line; `[]` for no history.
  - `StepRecord(step, decision, results, codes=[], cost: float = 0.0)`.
  - The loop calls `self.brain.decide(prompt, obs, ctx)`. Any brain object with that method works.

- [ ] **Step 1: Write the failing tests**

In `tests/test_brain.py`:

```python
def test_decision_routing_defaults():
    d = Decision("", "", "", [])
    assert (d.source, d.jev) == ("claude", None)

def test_decide_ignores_obs_and_ctx():
    a, b = FakeRunner(env()), FakeRunner(env())
    Brain([Path("s.md")], runner=a).decide("P")
    Brain([Path("s.md")], runner=b).decide("P", obs=object(), ctx=object())
    assert a.calls == b.calls
```

In `tests/test_prompt.py` (reuse that file's existing record/observation helpers):

```python
def test_history_lines_matches_prompt_window():
    hist = [StepRecord(i, Decision("e", "m", f"g{i}", []), ["ok"]) for i in range(1, 21)]
    lines = history_lines(hist)
    assert len(lines) == 16 and lines[0] == "(5 earlier steps omitted)"
    prompt = build_prompt("t", 21, 25, hist, "", obs)
    assert "<history>\n" + "\n".join(lines) + "\n</history>" in prompt

def test_history_lines_empty():
    assert history_lines([]) == []
```

In `tests/test_loop.py`, change `FakeBrain.decide` to `decide(self, prompt, obs=None, ctx=None)` and also append `obs` to `self.obs` and `ctx` to `self.ctxs`. Then add:

```python
def test_brain_gets_obs_and_ctx(tmp_path):
    brain = FakeBrain([dec(("hover", ["e1"])), dec(("done", ["success", "x"]))])
    Agent("t", FakePW(), brain, tmp_path).run()
    c1, c2 = brain.ctxs
    assert (c1.step, c1.task, c1.memory, c1.history_lines, c1.nudged, c1.previous_failed) == (1, "t", "", [], False, False)
    assert (c2.step, c2.memory, len(c2.history_lines)) == (2, "m", 1)
    assert brain.obs[0].snapshot == "- page"

def test_previous_failed_after_rejected_action(tmp_path):
    brain = FakeBrain([dec(("eval", ["x"])), dec(("hover", ["e1"])), dec(("done", ["success", "x"]))])
    Agent("t", FakePW(), brain, tmp_path).run()
    assert [c.previous_failed for c in brain.ctxs] == [False, True, False]

def test_previous_failed_after_brain_error(tmp_path):
    brain = FakeBrain([BrainError("x"), dec(("done", ["success", "x"]))])
    Agent("t", FakePW(), brain, tmp_path).run()
    assert brain.ctxs[1].previous_failed is True

def test_nudged_in_ctx(tmp_path):
    brain = FakeBrain([dec(("hover", ["e1"]))])
    Agent("t", FakePW(), brain, tmp_path, max_steps=4).run()
    assert [c.nudged for c in brain.ctxs] == [False, False, False, True]

def test_step_cost_recorded(tmp_path):
    err = BrainError("x", cost=0.25)
    brain = FakeBrain([err, dec(("done", ["success", "x"]))])
    r = Agent("t", FakePW(), brain, tmp_path).run()
    assert [h.cost for h in r.history] == [0.25, 0.5]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_brain.py tests/test_prompt.py tests/test_loop.py -q`
Expected: FAIL (`Decision` has no `source`; `history_lines` import error; `decide()` got unexpected arguments / `ctxs` empty).

- [ ] **Step 3: Implement**

- Add the `Decision` fields, `StepContext`, and the `decide` parameters in `brain.py`.
- Add `StepRecord.cost` and `history_lines`, and make `build_prompt` call `history_lines(history, window)`.
- In `loop.py`, build `StepContext(step, self.task, memory, history_lines(history), nudge is not None, _previous_failed(history))` before the brain call. `_previous_failed(history)` is true when the last record has any result starting with `"error:"` or `"brain error:"`; `"skipped:"` does not count. Set `cost=c` on a decided step and `cost=e.cost` on a brain-error step.
- Do not change repeat detection, failure counting, or `execute()`.

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest -q`
Expected: all pass (live e2e is skipped).

- [ ] **Step 5: Commit**

```bash
git add pw_agent/brain.py pw_agent/prompt.py pw_agent/loop.py tests/test_brain.py tests/test_prompt.py tests/test_loop.py
git commit -m "feat: pass observation and step context to the brain, record step cost"
```

---

### Task 2: Snapshot target extraction

**Files:**
- Create: `pw_agent/jev.py`
- Test: `tests/test_jev.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) Target(ref: str, role: str, name: str)`
  - `TARGET_ROLES = ("link", "button", "checkbox", "radio", "tab", "menuitem", "option")`
  - `extract_targets(snapshot: str) -> list[Target]`

- [ ] **Step 1: Write the failing tests**

```python
SNAP = '''- generic [ref=e1]:
  - link "Home" [ref=e2] [cursor=pointer]:
    - /url: /
  - button "Submit" [ref=e3] [cursor=pointer]
  - textbox "Name" [ref=e4]
  - checkbox "Agree" [checked] [ref=e5]
  - button [ref=e6] [cursor=pointer]
  - button [ref=e7]
  - link "Home" [ref=e2] [cursor=pointer]
  - heading "Title" [level=1] [ref=e8]
  - button "Say \\"hi\\" [ref=e99]" [ref=e9]
…[snapshot truncated]'''

def test_extract_targets():
    assert extract_targets(SNAP) == [
        Target("e2", "link", "Home"),
        Target("e3", "button", "Submit"),
        Target("e5", "checkbox", "Agree"),
        Target("e6", "button", ""),
        Target("e9", "button", 'Say "hi" [ref=e99]'),
    ]

def test_extract_targets_empty():
    assert extract_targets("") == [] and extract_targets("- page") == []
```

The first test covers role filtering (e1, e4, e8 dropped), unnamed refs (e6 kept for `[cursor=pointer]`, e7 dropped), duplicates (second e2), order, and Review Focus 2 (e9).

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_jev.py -q`
Expected: FAIL with `ModuleNotFoundError: pw_agent.jev`.

- [ ] **Step 3: Implement `extract_targets` in `pw_agent/jev.py`**

Match each line with role, optional quoted name (with backslash escapes), and the rest. Look for `[ref=…]` and `[cursor=pointer]` only in the rest, after the name, so text inside the name cannot fake a ref:

```python
_LINE = re.compile(r'^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$')
_REF = re.compile(r"\[ref=([^\]\s]+)\]")
# name = re.sub(r"\\(.)", r"\1", raw_name)
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest tests/test_jev.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pw_agent/jev.py tests/test_jev.py
git commit -m "feat(jev): extract clickable targets from snapshots"
```

---

### Task 3: Jev HTTP client

**Files:**
- Modify: `pw_agent/jev.py`
- Test: `tests/test_jev.py`

**Interfaces:**
- Produces:
  - `JEV_URL = "https://api.typesafe.ai/v1/systemone"`, `JEV_INPUT_USD_PER_TOKEN = 42e-9`, `JEV_OUTPUT_USD_PER_TOKEN = 0.0`
  - `class JevError(Exception)`: `__init__(self, msg: str = "", cost: float = 0.0)`, attribute `cost`.
  - `class JevAuthError(Exception)`: **not** a subclass of `JevError` or `BrainError`, so neither `HybridBrain` nor the loop catches it.
  - `Transport = Callable[[str, dict[str, str], bytes, float], tuple[int, bytes]]`: `(url, headers, body, timeout) -> (status, body)`. It raises `OSError` (this includes `TimeoutError` and `urllib.error.URLError`) on network failure.
  - `_urllib_post`, the default transport. It returns `(e.code, e.read())` for `urllib.error.HTTPError`.
  - `JevClient(api_key: str, model: str = "jev-latest", timeout: float = 10, transport: Transport = _urllib_post, sleep: Callable[[float], None] = time.sleep)`; public attribute `api_key`.
  - `JevClient.ask(state: object, questions: dict) -> tuple[dict, float]` returns `(answers, cost_usd)`.

- [ ] **Step 1: Write the failing tests**

Add a `FakeTransport(script)` that records `(url, headers, json.loads(body), timeout)` per call and returns or raises the next script item. Use a `sleeps` list as the sleep function. `OK = (200, json.dumps({"answers": {"a": {"type": "choice", "choice": "x", "probabilities": {"x": 1.0}, "confidence": 1.0}}, "usage": {"input_tokens": 1000, "output_tokens": 50}}).encode())`.

```python
def test_ask_request_and_cost():
    t = FakeTransport([OK]); c = JevClient("k", transport=t, sleep=sleeps.append)
    answers, cost = c.ask({"s": 1}, {"a": Q})
    url, headers, body, timeout = t.calls[0]
    assert url == "https://api.typesafe.ai/v1/systemone" and timeout == 10
    assert headers["Authorization"] == "Bearer k" and headers["Content-Type"] == "application/json"
    assert body == {"model": "jev-latest", "state": {"s": 1}, "questions": {"a": Q}}
    assert answers["a"]["choice"] == "x"
    assert cost == pytest.approx(1000 * 42e-9)

def test_retries_429_then_succeeds():      # script [(429, b""), OK] → answers, sleeps == [1]
def test_529_three_times_raises():         # 3×(529, b"") → JevError, sleeps == [1, 3], 3 calls
def test_401_raises_auth_error():          # (401, b"{}") → JevAuthError, 1 call, no sleep
def test_422_raises_jev_error():           # (422, b"{}") → JevError, 1 call
def test_timeout_raises_jev_error():       # script raises TimeoutError → JevError
def test_malformed_json_raises_jev_error():# (200, b"not json") → JevError, cost 0.0
def test_missing_answers_keeps_cost():     # 200 with usage but no "answers" → JevError, e.cost == approx(1000*42e-9)
def test_missing_usage_costs_zero():       # 200 with answers, no usage → cost == 0.0
```

Write each one-line test above out in full with those assertions.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_jev.py -q -k "ask or retries or 529 or 401 or 422 or timeout or malformed or missing"`
Expected: FAIL with `ImportError` for `JevClient`.

- [ ] **Step 3: Implement the errors, prices, `_urllib_post`, and `JevClient`**

- Make at most 3 attempts. Sleep `(1, 3)[attempt]` between them, only after a 429 or 529.
- Also send `User-Agent: pw_agent`.
- Cost is `input_tokens * JEV_INPUT_USD_PER_TOKEN + output_tokens * JEV_OUTPUT_USD_PER_TOKEN`. A missing or non-numeric count counts as 0.
- The response must be a JSON object whose `answers` is a dict; anything else raises `JevError` carrying the cost computed so far.

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest tests/test_jev.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pw_agent/jev.py tests/test_jev.py
git commit -m "feat(jev): stdlib HTTP client with retries and cost"
```

---

### Task 4: HybridBrain router

**Files:**
- Modify: `pw_agent/jev.py`
- Test: `tests/test_jev.py`

**Interfaces:**
- Consumes: `Decision`, `Action`, `BrainError`, `StepContext` (Task 1); `Observation` (`pw_agent/observe.py`, fields `tabs`, `snapshot`); `extract_targets` (Task 2); `JevClient.ask`, `JevError`, `JevAuthError` (Task 3).
- Produces:
  - `HybridBrain(jev: JevClient, claude: Brain, min_confidence: float = 0.8)`; public attributes `jev`, `claude`, `min_confidence`.
  - `HybridBrain.decide(prompt: str, obs: Observation | None = None, ctx: StepContext | None = None) -> tuple[Decision, float]`.
  - Routing record `jev` dict with keys `action`, `action_confidence`, `target`, `target_confidence`, `routed`. All values except `routed` are `None` on a `JevError`.

**Fixed copy (tune only after the benchmark):**

```python
ACTION_INSTRUCTIONS = (
    "You control a web browser to complete `task`. `snapshot` is the current page, "
    "`history` the steps so far, `memory` the agent's notes. Which single next action best advances the task?"
)
TARGET_INSTRUCTIONS = (
    "If the next action clicks, checks, unchecks or hovers an element of `snapshot`, which element should it be?"
)
# option: (description, cmd, args, needs_target); args None means [target ref]
ACTION_OPTIONS = {
    "click":        ("Click a link, button, tab or menu item on the page", "click", None, True),
    "check":        ("Tick an unticked checkbox or select a radio button", "check", None, True),
    "uncheck":      ("Untick a ticked checkbox", "uncheck", None, True),
    "hover":        ("Hover over an element to reveal a menu or tooltip", "hover", None, True),
    "press_enter":  ("Press Enter to submit the focused field", "press", ["Enter"], False),
    "press_tab":    ("Press Tab to move focus to the next field", "press", ["Tab"], False),
    "press_escape": ("Press Escape to close a dialog or menu", "press", ["Escape"], False),
    "go_back":      ("Go back to the previous page", "go-back", [], False),
    "needs_text":   ("The next action needs typed text: open a URL, fill or type into a field, or choose a value", None, None, False),
    "done":         ("The task is complete or cannot be completed", None, None, False),
}
```

**Routing (from the spec, in order):**

1. Go straight to `self.claude.decide(prompt, obs, ctx)`, with `jev=None` and without calling Jev, when `obs` or `ctx` is `None`, `ctx.step == 1`, `ctx.nudged`, `ctx.previous_failed`, or the target count is 0 or more than 255.
2. Otherwise make one `ask` call:
   - state is `{"task": ctx.task, "memory": ctx.memory, "history": ctx.history_lines, "tabs": obs.tabs, "snapshot": obs.snapshot}`.
   - questions are `{"action": {"type": "choice", "instructions": ACTION_INSTRUCTIONS, "criteria": {k: v[0] for k, v in ACTION_OPTIONS.items()}}, "target": {"type": "choice", "instructions": TARGET_INSTRUCTIONS, "criteria": {t.ref: f'{t.role} "{t.name}"'}}}`.
3. Read each answer with `_choice(answers, qid, options) -> tuple[str, float]`. It raises `JevError` when the id is missing, the answer is not a dict, `choice` is not in `options`, or `confidence` is not a number. The router treats that the same as a `JevError` from `ask`, keeping the cost already spent.
4. Set `routed`:
   - the action name, if the action is `needs_text` or `done`;
   - else `low_confidence`, if action confidence < `min_confidence`, or the action needs a target and target confidence < `min_confidence`;
   - else `accepted`.
5. An accepted answer becomes `Decision("", ctx.memory, next_goal, [Action(cmd, args)], source="jev", jev=record)`, and the step cost is the Jev cost only.
   - With a target, `next_goal` is `f'jev: {action} {role} "{name}" ({min(ac, tc):.2f})'`.
   - Without one, it is `f"jev: {action} ({ac:.2f})"`.
6. Any other outcome calls Claude:
   - Set `source="claude"` and attach `jev=record` to Claude's decision. The cost is Jev cost plus Claude cost.
   - On a `BrainError`, add the Jev cost to `e.cost` and re-raise.
   - Never catch `JevAuthError`.

- [ ] **Step 1: Write the failing tests**

Helpers:

- `FakeJev(script)`: records `(state, questions)` and returns `(answers, 1e-6)` or raises.
- `FakeClaude(script)`: records calls and returns `(decision, 0.5)` or raises.
- `PAGE = Observation("tabs", '- link "Home" [ref=e2]\n- button "Submit" [ref=e3]', False)`.
- `ctx(**kw)`: a `StepContext` with defaults `step=2, task="t", memory="mem", history_lines=["h"], nudged=False, previous_failed=False`.
- `ans(action, ac, target="e3", tc=0.9)`: builds the two choice answers.

Write one test per case:

| Test | Jev answer / setup | Assert |
| --- | --- | --- |
| `test_accepted_click` | `ans("click", .93, "e3", .88)` | claude not called; `actions == [Action("click", ["e3"])]`; `source == "jev"`; `memory == "mem"`; `evaluation_previous_goal == ""`; `next_goal == 'jev: click button "Submit" (0.88)'`; `jev == {"action": "click", "action_confidence": .93, "target": "e3", "target_confidence": .88, "routed": "accepted"}`; cost `== 1e-6` |
| `test_accepted_press_ignores_target_conf` | `ans("press_enter", .95, tc=.1)` | `actions == [Action("press", ["Enter"])]`; `next_goal == "jev: press_enter (0.95)"` |
| `test_accepted_go_back` | `ans("go_back", .9)` | `actions == [Action("go-back", [])]` |
| `test_low_action_confidence` | `ans("click", .79)` | claude called with `(prompt, obs, ctx)`; `source == "claude"`; `jev["routed"] == "low_confidence"`; cost `== approx(0.5 + 1e-6)` |
| `test_low_target_confidence` | `ans("click", .95, tc=.5)` | `routed == "low_confidence"` |
| `test_needs_text` / `test_done` | `ans("needs_text", .99)` / `ans("done", .99)` | claude called; `routed` equals the action name |
| `test_skip_step1`, `test_skip_nudged`, `test_skip_previous_failed` | `ctx(step=1)` / `ctx(nudged=True)` / `ctx(previous_failed=True)` | jev not called; `jev is None`; cost `== 0.5` |
| `test_skip_no_targets` | `Observation("t", "- page", False)` | jev not called |
| `test_skip_256_targets` | snapshot with 256 `- button "b{i}" [ref=e{i}]` lines | jev not called; 255 targets *do* call Jev (`test_255_targets_calls_jev`) |
| `test_jev_error_falls_back` | `ask` raises `JevError("boom", 1e-6)` | `jev == {"action": None, "action_confidence": None, "target": None, "target_confidence": None, "routed": "error: boom"}`; cost `== approx(0.5 + 1e-6)` |
| `test_unknown_target_ref_falls_back` | `ans("click", .99, "e404", .99)` | claude called; `routed.startswith("error:")` (Review Focus 1) |
| `test_missing_confidence_falls_back` | action answer without `confidence` | `routed.startswith("error:")` |
| `test_brain_error_carries_both_costs` | low confidence; claude raises `BrainError("x", cost=.25)` | raised `e.cost == approx(.25 + 1e-6)` |
| `test_auth_error_propagates` | `ask` raises `JevAuthError` | `pytest.raises(JevAuthError)`; claude not called |
| `test_request_shape` | accepted | state keys `== {"task", "memory", "history", "tabs", "snapshot"}`; `state["history"] == ["h"]`; `set(q["action"]["criteria"]) == set(ACTION_OPTIONS)`; `q["target"]["criteria"] == {"e2": 'link "Home"', "e3": 'button "Submit"'}` |

Agent-level test (Review Focus 3):

```python
def test_repeat_nudge_hands_step_to_claude(tmp_path):
    from tests.test_loop import FakePW
    class PagePW(FakePW):
        def snapshot(self, path): return PAGE.snapshot
    jev = FakeJev([ans("click", .99, "e3", .99)] * 10)
    claude = FakeClaude([Decision("", "", "", [Action("goto", ["u"])]),          # step 1
                         Decision("", "", "", [Action("done", ["success", "x"])])])  # step 5
    r = Agent("t", PagePW(), HybridBrain(jev, claude), tmp_path).run()
    assert [h.decision.source for h in r.history] == ["claude", "jev", "jev", "jev", "claude"]
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_jev.py -q`
Expected: FAIL with `ImportError` for `HybridBrain`.

- [ ] **Step 3: Implement `ACTION_INSTRUCTIONS`, `TARGET_INSTRUCTIONS`, `ACTION_OPTIONS`, `_choice`, and `HybridBrain`** as specified above.

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pw_agent/jev.py tests/test_jev.py
git commit -m "feat(jev): HybridBrain routes confident text-free steps to Jev"
```

---

### Task 5: CLI flags, preflight, `history.json`, README

**Files:**
- Modify: `pw_agent/__main__.py` (`_parse`, `_preflight`, `_history_json`, `main`)
- Modify: `README.md` (options table lines 76–82, a warning near it, roadmap line 187)
- Test: `tests/test_main.py`

**Interfaces:**
- Consumes: `HybridBrain`, `JevClient`, `JevAuthError` (Tasks 3–4); `StepRecord.cost`, `Decision.source`/`.jev` (Task 1).
- Produces:
  - Flags `--jev` (store_true) and `--jev-threshold FLOAT` (default `0.8`).
  - `_preflight(skill, state, jev: bool = False) -> str | None`
  - `history.json` gains:
    - per step: `"source"`, `"cost_usd"` (from `r.cost`), `"jev"` (`r.decision.jev`);
    - top level: `"jev_steps"` (records with `source == "jev"`) and `"claude_steps"` (all other records).

- [ ] **Step 1: Write the failing tests**

```python
def test_jev_requires_api_key(env, monkeypatch, capsys):
    tmp, argv = env
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert m.main(argv + ["--jev"]) == 2
    assert "TYPESAFE_API_KEY" in capsys.readouterr().err
    assert not (tmp / "runs").exists()

def test_jev_empty_api_key_exits_2(env, monkeypatch):      # setenv "" → 2
def test_jev_threshold_out_of_range(env, monkeypatch, capsys):
    # setenv key "k"; argv + ["--jev", "--jev-threshold", "1.5"] → 2, "--jev-threshold" in err
    # also "-0.1" → 2. Values 0 and 1 are allowed.

def test_jev_builds_hybrid_brain(env, monkeypatch):
    # setenv key "k"; Agent.run captures self.brain → isinstance HybridBrain,
    # brain.min_confidence == 0.7 with "--jev-threshold 0.7", brain.jev.api_key == "k",
    # isinstance(brain.claude, Brain)
def test_without_jev_brain_is_claude(env, monkeypatch):     # isinstance(brain, Brain), not HybridBrain

def test_jev_auth_error_exits_1_and_writes_history(env, monkeypatch, capsys):
    # Agent.run calls self.on_step(rec) once, then raises JevAuthError("401")
    # → rc 1; "jev error: invalid TYPESAFE_API_KEY" in err;
    # history answer == "jev error: invalid TYPESAFE_API_KEY"; len(history) == 1

def test_history_json_routing_fields():
    jev_rec = StepRecord(2, Decision("", "m", "g", [Action("click", ["e3"])], source="jev",
                         jev={"action": "click", "action_confidence": .9, "target": "e3",
                              "target_confidence": .9, "routed": "accepted"}), ["ok"], [None], cost=1e-6)
    cl_rec = StepRecord(1, Decision("e", "m", "g", [Action("goto", ["u"])]), ["ok"], [None], cost=0.5)
    data = m._history_json("t", True, "a", 2, 0.500001, [cl_rec, jev_rec])
    assert (data["jev_steps"], data["claude_steps"]) == (1, 1)
    s1, s2 = data["history"]
    assert (s1["source"], s1["cost_usd"], s1["jev"]) == ("claude", 0.5, None)
    assert (s2["source"], s2["cost_usd"], s2["jev"]["routed"]) == ("jev", 1e-6, "accepted")

def test_prints_jev_steps_only_with_jev(env, monkeypatch, capsys):
    # R.history = [cl_rec, jev_rec], steps 2; with --jev stdout has "Jev steps: 1/2" on the line after "Steps:";
    # without --jev "Jev steps" not in stdout
```

Also update `test_playwright_error_history_shape`'s expected dict. The step gains `"source": "claude", "cost_usd": 0.0, "jev": None`, and the top level gains `"jev_steps": 0, "claude_steps": 1`.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_main.py -q`
Expected: FAIL (unknown `--jev` argument, missing keys).

- [ ] **Step 3: Implement**

- `_preflight` with `jev=True`:
  - When `os.environ.get("TYPESAFE_API_KEY")` is falsy, return `"TYPESAFE_API_KEY not set (required by --jev)"`.
  - Check after the existing checks.
- In `main`, before preflight: if `not 0 <= args.jev_threshold <= 1`, print `--jev-threshold must be between 0 and 1` to stderr and return 2.
- With `--jev`, the brain is `HybridBrain(JevClient(key), Brain(...), args.jev_threshold)`.
- Catch `JevAuthError` before the generic `Exception`:
  - `write_failure("jev error: invalid TYPESAFE_API_KEY")`;
  - print the same text to stderr;
  - return 1.
- With `--jev`, print `Jev steps: {jev}/{result.steps}` right after the `Steps:` line.
- README:
  - Add rows to the options table: `--jev` (off) and `--jev-threshold` (`0.8`).
  - Add a `> [!WARNING]` block saying `--jev` sends the task, page snapshots and history to TypeSafe's API, including anything visible on authenticated pages, and needs `TYPESAFE_API_KEY`.
  - In the roadmap, change the Jev item to `- [x]`. Per the spec, the item is not described as ready until the benchmark passes (Task 6), so the README text says it is experimental.

- [ ] **Step 4: Run to verify pass**

Run: `python3 -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add pw_agent/__main__.py tests/test_main.py README.md
git commit -m "feat: --jev and --jev-threshold flags, routing fields in history.json"
```

---

### Task 6: Opt-in benchmark

**Files:**
- Create: `tests/fixtures/multipage.html`, `multipage-shop.html`, `multipage-hardware.html`, `multipage-keyboards.html`, `multipage-dead.html`
- Create: `tests/fixtures/settings.html`
- Create: `tests/bench/bench.py` (pure helpers), `tests/bench/test_bench.py` (live, skipped), `tests/bench/test_summary.py` (unit, runs in CI)

**Interfaces:**
- Consumes: `Agent`, `RunResult` (`pw_agent/loop.py`), `Brain`, `HybridBrain`, `JevClient`, `PlaywrightCLI`.
- Produces (in `tests/bench/bench.py`):
  - `@dataclass BenchRun(task: str, mode: str, success: bool, cost: float, seconds: float, steps: int, jev_steps: int)`; `mode` is `"claude"` or `"jev"`.
  - `summarize(runs: list[BenchRun]) -> dict`, shaped `{"<task>"|"total": {"<mode>": {"passes": int, "runs": int, "mean_cost": float, "mean_seconds": float, "jev_share": float}}}`. `jev_share` is the sum of `jev_steps` over the sum of `steps`, or 0 when there are no steps.
  - `meets_targets(summary: dict) -> tuple[bool, bool]`, which returns `(jev passes >= claude passes, jev mean_cost <= 0.5 * claude mean_cost)` from `summary["total"]`.

**Fixture content (fixed):**

| Page | Content |
| --- | --- |
| `multipage.html` | Links "Docs" and "Blog" go to `multipage-dead.html`; "Shop" goes to `multipage-shop.html` |
| `multipage-shop.html` | "Clothing" goes to dead; "Hardware" goes to `multipage-hardware.html` |
| `multipage-hardware.html` | "Mice" goes to dead; "Keyboards" goes to `multipage-keyboards.html` |
| `multipage-keyboards.html` | Shows `Product code: KX-4471` |
| `multipage-dead.html` | "Nothing here" |
| `settings.html` | Unchecked checkboxes "Email notifications", "Weekly digest", "SMS alerts", and a "Save" button. Save writes `Saved: ` plus the checked keys (`email`, `digest`, `sms`) joined by `, ` (or `Saved: nothing`) into a `<p id="status">` |

**Tasks (fixed):**

| Name | Task text (`{p}` = absolute fixture path) | Pass when the answer contains |
| --- | --- | --- |
| `multipage` | `Open file://{p}, go to Shop, then Hardware, then Keyboards, and report the product code shown.` | `KX-4471` |
| `settings` | `Open file://{p}, turn on Email notifications and Weekly digest, click Save, and report the confirmation text.` | `Saved: email, digest` |
| `form` | the existing `test_e2e_form` task | `Hello, Linh!` |

- [ ] **Step 1: Write the failing summary tests** (`tests/bench/test_summary.py`)

```python
def test_summarize_and_targets():
    runs = [BenchRun("a", "claude", True, 0.10, 5, 4, 0), BenchRun("a", "claude", False, 0.30, 7, 6, 0),
            BenchRun("a", "jev", True, 0.04, 4, 4, 3), BenchRun("a", "jev", True, 0.06, 6, 6, 3)]
    s = summarize(runs)
    assert s["a"]["claude"] == {"passes": 1, "runs": 2, "mean_cost": pytest.approx(0.2),
                                "mean_seconds": 6, "jev_share": 0.0}
    assert s["total"]["jev"]["jev_share"] == pytest.approx(0.6)
    assert meets_targets(s) == (True, True)

def test_targets_fail_on_cost():   # jev mean_cost 0.11 vs claude 0.2 → (True, False)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/bench/test_summary.py -q`
Expected: FAIL with `ModuleNotFoundError` for `tests.bench.bench`.

- [ ] **Step 3: Implement `bench.py`, the fixtures, and `test_bench.py`**

- `test_bench.py` is skipped unless `PW_AGENT_BENCH == "1"`, using the same `skipif` pattern as `tests/test_e2e.py`.
- Run each task 3 times per mode with `Agent(..., max_steps=12)` and `allow_file_access=True`, giving each run its own session name and `tmp_path` subdirectory.
- Time each run with `time.monotonic()`, and get `jev_steps` from `history` sources.
- Print a table per task and the total.
- Write `json.dumps(summary, indent=2)` to `runs/bench-<YYYYmmdd-HHMMSS>.json`.
- Finally, `assert meets_targets(summary) == (True, True)`.

- [ ] **Step 4: Verify**

Run: `python3 -m pytest -q`
Expected: all pass, and the benchmark is reported as skipped.

Run: `python3 -m pytest tests/bench/test_bench.py -q`
Expected: `1 skipped`.

- [ ] **Step 5: Commit**

```bash
git add tests/bench tests/fixtures
git commit -m "test: opt-in Jev vs Claude benchmark"
```

- [ ] **Step 6 (manual, needs a key and Claude): run the benchmark**

Run: `PW_AGENT_BENCH=1 TYPESAFE_API_KEY=... python3 -m pytest tests/bench -s`

Expected: both targets pass. If one fails:

1. Tune `--jev-threshold` and the `ACTION_OPTIONS` descriptions.
2. Re-run.
3. Only then drop "experimental" from the README.
