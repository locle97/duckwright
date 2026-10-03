from dataclasses import dataclass
from pathlib import Path

from duckwright.pw import PlaywrightCLI, PlaywrightError

MAX_SNAPSHOT_CHARS = 40_000
TRUNCATION_MARKER = "\n…[snapshot truncated]"


@dataclass
class Observation:
    tabs: str
    snapshot: str
    truncated: bool


def observe(
    pw: PlaywrightCLI, workdir: Path, max_chars: int = MAX_SNAPSHOT_CHARS
) -> Observation:
    tab_res = pw.run("tab-list", [])
    if tab_res.code != 0:
        raise PlaywrightError(tab_res.stderr or tab_res.stdout)
    snapshot = pw.snapshot(Path(workdir) / "snapshot.yml")
    truncated = len(snapshot) > max_chars
    if truncated:
        snapshot = snapshot[:max_chars] + TRUNCATION_MARKER
    return Observation(tabs=tab_res.stdout, snapshot=snapshot, truncated=truncated)
