"""Names for run folders: `runs/<timestamp>-<label>/`."""

import random
import re
import unicodedata
from datetime import datetime
from pathlib import Path

ADJECTIVES = (
    "brave", "bright", "calm", "clever", "cozy", "eager", "fancy", "gentle", "happy", "jolly",
    "keen", "kind", "lively", "lucky", "merry", "mighty", "nimble", "proud", "quick", "quiet",
    "rapid", "shiny", "silly", "snappy", "sunny", "swift", "tidy", "witty", "zany", "zesty",
)
NOUNS = (
    "acorn", "badger", "beacon", "cedar", "comet", "dune", "ember", "falcon", "fern", "harbor",
    "heron", "island", "lagoon", "maple", "meadow", "otter", "pebble", "pine", "puffin", "quill",
    "raven", "reef", "river", "robin", "sparrow", "summit", "thistle", "tulip", "walrus", "willow",
)
MAX_LABEL = 40


def slugify(text: str) -> str:
    """Lowercase ASCII letters and digits joined by single dashes, at most MAX_LABEL long.

    Accents are dropped first, so "Đăng nhập" becomes "dang-nhap".
    """
    text = unicodedata.normalize("NFKD", text.lower().replace("đ", "d"))
    text = text.encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return slug[:MAX_LABEL].rstrip("-")


def random_label(rng: random.Random | None = None) -> str:
    rng = rng or random
    return f"{rng.choice(ADJECTIVES)}-{rng.choice(NOUNS)}"


def run_label(task_file: str | None) -> str:
    """The task file's name without its extension, or random words for a command-line task."""
    if task_file is not None and (slug := slugify(Path(task_file).stem)):
        return slug
    return random_label()


def make_run_dir(root: Path, task_file: str | None, now: datetime | None = None) -> Path:
    """Create and return `root/<YYYYmmdd-HHMMSS>-<label>`, adding -2, -3, ... on a clash."""
    base = f"{(now or datetime.now()).strftime('%Y%m%d-%H%M%S')}-{run_label(task_file)}"
    root.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        path = root / (base if n == 1 else f"{base}-{n}")
        try:
            path.mkdir()
            return path
        except FileExistsError:
            n += 1
