import re
import unicodedata
from datetime import datetime
from pathlib import Path

RUNS_DIR = Path("runs")
TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S-%f"
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
