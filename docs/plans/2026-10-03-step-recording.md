# Playwright Code Capture for Test Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent run records, for each action, the Playwright code `playwright-cli` ran for it, so a later "generator" agent can turn `history.json` into a Node.js `@playwright/test` regression test.

**Architecture:** `playwright-cli` prints a `### Ran Playwright code` block for every successful action (e.g. `await page.getByRole('textbox', { name: 'Name' }).fill('hello');`), but `execute()` currently discards stdout. We:
1. extract that block in `execute()` into an opt-in `codes` list, index-aligned with the actions;
2. store it on `StepRecord.codes`;
3. write it to `history.json` as a per-action `code` key.

The prompt sent to the model does not change. Snapshot handling (`runs/<id>/snapshot.yml`) does not change.

**Tech Stack:** Python ≥3.11 standard library only, pytest; `@playwright/cli` (global npm).

**Spec:** No separate spec file. Requirement from the user: write a reusable Playwright script for regression testing by recording each step so a generator agent can build a Node.js Playwright test later. The user scoped this plan to **code capture only** (no per-step snapshot files, no URL/title recording).

## Facts (probed against the installed playwright-cli; do not re-derive)

A successful action prints the code it ran. Single line (`fill`, `goto`, `click`):

````
### Ran Playwright code
```js
await page.getByRole('textbox', { name: 'Name' }).fill('hello');
```
````

Multi-line with a comment, followed by other blocks (`press`):

````
### Ran Playwright code
```js
// Press Enter
await page.keyboard.press('Enter');
```
### Page
- Page URL: https://example.com/
````

`screenshot` prints a `### Result` block *before* the code block, and its code spans several lines:

````
### Result
- [Screenshot of viewport](.playwright-cli/page-1.png)
### Ran Playwright code
```js
// Screenshot viewport and save it as .playwright-cli/page-1.png
await page.screenshot({
  path: '.playwright-cli/page-1.png',
  scale: 'css',
  type: 'png'
});
```
````

## Design decisions (do not change)

- **`code` is `null`** for an action that was rejected, skipped, failed, timed out, is `done`, or whose stdout had no code block. Only a successful (`code == 0`) run contributes code.
- **`execute()` keeps its `(results, done)` return type.** Code capture is opt-in through a `codes` list argument, so the 24 existing call sites stay as they are. When passed, `codes` gets exactly `len(actions)` entries.
- **`history.json` changes are additive**: existing keys keep their names, order and meaning. The only new key is `code` on each action object.

## Global Constraints

- Python `>=3.11`, standard library only at runtime (`dependencies = []` in `pyproject.toml` stays empty).
- The prompt sent to `claude -p` (`build_prompt` output) must be byte-for-byte unchanged; `tests/test_prompt.py` must pass untouched.
- Every existing test must keep passing; existing tests may only be edited where this plan says so.
- Run tests with `python3 -m pytest` from the repo root.

## Review Focus

1. **Action that is rejected or skipped after a page change** → its `code` is `None`, never a stale code from a previous action, and `codes` stays index-aligned with `actions`. Pinned in Task 1 (`test_codes_none_for_rejected_skipped_failed_and_done`).
2. **Failed action whose stdout still contains a code block** → `None`; a test must not replay an action that didn't succeed. Pinned in Task 1 (`test_codes_none_for_failed_action`).
3. **Code block that is not first in stdout, or spans several lines** (`screenshot`, `press`) → the full block is captured and nothing after the closing fence leaks in. Pinned in Task 1 (`test_extract_code_after_result_block`, `test_extract_code_multi_line_stops_at_closing_fence`).
4. **A brain-failure step** → has an empty `codes` list and does not crash `history.json` writing. Pinned in Task 2 (`test_brain_error_step_has_no_codes`) and Task 3 (`test_history_json_defaults_for_records_without_codes`).
5. **A run that dies mid-way (Ctrl-C, playwright error)** → `history.json` written by the failure path still contains `code` for every step completed so far. Pinned in Task 3 (`test_playwright_error_history_shape`, updated).

---

## File map

| File | Change |
| --- | --- |
| `pw_agent/actions.py` | `extract_code()`; `execute(..., codes=None)` |
| `pw_agent/prompt.py` | `StepRecord` gains `codes` |
| `pw_agent/loop.py` | Passes a `codes` list to `execute` and stores it on the record |
| `pw_agent/__main__.py` | `_history_json` writes `code` per action |
| `README.md` | Output section; new "Turning a run into a Playwright test" section |
| `tests/test_actions.py`, `tests/test_loop.py`, `tests/test_main.py`, `tests/test_e2e.py` | Tests as given per task |

---

### Task 1: Capture the Playwright code each action ran

**Files:**
- Modify: `pw_agent/actions.py`
- Test: `tests/test_actions.py`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `pw_agent.actions.extract_code(stdout: str) -> str | None` — body of the first fenced block that follows a `### Ran Playwright code` line, without the fences; `None` if absent.
  - `pw_agent.actions.execute(pw: PlaywrightCLI, actions: list[Action], codes: list[str | None] | None = None) -> tuple[list[str], tuple[bool, str] | None]` — unchanged return; when `codes` is passed it is extended with exactly `len(actions)` entries, index-aligned with `actions`.

- [ ] **Step 1: Write the failing tests**

Change the first import line of `tests/test_actions.py` to `from pw_agent.actions import ALLOWED_LIST, execute, extract_code`, then append:

````python
FILL_OUT = (
    "### Ran Playwright code\n"
    "```js\n"
    "await page.getByRole('textbox', { name: 'Name' }).fill('hello');\n"
    "```\n"
)
FILL_CODE = "await page.getByRole('textbox', { name: 'Name' }).fill('hello');"
PRESS_OUT = (
    "### Ran Playwright code\n"
    "```js\n"
    "// Press Enter\n"
    "await page.keyboard.press('Enter');\n"
    "```\n"
    "### Page\n"
    "- Page URL: https://e.com/\n"
)
SCREENSHOT_OUT = (
    "### Result\n"
    "- [Screenshot of viewport](.playwright-cli/p.png)\n"
    "### Ran Playwright code\n"
    "```js\n"
    "await page.screenshot({\n"
    "  path: '.playwright-cli/p.png',\n"
    "  type: 'png'\n"
    "});\n"
    "```\n"
)


def test_extract_code_single_line():
    assert extract_code(FILL_OUT) == FILL_CODE


def test_extract_code_multi_line_stops_at_closing_fence():
    assert extract_code(PRESS_OUT) == "// Press Enter\nawait page.keyboard.press('Enter');"


def test_extract_code_after_result_block():
    assert extract_code(SCREENSHOT_OUT) == (
        "await page.screenshot({\n  path: '.playwright-cli/p.png',\n  type: 'png'\n});"
    )


def test_extract_code_absent():
    assert extract_code("### Result\n- 0: (current) [x](y)\n") is None
    assert extract_code("") is None


def test_codes_collected_per_action():
    pw, _ = make_pw(stdout=FILL_OUT)
    codes = []
    results, _ = execute(pw, [Action("fill", ["e1", "a"]), Action("hover", ["e2"])], codes=codes)
    assert results == ["ok", "ok"]
    assert codes == [FILL_CODE, FILL_CODE]


def test_codes_none_for_rejected_skipped_failed_and_done():
    pw, _ = make_pw(stdout=FILL_OUT)
    codes = []
    execute(
        pw,
        [Action("eval", ["1"]), Action("click", ["e1"]), Action("fill", ["e2", "x"])],
        codes=codes,
    )
    assert codes == [None, FILL_CODE, None]

    codes = []
    execute(pw, [Action("hover", ["e1"]), Action("done", ["failure", "x"])], codes=codes)
    assert codes == [FILL_CODE, None]


def test_codes_none_for_failed_action():
    pw, _ = make_pw(code=1, stdout=FILL_OUT)
    codes = []
    execute(pw, [Action("fill", ["e1", "a"])], codes=codes)
    assert codes == [None]


def test_codes_none_when_stdout_has_no_code():
    pw, _ = make_pw(stdout="### Result\n- done\n")
    codes = []
    execute(pw, [Action("hover", ["e1"])], codes=codes)
    assert codes == [None]
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_actions.py -q`
Expected: FAIL — `ImportError: cannot import name 'extract_code'`.

- [ ] **Step 3: Implement**

In `pw_agent/actions.py`, add below `_FLAG = ...`:

```python
# playwright-cli prints the code it ran as "### Ran Playwright code" + a fenced block.
_RAN_CODE = re.compile(
    r"^### Ran Playwright code\n```\w*\n(.*?)\n```", re.MULTILINE | re.DOTALL
)
```

add above `def execute`:

```python
def extract_code(stdout: str) -> str | None:
    m = _RAN_CODE.search(stdout)
    return m.group(1) if m else None
```

and replace `execute` with (only the signature, docstring, `ran` dict, `for` header, success branch and tail differ from today):

```python
def execute(
    pw: PlaywrightCLI, actions: list[Action], codes: list[str | None] | None = None
) -> tuple[list[str], tuple[bool, str] | None]:
    """Run allowed actions. If `codes` is given, it is extended with one entry per
    action: the Playwright code playwright-cli ran for it, or None if none ran."""
    results: list[str] = []
    done: tuple[bool, str] | None = None
    skip: str | None = None
    ran: dict[int, str] = {}
    for i, a in enumerate(actions):
        rejected = _rejection(a)
        if rejected is not None:
            results.append(rejected)
            continue
        if skip:
            results.append(skip)
            continue
        if a.cmd == "done":
            if not a.args or a.args[0] not in ("success", "failure"):
                got = ", ".join(json.dumps(x, ensure_ascii=False) for x in a.args)
                results.append(
                    f'error: done needs ["success"|"failure", "<answer>"], got [{got}]'
                )
                continue
            success = a.args[0] == "success"
            if success and any(r.startswith("error:") for r in results):
                results.append(EARLIER_FAILED)
                continue
            done = (success, a.args[1] if len(a.args) > 1 else "")
            results.append("done")
            skip = "skipped: done"
            continue
        res = pw.run(a.cmd, a.args)
        if res.code == 0:
            results.append("ok")
            code = extract_code(res.stdout)
            if code is not None:
                ran[i] = code
        else:
            msg = res.stderr.strip() or res.stdout.strip()
            results.append(f"error: {msg}"[: len("error: ") + MAX_ERROR_CHARS])
        # A timeout (-1) may still have navigated, so treat it like success here.
        if a.cmd in PAGE_CHANGING and res.code in (0, -1):
            skip = "skipped: page may have changed"
    if codes is not None:
        codes.extend(ran.get(i) for i in range(len(actions)))
    return results, done
```

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest -q`
Expected: all pass (the live e2e test stays skipped).

- [ ] **Step 5: Commit**

```bash
git add pw_agent/actions.py tests/test_actions.py
git commit -m "feat: capture the Playwright code playwright-cli ran for each action"
```

---

### Task 2: Store the captured code on each step

**Files:**
- Modify: `pw_agent/prompt.py` (`StepRecord` only)
- Modify: `pw_agent/loop.py`
- Test: `tests/test_loop.py`

**Interfaces:**
- Consumes: `execute(pw, actions, codes=list)` (Task 1).
- Produces: `pw_agent.prompt.StepRecord.codes: list[str | None] = field(default_factory=list)` — appended after `results` with a default so every existing constructor still works; index-aligned with `decision.actions`; empty for a brain-error step.

- [ ] **Step 1: Write the failing tests**

In `tests/test_loop.py`, give `FakePW` a configurable `run` stdout. Change its `__init__` and `run` to:

```python
    def __init__(self, open_code=0, snap_error=False, run_stdout="tabs"):
        self.calls = []
        self.closed = 0
        self.open_code = open_code
        self.snap_error = snap_error
        self.run_stdout = run_stdout

    def run(self, cmd, args):
        self.calls.append((cmd, list(args)))
        return ProcResult(0, self.run_stdout, "")
```

Then append:

````python
GOTO_OUT = "### Ran Playwright code\n```js\nawait page.goto('u');\n```\n"


def test_step_records_generated_code(tmp_path):
    pw = FakePW(run_stdout=GOTO_OUT)
    brain = FakeBrain([dec(("goto", ["u"])), dec(("done", ["success", "ok"]))])
    r = Agent("t", pw, brain, tmp_path).run()
    assert r.history[0].codes == ["await page.goto('u');"]
    assert r.history[1].codes == [None]


def test_brain_error_step_has_no_codes(tmp_path):
    pw = FakePW(run_stdout=GOTO_OUT)
    brain = FakeBrain([BrainError("x"), dec(("done", ["success", "ok"]))])
    r = Agent("t", pw, brain, tmp_path).run()
    assert r.history[0].codes == []
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_loop.py -q`
Expected: FAIL — `AttributeError: 'StepRecord' object has no attribute 'codes'`.

- [ ] **Step 3: Implement**

`pw_agent/prompt.py` — change `from dataclasses import dataclass` to `from dataclasses import dataclass, field` and extend `StepRecord` (leave `line()` exactly as is, so the prompt is unchanged):

```python
@dataclass
class StepRecord:
    step: int
    decision: Decision
    results: list[str]
    # Playwright code playwright-cli ran per action (None where nothing ran), for replay.
    codes: list[str | None] = field(default_factory=list)
```

`pw_agent/loop.py` — in `_loop`, replace these two lines:

```python
            results, done = execute(self.pw, decision.actions)
            self._record(history, StepRecord(step, decision, results))
```

with:

```python
            codes: list[str | None] = []
            results, done = execute(self.pw, decision.actions, codes=codes)
            self._record(history, StepRecord(step, decision, results, codes))
```

The brain-error `StepRecord(...)` call stays as is; it gets the empty default.

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest -q`
Expected: all pass, including `tests/test_prompt.py` unchanged.

- [ ] **Step 5: Commit**

```bash
git add pw_agent/prompt.py pw_agent/loop.py tests/test_loop.py
git commit -m "feat: record generated Playwright code on each step"
```

---

### Task 3: Write the code to history.json and document it

**Files:**
- Modify: `pw_agent/__main__.py` (`_history_json` only)
- Modify: `README.md`
- Test: `tests/test_main.py`, `tests/test_e2e.py`

**Interfaces:**
- Consumes: `StepRecord.codes` (Task 2).
- Produces: in `history.json`, each action object becomes `{"cmd", "args", "code"}`; `code` is a string or `null`. This is the contract the generator agent reads.

- [ ] **Step 1: Write the failing tests**

In `tests/test_main.py`, replace `test_playwright_error_history_shape` with:

```python
def test_playwright_error_history_shape(env, monkeypatch):
    tmp, argv = env
    rec = StepRecord(
        1,
        Decision("ev", "mem", "goal", [Action("click", ["e1"])]),
        ["ok"],
        ["await page.getByRole('button', { name: 'Go' }).click();"],
    )

    def fail(self):
        self.on_step(rec)
        raise PlaywrightError("snapshot died")

    monkeypatch.setattr(Agent, "run", fail)
    assert m.main(argv) == 1
    data = _history(tmp)
    assert data == {
        "task": "task",
        "success": False,
        "answer": "playwright error: snapshot died",
        "steps": 1,
        "cost_usd": 0.0,
        "history": [
            {
                "step": 1,
                "evaluation_previous_goal": "ev",
                "memory": "mem",
                "next_goal": "goal",
                "actions": [
                    {
                        "cmd": "click",
                        "args": ["e1"],
                        "code": "await page.getByRole('button', { name: 'Go' }).click();",
                    }
                ],
                "results": ["ok"],
            }
        ],
    }
```

and add:

```python
def test_history_json_defaults_for_records_without_codes():
    rec = StepRecord(1, Decision("", "", "", [Action("click", ["e1"])]), ["brain error: x"])
    step = m._history_json("t", False, "a", 1, 0.0, [rec])["history"][0]
    assert step["actions"] == [{"cmd": "click", "args": ["e1"], "code": None}]
```

In `tests/test_e2e.py`, append to the end of `test_e2e_form` (after the existing asserts):

```python
    codes = [c for rec in result.history for c in rec.codes if c]
    assert any("page.goto(" in c for c in codes)
    assert any("Linh" in c for c in codes)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_main.py -q`
Expected: FAIL — both tests miss the `code` key.

- [ ] **Step 3: Implement `_history_json`**

In `pw_agent/__main__.py`, inside `_history_json`, replace the `"actions": [...]` line with:

```python
                "actions": [
                    {
                        "cmd": a.cmd,
                        "args": list(a.args),
                        "code": r.codes[i] if i < len(r.codes) else None,
                    }
                    for i, a in enumerate(r.decision.actions)
                ],
```

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Update README.md**

In `README.md`, under `### Output`, replace the `history.json` bullet with:

```markdown
- `history.json`: the task, the outcome, the total cost, and every step's decision and results. Each action also records the Playwright `code` that `playwright-cli` ran for it (`null` when the action was rejected, skipped, failed, or was `done`).

> [!CAUTION]
> `code` contains whatever the agent typed, passwords included. Treat `history.json` like `auth.json`.
```

Then add this section directly after the `### Exit codes` table (before `## How it works`):

````markdown
### Turning a run into a Playwright test

`history.json` holds the code for a Node.js `@playwright/test` regression test, so you don't have to drive the agent again:

1. Read `history.json` in step order and collect every action's `code`, skipping `null`.
2. Put the code together in that order. It already uses semantic locators, for example:
   ```js
   await page.goto('https://example.com/form');
   await page.getByRole('textbox', { name: 'Name' }).fill('Linh');
   await page.getByRole('button', { name: 'Submit' }).click();
   ```
3. Add assertions for the outcome the run reported in `answer`, for example `await expect(page.getByRole('heading')).toHaveText('Hello, Linh!')`.
4. Run the test with `npx playwright test` and fix any locator that fails. [`.claude/skills/playwright-cli/references/test-generation.md`](.claude/skills/playwright-cli/references/test-generation.md) covers that workflow.
````

- [ ] **Step 6: Live e2e check (costs a few cents; needs `claude` and `playwright-cli`)**

Run: `PW_AGENT_E2E=1 python3 -m pytest tests/test_e2e.py -v -s`
Expected: PASS. If the environment has no `claude` login, report that the live check was skipped rather than claiming it passed.

- [ ] **Step 7: Commit**

```bash
git add pw_agent/__main__.py tests/test_main.py tests/test_e2e.py README.md
git commit -m "feat: write captured Playwright code to history.json"
```
