from pathlib import Path

import pytest

from duckwright.taskfile import TaskFileError, load_task_file

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
    tf = load_task_file(ROOT / "examples" / "task.md")
    assert tf.settings == {"model": "sonnet", "max_steps": 25}
    assert tf.task.startswith("Open https://example.com/form.")
