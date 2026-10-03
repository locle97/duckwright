import json
import re

from duckwright.proc import ProcResult
from duckwright.pw import PlaywrightCLI

# Check name -> its argument names. playwright-cli has no assertion command, so the
# harness reads the element's state with a fixed run-code snippet and compares it here.
CHECKS: dict[str, tuple[str, ...]] = {
    "visible": ("ref",),
    "text": ("ref", "expected"),
    "value": ("ref", "expected"),
    "checked": ("ref",),
    "unchecked": ("ref",),
    "url": ("expected",),
}
_CHECK_LIST = ", ".join(CHECKS)

_REF = re.compile(r"^[a-z0-9]+$")
_LOCATOR = re.compile(r"^(?:getBy[A-Za-z]+|locator)\([^\n]*\)$")

_READ: dict[str, str] = {
    "visible": "isVisible()",
    "text": "textContent()",
    "value": "inputValue()",
    "checked": "isChecked()",
    "unchecked": "isChecked()",
}
_URL_JS = "async page => page.url()"


def _q(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def _norm(s: str | None) -> str:
    return " ".join((s or "").split())


def check_args(args: list[str]) -> str | None:
    """Static check of an expect action's args; an error string, or None if well formed."""
    check = args[0] if args else ""
    if check not in CHECKS:
        return f"error: expect check '{check}' not allowed (allowed: {_CHECK_LIST})"
    names = CHECKS[check]
    if len(args) - 1 != len(names):
        usage = " ".join(f"<{n}>" for n in names)
        return f"error: usage: expect {check} {usage}"
    if names[0] == "ref" and not _REF.match(args[1]):
        return f"error: expect ref must be a snapshot ref like e15, got {_q(args[1])}"
    return None


def _cli_error(res: ProcResult) -> str:
    return f"error: {res.stderr.strip() or res.stdout.strip()}"


def run_expect(pw: PlaywrightCLI, args: list[str]) -> tuple[str, str | None]:
    """Verify one check against the live page. Returns ("ok", assertion code) on pass,
    or ("error: ...", None). Expects check_args(args) to be None."""
    check = args[0]
    if check == "url":
        subject, js = "page", _URL_JS
    else:
        res = pw.run("generate-locator", [args[1], "--raw"])
        if res.code != 0:
            return _cli_error(res), None
        loc = res.stdout.strip()
        if not _LOCATOR.match(loc):
            return f"error: expect: unusable locator {_q(loc)}", None
        subject, js = f"page.{loc}", f"async page => await page.{loc}.{_READ[check]}"
    res = pw.run("run-code", [js, "--raw"])
    if res.code != 0:
        return _cli_error(res), None
    try:
        actual = json.loads(res.stdout)
    except ValueError:
        return f"error: expect: unreadable result {_q(res.stdout.strip())}", None

    if check in ("visible", "checked", "unchecked"):
        want = check != "unchecked"
        if actual is not want:
            state = {"visible": "not visible", "checked": "not checked"}.get(check, "checked")
            return f"error: expect {check} failed: element is {state}", None
        matcher = {
            "visible": "toBeVisible()",
            "checked": "toBeChecked()",
            "unchecked": "not.toBeChecked()",
        }[check]
    else:
        expected = args[-1]
        if check == "text":
            expected, actual = _norm(expected), _norm(actual)
        elif not isinstance(actual, str):
            actual = "" if actual is None else str(actual)
        if actual != expected:
            return (
                f"error: expect {check} failed: expected {_q(expected)}, got {_q(actual)}",
                None,
            )
        matcher = {"text": "toHaveText", "value": "toHaveValue", "url": "toHaveURL"}[check]
        matcher = f"{matcher}({_q(expected)})"
    return "ok", f"await expect({subject}).{matcher};"
