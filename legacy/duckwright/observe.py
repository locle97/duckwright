from dataclasses import dataclass
from pathlib import Path

from duckwright.pw import PlaywrightCLI, PlaywrightError

MAX_SNAPSHOT_CHARS = 40_000
TRUNCATION_MARKER = "\n…[snapshot truncated]"
# The snapshot gets a folder of its own: in grep mode it is the only thing Claude can read.
PAGE_DIR = "page"
SNAPSHOT_FILE = "snapshot.yml"
# How the agent reads the page: always pasted, always grepped, or by size (hybrid).
SNAPSHOT_MODES = ("hybrid", "full", "grep")
HYBRID_MAX_CHARS = 5_000


@dataclass
class Observation:
    tabs: str
    snapshot: str
    truncated: bool
    # Size of the whole snapshot, before any truncation.
    lines: int = 0
    chars: int = 0


def page_dir(workdir: Path) -> Path:
    return Path(workdir) / PAGE_DIR


def paste_snapshot(mode: str, obs: Observation) -> bool:
    """Whether this step pastes the snapshot into the prompt rather than letting Claude grep it."""
    if mode == "hybrid":
        return obs.chars <= HYBRID_MAX_CHARS
    return mode == "full"


def observe(
    pw: PlaywrightCLI, workdir: Path, max_chars: int = MAX_SNAPSHOT_CHARS
) -> Observation:
    tab_res = pw.run("tab-list", [])
    if tab_res.code != 0:
        raise PlaywrightError(tab_res.stderr or tab_res.stdout)
    folder = page_dir(workdir)
    folder.mkdir(parents=True, exist_ok=True)
    full = pw.snapshot(folder / SNAPSHOT_FILE)
    snapshot = full
    truncated = len(full) > max_chars
    if truncated:
        snapshot = full[:max_chars] + TRUNCATION_MARKER
    return Observation(
        tabs=tab_res.stdout,
        snapshot=snapshot,
        truncated=truncated,
        lines=len(full.splitlines()),
        chars=len(full),
    )
