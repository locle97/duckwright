import json
import re
from pathlib import Path

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
            }
        ],
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


def test_default_prompts_live_in_package():
    pkg = Path(m.__file__).resolve().parent
    assert m.SYSTEM_MD == pkg / "prompts" / "system.md"
    assert m.DEFAULT_SKILL == pkg / "prompts" / "playwright-cli.md"
    assert m.SYSTEM_MD.is_file() and m.DEFAULT_SKILL.is_file()


def test_default_prompts_found_from_any_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # not the repo root
    monkeypatch.setattr(m.shutil, "which", lambda n: "/usr/bin/" + n)
    args = m._parse(["task"])
    assert m._preflight(Path(args.skill), None) is None


def test_relative_skill_resolves_against_cwd(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(m.shutil, "which", lambda n: "/usr/bin/" + n)
    (tmp_path / "my-skill.md").write_text("x")
    assert m._preflight(Path(m._parse(["t", "--skill", "my-skill.md"]).skill), None) is None
    assert "skill not found" in m._preflight(Path(m._parse(["t", "--skill", "nope.md"]).skill), None)


def test_agent_skill_omits_find_and_eval():
    text = m.DEFAULT_SKILL.read_text()
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
    text = m.SYSTEM_MD.read_text()
    assert "browser is already open" in text
    assert "no `open` command" in text
