import argparse
import json
import shutil
import sys
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from duckwright.brain import Brain
from duckwright.export import SPEC_NAME, ExportError, export_run
from duckwright.loop import Agent
from duckwright.prompt import StepRecord
from duckwright.pw import PlaywrightCLI, PlaywrightError

DIST_NAME = "duckwright"
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
SYSTEM_MD = PROMPTS_DIR / "system.md"
DEFAULT_SKILL = PROMPTS_DIR / "playwright-cli.md"


def _version() -> str:
    try:
        return version(DIST_NAME)
    except PackageNotFoundError:
        return "unknown"


def _parse(argv):
    p = argparse.ArgumentParser(
        prog="duckwright",
        description="Duckwright: browser agent loop on playwright-cli + claude -p",
        epilog="To turn an earlier run into a test: duckwright export runs/<id>",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {_version()}")
    p.add_argument("task")
    p.add_argument("--max-steps", type=int, default=25)
    p.add_argument("--model", default="sonnet")
    p.add_argument("--headed", action="store_true")
    p.add_argument("--skill", default=str(DEFAULT_SKILL))
    p.add_argument("--session", default="duckwright")
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
        "--export", action="store_true",
        help=f"after a successful run, write a Playwright test to runs/<id>/{SPEC_NAME}",
    )
    return p.parse_args(argv)


def _parse_export(argv):
    p = argparse.ArgumentParser(
        prog="duckwright export",
        description="Write a @playwright/test spec from a successful run's history.json",
    )
    p.add_argument("run", help="run directory or history.json")
    p.add_argument("-o", "--output", metavar="FILE", help=f"spec path (default: <run>/{SPEC_NAME})")
    return p.parse_args(argv)


def _export(run: Path, out: Path | None = None) -> Path:
    path, warnings = export_run(run, out)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    return path


def _export_main(argv) -> int:
    args = _parse_export(argv)
    try:
        path = _export(Path(args.run), Path(args.output) if args.output else None)
    except ExportError as e:
        print(e, file=sys.stderr)
        return e.exit_code
    print(f"Test: {path}")
    return 0


def _preflight(skill: Path, state: Path | None) -> str | None:
    if not SYSTEM_MD.is_file():
        return f"system prompt not found: {SYSTEM_MD} (is the installation complete?)"
    if not skill.is_file():
        return f"playwright-cli skill not found: {skill}"
    if state and not state.is_file():
        return f"state file not found: {state}"
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
                "actions": [
                    {
                        "cmd": a.cmd,
                        "args": list(a.args),
                        "code": r.codes[i] if i < len(r.codes) else None,
                    }
                    for i, a in enumerate(r.decision.actions)
                ],
                "results": list(r.results),
            }
            for r in history
        ],
    }


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "export":
        return _export_main(argv[1:])
    args = _parse(argv)
    skill = Path(args.skill)
    state = Path(args.state).resolve() if args.state else None
    err = _preflight(skill, state)
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
    print(f"History: {workdir / 'history.json'}")
    if args.export:
        if not result.success:
            print("Test: not exported (run did not succeed)")
        else:
            try:
                print(f"Test: {_export(workdir)}")
            except ExportError as e:
                # The run itself succeeded; a failed export does not change that.
                print(f"export failed: {e}", file=sys.stderr)
    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())
