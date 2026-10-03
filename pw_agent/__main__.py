import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

from pw_agent.brain import Brain
from pw_agent.jev import HybridBrain, JevAuthError, JevClient
from pw_agent.loop import Agent
from pw_agent.prompt import StepRecord
from pw_agent.pw import PlaywrightCLI, PlaywrightError

DEFAULT_SKILL = "prompts/playwright-cli.md"
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
        "--state", metavar="FILE",
        help="storage state JSON (cookies, localStorage) loaded with state-load before the task starts",
    )
    p.add_argument(
        "--allow-file-access", action="store_true",
        help=(
            "allow file:// URLs and UNRESTRICTED local file access in the browser. "
            "A hijacked agent could read any file you can (e.g. ~/.ssh) and leak it; "
            "only use with trusted pages and trusted tasks"
        ),
    )
    p.add_argument(
        "--jev", action="store_true",
        help=(
            "route easy steps to TypeSafe's Jev model (needs TYPESAFE_API_KEY); sends the task, "
            "page snapshots and history to TypeSafe. Experimental"
        ),
    )
    p.add_argument(
        "--jev-threshold", type=float, default=0.8, metavar="FLOAT",
        help="minimum Jev confidence (0..1) to accept its action instead of asking Claude (default: 0.8)",
    )
    return p.parse_args(argv)


def _preflight(skill: Path, state: Path | None, jev: bool = False) -> str | None:
    if not SYSTEM_MD.is_file():
        return f"system prompt not found: {SYSTEM_MD} (is the checkout complete?)"
    if not skill.is_file():
        return f"playwright-cli skill not found: {skill}"
    if state and not state.is_file():
        return f"state file not found: {state}"
    if not shutil.which("claude"):
        return "claude CLI not found on PATH (install Claude Code)"
    if not shutil.which("playwright-cli"):
        return "playwright-cli not found on PATH (npm i -g @playwright/cli@latest)"
    if jev and not os.environ.get("TYPESAFE_API_KEY"):
        return "TYPESAFE_API_KEY not set (required by --jev)"
    if jev and any(c.isspace() or not c.isprintable() for c in os.environ["TYPESAFE_API_KEY"]):
        return "TYPESAFE_API_KEY contains whitespace or control characters"
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
                "actions": [
                    {
                        "cmd": a.cmd,
                        "args": list(a.args),
                        "code": r.codes[i] if i < len(r.codes) else None,
                    }
                    for i, a in enumerate(r.decision.actions)
                ],
                "results": list(r.results),
                "source": r.decision.source,
                "cost_usd": r.cost,
                "jev": r.decision.jev,
            }
            for r in history
        ],
        "jev_steps": sum(1 for r in history if r.decision.source == "jev"),
        "claude_steps": sum(1 for r in history if r.decision.source != "jev"),
    }


def main(argv=None) -> int:
    args = _parse(argv)
    skill = Path(args.skill)
    state = Path(args.state).resolve() if args.state else None
    if not 0 <= args.jev_threshold <= 1:
        print("--jev-threshold must be between 0 and 1", file=sys.stderr)
        return 2
    err = _preflight(skill, state, args.jev)
    if err:
        print(err, file=sys.stderr)
        return 2

    # Microseconds keep two runs started in the same second apart.
    workdir = Path("runs") / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    workdir.mkdir(parents=True)

    collected: list[StepRecord] = []

    def on_step(rec: StepRecord) -> None:
        collected.append(rec)
        print(rec.line(), flush=True)

    brain = Brain(system_files=[SYSTEM_MD, skill], model=args.model)
    if args.jev:
        brain = HybridBrain(
            JevClient(os.environ["TYPESAFE_API_KEY"]), brain, args.jev_threshold
        )
    pw = PlaywrightCLI(session=args.session, allow_file_access=args.allow_file_access)
    agent = Agent(
        args.task, pw, brain, workdir,
        max_steps=args.max_steps, headed=args.headed, state=state, on_step=on_step,
    )
    def write_failure(answer: str) -> None:
        data = _history_json(
            args.task, False, answer, len(collected), agent.cost_usd, collected
        )
        (workdir / "history.json").write_text(json.dumps(data, indent=2))

    try:
        result = agent.run()
    except PlaywrightError as e:
        write_failure(f"playwright error: {e}")
        print(f"playwright error: {e}", file=sys.stderr)
        return 1
    except JevAuthError:
        msg = "jev error: invalid TYPESAFE_API_KEY"
        write_failure(msg)
        print(msg, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        write_failure("interrupted")
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as e:
        msg = f"error: {type(e).__name__}: {e}"
        write_failure(msg)
        print(msg, file=sys.stderr)
        return 1

    data = _history_json(
        args.task, result.success, result.answer, result.steps, result.cost_usd, result.history
    )
    (workdir / "history.json").write_text(json.dumps(data, indent=2))
    print(f"Result: {'success' if result.success else 'failure'}")
    print(f"Answer: {result.answer}")
    print(f"Steps: {result.steps}  Cost: ${result.cost_usd:.4f}")
    if args.jev:
        jev_steps = sum(1 for r in result.history if r.decision.source == "jev")
        print(f"Jev steps: {jev_steps}/{result.steps}")
    print(f"History: {workdir / 'history.json'}")
    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())
