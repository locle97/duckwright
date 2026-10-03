import json

import pytest

from duckwright.expect import check_args, run_expect
from duckwright.proc import ProcResult
from duckwright.pw import PlaywrightCLI

LOC = ProcResult(0, "getByTestId('msg')\n", "")
ALLOWED_MSG = "(allowed: visible, text, value, checked, unchecked, url)"


def val(v):
    return ProcResult(0, json.dumps(v) + "\n", "")


def make_pw(responses):
    calls = []

    def runner(argv, stdin, timeout):
        calls.append(argv[2:])
        return responses[argv[2]]

    return PlaywrightCLI(session="t", runner=runner), calls


@pytest.mark.parametrize(
    "args",
    [
        ["visible", "e1"],
        ["text", "e1", "Hi"],
        ["value", "e1", ""],
        ["checked", "e1"],
        ["unchecked", "e1"],
        ["url", "https://x/"],
    ],
)
def test_check_args_accepts_each_check(args):
    assert check_args(args) is None


def test_check_args_unknown_check():
    assert check_args(["exists", "e1"]) == f"error: expect check 'exists' not allowed {ALLOWED_MSG}"
    assert check_args([]) == f"error: expect check '' not allowed {ALLOWED_MSG}"


def test_check_args_wrong_arity():
    assert check_args(["text", "e1"]) == "error: usage: expect text <ref> <expected>"
    assert check_args(["visible", "e1", "x"]) == "error: usage: expect visible <ref>"
    assert check_args(["url"]) == "error: usage: expect url <expected>"


@pytest.mark.parametrize("ref", ["--session=x", "#id", ""])
def test_check_args_bad_ref(ref):
    assert check_args(["visible", ref]) == (
        f"error: expect ref must be a snapshot ref like e15, got {json.dumps(ref)}"
    )


def test_visible_pass_records_code():
    pw, calls = make_pw({"generate-locator": LOC, "run-code": val(True)})
    assert run_expect(pw, ["visible", "e7"]) == (
        "ok",
        "await expect(page.getByTestId('msg')).toBeVisible();",
    )
    assert calls == [
        ["generate-locator", "e7", "--raw"],
        ["run-code", "async page => await page.getByTestId('msg').isVisible()", "--raw"],
    ]


def test_text_pass_records_code():
    pw, calls = make_pw({"generate-locator": LOC, "run-code": val("Welcome, Linh")})
    assert run_expect(pw, ["text", "e7", "Welcome, Linh"]) == (
        "ok",
        "await expect(page.getByTestId('msg')).toHaveText(\"Welcome, Linh\");",
    )
    assert calls[1][1].endswith(".textContent()")


def test_text_compares_normalized_whitespace():
    pw, _ = make_pw({"generate-locator": LOC, "run-code": val("  Hello \n  World ")})
    for expected in ("Hello World", "Hello  World "):
        res, code = run_expect(pw, ["text", "e7", expected])
        assert res == "ok"
        assert code.endswith('toHaveText("Hello World");')


def test_text_mismatch_reports_actual():
    pw, _ = make_pw({"generate-locator": LOC, "run-code": val("Hello, !")})
    assert run_expect(pw, ["text", "e7", "Hello, Linh!"]) == (
        'error: expect text failed: expected "Hello, Linh!", got "Hello, !"',
        None,
    )


def test_text_null_content_is_empty():
    pw, _ = make_pw({"generate-locator": LOC, "run-code": val(None)})
    assert run_expect(pw, ["text", "e7", ""])[0] == "ok"


def test_value_pass_and_mismatch():
    pw, calls = make_pw({"generate-locator": LOC, "run-code": val("a@b.c")})
    res, code = run_expect(pw, ["value", "e7", "a@b.c"])
    assert res == "ok"
    assert code == "await expect(page.getByTestId('msg')).toHaveValue(\"a@b.c\");"
    assert calls[1][1].endswith(".inputValue()")
    pw, _ = make_pw({"generate-locator": LOC, "run-code": val("a ")})
    assert run_expect(pw, ["value", "e7", "a"]) == (
        'error: expect value failed: expected "a", got "a "',
        None,
    )


def test_checked_and_unchecked():
    pw, calls = make_pw({"generate-locator": LOC, "run-code": val(True)})
    assert run_expect(pw, ["checked", "e7"])[1] == (
        "await expect(page.getByTestId('msg')).toBeChecked();"
    )
    assert calls[1][1].endswith(".isChecked()")
    assert run_expect(pw, ["unchecked", "e7"]) == (
        "error: expect unchecked failed: element is checked",
        None,
    )
    pw, calls = make_pw({"generate-locator": LOC, "run-code": val(False)})
    assert run_expect(pw, ["unchecked", "e7"])[1] == (
        "await expect(page.getByTestId('msg')).not.toBeChecked();"
    )
    assert calls[1][1].endswith(".isChecked()")
    assert run_expect(pw, ["checked", "e7"]) == (
        "error: expect checked failed: element is not checked",
        None,
    )
    assert run_expect(pw, ["visible", "e7"]) == (
        "error: expect visible failed: element is not visible",
        None,
    )


def test_url_skips_locator():
    pw, calls = make_pw({"run-code": val("https://x/")})
    assert run_expect(pw, ["url", "https://x/"]) == (
        "ok",
        'await expect(page).toHaveURL("https://x/");',
    )
    assert calls == [["run-code", "async page => page.url()", "--raw"]]
    pw, _ = make_pw({"run-code": val("https://x/a")})
    assert run_expect(pw, ["url", "https://x/"]) == (
        'error: expect url failed: expected "https://x/", got "https://x/a"',
        None,
    )


def test_generate_locator_error_is_reported():
    err = ProcResult(
        1,
        "### Error\nError: Ref e99 not found in the current page snapshot. "
        "Try capturing new snapshot.",
        "",
    )
    pw, calls = make_pw({"generate-locator": err})
    res, code = run_expect(pw, ["visible", "e99"])
    assert res.startswith("error: ")
    assert "Ref e99 not found" in res
    assert code is None
    assert [c[0] for c in calls] == ["generate-locator"]

    pw, _ = make_pw({"generate-locator": ProcResult(-1, "", "timeout")})
    assert run_expect(pw, ["visible", "e1"]) == ("error: timeout", None)


def test_run_code_error_is_reported():
    err = ProcResult(1, "### Error\nError: strict mode violation: resolved to 2 elements", "")
    pw, _ = make_pw({"generate-locator": LOC, "run-code": err})
    res, code = run_expect(pw, ["visible", "e7"])
    assert res.startswith("error: ")
    assert "strict mode violation" in res
    assert code is None


@pytest.mark.parametrize("out", ["getByText('a')\nevil()", "page.goto('x')", ""])
def test_unusable_locator_is_rejected(out):
    pw, calls = make_pw({"generate-locator": ProcResult(0, out, "")})
    assert run_expect(pw, ["visible", "e7"]) == (
        f"error: expect: unusable locator {json.dumps(out.strip(), ensure_ascii=False)}",
        None,
    )
    assert [c[0] for c in calls] == ["generate-locator"]


def test_non_json_run_code_output_is_error():
    pw, _ = make_pw({"generate-locator": LOC, "run-code": ProcResult(0, "oops", "")})
    assert run_expect(pw, ["visible", "e7"]) == ('error: expect: unreadable result "oops"', None)


def test_expected_text_never_reaches_cli():
    expected = 'It\'s "ok"\\\n--x'
    page_text = " ".join(expected.split())
    pw, calls = make_pw({"generate-locator": LOC, "run-code": val(page_text)})
    res, code = run_expect(pw, ["text", "e7", expected])
    assert res == "ok"
    assert not any("It's" in part for call in calls for part in call)
    assert code.endswith("toHaveText(" + json.dumps(page_text, ensure_ascii=False) + ");")
