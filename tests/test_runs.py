import json
from datetime import datetime
from pathlib import Path

from duckwright.runs import RunInfo, find_runs, format_run, matches, new_run_dir, slugify


def _hist(d, task, success=True, steps=2, cost=0.01, task_file=None):
    d.mkdir(parents=True, exist_ok=True)
    data = {
        "task": task, "task_file": task_file, "success": success, "answer": "",
        "steps": steps, "cost_usd": cost, "history": [],
    }
    (d / "history.json").write_text(json.dumps(data))
    return d


def test_slugify_basic():
    assert slugify("Go to example.com and report") == "go-to-example-com-and-report"
    assert slugify("Café Login") == "cafe-login"
    assert slugify("  --Hello__World--  ") == "hello-world"


def test_slugify_falls_back_to_task():
    assert slugify("検索して") == "task"
    assert slugify("!!!") == "task"
    assert slugify("") == "task"


def test_slugify_truncates_on_word_boundary():
    s = slugify("Open https://example.com/form, enter the name Linh, submit, and check")
    assert s == "open-https-example-com-form-enter-the"
    assert len(slugify("a" * 100)) == 40


def test_slugify_cannot_escape():
    assert slugify("../../etc/passwd") == "etc-passwd"
    assert "/" not in slugify("a/b\\c")


def test_slugify_windows_reserved():
    assert slugify("CON") == "con-task"
    assert slugify("lpt1") == "lpt1-task"
    assert slugify("console") == "console"


def test_new_run_dir_layout(tmp_path):
    d = new_run_dir("tasks/Login", tmp_path / "runs", datetime(2026, 10, 3, 10, 15, 0, 123456))
    assert d == tmp_path / "runs" / "tasks-login" / "20261003-101500-123456"
    assert d.is_dir()


def test_find_runs_mixed_layouts(tmp_path):
    root = tmp_path / "runs"
    _hist(root / "20261001-090000-000001", "old")
    _hist(root / "greet" / "20261003-101500-123456", "new", task_file="tasks/greet.md")
    (root / "notes.txt").write_text("x")
    (root / "greet" / "stray.json").write_text("{}")
    runs, warnings = find_runs(root)
    assert [r.task for r in runs] == ["new", "old"]
    assert [r.group for r in runs] == ["greet", None]
    assert runs[0].task_file == "tasks/greet.md"
    assert warnings == []


def test_find_runs_warns_on_bad_history(tmp_path):
    root = tmp_path / "runs"
    (root / "x" / "20261003-101500-123456").mkdir(parents=True)
    (root / "x" / "20261003-101500-123456" / "history.json").write_text("{nope")
    runs, warnings = find_runs(root)
    assert runs == [] and len(warnings) == 1 and warnings[0].startswith("skipped ")


def test_find_runs_missing_root(tmp_path):
    assert find_runs(tmp_path / "runs") == ([], [])


def test_matches_group_task_file_and_task():
    r = RunInfo(Path("runs/greet/1"), "greet", "1", True, 1, 0.0, "Say Hello", "tasks/g.md")
    assert matches(r, "GREET") and matches(r, "tasks/g") and matches(r, "hello")
    assert not matches(r, "login")


def test_format_run():
    r = RunInfo(Path("runs/greet/20261003-101500-123456"), "greet", "20261003-101500-123456",
                False, 25, 0.21041, "Open https://example.com/form,\n  enter the name Linh", None)
    assert format_run(r) == (
        "2026-10-03 10:15  fail  25 steps  $0.2104  runs/greet/20261003-101500-123456  "
        "Open https://example.com/form, enter the…"
    )


def test_format_run_unparsed_timestamp_and_short_task():
    r = RunInfo(Path("runs/weird"), None, "weird", True, 3, 0.0, "Hi", None)
    assert format_run(r) == "weird  pass   3 steps  $0.0000  runs/weird  Hi"


def test_slugify_keeps_word_ending_at_cut():
    assert slugify("a" * 35 + "-bbbb-cc") == "a" * 35 + "-bbbb"


def test_find_runs_unstamped_folders_sort_last(tmp_path):
    root = tmp_path / "runs"
    _hist(root / "greet" / "backup", "copy")
    _hist(root / "greet" / "20261003-101500-123456", "real")
    runs, _ = find_runs(root)
    assert [r.task for r in runs] == ["real", "copy"]
