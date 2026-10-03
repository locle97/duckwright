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
    ):
        self.session = session
        self.runner = runner
        self.timeout = timeout

    def run(self, cmd: str, args: list[str]) -> ProcResult:
        argv = ["playwright-cli", f"-s={self.session}", cmd, *args]
        return self.runner(argv, None, self.timeout)

    def open(self, headed: bool) -> ProcResult:
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
