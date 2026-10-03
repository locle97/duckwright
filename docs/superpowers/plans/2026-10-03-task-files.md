# Task Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `duckwright -f tasks/login.md` runs the task written in a file, with optional front-matter settings, alongside the existing `duckwright "task"`.

**Architecture:** A new standard-library module, `duckwright/taskfile.py`, parses a file into its task body and a dict of typed settings keyed by argparse dest. `__main__.py` parses the arguments once to find `--file`, loads the file, applies its settings with `parser.set_defaults(...)`, and parses again, so flags you type always win. Everything from preflight onward is unchanged, except that `history.json` records `task_file`.

**Tech Stack:** Python ≥3.11 standard library (`argparse.BooleanOptionalAction`, `dataclasses`, `pathlib`); pytest.

**Spec:** `docs/superpowers/specs/2026-10-03-task-files-design.md`. Its **File format**, **Keys and values** and **Errors** sections are normative; this plan does not repeat the error table, so use its message text verbatim.

## Global Constraints

- Runtime stays standard-library only (`dependencies = []`).
- `duckwright "task"`, `duckwright -- export` and `duckwright export RUN` behave exactly as before.
- Every task-file error is one stderr line, `<path as typed>[:<line>]: <message>`, then exit `2`: no traceback, no `runs/` dir, the agent never starts.
- Allowed keys exactly: `max-steps`, `model`, `headed`, `skill`, `session`, `state`, `export`. `allow-file-access` is refused with its own message.
- `--headed` and `--export` become `argparse.BooleanOptionalAction` with default `False`.

## Review Focus

1. **A Markdown body that uses `#` headings or `#` inside text.** Expected: the body is kept verbatim; comment stripping applies only inside front matter. Pinned by Task 1 `test_body_hash_lines_are_kept`.
2. **A value containing `:` or a `#` with no space before it** (`session: team:a#1`). Expected: the key splits on the first `:` only, and only ` #` starts a comment, so the value is `team:a#1`. Pinned by Task 1 `test_value_keeps_colon_and_unspaced_hash`.
3. **An `.md` file that starts with a `---` horizontal rule, with no front matter intended.** Expected: the first line that isn't `key: value` gives a located error (`:3: expected "key: value"` for `---`, a blank line, then text), never a crash. Pinned by Task 1 `test_leading_rule_is_a_located_error`.
4. **A capitalised key** (`Model: opus`). Expected: `:N: unknown setting "Model"`, because keys are case-sensitive. Pinned by Task 1 `test_key_is_case_sensitive`.
5. **A relative `--state` on the command line together with `-f` from another folder.** Expected: the command-line path stays relative to the current directory, and only the file's own paths resolve from the file's folder. Pinned by Task 2 `test_cli_state_relative_to_cwd_with_file`.

---

### Task 1: `taskfile.py`, the parser, plus the example template

**Files:**
- Create: `duckwright/taskfile.py`
- Create: `examples/task.md` (exact text from the spec's `examples/task.md` section)
- Test: `tests/test_taskfile.py`

**Interfaces:**
- Produces:
  - `class TaskFileError(Exception)`; `str(e)` is the full formatted line.
  - `@dataclass(frozen=True) class TaskFile: task: str; settings: dict[str, object]; base_dir: Path`. Settings keys are dests (`max_steps`, `model`, `headed`, `skill`, `session`, `state`, `export`); values are `int`, `bool` or `str`. `skill` and `state` are absolute path strings.
  - `load_task_file(path: Path) -> TaskFile`.

Tests write files under `tmp_path` with a helper `_w(tmp_path, text, name="t.md") -> Path` and call `load_task_file`. Error tests assert `str(excinfo.value) == f"{path}:{line}: {message}"` with `path` exactly as passed.

- [ ] **Step 1: Write the failing tests** in `tests/test_taskfile.py`:

```python
def test_body_only():
    # "  Open a\nthen b \n\n" -> task == "Open a\nthen b", settings == {}, base_dir == tmp_path

def test_front_matter_and_body():
    # "---\nmodel: opus\nmax-steps: 15\nheaded: true\nexport: false\nsession: s1\n---\nGo\n"
    # -> settings == {"model": "opus", "max_steps": 15, "headed": True, "export": False, "session": "s1"}, task == "Go"

def test_comments_and_quotes():
    # "---\n# c\n\nmodel: sonnet   # trailing\nsession: \"a # b\"  # c\n---\nGo"
    # -> model "sonnet", session "a # b"

def test_quoted_typed_values():         # export: "true", max-steps: '15' -> True, 15
def test_bom_and_crlf():                # b"\xef\xbb\xbf---\r\nmodel: opus\r\n---\r\nGo\r\n" -> model "opus", task "Go"
def test_closing_rule_allows_trailing_space():  # "---  \nmodel: x\n---\t\nGo"
def test_paths_resolve_from_file_dir(): # tasks/t.md with state: auth.json, skill: ../s.md
                                        # -> state == str(tmp/"tasks"/"auth.json"), skill == str((tmp/"s.md").resolve())
def test_tilde_path_expanded(monkeypatch):  # HOME=tmp; state: ~/a.json -> str(tmp/"a.json")
def test_body_rule_is_kept():           # "---\nmodel: x\n---\nA\n---\nB" -> task "A\n---\nB"
def test_body_hash_lines_are_kept():    # "# Login\n\nOpen a  # not a comment" -> task kept verbatim (stripped ends only)
def test_value_keeps_colon_and_unspaced_hash():  # session: team:a#1 -> "team:a#1"
def test_key_is_case_sensitive():       # Model: opus at line 2 -> ':2: unknown setting "Model"'
def test_leading_rule_is_a_located_error():  # "---\n\nSome text\n" -> ':3: expected "key: value"'

@pytest.mark.parametrize("text,line,message", [
    ("---\nmodel: x\nGo", None, "front matter is not closed with ---"),
    ("---\njust words\n---\nGo", 2, 'expected "key: value"'),
    ('---\nmodel: "x\n---\nGo', 2, "bad quoted value"),
    ('---\nmodel: "x" y\n---\nGo', 2, "bad quoted value"),
    ("---\nmax_steps: 3\n---\nGo", 2, 'unknown setting "max_steps"'),
    ("---\nallow-file-access: true\n---\nGo", 2, "allow-file-access must be passed on the command line"),
    ("---\nmodel: a\nmodel: b\n---\nGo", 3, '"model" is set twice'),
    ("---\nmodel:\n---\nGo", 2, '"model" has no value'),
    ('---\nmodel: ""\n---\nGo', 2, '"model" has no value'),
    ("---\nmax-steps: lots\n---\nGo", 2, 'max-steps must be a whole number of at least 1, got "lots"'),
    ("---\nmax-steps: 0\n---\nGo", 2, 'max-steps must be a whole number of at least 1, got "0"'),
    ("---\nheaded: yes\n---\nGo", 2, 'headed must be true or false, got "yes"'),
    ("---\nheaded: True\n---\nGo", 2, 'headed must be true or false, got "True"'),
    ("---\nmodel: x\n---\n  \n", None, "no task text"),
])
def test_errors(tmp_path, text, line, message): ...
# Unclosed front matter has no line number: assert f"{p}: {message}" when line is None.

def test_missing_file():     # -> f"{p}: file not found"
def test_directory():        # -> str starts with f"{p}: cannot read: "
def test_not_utf8():         # bytes b"\xff\xfe\x00" -> starts with f"{p}: cannot read: "

def test_example_template_parses():
    tf = load_task_file(ROOT / "examples" / "task.md")
    assert tf.settings == {"model": "sonnet", "max_steps": 25}
    assert tf.task.startswith("Open https://example.com/form.")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest tests/test_taskfile.py -v`
Expected: FAIL, `ModuleNotFoundError: duckwright.taskfile`.

- [ ] **Step 3: Implement `duckwright/taskfile.py`** with the interfaces above.
  - Read with `encoding="utf-8-sig"` and normalise `\r\n` to `\n`. `FileNotFoundError` → `file not found`. Any other `OSError` or `UnicodeDecodeError` → `cannot read: <e>`.
  - Line numbers are 1-based file lines.
  - A key table maps each key to `(dest, kind)`, where kind is one of `"int"`, `"bool"`, `"str"`, `"path"`.
  - Paths: `(base_dir / Path(v).expanduser()).resolve()`, with `base_dir = Path(path).parent.resolve()`.
  - Unquoted value: cut at the first match of `\s#`, then strip.

- [ ] **Step 4: Run the tests**

Run: `python -m pytest tests/test_taskfile.py -v && python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add duckwright/taskfile.py examples/task.md tests/test_taskfile.py
git commit -m "feat: parse task files with front-matter settings"
```

---

### Task 2: `-f/--file` on the run, `task_file` in history, docs

**Files:**
- Modify: `duckwright/__main__.py` (`_parse`, `_history_json`, `main`)
- Modify: `README.md` (the edits listed in the spec's **README** section)
- Test: `tests/test_main.py`

**Interfaces:**
- Consumes: `load_task_file`, `TaskFile`, `TaskFileError` (Task 1).
- Produces:
  - `_run_parser() -> argparse.ArgumentParser`.
  - `_parse(argv)` is kept as `_run_parser().parse_args(argv)`, because existing tests call it.
  - `_history_json(task, success, answer, steps, cost, history, task_file: str | None = None) -> dict`, with `"task_file"` placed directly after `"task"`.

- [ ] **Step 1: Write the failing tests** in `tests/test_main.py`, reusing the `env` fixture. Its `argv` is `["task", "--skill", <skill>]`, so file tests use `argv[1:]` to drop the positional. A shared module-level result class `R` (`success=True, answer="a", steps=1, cost_usd=0.0, history=[]`) and an `Agent.run` stub that records `self.task`, `self.max_steps`, `self.headed`, `self.state` and the brain model.

```python
def test_file_runs_body_with_settings(env, monkeypatch):
    # tasks/t.md: "---\nmax-steps: 7\nheaded: true\nmodel: opus\n---\nOpen a\nthen b\n"
    # main(argv[1:] + ["-f", "tasks/t.md"]) == 0; seen task == "Open a\nthen b", max_steps 7, headed True, model "opus"
    # history task == "Open a\nthen b", task_file == "tasks/t.md"

def test_cli_flag_beats_file(env, monkeypatch):
    # file has max-steps: 7, export: true; "--max-steps", "3", "--no-export" -> max_steps 3, no duckwright.spec.ts written

def test_cli_state_relative_to_cwd_with_file(env, monkeypatch):
    # tasks/t.md has state: auth.json; tasks/auth.json and ./cli.json exist;
    # "-f", "tasks/t.md" -> seen state == tmp/"tasks"/"auth.json"
    # "-f", "tasks/t.md", "--state", "cli.json" -> seen state == tmp/"cli.json"

def test_task_and_file_exits_2(env, capsys):
    # pytest.raises(SystemExit) code 2; "give a task or --file, not both" in err; not (tmp/"runs").exists()

def test_neither_task_nor_file_exits_2(env, capsys):
    # argv[1:] only -> SystemExit 2, "give a task or --file" in err

def test_file_error_exits_2_without_runs(env, monkeypatch, capsys):
    # "---\nmodel:\n---\nGo" -> main == 2; err == 'tasks/t.md:2: "model" has no value\n'; agent never ran; no runs/

def test_file_task_file_on_failure_path(env, monkeypatch):
    # Agent.run raises PlaywrightError -> history task_file == "tasks/t.md"

def test_plain_task_has_null_task_file(env, monkeypatch):
    # main(argv) == 0 -> history["task_file"] is None
```

Also update `test_playwright_error_history_shape`'s expected dict with `"task_file": None` after `"task"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest tests/test_main.py -v`
Expected: the new tests and the updated shape test FAIL (`unrecognized arguments: -f`, missing `task_file`).

- [ ] **Step 3: Implement.**
  - **`_run_parser`:**
    - `task` becomes `nargs="?"`.
    - Add `-f/--file` (`metavar="FILE"`, help `read the task, and optional settings, from a .txt or .md file`).
    - `--headed` and `--export` become `action=argparse.BooleanOptionalAction, default=False`.
  - **`main`, in order:**
    1. `parser = _run_parser(); args = parser.parse_args(argv)`.
    2. Both given → `parser.error("give a task or --file, not both")`. Neither given → `parser.error("give a task or --file")`.
    3. If `args.file`: `tf = load_task_file(Path(args.file))`; on `TaskFileError` print it to stderr and return `2`. Then `parser.set_defaults(**tf.settings)`, `args = parser.parse_args(argv)`, `args.task = tf.task`.
    4. Continue to preflight as today.
  - Pass `args.file` as `task_file` to both `_history_json` calls.
  - Add `epilog` text for `-f`: `Run a task file: duckwright -f tasks/login.md`.
  - **README:** apply the spec's README edits.
    - The "Task files" section shows the spec's front-matter example and the key table.
    - Link the template as `[examples/task.md](https://github.com/locle97/duckwright/blob/main/examples/task.md)`, matching the README's existing absolute links.

- [ ] **Step 4: Run the suite and a smoke**

Run: `python -m pytest -q`
Expected: all pass.

Run: `python -m duckwright -f examples/task.md --skill /nope; echo $?`
Expected: `playwright-cli skill not found: /nope`, exit `2`. This shows the file parsed and the flag won.

Run: `printf -- '---\nallow-file-access: true\n---\nGo\n' > /tmp/x.md && python -m duckwright -f /tmp/x.md; echo $?`
Expected: `/tmp/x.md:2: allow-file-access must be passed on the command line`, exit `2`.

- [ ] **Step 5: Commit**

```bash
git add duckwright/__main__.py tests/test_main.py README.md
git commit -m "feat: run a task from a file with -f/--file"
```
