import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from duckwright.export import ExportError, load_history

RUNS_DIR = Path("runs")
TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S-%f"
TASK_WIDTH = 40
# Device names Windows will not accept as a folder name.
RESERVED = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)


def slugify(text: str, max_len: int = 40) -> str:
    """A folder-safe name for `text`: lowercase ASCII words joined by `-`, or `task`."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    if len(slug) > max_len:
        slug = slug[:max_len]
        if "-" in slug:
            slug = slug[: slug.rindex("-")]
        slug = slug.strip("-")
    if not slug:
        return "task"
    return slug + "-task" if slug in RESERVED else slug


def new_run_dir(label: str, root: Path = RUNS_DIR, now: datetime | None = None) -> Path:
    """Create runs/<slug>/<timestamp>/ for a run labelled `label`."""
    # Microseconds keep two runs started in the same second apart.
    stamp = (now or datetime.now()).strftime(TIMESTAMP_FORMAT)
    path = Path(root) / slugify(label) / stamp
    path.mkdir(parents=True)
    return path


@dataclass(frozen=True)
class RunInfo:
    path: Path
    group: str | None  # None for a run in the old flat runs/<timestamp>/ layout
    started: str  # the timestamp folder name
    success: bool
    steps: int
    cost_usd: float
    task: str
    task_file: str | None


def find_runs(root: Path = RUNS_DIR) -> tuple[list[RunInfo], list[str]]:
    """Every run under `root`, newest first, plus a warning for each history that can't be read."""
    root = Path(root)
    files = sorted({*root.glob("*/history.json"), *root.glob("*/*/history.json")})
    runs: list[RunInfo] = []
    warnings: list[str] = []
    for file in files:
        try:
            _, data = load_history(file)
        except ExportError as e:
            warnings.append(f"skipped {file}: {e}")
            continue
        run_dir = file.parent
        steps, cost, task_file = data.get("steps"), data.get("cost_usd"), data.get("task_file")
        runs.append(RunInfo(
            path=run_dir,
            group=run_dir.parent.name if run_dir.parent != root else None,
            started=run_dir.name,
            success=data["success"],
            steps=steps if isinstance(steps, int) and not isinstance(steps, bool) else 0,
            cost_usd=_number(cost),
            task=data["task"],
            task_file=task_file if isinstance(task_file, str) else None,
        ))
    runs.sort(key=lambda r: (r.started, str(r.path)), reverse=True)
    return runs, warnings


def _number(v) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return 0.0
    try:
        return float(v)
    except OverflowError:  # an int too big for a float
        return 0.0


def matches(run: RunInfo, query: str) -> bool:
    """Case-insensitive substring match against the run's group, task file and task."""
    q = query.casefold()
    return any(q in (s or "").casefold() for s in (run.group, run.task_file, run.task))


def format_run(run: RunInfo) -> str:
    try:
        when = datetime.strptime(run.started, TIMESTAMP_FORMAT).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        when = run.started
    task = " ".join(run.task.split())
    if len(task) > TASK_WIDTH:
        task = task[:TASK_WIDTH].rstrip() + "…"
    return "  ".join([
        when,
        "pass" if run.success else "fail",
        f"{run.steps:>2} steps",
        f"${run.cost_usd:.4f}",
        str(run.path),
        task,
    ])
