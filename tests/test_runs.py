from datetime import datetime

from duckwright.runs import new_run_dir, slugify


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
