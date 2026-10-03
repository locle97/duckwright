import json

import pytest

from pw_agent import __main__ as m
from pw_agent.brain import Action, Decision
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
                "actions": [{"cmd": "click", "args": ["e1"]}],
                "results": ["ok"],
            }
        ],
    }


def test_keyboard_interrupt_writes_history(env, monkeypatch):
    tmp, argv = env

    def stop(self):
        raise KeyboardInterrupt

    monkeypatch.setattr(Agent, "run", stop)
    assert m.main(argv) == 130
    assert _history(tmp)["success"] is False
