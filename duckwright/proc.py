import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProcResult:
    code: int
    stdout: str
    stderr: str


Runner = Callable[..., ProcResult]


def run_process(
    argv: list[str], stdin: str | None, timeout: float, cwd: Path | None = None
) -> ProcResult:
    """Real runner: argv list only, never a shell."""
    try:
        p = subprocess.run(
            argv,
            input=stdin,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        return ProcResult(-1, "", "timeout")
    return ProcResult(p.returncode, p.stdout, p.stderr)
