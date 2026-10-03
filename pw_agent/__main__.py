import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

from pw_agent.brain import Brain
from pw_agent.loop import Agent
from pw_agent.prompt import StepRecord
from pw_agent.pw import PlaywrightCLI, PlaywrightError

DEFAULT_SKILL = ".claude/skills/playwright-cli/SKILL.md"
SYSTEM_MD = Path(__file__).resolve().parent.parent / "prompts" / "system.md"


def _parse(argv):
    p = argparse.ArgumentParser(
        prog="pw_agent", description="Browser agent loop: playwright-cli + claude -p"
    )
    p.add_argument("task")
    p.add_argument("--max-steps", type=int, default=25)
    p.add_argument("--model", default="sonnet")
    p.add_argument("--headed", action="store_true")
    p.add_argument("--skill", default=DEFAULT_SKILL)
    p.add_argument("--session", default="pw-agent")
    p.add_argument(
        "--allow-file-access", action="store_true",
        help="allow file:// URLs and unrestricted file access in the browser",
    )
    return p.parse_args(argv)


def _preflight(skill: Path) -> str | None:
    if not skill.is_file():
        return f"playwright-cli skill not found: {skill}"
    if not shutil.which("claude"):
        return "claude CLI not found on PATH (install Claude Code)"
    if not shutil.which("playwright-cli"):
        return "playwright-cli not found on PATH (npm i -g @playwright/cli@latest)"
    return None


def _history_json(task, success, answer, steps, cost, history: list[StepRecord]) -> dict:
    return {
        "task": task,
        "success": success,
        "answer": answer,
        "steps": steps,
        "cost_usd": cost,
        "history": [
            {
                "step": r.step,
                "evaluation_previous_goal": r.decision.evaluation_previous_goal,
                "memory": r.decision.memory,
                "next_goal": r.decision.next_goal,
                "actions": [{"cmd": a.cmd, "args": list(a.args)} for a in r.decision.actions],
                "results": list(r.results),
            }
            for r in history
        ],
    }


def main(argv=None) -> int:
    args = _parse(argv)
    skill = Path(args.skill)
    err = _preflight(skill)
    if err:
        print(err, file=sys.stderr)
        return 2

    workdir = Path("runs") / datetime.now().strftime("%Y%m%d-%H%M%S")
    workdir.mkdir(parents=True, exist_ok=True)

    collected: list[StepRecord] = []

    def on_step(rec: StepRecord) -> None:
        collected.append(rec)
        print(rec.line(), flush=True)

    brain = Brain(system_files=[SYSTEM_MD, skill], model=args.model)
    pw = PlaywrightCLI(session=args.session, allow_file_access=args.allow_file_access)
    agent = Agent(
        args.task, pw, brain, workdir,
        max_steps=args.max_steps, headed=args.headed, on_step=on_step,
    )
    try:
        result = agent.run()
    except PlaywrightError as e:
        data = _history_json(
            args.task, False, f"playwright error: {e}", len(collected), 0.0, collected
        )
        (workdir / "history.json").write_text(json.dumps(data, indent=2))
        print(f"playwright error: {e}", file=sys.stderr)
        return 1

    data = _history_json(
        args.task, result.success, result.answer, result.steps, result.cost_usd, result.history
    )
    (workdir / "history.json").write_text(json.dumps(data, indent=2))
    print(f"Result: {'success' if result.success else 'failure'}")
    print(f"Answer: {result.answer}")
    print(f"Steps: {result.steps}  Cost: ${result.cost_usd:.4f}")
    print(f"History: {workdir / 'history.json'}")
    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())
