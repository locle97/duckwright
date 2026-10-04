import json
import re

from duckwright.brain import ALLOWED_COMMANDS, Action
from duckwright.expect import check_args, run_expect
from duckwright.pw import PlaywrightCLI

ALLOWED: frozenset[str] = frozenset(ALLOWED_COMMANDS)
ALLOWED_LIST = ", ".join(ALLOWED_COMMANDS)
PAGE_CHANGING: frozenset[str] = frozenset(
    {"goto", "click", "press", "tab-new", "tab-select", "tab-close", "go-back"}
)

# Harmless flags per command (from `playwright-cli <cmd> --help`). Any other flag,
# including global ones like -s/--session and --filename, is rejected.
ALLOWED_FLAGS: dict[str, frozenset[str]] = {
    "fill": frozenset({"--submit"}),
    "type": frozenset({"--submit"}),
    "click": frozenset({"--modifiers"}),
    "screenshot": frozenset({"--type", "--full-page", "--hires"}),
}
_FLAG = re.compile(r"^-{1,2}[A-Za-z]")

# playwright-cli prints the code it ran as "### Ran Playwright code" + a fenced block.
_RAN_CODE = re.compile(
    r"^### Ran Playwright code\n```\w*\n((?:(?!```)[^\n]*\n)*?(?!```)[^\n]+)\n```",
    re.MULTILINE,
)

MAX_ERROR_CHARS = 300
EARLIER_FAILED = "error: an earlier action failed; verify before finishing"


def _bad_flag(cmd: str, args: list[str]) -> str | None:
    allowed = ALLOWED_FLAGS.get(cmd, frozenset())
    for arg in args:
        if _FLAG.match(arg) and arg.split("=", 1)[0] not in allowed:
            return arg
    return None


def _rejection(a: Action) -> str | None:
    """Static allowlist check, so a rejected action is reported even when skipped."""
    if a.cmd not in ALLOWED:
        return f"error: command '{a.cmd}' not allowed (allowed: {ALLOWED_LIST})"
    if a.cmd == "expect":
        # Its args never reach playwright-cli as given, so expected text may look like a flag.
        return check_args(a.args)
    bad = _bad_flag(a.cmd, a.args)
    if bad is not None:
        return f"error: flag '{bad}' not allowed"
    return None


def extract_code(stdout: str) -> str | None:
    m = _RAN_CODE.search(stdout)
    return m.group(1) if m else None


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
        if a.cmd == "expect":
            result, code = run_expect(pw, a.args)
            results.append(result[: len("error: ") + MAX_ERROR_CHARS])
            if code is not None:
                ran[i] = code
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
