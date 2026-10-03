import os
from pathlib import Path

from pw_agent.proc import ProcResult, Runner, run_process


class PlaywrightError(Exception):
    pass


class PlaywrightCLI:
    def __init__(
        self,
        session: str = "pw-agent",
        runner: Runner = run_process,
        timeout: float = 30,
        allow_file_access: bool = False,
    ):
        self.allow_file_access = allow_file_access
        self.session = session
        self.runner = runner
        self.timeout = timeout

    def run(self, cmd: str, args: list[str]) -> ProcResult:
        argv = ["playwright-cli", f"-s={self.session}", cmd, *args]
        return self.runner(argv, None, self.timeout)

    def open(self, headed: bool) -> ProcResult:
        if self.allow_file_access:
            # playwright-cli blocks file: URLs unless the daemon is started with
            # this env var (there is no CLI flag for it); the daemon inherits it.
            os.environ["PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS"] = "1"
        args = ["about:blank"] + (["--headed"] if headed else [])
        return self.run("open", args)

    def close(self) -> None:
        try:
            self.run("close", [])
        except Exception:
            pass

    def snapshot(self, path: Path) -> str:
        res = self.run("snapshot", [f"--filename={path}"])
        if res.code != 0:
            raise PlaywrightError(res.stderr or res.stdout)
        return Path(path).read_text()
