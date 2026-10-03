import json
from dataclasses import dataclass
from pathlib import Path

from pw_agent.proc import Runner, run_process

DECISION_SCHEMA: dict = {
    "type": "object",
    "required": ["evaluation_previous_goal", "memory", "next_goal", "actions"],
    "properties": {
        "evaluation_previous_goal": {"type": "string"},
        "memory": {"type": "string"},
        "next_goal": {"type": "string"},
        "actions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {
                "type": "object",
                "required": ["cmd", "args"],
                "properties": {
                    "cmd": {"type": "string"},
                    "args": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    },
}


@dataclass
class Action:
    cmd: str
    args: list[str]


@dataclass
class Decision:
    evaluation_previous_goal: str
    memory: str
    next_goal: str
    actions: list[Action]


class BrainError(Exception):
    pass


def _parse_decision(so: object) -> Decision:
    if not isinstance(so, dict):
        raise BrainError("structured_output is not an object")
    for key in ("evaluation_previous_goal", "memory", "next_goal"):
        if not isinstance(so.get(key), str):
            raise BrainError(f"structured_output missing string field: {key}")
    raw = so.get("actions")
    if not isinstance(raw, list) or not raw:
        raise BrainError("structured_output.actions must be a non-empty list")
    actions = []
    for a in raw:
        if (
            not isinstance(a, dict)
            or not isinstance(a.get("cmd"), str)
            or not isinstance(a.get("args"), list)
            or not all(isinstance(x, str) for x in a["args"])
        ):
            raise BrainError(f"malformed action: {a!r}")
        actions.append(Action(a["cmd"], list(a["args"])))
    return Decision(
        so["evaluation_previous_goal"], so["memory"], so["next_goal"], actions
    )


class Brain:
    def __init__(
        self,
        system_files: list[Path],
        model: str = "sonnet",
        runner: Runner = run_process,
        timeout: float = 60,
    ):
        self.system_files = system_files
        self.model = model
        self.runner = runner
        self.timeout = timeout

    def _argv(self) -> list[str]:
        argv = [
            "claude", "-p", "--output-format", "json", "--tools", "",
            "--no-session-persistence",
            "--model", self.model,
            "--json-schema", json.dumps(DECISION_SCHEMA),
        ]
        for f in self.system_files:
            argv += ["--append-system-prompt-file", str(f)]
        return argv

    def decide(self, prompt: str) -> tuple[Decision, float]:
        res = self.runner(self._argv(), prompt, self.timeout)
        if res.code == -1:
            raise BrainError("timeout")
        if res.code != 0:
            raise BrainError(res.stderr.strip() or f"claude exited {res.code}")
        try:
            env = json.loads(res.stdout)
        except ValueError as e:
            raise BrainError(f"non-JSON output: {e}") from e
        if not isinstance(env, dict):
            raise BrainError("envelope is not an object")
        if env.get("is_error"):
            raise BrainError(f"claude error: {env.get('result') or 'unknown'}")
        so = env.get("structured_output")
        if so is None:
            raise BrainError("missing structured_output")
        decision = _parse_decision(so)
        cost = env.get("total_cost_usd")
        if isinstance(cost, bool) or not isinstance(cost, (int, float)):
            cost = 0.0
        return decision, float(cost)
