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
from duckwright.observe import page_dir
from duckwright.prompt import StepRecord
from duckwright.pw import PlaywrightCLI, PlaywrightError
from duckwright.taskfile import TaskFile, TaskFileError, load_task_file, task_paths

DIST_NAME = "duckwright"
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
SYSTEM_MD = PROMPTS_DIR / "system.md"
DEFAULT_SKILL = PROMPTS_DIR / "playwright-cli.md"
# How the agent reads the page: pasted into the prompt, or grepped from the saved file.
SNAPSHOT_FULL_MD = PROMPTS_DIR / "snapshot-full.md"
SNAPSHOT_GREP_MD = PROMPTS_DIR / "snapshot-grep.md"


def _version() -> str:
    try:
        return version(DIST_NAME)
    except PackageNotFoundError:
        return "unknown"


def _run_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="duckwright",
        description="Duckwright: browser agent loop on playwright-cli + claude -p",
        epilog=(
            "Run a task file: duckwright -f tasks/login.md. "
            "To turn an earlier run into a test: duckwright export runs/<id>"
        ),
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {_version()}")
    p.add_argument("task", nargs="?")
    p.add_argument(
        "-f", "--file", metavar="FILE", nargs="+", action="extend",
        help=(
            "read the task, and optional settings, from a .txt or .md file; "
            "several files, or a folder of them, run one after another"
        ),
    )
    p.add_argument("--max-steps", type=int, default=25)
    p.add_argument("--model", default="sonnet")
    p.add_argument("--headed", action=argparse.BooleanOptionalAction, default=False)
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
        "--export", action=argparse.BooleanOptionalAction, default=False,
        help=f"after a successful run, write a Playwright test to runs/<id>/{SPEC_NAME}",
    )
    p.add_argument(
        "--full-snapshot", action=argparse.BooleanOptionalAction, default=False,
        help=(
            "paste the whole page snapshot (up to 40k characters) into every prompt, "
            "instead of letting Claude grep the saved snapshot file"
        ),
    )
    return p


def _parse(argv):
    return _run_parser().parse_args(argv)


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
    for path in (SYSTEM_MD, SNAPSHOT_FULL_MD, SNAPSHOT_GREP_MD):
        if not path.is_file():
            return f"system prompt not found: {path} (is the installation complete?)"
    if not skill.is_file():
        return f"playwright-cli skill not found: {skill}"
    if state and not state.is_file():
        return f"state file not found: {state}"
    if not shutil.which("claude"):
        return "claude CLI not found on PATH (install Claude Code)"
    if not shutil.which("playwright-cli"):
        return "playwright-cli not found on PATH (npm i -g @playwright/cli@latest)"
    return None


def _history_json(
    task, success, answer, steps, cost, history: list[StepRecord], task_file: str | None = None
) -> dict:
    return {
        "task": task,
        "task_file": task_file,
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


def _args_for(argv: list[str], tf: TaskFile) -> argparse.Namespace:
    # A fresh parser per file, so one file's settings never become another's defaults.
    # File settings are defaults, so flags given on the command line still win.
    parser = _run_parser()
    parser.set_defaults(**tf.settings)
    args = parser.parse_args(argv)
    args.task = tf.task
    return args


def _preflight_args(args: argparse.Namespace) -> str | None:
    return _preflight(Path(args.skill), Path(args.state).resolve() if args.state else None)


def _run_one(args: argparse.Namespace, task_file: str | None) -> tuple[int, Path]:
    """Run one task whose preflight has passed; returns the exit code and its history.json."""
    skill = Path(args.skill)
    state = Path(args.state).resolve() if args.state else None

    # Microseconds keep two runs started in the same second apart.
    workdir = Path("runs") / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    workdir.mkdir(parents=True)
    history_path = workdir / "history.json"

    collected: list[StepRecord] = []

    def on_step(rec: StepRecord) -> None:
        collected.append(rec)
        print(rec.line(), flush=True)

    mode_md = SNAPSHOT_FULL_MD if args.full_snapshot else SNAPSHOT_GREP_MD
    brain = Brain(
        system_files=[SYSTEM_MD, mode_md, skill],
        model=args.model,
        snapshot_dir=None if args.full_snapshot else page_dir(workdir),
    )
    pw = PlaywrightCLI(session=args.session, allow_file_access=args.allow_file_access)
    agent = Agent(
        args.task, pw, brain, workdir,
        max_steps=args.max_steps, headed=args.headed, state=state, on_step=on_step,
        full_snapshot=args.full_snapshot,
    )
    def write_failure(answer: str) -> None:
        data = _history_json(
            args.task, False, answer, len(collected), agent.cost_usd, collected, task_file
        )
        history_path.write_text(json.dumps(data, indent=2))

    try:
        result = agent.run()
    except PlaywrightError as e:
        write_failure(f"playwright error: {e}")
        print(f"playwright error: {e}", file=sys.stderr)
        return 1, history_path
    except KeyboardInterrupt:
        write_failure("interrupted")
        print("interrupted", file=sys.stderr)
        return 130, history_path
    except Exception as e:
        msg = f"error: {type(e).__name__}: {e}"
        write_failure(msg)
        print(msg, file=sys.stderr)
        return 1, history_path

    data = _history_json(
        args.task, result.success, result.answer, result.steps, result.cost_usd, result.history,
        task_file,
    )
    history_path.write_text(json.dumps(data, indent=2))
    print(f"Result: {'success' if result.success else 'failure'}")
    print(f"Answer: {result.answer}")
    print(f"Steps: {result.steps}  Cost: ${result.cost_usd:.4f}")
    print(f"History: {history_path}")
    if args.export:
        if not result.success:
            print("Test: not exported (run did not succeed)")
        else:
            try:
                print(f"Test: {_export(workdir)}")
            except ExportError as e:
                # The run itself succeeded; a failed export does not change that.
                print(f"export failed: {e}", file=sys.stderr)
    return (0 if result.success else 1), history_path


def _run_batch(runs: list[tuple[str, argparse.Namespace]]) -> int:
    """Preflight every task, then run them in order and print a summary."""
    errors = [f"{path}: {err}" for path, args in runs if (err := _preflight_args(args))]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 2
    rows: list[tuple[str, str, str]] = []
    interrupted = False
    for i, (path, args) in enumerate(runs, 1):
        if interrupted:
            rows.append(("skip", path, "-"))
            continue
        print(f"[{i}/{len(runs)}] {path}", flush=True)
        code, history = _run_one(args, path)
        interrupted = code == 130
        status = "pass" if code == 0 else "stop" if interrupted else "fail"
        rows.append((status, path, str(history)))
    count = {s: sum(r[0] == s for r in rows) for s in ("pass", "fail", "skip")}
    print(f"Batch: {count['pass']} passed, {count['fail']} failed, {count['skip']} not run")
    for row in rows:
        print("  ".join(row))
    if interrupted:
        return 130
    return 0 if count["pass"] == len(rows) else 1


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "export":
        return _export_main(argv[1:])
    parser = _run_parser()
    args = parser.parse_args(argv)
    if args.task is not None and args.file is not None:
        parser.error("give a task or --file, not both")
    if args.task is None and args.file is None:
        parser.error("give a task or --file")
    if args.file is None:
        err = _preflight_args(args)
        if err:
            print(err, file=sys.stderr)
            return 2
        return _run_one(args, None)[0]

    # Load every file before anything runs, so one bad file stops the whole batch.
    errors: list[str] = []
    runs: list[tuple[str, argparse.Namespace]] = []
    for path in task_paths(args.file):
        if isinstance(path, TaskFileError):
            errors.append(str(path))
            continue
        try:
            runs.append((path, _args_for(argv, load_task_file(path))))
        except TaskFileError as e:
            errors.append(str(e))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 2
    if len(runs) > 1:
        return _run_batch(runs)
    path, args = runs[0]
    err = _preflight_args(args)
    if err:
        print(err, file=sys.stderr)
        return 2
    return _run_one(args, path)[0]


if __name__ == "__main__":
    sys.exit(main())
