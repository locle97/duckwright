import re
from dataclasses import dataclass
from pathlib import Path

from pw_agent.pw import PlaywrightCLI, PlaywrightError

MAX_SNAPSHOT_CHARS = 40_000
TRUNCATION_MARKER = "\n…[snapshot truncated]"
MAX_LABEL_NAME_CHARS = 60

# A snapshot element line: role, optional quoted name (backslash escapes), rest of line.
SNAPSHOT_LINE = re.compile(r'^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$')
# The element's ref; search only the rest of the line, so text inside a name cannot fake one.
SNAPSHOT_REF = re.compile(r"\[ref=([^\]\s]+)\]")


def unescape_name(raw: str) -> str:
    return re.sub(r"\\(.)", r"\1", raw)


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


def element_labels(snapshot: str) -> dict[str, str]:
    """Map each ref in a snapshot to `role "name"`, or just `role` when unnamed."""
    labels: dict[str, str] = {}
    for line in snapshot.splitlines():
        m = SNAPSHOT_LINE.match(line)
        if not m:
            continue
        role, raw_name, rest = m.groups()
        ref = SNAPSHOT_REF.search(rest)
        if not ref or ref.group(1) in labels:
            continue
        name = unescape_name(raw_name) if raw_name else ""
        if len(name) > MAX_LABEL_NAME_CHARS:
            name = name[:MAX_LABEL_NAME_CHARS] + "…"
        labels[ref.group(1)] = f'{role} "{name}"' if name else role
    return labels
