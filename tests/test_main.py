import json
import re
from pathlib import Path

import pytest

from duckwright import __main__ as m
from duckwright.brain import Action, Decision
from duckwright.loop import Agent, RunResult
from duckwright.prompt import StepRecord
from duckwright.pw import PlaywrightError


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(m.shutil, "which", lambda n: "/usr/bin/" + n)
    skill = tmp_path / "SKILL.md"
    skill.write_text("x")
    return tmp_path, ["task", "--skill", str(skill)]


def _history(tmp_path):
    files = list(tmp_path.glob("runs/*/*/history.json"))
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
        "task_file": None,
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
    assert len(list(tmp.glob("runs/*/*/history.json"))) == 2


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


def test_version_flag(monkeypatch, capsys):
    monkeypatch.setattr(m, "version", lambda name: "1.2.3")
    with pytest.raises(SystemExit) as e:
        m._parse(["--version"])
    assert e.value.code == 0
    assert capsys.readouterr().out.strip() == "duckwright 1.2.3"


def test_default_session():
    assert m._parse(["x"]).session == "duckwright"


def test_version_unknown_when_not_installed(monkeypatch):
    def missing(name):
        raise m.PackageNotFoundError(name)
    monkeypatch.setattr(m, "version", missing)
    assert m._version() == "unknown"


def test_system_prompt_documents_expect():
    text = m.SYSTEM_MD.read_text()
    assert "screenshot, expect, done" in text
    assert '{"cmd": "expect", "args": ["text", "e15", ' in text
    for check in ("visible", "value", "checked", "unchecked", "url"):
        assert f'"{check}"' in text


GOTO = "await page.goto('https://example.com');"
EXPECT = "await expect(page).toHaveURL(\"https://example.com/\");"


def _write_run(tmp_path, success=True, code=GOTO):
    run_dir = tmp_path / "runs" / "r1"
    run_dir.mkdir(parents=True)
    data = {
        "task": "t", "success": success, "answer": "", "steps": 1, "cost_usd": 0.0,
        "history": [{"step": 1, "actions": [{"cmd": "goto", "args": ["u"], "code": code}],
                     "results": ["ok"]}],
    }
    (run_dir / "history.json").write_text(json.dumps(data))
    return run_dir


def test_export_subcommand_writes_spec(tmp_path, capsys):
    run_dir = _write_run(tmp_path)
    assert m.main(["export", str(run_dir)]) == 0
    spec = run_dir / "duckwright.spec.ts"
    assert spec.is_file()
    assert f"Test: {spec}" in capsys.readouterr().out


def test_export_subcommand_output_flag(tmp_path):
    run_dir = _write_run(tmp_path)
    out = tmp_path / "e2e" / "greet.spec.ts"
    assert m.main(["export", str(run_dir), "-o", str(out)]) == 0
    assert out.is_file()
    assert not (run_dir / "duckwright.spec.ts").exists()


def test_export_skips_preflight(tmp_path, monkeypatch):
    monkeypatch.setattr(m.shutil, "which", lambda n: None)
    assert m.main(["export", str(_write_run(tmp_path))]) == 0


def test_export_failed_run_exits_1(tmp_path, capsys):
    run_dir = _write_run(tmp_path, success=False)
    assert m.main(["export", str(run_dir)]) == 1
    assert "did not succeed" in capsys.readouterr().err
    assert not (run_dir / "duckwright.spec.ts").exists()


def test_export_bad_path_exits_2(tmp_path, capsys):
    assert m.main(["export", str(tmp_path / "nope")]) == 2
    err = capsys.readouterr().err
    assert len(err.strip().splitlines()) == 1
    assert "Traceback" not in err


def test_export_warnings_go_to_stderr(tmp_path, capsys):
    assert m.main(["export", str(_write_run(tmp_path))]) == 0
    assert "warning: no assertions recorded" in capsys.readouterr().err


def _fake_run(monkeypatch, success=True, actions=None, codes=None):
    actions = actions or [Action("goto", ["u"]), Action("expect", ["url", "u"])]
    codes = codes if codes is not None else [GOTO, EXPECT]
    rec = StepRecord(1, Decision("", "", "", actions), ["ok"] * len(actions), codes)

    def run(self):
        self.on_step(rec)
        return RunResult(success, "a", 1, 0.0, [rec])

    monkeypatch.setattr(Agent, "run", run)


def test_run_with_export_writes_spec(env, monkeypatch, capsys):
    tmp, argv = env
    _fake_run(monkeypatch)
    assert m.main(argv + ["--export"]) == 0
    (run_dir,) = tmp.glob("runs/*/*")
    assert (run_dir / "history.json").is_file()
    spec = run_dir / "duckwright.spec.ts"
    assert spec.is_file()
    out = capsys.readouterr().out.strip().splitlines()
    assert out[-2].startswith("History: ")
    assert out[-1] == f"Test: {spec.relative_to(tmp)}"


def test_run_without_export_writes_no_spec(env, monkeypatch):
    tmp, argv = env
    _fake_run(monkeypatch)
    assert m.main(argv) == 0
    assert not list(tmp.glob("runs/*/*/duckwright.spec.ts"))


def test_run_export_on_failed_run(env, monkeypatch, capsys):
    tmp, argv = env
    _fake_run(monkeypatch, success=False)
    assert m.main(argv + ["--export"]) == 1
    assert not list(tmp.glob("runs/*/*/duckwright.spec.ts"))
    assert "Test: not exported (run did not succeed)" in capsys.readouterr().out


def test_run_export_failure_keeps_exit_0(env, monkeypatch, capsys):
    tmp, argv = env
    _fake_run(monkeypatch, actions=[Action("done", ["success", "a"])], codes=[None])
    assert m.main(argv + ["--export"]) == 0
    assert len(list(tmp.glob("runs/*/*/history.json"))) == 1
    assert "export failed: nothing to export" in capsys.readouterr().err


def _task_file(tmp, text, name="tasks/t.md"):
    p = tmp / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return name


def _record_run(monkeypatch, success=True):
    seen = {}

    def run(self):
        seen.update(
            task=self.task, max_steps=self.max_steps, headed=self.headed,
            state=self.state, model=self.brain.model,
        )
        return RunResult(success, "a", 1, 0.0, [])

    monkeypatch.setattr(Agent, "run", run)
    return seen


def test_file_runs_body_with_settings(env, monkeypatch):
    tmp, argv = env
    f = _task_file(tmp, "---\nmax-steps: 7\nheaded: true\nmodel: opus\n---\nOpen a\nthen b\n")
    seen = _record_run(monkeypatch)
    assert m.main(argv[1:] + ["-f", f]) == 0
    assert seen == {
        "task": "Open a\nthen b", "max_steps": 7, "headed": True, "state": None, "model": "opus",
    }
    data = _history(tmp)
    assert data["task"] == "Open a\nthen b"
    assert data["task_file"] == "tasks/t.md"


def test_cli_flag_beats_file(env, monkeypatch):
    tmp, argv = env
    f = _task_file(tmp, "---\nmax-steps: 7\nexport: true\n---\nGo\n")
    _fake_run(monkeypatch)
    seen = {}
    orig = Agent.run

    def run(self):
        seen["max_steps"] = self.max_steps
        return orig(self)

    monkeypatch.setattr(Agent, "run", run)
    assert m.main(argv[1:] + ["-f", f, "--max-steps", "3", "--no-export"]) == 0
    assert seen["max_steps"] == 3
    assert not list(tmp.glob("runs/*/*/duckwright.spec.ts"))


def test_file_export_setting_writes_spec(env, monkeypatch):
    tmp, argv = env
    f = _task_file(tmp, "---\nexport: true\n---\nGo\n")
    _fake_run(monkeypatch)
    assert m.main(argv[1:] + ["-f", f]) == 0
    assert len(list(tmp.glob("runs/*/*/duckwright.spec.ts"))) == 1


def test_cli_state_relative_to_cwd_with_file(env, monkeypatch):
    tmp, argv = env
    f = _task_file(tmp, "---\nstate: auth.json\n---\nGo\n")
    (tmp / "tasks" / "auth.json").write_text("{}")
    (tmp / "cli.json").write_text("{}")
    seen = _record_run(monkeypatch)
    assert m.main(argv[1:] + ["-f", f]) == 0
    assert seen["state"] == (tmp / "tasks" / "auth.json").resolve()
    assert m.main(argv[1:] + ["-f", f, "--state", "cli.json"]) == 0
    assert seen["state"] == (tmp / "cli.json").resolve()


def test_task_and_file_exits_2(env, capsys):
    tmp, argv = env
    f = _task_file(tmp, "Go\n")
    with pytest.raises(SystemExit) as e:
        m.main(argv + ["-f", f])
    assert e.value.code == 2
    assert "give a task or --file, not both" in capsys.readouterr().err
    assert not (tmp / "runs").exists()


def test_neither_task_nor_file_exits_2(env, capsys):
    tmp, argv = env
    with pytest.raises(SystemExit) as e:
        m.main(argv[1:])
    assert e.value.code == 2
    assert "error: give a task or --file" in capsys.readouterr().err


def test_file_error_exits_2_without_runs(env, monkeypatch, capsys):
    tmp, argv = env
    f = _task_file(tmp, "---\nmodel:\n---\nGo\n")

    def never(self):
        raise AssertionError("should not run")

    monkeypatch.setattr(Agent, "run", never)
    assert m.main(argv[1:] + ["-f", f]) == 2
    assert capsys.readouterr().err == 'tasks/t.md:2: "model" has no value\n'
    assert not (tmp / "runs").exists()


def test_file_task_file_on_failure_path(env, monkeypatch):
    tmp, argv = env
    f = _task_file(tmp, "Go\n")

    def fail(self):
        raise PlaywrightError("snapshot died")

    monkeypatch.setattr(Agent, "run", fail)
    assert m.main(argv[1:] + ["-f", f]) == 1
    data = _history(tmp)
    assert data["task_file"] == "tasks/t.md"
    assert data["task"] == "Go"


def test_plain_task_has_null_task_file(env, monkeypatch):
    tmp, argv = env
    _record_run(monkeypatch)
    assert m.main(argv) == 0
    assert _history(tmp)["task_file"] is None


def test_task_named_export_still_runs(env, monkeypatch):
    tmp, argv = env
    seen = _record_run(monkeypatch)
    assert m.main(["--skill", argv[2], "--", "export"]) == 0
    assert seen["task"] == "export"


def _record_runs(monkeypatch, outcomes):
    calls = []
    outcomes = list(outcomes)

    def run(self):
        calls.append((self.task, self.max_steps, self.headed, self.brain.model))
        out = outcomes.pop(0)
        if isinstance(out, BaseException):
            raise out
        return RunResult(out, "a", 1, 0.0, [])

    monkeypatch.setattr(Agent, "run", run)
    return calls


def _histories(tmp):
    return [json.loads(p.read_text()) for p in sorted(tmp.glob("runs/*/*/history.json"))]


def _summary(out: str) -> list[str]:
    lines = out.splitlines()
    i = next(i for i, l in enumerate(lines) if l.startswith("Batch: "))
    return [re.sub(r"runs/\S+/history.json", "runs/<id>/history.json", l) for l in lines[i:]]


def _never(monkeypatch):
    def never(self):
        raise AssertionError("should not run")

    monkeypatch.setattr(Agent, "run", never)


def test_single_file_output_unchanged(env, monkeypatch, capsys):
    tmp, argv = env
    f = _task_file(tmp, "Go\n")
    _record_runs(monkeypatch, [True])
    assert m.main(argv[1:] + ["-f", f]) == 0
    out = capsys.readouterr().out
    assert "[1/1]" not in out and "Batch:" not in out
    assert out.splitlines()[0] == "Result: success"


def test_single_file_from_folder_is_a_single_run(env, monkeypatch, capsys):
    tmp, argv = env
    _task_file(tmp, "Go\n", "tasks/a.md")
    _record_runs(monkeypatch, [True])
    assert m.main(argv[1:] + ["-f", "tasks"]) == 0
    assert "Batch:" not in capsys.readouterr().out
    assert _history(tmp)["task_file"] == "tasks/a.md"


def test_batch_runs_files_in_order_with_own_settings(env, monkeypatch):
    tmp, argv = env
    a = _task_file(tmp, "---\nmax-steps: 7\nheaded: true\n---\nA\n", "tasks/a.md")
    b = _task_file(tmp, "B\n", "tasks/b.md")
    calls = _record_runs(monkeypatch, [True, True])
    assert m.main(argv[1:] + ["-f", a, b]) == 0
    assert calls == [("A", 7, True, "sonnet"), ("B", 25, False, "sonnet")]
    assert sorted(h["task_file"] for h in _histories(tmp)) == ["tasks/a.md", "tasks/b.md"]


def test_batch_cli_flag_applies_to_all(env, monkeypatch):
    tmp, argv = env
    a = _task_file(tmp, "---\nmax-steps: 7\n---\nA\n", "tasks/a.md")
    b = _task_file(tmp, "B\n", "tasks/b.md")
    calls = _record_runs(monkeypatch, [True, True])
    assert m.main(argv[1:] + ["-f", a, b, "--max-steps", "3", "--model", "opus"]) == 0
    assert calls == [("A", 3, False, "opus"), ("B", 3, False, "opus")]


def test_batch_from_folder(env, monkeypatch):
    tmp, argv = env
    _task_file(tmp, "B\n", "tasks/b.md")
    _task_file(tmp, "A\n", "tasks/a.md")
    _task_file(tmp, "{}", "tasks/auth.json")
    calls = _record_runs(monkeypatch, [True, True])
    assert m.main(argv[1:] + ["-f", "tasks"]) == 0
    assert [c[0] for c in calls] == ["A", "B"]
    assert sorted(h["task_file"] for h in _histories(tmp)) == ["tasks/a.md", "tasks/b.md"]


def test_repeated_file_flag_extends(env, monkeypatch):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    b = _task_file(tmp, "B\n", "tasks/b.md")
    calls = _record_runs(monkeypatch, [True, True])
    assert m.main(argv[1:] + ["-f", a, "-f", b]) == 0
    assert [c[0] for c in calls] == ["A", "B"]


def test_batch_failure_continues_and_exits_1(env, monkeypatch, capsys):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    b = _task_file(tmp, "B\n", "tasks/b.md")
    calls = _record_runs(monkeypatch, [False, True])
    assert m.main(argv[1:] + ["-f", a, b]) == 1
    assert len(calls) == 2
    out = capsys.readouterr().out
    assert "[1/2] tasks/a.md" in out.splitlines()
    assert "[2/2] tasks/b.md" in out.splitlines()
    assert _summary(out) == [
        "Batch: 1 passed, 1 failed, 0 not run",
        "fail  tasks/a.md  runs/<id>/history.json",
        "pass  tasks/b.md  runs/<id>/history.json",
    ]


def test_batch_crash_counts_as_fail(env, monkeypatch):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    b = _task_file(tmp, "B\n", "tasks/b.md")
    calls = _record_runs(monkeypatch, [PlaywrightError("x"), True])
    assert m.main(argv[1:] + ["-f", a, b]) == 1
    assert len(calls) == 2


def test_batch_all_pass_exits_0(env, monkeypatch, capsys):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    b = _task_file(tmp, "B\n", "tasks/b.md")
    _record_runs(monkeypatch, [True, True])
    assert m.main(argv[1:] + ["-f", a, b]) == 0
    assert _summary(capsys.readouterr().out)[0] == "Batch: 2 passed, 0 failed, 0 not run"


def test_batch_bad_file_runs_nothing(env, monkeypatch, capsys):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    b = _task_file(tmp, "---\nmodel:\n---\nGo\n", "tasks/b.md")
    c = _task_file(tmp, "", "tasks/c.md")
    _never(monkeypatch)
    assert m.main(argv[1:] + ["-f", a, b, c]) == 2
    assert capsys.readouterr().err == 'tasks/b.md:2: "model" has no value\ntasks/c.md: no task text\n'
    assert not (tmp / "runs").exists()


def test_batch_preflight_failure_runs_nothing(env, monkeypatch, capsys):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    b = _task_file(tmp, "---\nstate: nope.json\n---\nGo\n", "tasks/b.md")
    _never(monkeypatch)
    assert m.main(argv[1:] + ["-f", a, b]) == 2
    err = capsys.readouterr().err.splitlines()
    assert len(err) == 1 and err[0].startswith("tasks/b.md: state file not found: ")
    assert not (tmp / "runs").exists()


def test_batch_interrupt_stops_and_summarises(env, monkeypatch, capsys):
    tmp, argv = env
    files = [_task_file(tmp, f"{n}\n", f"tasks/{n}.md") for n in "abc"]
    calls = _record_runs(monkeypatch, [KeyboardInterrupt(), True, True])
    assert m.main(argv[1:] + ["-f", *files]) == 130
    assert len(calls) == 1
    assert _history(tmp)["answer"] == "interrupted"
    assert _summary(capsys.readouterr().out) == [
        "Batch: 0 passed, 0 failed, 2 not run",
        "stop  tasks/a.md  runs/<id>/history.json",
        "skip  tasks/b.md  -",
        "skip  tasks/c.md  -",
    ]


def test_task_after_file_is_read_as_file(env, monkeypatch, capsys):
    tmp, argv = env
    a = _task_file(tmp, "A\n", "tasks/a.md")
    _never(monkeypatch)
    assert m.main(argv[1:] + ["-f", a, "Open the site"]) == 2
    assert capsys.readouterr().err == "Open the site: file not found\n"
    assert not (tmp / "runs").exists()


def test_empty_folder_exits_2(env, monkeypatch, capsys):
    tmp, argv = env
    _task_file(tmp, "{}", "tasks/auth.json")
    _never(monkeypatch)
    assert m.main(argv[1:] + ["-f", "tasks"]) == 2
    assert capsys.readouterr().err == "tasks: no task files (.md or .txt)\n"
    assert not (tmp / "runs").exists()


def test_batch_reports_folder_and_file_errors_in_order(env, monkeypatch, capsys):
    tmp, argv = env
    _task_file(tmp, "---\nfoo: 1\n---\nGo\n", "bad.md")
    _task_file(tmp, "{}", "empty/auth.json")
    _task_file(tmp, "{}", "none/auth.json")
    _never(monkeypatch)
    assert m.main(argv[1:] + ["-f", "bad.md", "empty/", "none"]) == 2
    assert capsys.readouterr().err == (
        'bad.md:2: unknown setting "foo"\n'
        "empty/: no task files (.md or .txt)\n"
        "none: no task files (.md or .txt)\n"
    )
    assert not (tmp / "runs").exists()


def test_unstattable_file_is_a_one_line_error(env, monkeypatch, capsys):
    tmp, argv = env
    _never(monkeypatch)
    assert m.main(argv[1:] + ["-f", "a" * 300]) == 2
    err = capsys.readouterr().err
    assert err.startswith("a" * 300 + ": cannot read: ") and "Traceback" not in err


def test_inline_task_grouped_by_task_text(env, monkeypatch):
    tmp, argv = env
    _record_runs(monkeypatch, [True])
    assert m.main(["Open the site", *argv[1:]]) == 0
    (d,) = tmp.glob("runs/*/*/history.json")
    assert d.parent.parent.name == "open-the-site"
    assert re.fullmatch(r"\d{8}-\d{6}-\d{6}", d.parent.name)


def test_name_flag_sets_group(env, monkeypatch):
    tmp, argv = env
    _record_runs(monkeypatch, [True])
    assert m.main([*argv, "--name", "Smoke Test"]) == 0
    assert len(list(tmp.glob("runs/smoke-test/*/history.json"))) == 1


def test_task_file_grouped_by_stem(env, monkeypatch):
    tmp, argv = env
    _task_file(tmp, "Do it", name="tasks/Login Flow.md")
    _record_runs(monkeypatch, [True])
    assert m.main(["-f", "tasks/Login Flow.md", *argv[1:]]) == 0
    assert len(list(tmp.glob("runs/login-flow/*/history.json"))) == 1


def test_task_file_name_key_beats_stem(env, monkeypatch):
    tmp, argv = env
    _task_file(tmp, "---\nname: checkout\n---\nDo it")
    _record_runs(monkeypatch, [True])
    assert m.main(["-f", "tasks/t.md", *argv[1:]]) == 0
    assert len(list(tmp.glob("runs/checkout/*/history.json"))) == 1


def test_batch_same_stem_shares_group(env, monkeypatch, capsys):
    tmp, argv = env
    _task_file(tmp, "A", name="a/login.md")
    _task_file(tmp, "B", name="b/login.md")
    _record_runs(monkeypatch, [True, True])
    assert m.main(["-f", "a/login.md", "b/login.md", *argv[1:]]) == 0
    assert len(list(tmp.glob("runs/login/*/history.json"))) == 2
    rows = [l for l in capsys.readouterr().out.splitlines() if l.startswith("pass  ")]
    assert len({r.split("  ")[2] for r in rows}) == 2
