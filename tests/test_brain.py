import json
from pathlib import Path

import jsonschema
import pytest

from duckwright.brain import DECISION_SCHEMA, Action, Brain, BrainError, Decision
from duckwright.proc import ProcResult


class FakeRunner:
    def __init__(self, result):
        self.calls = []
        self.cwds = []
        self.result = result

    def __call__(self, argv, stdin, timeout, cwd=None):
        self.calls.append((argv, stdin, timeout))
        self.cwds.append(cwd)
        return self.result


GOOD = {
    "evaluation_previous_goal": "ok",
    "memory": "m",
    "next_goal": "g",
    "actions": [{"cmd": "click", "args": ["e3"]}],
}


def env(**kw):
    d = {"is_error": False, "total_cost_usd": 0.01, "structured_output": GOOD}
    d.update(kw)
    return ProcResult(0, json.dumps(d), "")


def test_decide_argv():
    fake = FakeRunner(env())
    Brain([Path("prompts/system.md"), Path("skill.md")], runner=fake).decide("PROMPT")
    argv, stdin, timeout = fake.calls[0]
    assert argv[:6] == ["claude", "-p", "--output-format", "json", "--tools", ""]
    assert argv[6:9] == [
        "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ]
    assert "--setting-sources" not in argv
    assert argv[argv.index("--json-schema") + 1] == json.dumps(DECISION_SCHEMA)
    assert argv[argv.index("--model") + 1] == "sonnet"
    pairs = [argv[i + 1] for i, a in enumerate(argv) if a == "--append-system-prompt-file"]
    assert pairs == ["prompts/system.md", "skill.md"]
    assert stdin == "PROMPT"
    assert timeout == 60


def test_decide_parses():
    d, cost = Brain([], runner=FakeRunner(env())).decide("x")
    assert d == Decision("ok", "m", "g", [Action("click", ["e3"])])
    assert cost == 0.01


def test_missing_cost_is_zero():
    r = ProcResult(0, json.dumps({"structured_output": GOOD}), "")
    assert Brain([], runner=FakeRunner(r)).decide("x")[1] == 0.0


def test_decide_error_envelope():
    with pytest.raises(BrainError, match="boom"):
        Brain([], runner=FakeRunner(env(is_error=True, result="boom"))).decide("x")


def test_decide_missing_structured_output():
    r = ProcResult(0, json.dumps({"is_error": False, "result": "text"}), "")
    with pytest.raises(BrainError):
        Brain([], runner=FakeRunner(r)).decide("x")


def test_decide_non_json_stdout():
    with pytest.raises(BrainError):
        Brain([], runner=FakeRunner(ProcResult(0, "not json", ""))).decide("x")


def test_decide_timeout():
    with pytest.raises(BrainError, match="^timeout$"):
        Brain([], runner=FakeRunner(ProcResult(-1, "", "timeout"))).decide("x")


def test_decide_nonzero_exit():
    with pytest.raises(BrainError, match="bad"):
        Brain([], runner=FakeRunner(ProcResult(2, "", "bad"))).decide("x")


@pytest.mark.parametrize(
    "so",
    [
        {"memory": "m", "next_goal": "g", "actions": []},
        {**GOOD, "actions": [{"cmd": "click"}]},
        {**GOOD, "actions": ["click"]},
        {**GOOD, "actions": [{"cmd": "click", "args": [1]}]},
        {**GOOD, "actions": "x"},
        [1],
    ],
)
def test_malformed_structured_output(so):
    with pytest.raises(BrainError):
        Brain([], runner=FakeRunner(env(structured_output=so))).decide("x")


def test_non_dict_envelope():
    with pytest.raises(BrainError):
        Brain([], runner=FakeRunner(ProcResult(0, "[1]", ""))).decide("x")


def test_error_envelope_carries_cost():
    with pytest.raises(BrainError) as ei:
        Brain([], runner=FakeRunner(env(is_error=True, result="boom", total_cost_usd=0.07))).decide("x")
    assert ei.value.cost == 0.07


def test_brain_error_cost_defaults_to_zero():
    assert BrainError("x").cost == 0.0
    with pytest.raises(BrainError) as ei:
        Brain([], runner=FakeRunner(ProcResult(-1, "", "timeout"))).decide("x")
    assert ei.value.cost == 0.0


def test_parse_failure_after_cost_carries_cost():
    with pytest.raises(BrainError) as ei:
        Brain([], runner=FakeRunner(env(structured_output=None, total_cost_usd=0.02))).decide("x")
    assert ei.value.cost == 0.02


def test_schema_restricts_cmd_to_allowed():
    from duckwright.actions import ALLOWED

    done, expect, other = DECISION_SCHEMA["properties"]["actions"]["items"]["anyOf"]
    assert done["properties"]["cmd"] == {"const": "done"}
    assert expect["properties"]["cmd"] == {"const": "expect"}
    cmds = set(other["properties"]["cmd"]["enum"]) | {"done", "expect"}
    assert cmds == ALLOWED
    assert "playwright-cli" not in cmds


def test_schema_done_requires_status_and_answer():
    item = DECISION_SCHEMA["properties"]["actions"]["items"]
    ok = lambda a: jsonschema.Draft7Validator(item).is_valid(a)  # noqa: E731
    assert ok({"cmd": "done", "args": ["success", "42"]})
    assert ok({"cmd": "done", "args": ["failure", "gave up"]})
    assert not ok({"cmd": "done", "args": []})
    assert not ok({"cmd": "done", "args": ["success"]})
    assert not ok({"cmd": "done", "args": ["42", "x"]})
    assert ok({"cmd": "click", "args": ["e1"]})
    assert not ok({"cmd": "eval", "args": ["1"]})
    assert ok({"cmd": "expect", "args": ["visible", "e1"]})
    assert ok({"cmd": "expect", "args": ["text", "e1", "Hi"]})
    assert ok({"cmd": "expect", "args": ["e1", "text", "Hi"]})
    assert not ok({"cmd": "expect", "args": ["e1", "toHaveText", "Hi"]})
    assert not ok({"cmd": "expect", "args": []})
    assert not ok({"cmd": "expect", "args": ["text", "e1", "a", "b"]})


def test_schema_expect_checks_match_expect_module():
    from duckwright.expect import CHECKS

    expect = DECISION_SCHEMA["properties"]["actions"]["items"]["anyOf"][1]
    assert expect["properties"]["args"]["contains"] == {"enum": list(CHECKS)}


def test_snapshot_dir_argv_and_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fake = FakeRunner(env())
    Brain([], runner=fake, snapshot_dir=Path("runs/r1/page")).decide("P")
    argv, _, timeout = fake.calls[0]
    assert argv[:9] == [
        "claude", "-p", "--output-format", "json",
        "--tools", "Read,Grep", "--allowedTools", "Read,Grep", "--restricted",
    ]
    assert argv[9:12] == [
        "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ]
    assert fake.cwds == [(tmp_path / "runs" / "r1" / "page").resolve()]
    assert fake.cwds[0].is_absolute()
    assert timeout == 120


def test_no_snapshot_dir_keeps_three_arg_call():
    calls = []

    def runner(argv, stdin, timeout):  # no cwd parameter: must still work
        calls.append(argv)
        return env()

    Brain([], runner=runner).decide("P")
    assert "--restricted" not in calls[0]
    assert calls[0][4:6] == ["--tools", ""]


def test_explicit_timeout_wins_in_snapshot_mode():
    fake = FakeRunner(env())
    Brain([], runner=fake, timeout=30, snapshot_dir=Path("p")).decide("P")
    assert fake.calls[0][2] == 30
