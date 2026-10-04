from pathlib import Path

import pytest

from duckwright.taskfile import TaskFileError, expand_task_paths, load_task_file, task_paths

ROOT = Path(__file__).resolve().parent.parent


def _w(tmp_path, text, name="t.md") -> Path:
    p = tmp_path / name
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        p.write_bytes(text)
    else:
        p.write_text(text, encoding="utf-8")
    return p


def _err(path) -> str:
    with pytest.raises(TaskFileError) as e:
        load_task_file(path)
    return str(e.value)


def test_body_only(tmp_path):
    tf = load_task_file(_w(tmp_path, "  Open a\nthen b \n\n"))
    assert tf.task == "Open a\nthen b"
    assert tf.settings == {}
    assert tf.base_dir == tmp_path.resolve()


def test_front_matter_and_body(tmp_path):
    p = _w(
        tmp_path,
        "---\nmodel: opus\nmax-steps: 15\nheaded: true\nexport: false\nsession: s1\n---\nGo\n",
    )
    tf = load_task_file(p)
    assert tf.settings == {
        "model": "opus", "max_steps": 15, "headed": True, "export": False, "session": "s1",
    }
    assert tf.task == "Go"


def test_comments_and_quotes(tmp_path):
    p = _w(tmp_path, '---\n# c\n\nmodel: sonnet   # trailing\nsession: "a # b"  # c\n---\nGo')
    assert load_task_file(p).settings == {"model": "sonnet", "session": "a # b"}


def test_quoted_typed_values(tmp_path):
    p = _w(tmp_path, "---\nexport: \"true\"\nmax-steps: '15'\n---\nGo")
    assert load_task_file(p).settings == {"export": True, "max_steps": 15}


@pytest.mark.parametrize("mode", ["full", "grep", "hybrid"])
def test_snapshot_setting(tmp_path, mode):
    p = _w(tmp_path, f"---\nsnapshot: {mode}\n---\nGo")
    assert load_task_file(p).settings == {"snapshot": mode}


def test_bad_snapshot_setting_is_a_located_error(tmp_path):
    p = _w(tmp_path, "---\nsnapshot: fast\n---\nGo")
    with pytest.raises(TaskFileError, match=r':2: snapshot must be full, grep or hybrid, got "fast"$'):
        load_task_file(p)


def test_bom_and_crlf(tmp_path):
    tf = load_task_file(_w(tmp_path, b"\xef\xbb\xbf---\r\nmodel: opus\r\n---\r\nGo\r\n"))
    assert tf.settings == {"model": "opus"}
    assert tf.task == "Go"


def test_closing_rule_allows_trailing_space(tmp_path):
    tf = load_task_file(_w(tmp_path, "---  \nmodel: x\n---\t\nGo"))
    assert tf.settings == {"model": "x"}
    assert tf.task == "Go"


def test_paths_resolve_from_file_dir(tmp_path):
    p = _w(tmp_path, "---\nstate: auth.json\nskill: ../s.md\n---\nGo", name="tasks/t.md")
    s = load_task_file(p).settings
    assert s["state"] == str((tmp_path / "tasks" / "auth.json").resolve())
    assert s["skill"] == str((tmp_path / "s.md").resolve())


def test_tilde_path_expanded(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    p = _w(tmp_path, "---\nstate: ~/a.json\n---\nGo", name="sub/t.md")
    assert load_task_file(p).settings["state"] == str((tmp_path / "a.json").resolve())


def test_body_rule_is_kept(tmp_path):
    assert load_task_file(_w(tmp_path, "---\nmodel: x\n---\nA\n---\nB")).task == "A\n---\nB"


def test_body_hash_lines_are_kept(tmp_path):
    text = "# Login\n\nOpen a  # not a comment"
    assert load_task_file(_w(tmp_path, text + "\n")).task == text


def test_value_keeps_colon_and_unspaced_hash(tmp_path):
    p = _w(tmp_path, "---\nsession: team:a#1\n---\nGo")
    assert load_task_file(p).settings == {"session": "team:a#1"}


def test_hash_without_space_is_kept(tmp_path):
    p = _w(tmp_path, "---\nmodel:#x\nsession: #gone\n---\nGo")
    with pytest.raises(TaskFileError, match='"session" has no value'):
        load_task_file(p)
    p = _w(tmp_path, "---\nmodel:#x\n---\nGo")
    assert load_task_file(p).settings == {"model": "#x"}


def test_huge_max_steps_is_a_located_error(tmp_path):
    p = _w(tmp_path, "---\nmax-steps: " + "9" * 5000 + "\n---\nGo")
    assert _err(p).startswith(f"{p}:2: max-steps must be a whole number of at least 1")


@pytest.mark.parametrize("value", ["~nosuchuser-duckwright/x.json", "a\x00b"])
def test_unusable_path_is_a_located_error(tmp_path, value):
    p = _w(tmp_path, f"---\nstate: {value}\n---\nGo")
    assert _err(p).startswith(f"{p}:2: state is not a usable path: ")


def test_symlink_loop_is_not_a_crash(tmp_path):
    (tmp_path / "loop1").symlink_to(tmp_path / "loop2")
    (tmp_path / "loop2").symlink_to(tmp_path / "loop1")
    p = _w(tmp_path, "---\nstate: loop1/x.json\n---\nGo")
    try:
        load_task_file(p)  # Python 3.13 resolves loops without raising
    except TaskFileError as e:
        assert str(e).startswith(f"{p}:2: state is not a usable path: ")


def test_error_names_path_as_typed(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert _err("./tasks//missing.md") == "./tasks//missing.md: file not found"


def test_key_is_case_sensitive(tmp_path):
    p = _w(tmp_path, "---\nModel: opus\n---\nGo")
    assert _err(p) == f'{p}:2: unknown setting "Model"'


def test_leading_rule_is_a_located_error(tmp_path):
    # A Markdown file using --- as dividers, with no front matter intended.
    p = _w(tmp_path, "---\n\nSome text\n---\nMore")
    assert _err(p) == f'{p}:3: expected "key: value"'


@pytest.mark.parametrize(
    "text,line,message",
    [
        ("---\nmodel: x\nGo", None, "front matter is not closed with ---"),
        ("---\njust words\n---\nGo", 2, 'expected "key: value"'),
        ('---\nmodel: "x\n---\nGo', 2, "bad quoted value"),
        ('---\nmodel: "x" y\n---\nGo', 2, "bad quoted value"),
        ("---\nmax_steps: 3\n---\nGo", 2, 'unknown setting "max_steps"'),
        (
            "---\nallow-file-access: true\n---\nGo", 2,
            "allow-file-access must be passed on the command line",
        ),
        ("---\nmodel: a\nmodel: b\n---\nGo", 3, '"model" is set twice'),
        ("---\nmodel:\n---\nGo", 2, '"model" has no value'),
        ('---\nmodel: ""\n---\nGo', 2, '"model" has no value'),
        (
            "---\nmax-steps: lots\n---\nGo", 2,
            'max-steps must be a whole number of at least 1, got "lots"',
        ),
        (
            "---\nmax-steps: 0\n---\nGo", 2,
            'max-steps must be a whole number of at least 1, got "0"',
        ),
        ("---\nheaded: yes\n---\nGo", 2, 'headed must be true or false, got "yes"'),
        ("---\nheaded: True\n---\nGo", 2, 'headed must be true or false, got "True"'),
        ("---\nmodel: x\n---\n  \n", None, "no task text"),
        ("", None, "no task text"),
    ],
)
def test_errors(tmp_path, text, line, message):
    p = _w(tmp_path, text)
    where = f"{p}:{line}" if line else f"{p}"
    assert _err(p) == f"{where}: {message}"


def test_missing_file(tmp_path):
    p = tmp_path / "nope.md"
    assert _err(p) == f"{p}: file not found"


def test_directory(tmp_path):
    assert _err(tmp_path).startswith(f"{tmp_path}: cannot read: ")


def test_not_utf8(tmp_path):
    p = _w(tmp_path, b"\xff\xfe\x00")
    assert _err(p).startswith(f"{p}: cannot read: ")


def test_example_template_parses():
    tf = load_task_file(ROOT.parent / "examples" / "task.md")
    assert tf.settings == {"model": "sonnet", "max_steps": 25}
    assert tf.task.startswith("Open https://example.com/form.")


def test_expand_files_pass_through_in_order(tmp_path):
    a, b = _w(tmp_path, "A", "a.md"), _w(tmp_path, "B", "b.txt")
    assert expand_task_paths([str(b), str(a), "missing.md"]) == [str(b), str(a), "missing.md"]


def test_expand_folder_filters_and_sorts(tmp_path):
    for name in ("b.md", "a.TXT", "c.Md", ".hidden.md", "auth.json", "notes", "sub/d.md"):
        _w(tmp_path / "tasks", "x", name)
    assert expand_task_paths([str(tmp_path / "tasks")]) == [
        str(tmp_path / "tasks" / n) for n in ("a.TXT", "b.md", "c.Md")
    ]


def test_expand_folder_keeps_path_as_typed(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _w(tmp_path / "tasks", "x", "a.md")
    assert expand_task_paths(["tasks/"]) == ["tasks/a.md"]
    assert expand_task_paths(["tasks"]) == ["tasks/a.md"]


def test_expand_dedupes_by_resolved_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _w(tmp_path / "tasks", "x", "a.md")
    _w(tmp_path / "tasks", "x", "b.md")
    assert expand_task_paths(["tasks/a.md", "tasks", "./tasks/b.md"]) == [
        "tasks/a.md", "tasks/b.md",
    ]


def test_expand_empty_folder_errors(tmp_path):
    _w(tmp_path / "tasks", "{}", "auth.json")
    with pytest.raises(TaskFileError) as e:
        expand_task_paths([str(tmp_path / "tasks")])
    assert str(e.value) == f"{tmp_path / 'tasks'}: no task files (.md or .txt)"


def test_expand_unreadable_folder_errors(tmp_path, monkeypatch):
    (tmp_path / "tasks").mkdir()

    def deny(self):
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "iterdir", deny)
    with pytest.raises(TaskFileError) as e:
        expand_task_paths([str(tmp_path / "tasks")])
    assert str(e.value) == f"{tmp_path / 'tasks'}: cannot read: denied"


def test_expand_keeps_dot_slash_as_typed(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _w(tmp_path / "tasks", "x", "a.md")
    assert expand_task_paths(["./tasks/"]) == ["./tasks/a.md"]
    assert expand_task_paths(["./tasks"]) == ["./tasks/a.md"]


def test_expand_unstattable_path_is_left_for_loading(tmp_path):
    long = str(tmp_path / ("a" * 300))
    assert expand_task_paths([long]) == [long]
    assert _err(long).startswith(f"{long}: cannot read: ")


def test_task_paths_keeps_every_folder_error_in_order(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _w(tmp_path / "empty", "{}", "auth.json")
    _w(tmp_path / "tasks", "x", "a.md")
    out = task_paths(["empty", "x.md", "nope", "tasks"])
    assert [str(p) if isinstance(p, TaskFileError) else p for p in out] == [
        "empty: no task files (.md or .txt)", "x.md", "nope", "tasks/a.md",
    ]
