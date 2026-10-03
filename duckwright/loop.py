from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from duckwright.actions import execute
from duckwright.brain import Brain, BrainError, Decision
from duckwright.observe import observe
from duckwright.prompt import StepRecord, build_prompt
from duckwright.pw import PlaywrightCLI, PlaywrightError

REPEAT_NUDGE = "You are repeating the same actions; try a different approach."
REPEAT_THRESHOLD = 3


@dataclass
class RunResult:
    success: bool
    answer: str
    steps: int
    cost_usd: float
    history: list[StepRecord]


def _action_key(rec: StepRecord) -> list[tuple[str, tuple[str, ...]]]:
    return [(a.cmd, tuple(a.args)) for a in rec.decision.actions]


def _is_repeating(history: list[StepRecord]) -> bool:
    last = history[-REPEAT_THRESHOLD:]
    if len(last) < REPEAT_THRESHOLD or not all(r.decision.actions for r in last):
        return False
    keys = [_action_key(r) for r in last]
    return all(k == keys[0] for k in keys)


class Agent:
    def __init__(
        self,
        task: str,
        pw: PlaywrightCLI,
        brain: Brain,
        workdir: Path,
        max_steps: int = 25,
        max_failures: int = 3,
        headed: bool = False,
        state: Path | None = None,
        on_step: Callable[[StepRecord], None] | None = None,
    ):
        self.task = task
        self.pw = pw
        self.brain = brain
        self.workdir = Path(workdir)
        self.max_steps = max_steps
        self.max_failures = max_failures
        self.headed = headed
        self.state = state
        self.on_step = on_step
        self.cost_usd = 0.0

    def _record(self, history: list[StepRecord], rec: StepRecord) -> None:
        history.append(rec)
        if self.on_step:
            self.on_step(rec)

    def run(self) -> RunResult:
        try:
            res = self.pw.open(self.headed)
            if res.code != 0:
                raise PlaywrightError(res.stderr or res.stdout)
            if self.state:
                self.pw.state_load(self.state)
            return self._loop()
        finally:
            self.pw.close()

    def _loop(self) -> RunResult:
        history: list[StepRecord] = []
        memory = ""
        self.cost_usd = 0.0
        failures = 0
        steps = 0
        for step in range(1, self.max_steps + 1):
            obs = observe(self.pw, self.workdir)
            nudge = REPEAT_NUDGE if _is_repeating(history) else None
            prompt = build_prompt(
                self.task, step, self.max_steps, history, memory, obs, nudge=nudge
            )
            steps = step
            try:
                decision, c = self.brain.decide(prompt)
            except BrainError as e:
                self.cost_usd += e.cost
                failures += 1
                self._record(
                    history, StepRecord(step, Decision("", memory, "", []), [f"brain error: {e}"])
                )
                if failures >= self.max_failures:
                    return RunResult(
                        False,
                        f"stopped after {failures} consecutive brain failures: {e}",
                        steps,
                        self.cost_usd,
                        history,
                    )
                continue
            failures = 0
            self.cost_usd += c
            memory = decision.memory
            codes: list[str | None] = []
            results, done = execute(self.pw, decision.actions, codes=codes)
            self._record(history, StepRecord(step, decision, results, codes))
            if done is not None:
                return RunResult(done[0], done[1], steps, self.cost_usd, history)
        return RunResult(False, "max steps reached", steps, self.cost_usd, history)
