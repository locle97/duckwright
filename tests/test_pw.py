from pathlib import Path

import pytest

from pw_agent.proc import ProcResult
from pw_agent.pw import PlaywrightCLI, PlaywrightError


class FakeRunner:
    def __init__(self, result=None, on_call=None):
        self.calls = []
        self.result = result or ProcResult(0, "", "")
        self.on_call = on_call

    def __call__(self, argv, stdin, timeout):
        self.calls.append((argv, stdin, timeout))
        if self.on_call:
            self.on_call(argv)
        return self.result


def test_run_builds_argv():
    fake = FakeRunner()
    PlaywrightCLI(session="t", runner=fake).run("click", ["e5"])
    assert fake.calls[0][0] == ["playwright-cli", "-s=t", "click", "e5"]


def test_open_headed():
    fake = FakeRunner()
    PlaywrightCLI(session="t", runner=fake).open(headed=True)
    assert fake.calls[0][0][-3:] == ["open", "about:blank", "--headed"]


def test_snapshot_reads_file(tmp_path: Path):
    path = tmp_path / "snap.yml"

    def write(argv):
        arg = next(a for a in argv if a.startswith("--filename="))
        Path(arg.split("=", 1)[1]).write_text('- button "Go" [ref=e1]')

    fake = FakeRunner(on_call=write)
    assert PlaywrightCLI(runner=fake).snapshot(path) == '- button "Go" [ref=e1]'


def test_snapshot_failure_raises(tmp_path: Path):
    fake = FakeRunner(result=ProcResult(1, "", "boom"))
    with pytest.raises(PlaywrightError, match="boom"):
        PlaywrightCLI(runner=fake).snapshot(tmp_path / "s.yml")


def test_open_allow_file_access_prefixes_env():
    fake = FakeRunner()
    PlaywrightCLI(session="t", runner=fake).open(headed=False)
    assert fake.calls[0][0] == ["playwright-cli", "-s=t", "open", "about:blank"]
    fake = FakeRunner()
    PlaywrightCLI(session="t", runner=fake, allow_file_access=True).open(headed=False)
    assert fake.calls[0][0] == [
        "env",
        "PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1",
        "playwright-cli",
        "-s=t",
        "open",
        "about:blank",
    ]


def test_snapshot_reads_utf8_and_replaces_bad_bytes(tmp_path: Path, monkeypatch):
    path = tmp_path / "snap.yml"
    monkeypatch.setenv("LC_ALL", "C")

    def write(argv):
        path.write_bytes("café ".encode("utf-8") + b"\xff")

    out = PlaywrightCLI(runner=FakeRunner(on_call=write)).snapshot(path)
    assert out == "café �"


def test_state_load_builds_argv():
    fake = FakeRunner()
    PlaywrightCLI(session="t", runner=fake).state_load(Path("/x/auth.json"))
    assert fake.calls[0][0] == ["playwright-cli", "-s=t", "state-load", "/x/auth.json"]


def test_state_load_failure_raises():
    fake = FakeRunner(result=ProcResult(1, "", "bad state"))
    with pytest.raises(PlaywrightError, match="bad state"):
        PlaywrightCLI(runner=fake).state_load(Path("/x/auth.json"))
