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

MAX_ERROR_CHARS = 300


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
                results.append("error: done requires success|failure")
                continue
            done = (a.args[0] == "success", a.args[1] if len(a.args) > 1 else "")
            results.append("done")
            skip = "skipped: done"
            continue
        res = pw.run(a.cmd, a.args)
        if res.code == 0:
            results.append("ok")
            if a.cmd in PAGE_CHANGING:
                skip = "skipped: page may have changed"
        else:
            msg = res.stderr.strip() or res.stdout.strip()
            results.append(f"error: {msg}"[: len("error: ") + MAX_ERROR_CHARS])
    return results, done
