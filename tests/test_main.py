import json
import re
from pathlib import Path

import pytest

from pw_agent import __main__ as m
from pw_agent.brain import Action, Brain, Decision
from pw_agent.jev import HybridBrain, JevAuthError
from pw_agent.loop import Agent
from pw_agent.prompt import StepRecord
from pw_agent.pw import PlaywrightError


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(m.shutil, "which", lambda n: "/usr/bin/" + n)
    skill = tmp_path / "SKILL.md"
    skill.write_text("x")
    return tmp_path, ["task", "--skill", str(skill)]


def _history(tmp_path):
    files = list(tmp_path.glob("runs/*/history.json"))
    assert len(files) == 1
    return json.loads(files[0].read_text())


def test_oserror_writes_history(env, monkeypatch, capsys):
    tmp, argv = env

    def boom(self):
        raise OSError("claude vanished")

    monkeypatch.setattr(Agent, "run", boom)
    assert m.main(argv) == 1
    data = _history(tmp)
    assert data["success"] is False
    assert data["answer"] == "error: OSError: claude vanished"
    assert "OSError" in capsys.readouterr().err


def test_playwright_error_history_shape(env, monkeypatch):
    tmp, argv = env
    rec = StepRecord(
        1,
        Decision("ev", "mem", "goal", [Action("click", ["e1"])]),
        ["ok"],
        ["await page.getByRole('button', { name: 'Go' }).click();"],
    )

    def fail(self):
        self.on_step(rec)
        raise PlaywrightError("snapshot died")

    monkeypatch.setattr(Agent, "run", fail)
    assert m.main(argv) == 1
    data = _history(tmp)
    assert data == {
        "task": "task",
        "success": False,
        "answer": "playwright error: snapshot died",
        "steps": 1,
        "cost_usd": 0.0,
        "history": [
            {
                "step": 1,
                "evaluation_previous_goal": "ev",
                "memory": "mem",
                "next_goal": "goal",
                "actions": [
                    {
                        "cmd": "click",
                        "args": ["e1"],
                        "code": "await page.getByRole('button', { name: 'Go' }).click();",
                    }
                ],
                "results": ["ok"],
                "source": "claude",
                "cost_usd": 0.0,
                "jev": None,
            }
        ],
        "jev_steps": 0,
        "claude_steps": 1,
    }


def test_history_json_defaults_for_records_without_codes():
    rec = StepRecord(1, Decision("", "", "", [Action("click", ["e1"])]), ["brain error: x"])
    step = m._history_json("t", False, "a", 1, 0.0, [rec])["history"][0]
    assert step["actions"] == [{"cmd": "click", "args": ["e1"], "code": None}]


def test_keyboard_interrupt_writes_history(env, monkeypatch):
    tmp, argv = env

    def stop(self):
        raise KeyboardInterrupt

    monkeypatch.setattr(Agent, "run", stop)
    assert m.main(argv) == 130
    assert _history(tmp)["success"] is False


def test_failure_history_records_running_cost(env, monkeypatch):
    tmp, argv = env

    def fail(self):
        self.cost_usd = 0.42
        raise PlaywrightError("snapshot died")

    monkeypatch.setattr(Agent, "run", fail)
    assert m.main(argv) == 1
    assert _history(tmp)["cost_usd"] == 0.42


def test_missing_system_md_exits_2(env, monkeypatch, capsys):
    tmp, argv = env
    monkeypatch.setattr(m, "SYSTEM_MD", tmp / "nope" / "system.md")

    def never(self):
        raise AssertionError("should not run")

    monkeypatch.setattr(Agent, "run", never)
    assert m.main(argv) == 2
    assert "system prompt not found" in capsys.readouterr().err
    assert not (tmp / "runs").exists()


def test_default_skill_is_cwd_relative():
    assert m.DEFAULT_SKILL == "prompts/playwright-cli.md"


def test_agent_skill_omits_find_and_eval():
    text = (Path(__file__).parent.parent / m.DEFAULT_SKILL).read_text()
    assert re.search(r"\b(find|eval)\b", text) is None


def test_run_dirs_do_not_collide(env, monkeypatch):
    tmp, argv = env

    class R:
        success, answer, steps, cost_usd, history = True, "a", 1, 0.0, []

    monkeypatch.setattr(Agent, "run", lambda self: R())
    assert m.main(argv) == 0
    assert m.main(argv) == 0
    assert len(list(tmp.glob("runs/*/history.json"))) == 2


def test_allow_file_access_help_warns(capsys):
    with pytest.raises(SystemExit):
        m._parse(["--help"])
    out = " ".join(capsys.readouterr().out.split())
    assert "trusted" in out


def test_missing_state_file_exits_2(env, monkeypatch, capsys):
    tmp, argv = env

    def never(self):
        raise AssertionError("should not run")

    monkeypatch.setattr(Agent, "run", never)
    assert m.main(argv + ["--state", "nope.json"]) == 2
    assert "state file not found" in capsys.readouterr().err


def test_state_passed_to_agent_as_absolute_path(env, monkeypatch):
    tmp, argv = env
    (tmp / "auth.json").write_text("{}")
    seen = {}

    class R:
        success, answer, steps, cost_usd, history = True, "a", 1, 0.0, []

    def run(self):
        seen["state"] = self.state
        return R()

    monkeypatch.setattr(Agent, "run", run)
    assert m.main(argv + ["--state", "auth.json"]) == 0
    assert seen["state"] == tmp / "auth.json"
    assert seen["state"].is_absolute()


def test_system_prompt_says_browser_is_open():
    text = (Path(__file__).resolve().parent.parent / "prompts" / "system.md").read_text()
    assert "browser is already open" in text
    assert "no `open` command" in text


def _never_run(monkeypatch):
    def never(self):
        raise AssertionError("should not run")

    monkeypatch.setattr(Agent, "run", never)


def test_jev_requires_api_key(env, monkeypatch, capsys):
    tmp, argv = env
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    _never_run(monkeypatch)
    assert m.main(argv + ["--jev"]) == 2
    assert "TYPESAFE_API_KEY" in capsys.readouterr().err
    assert not (tmp / "runs").exists()


def test_jev_empty_api_key_exits_2(env, monkeypatch, capsys):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    _never_run(monkeypatch)
    assert m.main(argv + ["--jev"]) == 2
    assert "TYPESAFE_API_KEY" in capsys.readouterr().err
    assert not (tmp / "runs").exists()


@pytest.mark.parametrize("bad", ["1.5", "-0.1"])
def test_jev_threshold_out_of_range(env, monkeypatch, capsys, bad):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    _never_run(monkeypatch)
    assert m.main(argv + ["--jev", "--jev-threshold", bad]) == 2
    assert "--jev-threshold" in capsys.readouterr().err
    assert not (tmp / "runs").exists()


def test_jev_threshold_validated_without_jev(env, monkeypatch, capsys):
    tmp, argv = env
    _never_run(monkeypatch)
    assert m.main(argv + ["--jev-threshold", "2"]) == 2
    assert "--jev-threshold" in capsys.readouterr().err


@pytest.mark.parametrize("ok", ["0", "1"])
def test_jev_threshold_bounds_allowed(env, monkeypatch, ok):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")

    class R:
        success, answer, steps, cost_usd, history = True, "a", 1, 0.0, []

    monkeypatch.setattr(Agent, "run", lambda self: R())
    assert m.main(argv + ["--jev", "--jev-threshold", ok]) == 0


def test_jev_builds_hybrid_brain(env, monkeypatch):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    seen = {}

    class R:
        success, answer, steps, cost_usd, history = True, "a", 1, 0.0, []

    def run(self):
        seen["brain"] = self.brain
        return R()

    monkeypatch.setattr(Agent, "run", run)
    assert m.main(argv + ["--jev", "--jev-threshold", "0.7"]) == 0
    brain = seen["brain"]
    assert isinstance(brain, HybridBrain)
    assert brain.min_confidence == 0.7
    assert brain.jev.api_key == "k"
    assert isinstance(brain.claude, Brain)


def test_without_jev_brain_is_claude(env, monkeypatch):
    tmp, argv = env
    seen = {}

    class R:
        success, answer, steps, cost_usd, history = True, "a", 1, 0.0, []

    def run(self):
        seen["brain"] = self.brain
        return R()

    monkeypatch.setattr(Agent, "run", run)
    assert m.main(argv) == 0
    assert isinstance(seen["brain"], Brain)
    assert not isinstance(seen["brain"], HybridBrain)


def test_jev_auth_error_exits_1_and_writes_history(env, monkeypatch, capsys):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    rec = StepRecord(1, Decision("e", "m", "g", [Action("goto", ["u"])]), ["ok"], [None])

    def fail(self):
        self.on_step(rec)
        raise JevAuthError("401")

    monkeypatch.setattr(Agent, "run", fail)
    assert m.main(argv + ["--jev"]) == 1
    msg = "jev error: invalid TYPESAFE_API_KEY"
    assert msg in capsys.readouterr().err
    data = _history(tmp)
    assert data["answer"] == msg
    assert data["success"] is False
    assert len(data["history"]) == 1


def _routing_records():
    jev_rec = StepRecord(
        2,
        Decision(
            "", "m", "g", [Action("click", ["e3"])], source="jev",
            jev={"action": "click", "action_confidence": .9, "target": "e3",
                 "target_confidence": .9, "routed": "accepted"},
        ),
        ["ok"], [None], cost=1e-6,
    )
    cl_rec = StepRecord(1, Decision("e", "m", "g", [Action("goto", ["u"])]), ["ok"], [None], cost=0.5)
    return cl_rec, jev_rec


def test_history_json_routing_fields():
    cl_rec, jev_rec = _routing_records()
    data = m._history_json("t", True, "a", 2, 0.500001, [cl_rec, jev_rec])
    assert (data["jev_steps"], data["claude_steps"]) == (1, 1)
    s1, s2 = data["history"]
    assert (s1["source"], s1["cost_usd"], s1["jev"]) == ("claude", 0.5, None)
    assert (s2["source"], s2["cost_usd"], s2["jev"]["routed"]) == ("jev", 1e-6, "accepted")


def test_prints_jev_steps_only_with_jev(env, monkeypatch, capsys):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    cl_rec, jev_rec = _routing_records()

    class R:
        success, answer, steps, cost_usd, history = True, "a", 2, 0.5, [cl_rec, jev_rec]

    monkeypatch.setattr(Agent, "run", lambda self: R())
    assert m.main(argv + ["--jev"]) == 0
    lines = capsys.readouterr().out.splitlines()
    i = next(i for i, l in enumerate(lines) if l.startswith("Steps:"))
    assert lines[i + 1] == "Jev steps: 1/2"
    assert m.main(argv) == 0
    assert "Jev steps" not in capsys.readouterr().out


@pytest.mark.parametrize("bad", ["k\r", "k k", "k\n", "k\x1b"])
def test_jev_api_key_with_whitespace_exits_2(env, monkeypatch, capsys, bad):
    tmp, argv = env
    monkeypatch.setenv("TYPESAFE_API_KEY", bad)
    _never_run(monkeypatch)
    assert m.main(argv + ["--jev"]) == 2
    err = capsys.readouterr().err
    assert "whitespace or control characters" in err and "k\r" not in err and "k k" not in err
    assert not (tmp / "runs").exists()
