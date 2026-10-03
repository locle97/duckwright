from duckwright.actions import ALLOWED_LIST, execute, extract_code
from duckwright.brain import Action
from duckwright.proc import ProcResult
from duckwright.pw import PlaywrightCLI


def make_pw(code=0, stderr="", stdout=""):
    calls = []

    def runner(argv, stdin, timeout):
        calls.append(argv[2:])
        return ProcResult(code, stdout, stderr)

    return PlaywrightCLI(session="t", runner=runner), calls


def test_rejects_unknown_cmd():
    pw, calls = make_pw()
    results, done = execute(pw, [Action("eval", ["1"])])
    assert results == [f"error: command 'eval' not allowed (allowed: {ALLOWED_LIST})"]
    assert done is None
    assert calls == []


def test_rejects_prefixed_cmd():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("playwright-cli", ["eval", "1"])])
    assert results == [
        f"error: command 'playwright-cli' not allowed (allowed: {ALLOWED_LIST})"
    ]
    assert calls == []


def test_disallowed_cmd_after_page_change_reports_rejection():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("goto", ["x"]), Action("eval", ["1"])])
    assert results == [
        "ok",
        f"error: command 'eval' not allowed (allowed: {ALLOWED_LIST})",
    ]
    assert calls == [["goto", "x"]]


def test_bad_flag_after_page_change_reports_rejection():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("goto", ["x"]), Action("fill", ["e1", "a", "-s=o"])])
    assert results == ["ok", "error: flag '-s=o' not allowed"]
    assert calls == [["goto", "x"]]


def test_skips_after_page_change():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("click", ["e5"]), Action("fill", ["e9", "hi"])])
    assert results == ["ok", "skipped: page may have changed"]
    assert calls == [["click", "e5"]]


def test_no_skip_after_failed_page_change():
    pw, calls = make_pw(code=1, stderr="nope")
    results, _ = execute(pw, [Action("click", ["e5"]), Action("fill", ["e9", "hi"])])
    assert results == ["error: nope", "error: nope"]
    assert len(calls) == 2


def test_done_returns_answer():
    pw, calls = make_pw()
    results, done = execute(pw, [Action("done", ["success", "42"]), Action("click", ["e1"])])
    assert results == ["done", "skipped: done"]
    assert done == (True, "42")
    assert calls == []


def test_done_invalid_status_continues():
    pw, _ = make_pw()
    results, done = execute(pw, [Action("done", ["maybe", "x"]), Action("hover", ["e1"])])
    assert results == [
        'error: done needs ["success"|"failure", "<answer>"], got ["maybe", "x"]',
        "ok",
    ]
    assert done is None


def test_done_failure_without_answer():
    pw, _ = make_pw()
    _, done = execute(pw, [Action("done", ["failure"])])
    assert done == (False, "")


def test_skip_applies_to_done():
    pw, _ = make_pw()
    results, done = execute(pw, [Action("goto", ["x"]), Action("done", ["success", "a"])])
    assert results == ["ok", "skipped: page may have changed"]
    assert done is None


def test_failed_command_reports_stderr():
    pw, _ = make_pw(code=1, stderr="ref e9 not found\n")
    results, _ = execute(pw, [Action("fill", ["e9", "x"])])
    assert results == ["error: ref e9 not found"]


def test_failed_command_falls_back_to_stdout_and_truncates():
    pw, _ = make_pw(code=1, stdout="x" * 500)
    results, _ = execute(pw, [Action("fill", ["e9", "x"])])
    assert len(results[0]) == len("error: ") + 300


def test_success_hides_stdout():
    pw, _ = make_pw(stdout="huge")
    results, _ = execute(pw, [Action("hover", ["e1"])])
    assert results == ["ok"]


def test_rejects_filename_flag():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("screenshot", ["--filename=/x"])])
    assert results == ["error: flag '--filename=/x' not allowed"]
    assert calls == []


def test_rejects_session_hop_flag():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("click", ["e1", "-s=other"])])
    assert results == ["error: flag '-s=other' not allowed"]
    assert calls == []


def test_negative_number_and_dash_values_allowed():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("fill", ["e1", "-5"]), Action("type", ["-"])])
    assert results == ["ok", "ok"]
    assert calls == [["fill", "e1", "-5"], ["type", "-"]]


def test_per_command_flag_allow_set():
    pw, calls = make_pw()
    results, _ = execute(
        pw,
        [Action("fill", ["e1", "x", "--submit"]), Action("screenshot", ["--full-page"]),
         Action("fill", ["e1", "--full-page"])],
    )
    assert results == ["ok", "ok", "error: flag '--full-page' not allowed"]
    assert calls == [["fill", "e1", "x", "--submit"], ["screenshot", "--full-page"]]


def test_flag_flagged_on_unlisted_command():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("goto", ["--browser=firefox"])])
    assert results == ["error: flag '--browser=firefox' not allowed"]
    assert calls == []


def test_skips_after_page_change_timeout():
    pw, calls = make_pw(code=-1, stderr="timeout")
    results, _ = execute(pw, [Action("click", ["e5"]), Action("fill", ["e9", "hi"])])
    assert results == ["error: timeout", "skipped: page may have changed"]
    assert calls == [["click", "e5"]]


def test_done_success_rejected_after_earlier_error():
    pw, calls = make_pw(code=1, stderr="ref e9 not found")
    results, done = execute(
        pw, [Action("fill", ["e9", "x"]), Action("done", ["success", "yay"])]
    )
    assert results == [
        "error: ref e9 not found",
        "error: an earlier action failed; verify before finishing",
    ]
    assert done is None


def test_done_success_rejected_after_rejected_command():
    pw, _ = make_pw()
    results, done = execute(pw, [Action("eval", ["1"]), Action("done", ["success", "yay"])])
    assert results[1] == "error: an earlier action failed; verify before finishing"
    assert done is None


def test_done_failure_allowed_after_earlier_error():
    pw, _ = make_pw(code=1, stderr="nope")
    results, done = execute(pw, [Action("fill", ["e9", "x"]), Action("done", ["failure", "gave up"])])
    assert results == ["error: nope", "done"]
    assert done == (False, "gave up")


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


def test_extract_code_empty_block_is_none():
    out = (
        "### Ran Playwright code\n```js\n```\n"
        "### Snapshot\n```yaml\n- button\n```\n"
    )
    assert extract_code(out) is None
