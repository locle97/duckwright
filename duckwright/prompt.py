import re
from dataclasses import dataclass, field

from duckwright.brain import Decision
from duckwright.observe import Observation

HISTORY_WINDOW = 15


def _flat(s: str) -> str:
    return " ".join(str(s).splitlines()) if s else ""


@dataclass
class StepRecord:
    step: int
    decision: Decision
    results: list[str]
    # Playwright code playwright-cli ran per action (None where nothing ran), for replay.
    codes: list[str | None] = field(default_factory=list)

    def line(self) -> str:
        d = self.decision
        results = [_flat(r) for r in self.results]
        if d.actions:
            parts = []
            for i, a in enumerate(d.actions):
                cmd = _flat(" ".join([a.cmd, *a.args]))
                res = results[i] if i < len(results) else "(no result)"
                parts.append(f"{cmd} → {res}")
            acts = "; ".join(parts)
        else:
            acts = "; ".join(results)
        return f"step {self.step} | {_flat(d.evaluation_previous_goal)} | {_flat(d.next_goal)} | {acts}"


_HARNESS_TAG = re.compile(r"<(?=/?(?:page_snapshot|tabs|task|memory|history))", re.IGNORECASE)


def _neutralise(body: str) -> str:
    """Escape harness section tags inside untrusted page data so it cannot close its block."""
    return _HARNESS_TAG.sub("&lt;", body)


def _section(tag: str, body: str) -> str:
    return f"<{tag}>\n{body}\n</{tag}>"


def build_prompt(
    task: str,
    step: int,
    max_steps: int,
    history: list[StepRecord],
    memory: str,
    obs: Observation,
    window: int = HISTORY_WINDOW,
    nudge: str | None = None,
) -> str:
    shown = history[-window:] if window > 0 else []
    omitted = len(history) - len(shown)
    lines = [r.line() for r in shown]
    if omitted:
        lines.insert(0, f"({omitted} earlier steps omitted)")
    parts = [
        f"Step {step}/{max_steps}",
        _section("task", task),
        _section("memory", memory or "(empty)"),
        _section("tabs", _neutralise(obs.tabs)),
        _section("history", "\n".join(lines) if lines else "(none)"),
    ]
    if nudge:
        parts.append(nudge)
    parts.append(_section("page_snapshot", _neutralise(obs.snapshot)))
    return "\n\n".join(parts) + "\n"
