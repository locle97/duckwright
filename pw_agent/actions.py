import json
import re

from pw_agent.brain import Action
from pw_agent.pw import PlaywrightCLI

ALLOWED: frozenset[str] = frozenset(
    {
        "goto", "click", "fill", "type", "press", "select", "check", "uncheck",
        "hover", "drag", "tab-new", "tab-select", "tab-close", "go-back",
        "screenshot", "done",
    }
)
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


def execute(
    pw: PlaywrightCLI, actions: list[Action]
) -> tuple[list[str], tuple[bool, str] | None]:
    results: list[str] = []
    done: tuple[bool, str] | None = None
    skip: str | None = None
    for a in actions:
        if skip:
            results.append(skip)
            continue
        if a.cmd not in ALLOWED:
            results.append(f"error: command '{a.cmd}' not allowed")
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
        bad = _bad_flag(a.cmd, a.args)
        if bad is not None:
            results.append(f"error: flag '{bad}' not allowed")
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
