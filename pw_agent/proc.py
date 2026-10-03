import subprocess
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class ProcResult:
    code: int
    stdout: str
    stderr: str


Runner = Callable[[list[str], str | None, float], ProcResult]


def run_process(argv: list[str], stdin: str | None, timeout: float) -> ProcResult:
    """Real runner: argv list only, never a shell."""
    try:
        p = subprocess.run(
            argv, input=stdin, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return ProcResult(-1, "", "timeout")
    return ProcResult(p.returncode, p.stdout, p.stderr)
