"""Pure helpers for the opt-in Jev vs Claude benchmark."""
from dataclasses import dataclass


@dataclass
class BenchRun:
    task: str
    mode: str  # "claude" or "jev"
    success: bool
    cost: float
    seconds: float
    steps: int
    jev_steps: int


def _stats(runs: list[BenchRun]) -> dict:
    n = len(runs)
    steps = sum(r.steps for r in runs)
    return {
        "passes": sum(1 for r in runs if r.success),
        "runs": n,
        "mean_cost": sum(r.cost for r in runs) / n,
        "mean_seconds": sum(r.seconds for r in runs) / n,
        "jev_share": sum(r.jev_steps for r in runs) / steps if steps else 0,
    }


def summarize(runs: list[BenchRun]) -> dict:
    groups: dict[str, dict[str, list[BenchRun]]] = {}
    for r in runs:
        groups.setdefault(r.task, {}).setdefault(r.mode, []).append(r)
        groups.setdefault("total", {}).setdefault(r.mode, []).append(r)
    return {
        key: {mode: _stats(rs) for mode, rs in modes.items()}
        for key, modes in groups.items()
    }


def meets_targets(summary: dict) -> tuple[bool, bool]:
    claude = summary["total"]["claude"]
    jev = summary["total"]["jev"]
    return (
        jev["passes"] >= claude["passes"],
        jev["mean_cost"] <= 0.5 * claude["mean_cost"],
    )
