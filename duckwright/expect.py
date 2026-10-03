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

# The locator from generate-locator is spliced into run-code, so it must be a plain
# locator chain. Literals are blanked out first (a regex literal only where an argument
# starts, so a division cannot pass as one); what is left may only call these methods,
# and has no operators, statements or template strings.
_LITERAL = re.compile(
    r"'(?:[^'\\\n]|\\.)*'" r'|"(?:[^"\\\n]|\\.)*"'
    r"|(?:(?<=\()|(?<=, )|(?<=: ))/(?:[^/\\\n]|\\.)+/[a-z]*"
)
_LOCATOR_START = re.compile(r"^(?:getBy[A-Za-z]+|locator|frameLocator)\(")
_LOCATOR_CHARS = re.compile(r"^[A-Za-z0-9_.(){}:, ]*$")
_CALL = re.compile(r"([A-Za-z_$][\w$]*)\s*\(")
_LOCATOR_METHODS = frozenset({
    "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText",
    "getByTitle", "getByTestId", "locator", "frameLocator", "contentFrame",
    "first", "last", "nth", "filter", "and", "or",
})

# Playwright's toHaveText drops U+200B, then trims and collapses JS whitespace (\s).
_JS_WS = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")

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
    return _JS_WS.sub(" ", (s or "").replace("\u200b", "")).strip(" ")


def _is_locator(loc: str) -> bool:
    if "\n" in loc or not _LOCATOR_START.match(loc):
        return False
    rest = _LITERAL.sub("0", loc)
    return bool(_LOCATOR_CHARS.match(rest)) and all(
        name in _LOCATOR_METHODS for name in _CALL.findall(rest)
    )


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
        if not _is_locator(loc):
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
