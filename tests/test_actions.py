from pw_agent.actions import execute
from pw_agent.brain import Action
from pw_agent.proc import ProcResult
from pw_agent.pw import PlaywrightCLI


def make_pw(code=0, stderr="", stdout=""):
    calls = []

    def runner(argv, stdin, timeout):
        calls.append(argv[2:])
        return ProcResult(code, stdout, stderr)

    return PlaywrightCLI(session="t", runner=runner), calls


def test_rejects_unknown_cmd():
    pw, calls = make_pw()
    results, done = execute(pw, [Action("eval", ["1"])])
    assert results == ["error: command 'eval' not allowed"]
    assert done is None
    assert calls == []


def test_skips_after_page_change():
    pw, calls = make_pw()
    results, _ = execute(pw, [Action("click", ["e5"]), Action("fill", ["e9", "hi"])])
    assert results == ["ok", "skipped: page may have changed"]
    assert calls == [["click", "e5"]]


def test_no_skip_after_failed_page_change():
    pw, calls = make_pw(code=1, stderr="nope")
    results, _ = execute(pw, [Action("click", ["e5"]), Action("fill", ["e9", "hi"])])
    assert results == ["error: nope", "error: nope"]
    assert len(calls) == 2


def test_done_returns_answer():
    pw, calls = make_pw()
    results, done = execute(pw, [Action("done", ["success", "42"]), Action("click", ["e1"])])
    assert results == ["done", "skipped: done"]
    assert done == (True, "42")
    assert calls == []


def test_done_invalid_status_continues():
    pw, _ = make_pw()
    results, done = execute(pw, [Action("done", ["maybe"]), Action("hover", ["e1"])])
    assert results == ["error: done requires success|failure", "ok"]
    assert done is None


def test_done_failure_without_answer():
    pw, _ = make_pw()
    _, done = execute(pw, [Action("done", ["failure"])])
    assert done == (False, "")


def test_skip_applies_to_done():
    pw, _ = make_pw()
    results, done = execute(pw, [Action("goto", ["x"]), Action("done", ["success", "a"])])
    assert results == ["ok", "skipped: page may have changed"]
    assert done is None


def test_failed_command_reports_stderr():
    pw, _ = make_pw(code=1, stderr="ref e9 not found\n")
    results, _ = execute(pw, [Action("fill", ["e9", "x"])])
    assert results == ["error: ref e9 not found"]


def test_failed_command_falls_back_to_stdout_and_truncates():
    pw, _ = make_pw(code=1, stdout="x" * 500)
    results, _ = execute(pw, [Action("fill", ["e9", "x"])])
    assert len(results[0]) == len("error: ") + 300


def test_success_hides_stdout():
    pw, _ = make_pw(stdout="huge")
    results, _ = execute(pw, [Action("hover", ["e1"])])
    assert results == ["ok"]
