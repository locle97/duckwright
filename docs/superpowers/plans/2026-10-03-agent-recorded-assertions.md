# Agent-Recorded Assertions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `expect` action lets the agent check the page during a run. The harness verifies each check live and stores it in `history.json` as a Playwright `expect(...)` line, so nobody has to write assertions by hand from `answer`.

**Architecture:** `expect` joins the allowed commands. It is not passed through to `playwright-cli`, because the CLI has no assertion command. A new module, `duckwright/expect.py`, handles it in three steps. First it turns the ref into a stable locator with `playwright-cli generate-locator <ref> --raw`. Then it reads the element's current state with a fixed, harness-written `run-code` snippet. Finally it compares that state to the agent's expected value in Python. A passing check returns `ok` and records an `await expect(...)` line as the action's `code`. A failing check returns `error: ...` and records no code. The existing rule that refuses `done success` after an `error:` in the same step then makes the agent fix the problem before it can finish.

**Tech Stack:** Python ≥3.11 standard library; `playwright-cli` (`generate-locator`, `run-code`); pytest.

**Spec:** No separate spec file. The requirement is the README roadmap line: "**Agent-recorded assertions**: an `expect` action, so the checks the agent makes become `expect(...)` lines instead of being written by hand from `answer`."

## Facts (checked against `@playwright/cli@latest` on 2026-10-03; do not re-derive)

- `playwright-cli` has no assertion or verify command. `run-code` does not define `expect` (`ReferenceError: expect is not defined`), so the harness cannot run the real matcher. It reads the state with locator methods and compares the values itself.
- `playwright-cli -s=S generate-locator e2 --raw` prints only the locator plus a newline, e.g. `getByRole('heading', { name: 'Hello World' })`, `getByTestId('msg')`, `getByText('Saved!')`. `--raw` works after the command. When the element is not unique, the output already ends in `.first()`, e.g. `getByRole('button', { name: 'Go' }).first()`, so the locator never breaks strict mode.
- An unknown ref exits 1 with stdout `### Error\nError: Ref e99 not found in the current page snapshot. Try capturing new snapshot.`
- `run-code "<async page => ...>" --raw` prints the return value as JSON: `"a@b.c"`, `true`, `{"text":"Hello   World"}`, `null`. Errors exit 1 with `### Error\n...` on stdout.
- `textContent()` returns the raw text (`"Hello   World"` for `<h1>Hello   <b>World</b></h1>`). Playwright's `toHaveText(string)` normalizes whitespace before comparing, so the harness must too.

## Global Constraints

- Runtime stays standard-library only (`dependencies = []`).
- The agent never gets `generate-locator`, `run-code` or `eval` as commands. The harness calls them itself, through `PlaywrightCLI.run`.
- Text from the agent (expected values) is never put into a `run-code` snippet or any `playwright-cli` argv. Only the ref, after it passes `^[a-z0-9]+$`, reaches `generate-locator`.
- `expect` is not page-changing, so it may be batched before a page-changing action, and is skipped after one like any other action.
- Recorded code is one line per check, ending in `;`, with expected values written as `json.dumps(value, ensure_ascii=False)`.
- The allowed checks are exactly: `visible`, `text`, `value`, `checked`, `unchecked`, `url`.

## Review Focus

1. **A stale ref** (an `expect` after a page-changing action in the same step, or a ref from an older snapshot). Expected: the action is skipped, or it returns `error:` with the CLI message, and records no code. Pinned by Task 1 `test_generate_locator_error_is_reported` and Task 2 `test_expect_skipped_after_page_change`.
2. **Expected text with quotes, backslashes, newlines or a leading `--`**. Expected: no rejection as a flag, the text never reaches `playwright-cli`, and the recorded line is a valid JS string literal. Pinned by Task 1 `test_expected_text_never_reaches_cli` and Task 2 `test_expect_expected_value_may_look_like_flag`.
3. **Whitespace differences between the page text and the expected text**. Expected: they match the way `toHaveText` matches. Pinned by Task 1 `test_text_compares_normalized_whitespace`.
4. **A failed `expect` followed by `done success` in the same step**. Expected: the `done` is refused with `EARLIER_FAILED`, so a run cannot succeed on a failed check. Pinned by Task 2 `test_done_success_refused_after_failed_expect`.
5. **Unexpected `generate-locator` output** (a multi-line or non-locator string, e.g. from a future CLI change). Expected: an `error:` result, and no `run-code` call. Pinned by Task 1 `test_unusable_locator_is_rejected`.

---

### Task 1: `expect.py`, which validates and runs one check

**Files:**
- Create: `duckwright/expect.py`
- Test: `tests/test_expect.py`

**Interfaces:**
- Consumes: `PlaywrightCLI.run(cmd: str, args: list[str]) -> ProcResult` (`duckwright/pw.py`), `ProcResult(code, stdout, stderr)` (`duckwright/proc.py`).
- Produces:
  - `CHECKS: dict[str, tuple[str, ...]]`: each check name mapped to the names of its arguments, in this order: `"visible": ("ref",)`, `"text": ("ref", "expected")`, `"value": ("ref", "expected")`, `"checked": ("ref",)`, `"unchecked": ("ref",)`, `"url": ("expected",)`.
  - `check_args(args: list[str]) -> str | None`: static validation. Returns an `error: ...` string, or `None` when the args are well formed.
  - `run_expect(pw: PlaywrightCLI, args: list[str]) -> tuple[str, str | None]`: `("ok", code_line)` on pass, `("error: ...", None)` on failure. Assumes `check_args(args) is None`.

- [ ] **Step 1: Write the failing tests** in `tests/test_expect.py`

Use a fake runner that answers by command name (`argv[2]`) and records `argv[2:]`:

```python
def make_pw(responses):  # {"generate-locator": ProcResult, "run-code": ProcResult}
    calls = []
    def runner(argv, stdin, timeout):
        calls.append(argv[2:])
        return responses[argv[2]]
    return PlaywrightCLI(session="t", runner=runner), calls

LOC = ProcResult(0, "getByTestId('msg')\n", "")
def val(v): return ProcResult(0, json.dumps(v) + "\n", "")
```

Tests and their assertions:

- `test_check_args_accepts_each_check`: `None` for `["visible","e1"]`, `["text","e1","Hi"]`, `["value","e1",""]`, `["checked","e1"]`, `["unchecked","e1"]`, `["url","https://x/"]`.
- `test_check_args_unknown_check`: `check_args(["exists","e1"]) == "error: expect check 'exists' not allowed (allowed: visible, text, value, checked, unchecked, url)"`; `check_args([])` returns that same message with `''` in place of `'exists'`.
- `test_check_args_wrong_arity`: `check_args(["text","e1"]) == "error: usage: expect text <ref> <expected>"`; `check_args(["visible","e1","x"]) == "error: usage: expect visible <ref>"`; `check_args(["url"]) == "error: usage: expect url <expected>"`.
- `test_check_args_bad_ref`: `check_args(["visible","--session=x"]) == "error: expect ref must be a snapshot ref like e15, got \"--session=x\""` (the ref is written with `json.dumps`); the same applies for `"#id"` and `""`.
- `test_visible_pass_records_code`: with `run-code` returning `val(True)`, the result is `("ok", "await expect(page.getByTestId('msg')).toBeVisible();")`, and `calls == [["generate-locator","e7","--raw"], ["run-code","async page => await page.getByTestId('msg').isVisible()","--raw"]]`.
- `test_text_pass_records_code`: with `run-code` returning `val("Welcome, Linh")` and args `["text","e7","Welcome, Linh"]`, the result is `("ok", 'await expect(page.getByTestId(\'msg\')).toHaveText("Welcome, Linh");')`, and the `run-code` snippet ends with `.textContent()`.
- `test_text_compares_normalized_whitespace`: page `"  Hello \n  World "`, expected `"Hello World"` gives `ok`, and the recorded literal is `"Hello World"`. Expected `"Hello  World "` also passes and records `"Hello World"`.
- `test_text_mismatch_reports_actual`: page `"Hello, !"`, expected `"Hello, Linh!"` gives `('error: expect text failed: expected "Hello, Linh!", got "Hello, !"', None)`.
- `test_text_null_content_is_empty`: `run-code` returning `val(None)` with expected `""` gives `ok`.
- `test_value_pass_and_mismatch`: the snippet ends with `.inputValue()`, the code is `toHaveValue("a@b.c")`, and there is no whitespace normalization (page `"a "` vs expected `"a"` is an error).
- `test_checked_and_unchecked`: `checked` with `val(True)` gives code `...).toBeChecked();`; `unchecked` with `val(False)` gives code `...).not.toBeChecked();`; `checked` with `val(False)` gives `("error: expect checked failed: element is not checked", None)`; `unchecked` with `val(True)` gives `"error: expect unchecked failed: element is checked"`; `visible` with `val(False)` gives `"error: expect visible failed: element is not visible"`. Both checks call `.isChecked()`.
- `test_url_skips_locator`: args `["url","https://x/"]` with `run-code` returning `val("https://x/")` gives `("ok", 'await expect(page).toHaveURL("https://x/");')`, and `calls == [["run-code","async page => page.url()","--raw"]]`. A mismatch gives `error: expect url failed: expected "https://x/", got "https://x/a"`.
- `test_generate_locator_error_is_reported`: `generate-locator` returning `ProcResult(1, "### Error\nError: Ref e99 not found in the current page snapshot. Try capturing new snapshot.", "")` gives a result that starts with `"error: "` and contains `"Ref e99 not found"`, with code `None` and no `run-code` call. Prefer stderr and fall back to stdout, as `actions.execute` does. A timeout (`code == -1`) gives `"error: timeout"`.
- `test_run_code_error_is_reported`: `run-code` exiting 1 with `"### Error\nError: strict mode violation..."` gives an `error: ...` result containing `strict mode violation`, with code `None`.
- `test_unusable_locator_is_rejected`: `generate-locator` returning `"getByText('a')\nevil()"`, `"page.goto('x')"` or `""` each give `('error: expect: unusable locator "<json-escaped output>"', None)` with no `run-code` call.
- `test_non_json_run_code_output_is_error`: `run-code` returning `"oops"` gives `('error: expect: unreadable result "oops"', None)`.
- `test_expected_text_never_reaches_cli`: with expected `'It\'s "ok"\\\n--x'`, no element of any recorded call contains `It's`. The code ends with `toHaveText(` + `json.dumps(" ".join(expected.split()), ensure_ascii=False)` + `");"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m pytest tests/test_expect.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'duckwright.expect'`.

- [ ] **Step 3: Implement `duckwright/expect.py`**

- `_REF = re.compile(r"^[a-z0-9]+$")`. `_LOCATOR = re.compile(r"^(?:getBy[A-Za-z]+|locator)\([^\n]*\)$")` is checked against `stdout.strip()`.
- `_READ: dict[str, str]`: `visible → "isVisible()"`, `text → "textContent()"`, `value → "inputValue()"`, `checked`/`unchecked → "isChecked()"`. The snippet is exactly `f"async page => await page.{loc}.{_READ[check]}"`. For `url` it is the constant `"async page => page.url()"`.
- Matchers for the code line: `visible → "toBeVisible()"`, `text → f"toHaveText({lit})"`, `value → f"toHaveValue({lit})"`, `checked → "toBeChecked()"`, `unchecked → "not.toBeChecked()"`, `url → f"toHaveURL({lit})"`, with `lit = json.dumps(expected, ensure_ascii=False)`. The subject is `page.{loc}`, or `page` for `url`. Line: `f"await expect({subject}).{matcher};"`.
- Normalize `text` on both sides with `" ".join(s.split())`, and treat `None` as `""`. Compare `value` and `url` exactly. `visible`, `checked` and `unchecked` compare the JSON boolean.
- Write the CLI error helper with the same stderr-first fallback as `actions.execute`. Leave truncation to the caller.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_expect.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add duckwright/expect.py tests/test_expect.py
git commit -m "feat: expect checks verified live and rendered as Playwright assertions"
```

---

### Task 2: Wire `expect` into the allow-list, schema and executor

**Files:**
- Modify: `duckwright/brain.py:7-11` (`ALLOWED_COMMANDS`)
- Modify: `duckwright/actions.py` (`_rejection`, `execute`)
- Test: `tests/test_actions.py`, `tests/test_brain.py`

**Interfaces:**
- Consumes: `check_args`, `run_expect` from Task 1.
- Produces: `"expect"` in `ALLOWED_COMMANDS` (placed before `"done"`) and therefore in `ALLOWED`, `ALLOWED_LIST` and the schema's non-`done` `cmd` enum. `execute(...)` puts the `run_expect` code line into `codes` for a passing `expect`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_actions.py`, add a dispatching fake like the one in Task 1, local to these tests:

- `test_expect_pass_records_assertion_code`: `execute(pw, [Action("expect", ["visible","e7"])], codes=codes)` gives `results == ["ok"]` and `codes == ["await expect(page.getByTestId('msg')).toBeVisible();"]`.
- `test_expect_failure_records_no_code`: with `run-code` returning `false`, the result is `["error: expect visible failed: element is not visible"]` and `codes == [None]`.
- `test_expect_bad_args_rejected_statically`: `Action("expect", ["text","e1"])` gives `["error: usage: expect text <ref> <expected>"]`, and the runner was never called. The same applies after a `goto` in the same step: the rejection is reported, not `skipped`, matching `test_bad_flag_after_page_change_reports_rejection`.
- `test_expect_expected_value_may_look_like_flag`: `Action("expect", ["text","e7","--submit me"])` is not rejected as a flag. It reaches `run-code` and passes when the page text is `"--submit me"`.
- `test_expect_skipped_after_page_change`: `[Action("click",["e5"]), Action("expect",["visible","e7"])]` gives `["ok", "skipped: page may have changed"]`.
- `test_expect_does_not_skip_following_actions`: `[Action("expect",["visible","e7"]), Action("fill",["e4","x"])]` runs both.
- `test_done_success_refused_after_failed_expect`: `[Action("expect",["visible","e7"]) (fails), Action("done",["success","x"])]` gives `results[1] == EARLIER_FAILED` and `done is None`.
- `test_expect_error_truncated`: a 1000-char CLI error is cut to `len("error: ") + MAX_ERROR_CHARS`.

In `tests/test_brain.py`, `test_schema_restricts_cmd_to_allowed` already covers the enum. Add to `test_schema_done_requires_status_and_answer`: `assert ok({"cmd": "expect", "args": ["visible", "e1"]})`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m pytest tests/test_actions.py tests/test_brain.py -q`
Expected: the new tests fail with `command 'expect' not allowed`.

- [ ] **Step 3: Implement**

- `brain.py`: insert `"expect"` before `"done"` in `ALLOWED_COMMANDS`.
- `actions.py` `_rejection`: after the allow-list check, `if a.cmd == "expect": return check_args(a.args)`. This means `expect` bypasses `_bad_flag`, which is safe because its args never reach the CLI as-is.
- `actions.py` `execute`: after the `done` branch, `if a.cmd == "expect":` call `run_expect`, append the result truncated like other errors, set `ran[i]` when the code is not `None`, and `continue`. It never sets `skip`.

- [ ] **Step 4: Run the full suite**

Run: `python3 -m pytest -q`
Expected: all pass (the e2e test is skipped).

- [ ] **Step 5: Commit**

```bash
git add duckwright/brain.py duckwright/actions.py tests/test_actions.py tests/test_brain.py
git commit -m "feat: allow the expect action and record its assertion code"
```

---

### Task 3: Teach the agent to use `expect`, and document it

**Files:**
- Modify: `duckwright/prompts/system.md`
- Modify: `README.md` (Features, Output, "Turning a run into a regression test", How it works step 3, Roadmap)
- Test: `tests/test_main.py`, `tests/test_e2e.py`

**Interfaces:**
- Consumes: the `expect` arg shapes from Task 1 `CHECKS`.
- Produces: no code interfaces.

- [ ] **Step 1: Write the failing tests**

- `tests/test_main.py::test_system_prompt_documents_expect`: `m.SYSTEM_MD.read_text()` contains `"expect"` in the allowed-commands sentence, and contains each of `'{"cmd": "expect", "args": ["text", "e15", '`, `"visible"`, `"value"`, `"checked"`, `"unchecked"` and `"url"`.
- `tests/test_e2e.py::test_e2e_form`: add `assert any(c.startswith("await expect(") and "Hello, Linh!" in c for c in codes)`.

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `python3 -m pytest tests/test_main.py -q -k expect`
Expected: FAIL.

- [ ] **Step 3: Edit `system.md`**

- Add `expect` to the list in "## Commands".
- Add a new section "## Checking the outcome" before "## Finishing" that covers:
  - Before `done success`, verify the outcome the task asked for with one or more `expect` actions on the elements that show it, either in an earlier step or in the same step before `done`. These checks become the assertions of a regression test.
  - The arg shapes, one example each: `["visible", "<ref>"]`, `["text", "<ref>", "<exact text>"]`, `["value", "<ref>", "<input value>"]`, `["checked", "<ref>"]`, `["unchecked", "<ref>"]`, `["url", "<exact url>"]`.
  - Point at the element that holds the text itself, not a container. If an `expect` fails, read the reported actual value and fix the step. Never call `done success` in a step where an action failed.
- Leave the "Reading the page" guidance in place (no command is needed to read), and add that `expect` is for recording checks, not for reading.

- [ ] **Step 4: Edit `README.md`**

- Features: add a bullet saying the agent's `expect` checks are verified live and recorded as `expect(...)` lines.
- How it works step 3: add `expect` to the list of allowed commands.
- Output: for `expect` actions, `code` is the assertion line rather than code the CLI ran.
- Regression test section: step 1 now yields both actions and assertions. Show an example that ends with `await expect(page.getByText('Hello, Linh!')).toHaveText("Hello, Linh!");`, plus a note to `import { test, expect } from '@playwright/test'`. Step 2 becomes "add any further assertions the agent did not record".
- Roadmap: tick **Agent-recorded assertions**.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python3 -m pytest -q`
Expected: all pass. If `claude` and `playwright-cli` are available, also run `DUCKWRIGHT_E2E=1 python3 -m pytest tests/test_e2e.py -v -s`, which should pass with an `expect` step in the printed history.

- [ ] **Step 6: Commit**

```bash
git add duckwright/prompts/system.md README.md tests/test_main.py tests/test_e2e.py
git commit -m "docs: teach the agent the expect action and document recorded assertions"
```
