import random
import re
from datetime import datetime

from duckwright import rundir
from duckwright.rundir import make_run_dir, random_label, run_label, slugify

NOW = datetime(2026, 10, 3, 10, 15, 0)


def test_slugify():
    assert slugify("01-todomvc") == "01-todomvc"
    assert slugify("  My Login_Flow!! ") == "my-login-flow"
    assert slugify("Đăng nhập") == "dang-nhap"
    assert slugify("Café Crème") == "cafe-creme"
    assert slugify("日本語") == ""
    assert slugify("a" * 39 + "-bbb") == "a" * 39


def test_label_from_task_file_stem():
    assert run_label("benchmark_tasks/01-todomvc.md") == "01-todomvc"
    assert run_label("tasks/Check Out.txt") == "check-out"


def test_label_random_words_without_file_or_usable_name(monkeypatch):
    monkeypatch.setattr(rundir, "random_label", lambda: "brave-otter")
    assert run_label(None) == "brave-otter"
    assert run_label("tasks/日本語.md") == "brave-otter"


def test_random_label_shape():
    label = random_label(random.Random(0))
    adj, noun = label.split("-")
    assert adj in rundir.ADJECTIVES and noun in rundir.NOUNS


def test_make_run_dir_names_and_clashes(tmp_path):
    root = tmp_path / "runs"
    first = make_run_dir(root, "tasks/login.md", NOW)
    second = make_run_dir(root, "tasks/login.md", NOW)
    third = make_run_dir(root, "tasks/login.md", NOW)
    assert [p.name for p in (first, second, third)] == [
        "20261003-101500-login", "20261003-101500-login-2", "20261003-101500-login-3",
    ]
    assert all(p.is_dir() for p in (first, second, third))


def test_make_run_dir_command_line_task(tmp_path):
    path = make_run_dir(tmp_path / "runs", None, NOW)
    assert re.fullmatch(r"20261003-101500-[a-z]+-[a-z]+", path.name)
