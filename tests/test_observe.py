from pathlib import Path

import pytest

from duckwright.observe import observe
from duckwright.proc import ProcResult
from duckwright.pw import PlaywrightCLI, PlaywrightError


def make_pw(snapshot_text, tabs="0: [current] Example", tab_code=0):
    def runner(argv, stdin, timeout):
        cmd = argv[2]
        if cmd == "tab-list":
            if tab_code:
                return ProcResult(tab_code, "", "tab boom")
            return ProcResult(0, tabs, "")
        if cmd == "snapshot":
            arg = next(a for a in argv if a.startswith("--filename="))
            Path(arg.split("=", 1)[1]).write_text(snapshot_text)
            return ProcResult(0, "", "")
        return ProcResult(0, "", "")

    return PlaywrightCLI(session="t", runner=runner)


def test_observe_small_page(tmp_path):
    obs = observe(make_pw("abc"), tmp_path)
    assert obs.truncated is False
    assert obs.snapshot == "abc"


def test_observe_truncates(tmp_path):
    obs = observe(make_pw("x" * 50), tmp_path, max_chars=10)
    assert obs.snapshot == "x" * 10 + "\n…[snapshot truncated]"
    assert obs.truncated is True


def test_observe_exact_limit_not_truncated(tmp_path):
    obs = observe(make_pw("x" * 10), tmp_path, max_chars=10)
    assert obs.snapshot == "x" * 10
    assert obs.truncated is False


def test_observe_includes_tabs(tmp_path):
    obs = observe(make_pw("abc"), tmp_path)
    assert "0: [current] Example" in obs.tabs


def test_observe_tab_list_failure(tmp_path):
    with pytest.raises(PlaywrightError, match="tab boom"):
        observe(make_pw("abc", tab_code=1), tmp_path)
