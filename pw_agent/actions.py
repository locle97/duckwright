import json
import re

from pw_agent.brain import Action
from pw_agent.pw import PlaywrightCLI

_ALLOWED_ORDER = (
    "goto", "click", "fill", "type", "press", "select", "check", "uncheck",
    "hover", "drag", "tab-new", "tab-select", "tab-close", "go-back",
    "screenshot", "done",
)
ALLOWED: frozenset[str] = frozenset(_ALLOWED_ORDER)
ALLOWED_LIST = ", ".join(_ALLOWED_ORDER)
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
    bad = _bad_flag(a.cmd, a.args)
    if bad is not None:
        return f"error: flag '{bad}' not allowed"
    return None


def execute(
    pw: PlaywrightCLI, actions: list[Action]
) -> tuple[list[str], tuple[bool, str] | None]:
    results: list[str] = []
    done: tuple[bool, str] | None = None
    skip: str | None = None
    for a in actions:
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
        else:
            msg = res.stderr.strip() or res.stdout.strip()
            results.append(f"error: {msg}"[: len("error: ") + MAX_ERROR_CHARS])
        # A timeout (-1) may still have navigated, so treat it like success here.
        if a.cmd in PAGE_CHANGING and res.code in (0, -1):
            skip = "skipped: page may have changed"
    return results, done
