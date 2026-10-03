# Batch Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `duckwright -f a.md b.md` and `duckwright -f tasks/` run several task files one after another and print a summary; `-f one.md` behaves exactly as today.

**Architecture:** `taskfile.expand_task_paths` turns the `-f` arguments into an ordered, de-duplicated list of file paths (folders expanded to their root-level `.md`/`.txt` files). `__main__.main` loads every file, builds one `argparse.Namespace` per file from a fresh parser (so settings never leak), and either calls the extracted `_run_one` once (single file) or hands the list to `_run_batch`, which preflights all tasks, runs them in order and prints the summary.

**Tech Stack:** Python ≥3.11 standard library (`argparse` `action="extend"`, `pathlib`); pytest.

**Spec:** `docs/superpowers/specs/2026-10-03-batch-runs-design.md`. Its **Expanding paths**, **Batch flow** and **Exit codes** sections are normative; use its message text and summary format verbatim. `docs/superpowers/specs/2026-10-03-task-files-design.md` still governs each individual file.

## Global Constraints

- Runtime stays standard-library only (`dependencies = []`).
- `duckwright "task"`, `duckwright -f one.md`, `duckwright -- export` and `duckwright export RUN`: output, exit codes and `history.json` unchanged. Every existing test in `tests/test_main.py` and `tests/test_taskfile.py` passes unmodified.
- Nothing runs and no `runs/` folder is created when any file, folder or preflight check is bad (exit `2`).
- Tasks run sequentially, in command-line order, folder entries sorted by name.
- `history.json` `task_file` is the path as typed, or `<folder as typed>/<name>` for a folder entry.

## Review Focus

1. **A folder that also holds `auth.json`, a `.draft.md`, or a subfolder.** Expected: only root-level, non-hidden `.md`/`.txt` files run; the rest are ignored. Pinned by Task 1 `test_expand_folder_filters_and_sorts`.
2. **A positional task after `-f`** (`duckwright -f a.md "Open the site"`). Expected: `Open the site: file not found`, exit `2`, nothing runs. Pinned by Task 2 `test_task_after_file_is_read_as_file`.
3. **One bad file among several.** Expected: every error printed, exit `2`, no `runs/`, no agent started, even for the good files. Pinned by Task 2 `test_batch_bad_file_runs_nothing`.
4. **A folder and a file inside it both given** (`-f tasks tasks/a.md`). Expected: `tasks/a.md` runs once. Pinned by Task 1 `test_expand_dedupes_by_resolved_path`.
5. **Ctrl-C in the middle of a batch.** Expected: that task's `history.json` says `interrupted`, later tasks do not start, the summary shows `stop` then `skip`, exit `130`. Pinned by Task 2 `test_batch_interrupt_stops_and_summarises`.

---

### Task 1: `expand_task_paths` in `taskfile.py`

**Files:**
- Modify: `duckwright/taskfile.py` (add constant and function after `load_task_file`)
- Test: `tests/test_taskfile.py`

**Interfaces:**
- Produces: `TASK_SUFFIXES = (".md", ".txt")` and `expand_task_paths(paths: list[str]) -> list[str]`. Returns paths as strings as typed (folder entries as `str(Path(arg) / name)`), de-duplicated by `Path(p).resolve()` keeping the first. Raises `TaskFileError` with `f"{arg}: no task files (.md or .txt)"` or `f"{arg}: cannot read: {e}"` (from `OSError` while listing). Non-directory arguments, including missing ones, pass through untouched.

- [ ] **Step 1: Write the failing tests** (use the existing `_w` helper):

```python
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
    _w(tmp_path / "tasks", "x", "a.md"); _w(tmp_path / "tasks", "x", "b.md")
    assert expand_task_paths(["tasks/a.md", "tasks", "./tasks/b.md"]) == ["tasks/a.md", "tasks/b.md"]

def test_expand_empty_folder_errors(tmp_path):
    _w(tmp_path / "tasks", "{}", "auth.json")
    with pytest.raises(TaskFileError) as e:
        expand_task_paths([str(tmp_path / "tasks")])
    assert str(e.value) == f"{tmp_path / 'tasks'}: no task files (.md or .txt)"

def test_expand_unreadable_folder_errors(tmp_path, monkeypatch):
    (tmp_path / "tasks").mkdir()
    def deny(self): raise PermissionError("denied")
    monkeypatch.setattr(Path, "iterdir", deny)
    with pytest.raises(TaskFileError) as e:
        expand_task_paths([str(tmp_path / "tasks")])
    assert str(e.value) == f"{tmp_path / 'tasks'}: cannot read: denied"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pytest tests/test_taskfile.py -k expand -v`
Expected: FAIL with `ImportError: cannot import name 'expand_task_paths'`

- [ ] **Step 3: Implement `expand_task_paths(paths: list[str]) -> list[str]` in `duckwright/taskfile.py`**

Use `Path(arg).is_dir()`; list with `sorted(Path(arg).iterdir(), key=lambda p: p.name)` inside `try/except OSError`; keep entries where `p.is_file() and not p.name.startswith(".") and p.suffix.lower() in TASK_SUFFIXES`. De-duplicate with a `set` of `Path(p).resolve()` (wrap `resolve()` in `try/except (OSError, RuntimeError, ValueError)` and fall back to the string, so a bad path is left for `load_task_file` to report).

- [ ] **Step 4: Run the whole file to verify it passes**

Run: `pytest tests/test_taskfile.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add duckwright/taskfile.py tests/test_taskfile.py
git commit -m "feat: expand task-file folders for batch runs"
```

---

### Task 2: Batch runs in `__main__.py`, plus README

**Files:**
- Modify: `duckwright/__main__.py` (`_run_parser` `-f` argument; `main`; new `_args_for`, `_run_one`, `_run_batch`)
- Modify: `README.md` (Usage synopsis and `-f` row, new "Batch runs" subsection at the end of "Task files", Exit codes table)
- Test: `tests/test_main.py`

**Interfaces:**
- Consumes: `expand_task_paths(paths: list[str]) -> list[str]`, `TASK_SUFFIXES` (Task 1); existing `load_task_file`, `TaskFile`, `TaskFileError`, `_preflight`, `_history_json`.
- Produces (module-private, for tests and readers):
  - `_args_for(argv: list[str], tf: TaskFile) -> argparse.Namespace`: a **fresh** `_run_parser()` with `set_defaults(**tf.settings)`, parsed from `argv`, then `args.task = tf.task`.
  - `_run_one(args: argparse.Namespace, task_file: str | None) -> tuple[int, Path]`: everything in today's `main` from `workdir = ...` to the final return, unchanged in behavior; returns `(exit_code, workdir / "history.json")`. Preflight stays in `main`/`_run_batch`, not here.
  - `_run_batch(runs: list[tuple[str, argparse.Namespace]]) -> int`: implements spec **Batch flow** steps 2–5.

`-f` becomes `p.add_argument("-f", "--file", metavar="FILE", nargs="+", action="extend", help=...)`; help says it takes files or folders. `main` after the existing task/`--file` checks: `paths = expand_task_paths(args.file)`, then load every path, collecting every `TaskFileError` message (expansion error counts as one and stops collecting). Any error → print each on its own stderr line, return `2`. One file → today's single-run path (`_preflight` unprefixed, then `_run_one(args, path)`). Two or more → `_run_batch`.

New test helper: `_record_runs(monkeypatch, outcomes)` patches `Agent.run` to append `(self.task, self.max_steps, self.headed, self.brain.model)` to a list and return `RunResult(success, ...)` from `outcomes` in order (an exception instance in `outcomes` is raised instead).

- [ ] **Step 1: Write the failing tests** in `tests/test_main.py`:

```python
def test_single_file_output_unchanged(env, monkeypatch, capsys):
    # -f tasks/t.md: stdout has no "[1/1]" and no "Batch:" line; exit 0

def test_batch_runs_files_in_order_with_own_settings(env, monkeypatch):
    # a.md: "---\nmax-steps: 7\nheaded: true\n---\nA";  b.md: "B"
    # main(["--skill", skill, "-f", a, b]) == 0
    # calls == [("A", 7, True, "sonnet"), ("B", 25, False, "sonnet")]   # no leak from a.md
    # two runs/*/history.json with task_file "tasks/a.md" and "tasks/b.md"

def test_batch_cli_flag_applies_to_all(env, monkeypatch):
    # same files + "--max-steps", "3" -> both calls have max_steps 3

def test_batch_from_folder(env, monkeypatch):
    # tasks/b.md, tasks/a.md, tasks/auth.json; -f tasks -> tasks run A then B; task_file "tasks/a.md"

def test_batch_failure_continues_and_exits_1(env, monkeypatch, capsys):
    # outcomes [False, True]; exit 1; both ran
    # stdout contains "[1/2] tasks/a.md" and "[2/2] tasks/b.md"
    # summary lines: "Batch: 1 passed, 1 failed, 0 not run",
    #   "fail  tasks/a.md  runs/<id>/history.json", "pass  tasks/b.md  runs/<id>/history.json"

def test_batch_crash_counts_as_fail(env, monkeypatch):
    # outcomes [PlaywrightError("x"), True]; exit 1; second task still ran

def test_batch_all_pass_exits_0(env, monkeypatch, capsys):
    # outcomes [True, True]; "Batch: 2 passed, 0 failed, 0 not run"

def test_batch_bad_file_runs_nothing(env, monkeypatch, capsys):
    # a.md good, b.md "---\nmodel:\n---\nGo", c.md "" ; Agent.run raises AssertionError if called
    # exit 2; stderr == 'tasks/b.md:2: "model" has no value\ntasks/c.md: no task text\n'; no runs/

def test_batch_preflight_failure_runs_nothing(env, monkeypatch, capsys):
    # b.md "---\nstate: nope.json\n---\nGo"; exit 2; no runs/
    # stderr line starts with "tasks/b.md: state file not found: "

def test_batch_interrupt_stops_and_summarises(env, monkeypatch, capsys):
    # outcomes [KeyboardInterrupt(), True, True] over a, b, c; exit 130; only one Agent.run call
    # a's history.json answer == "interrupted"
    # summary: "Batch: 0 passed, 0 failed, 2 not run", "stop  tasks/a.md  runs/<id>/history.json",
    #   "skip  tasks/b.md  -", "skip  tasks/c.md  -"

def test_task_after_file_is_read_as_file(env, monkeypatch, capsys):
    # main(["--skill", skill, "-f", a, "Open the site"]) == 2
    # stderr == "Open the site: file not found\n"; no runs/

def test_repeated_file_flag_extends(env, monkeypatch):
    # "-f", a, "-f", b -> two runs, A then B

def test_empty_folder_exits_2(env, capsys):
    # tasks/ holds only auth.json -> exit 2, stderr "tasks: no task files (.md or .txt)\n"
```

Write each as a full test using the `env`, `_task_file`, `_history` helpers already in the file; the comments above give the exact inputs and assertions.

- [ ] **Step 2: Run them to verify they fail**

Run: `pytest tests/test_main.py -v`
Expected: the new tests FAIL (`-f` accepts one value, `unrecognized arguments`); every existing test PASSES.

- [ ] **Step 3: Extract `_args_for` and `_run_one` from `main`, with no behavior change**

`main` keeps the `export` dispatch, the two `parser.error` checks and the plain-task path (`_preflight`, then `_run_one(args, None)`). Return the exit code from the tuple.

- [ ] **Step 4: Run the existing tests to confirm the refactor is neutral**

Run: `pytest tests/test_main.py -v -k "not batch and not after_file and not extends and not empty_folder and not single_file_output"`
Expected: all PASS

- [ ] **Step 5: Change `-f` to `nargs="+", action="extend"` and implement expansion, loading, and `_run_batch(runs) -> int`**

`_run_batch`: preflight each `(path, args)` with `_preflight(Path(args.skill), Path(args.state).resolve() if args.state else None)`, printing `f"{path}: {err}"`; any → return `2`. Then loop with `print(f"[{i}/{n}] {path}", flush=True)` and `_run_one`; record `(status, path, history)` where status is `pass` for `0`, `stop` for `130`, else `fail`; break on `130`; fill the rest with `("skip", path, "-")`. Print the summary exactly as the spec shows (`f"{status}  {path}  {history}"`). Return `130` if interrupted, else `0` if all passed, else `1`.

- [ ] **Step 6: Update `README.md`**

Synopsis: `duckwright -f FILE|FOLDER [FILE|FOLDER ...] [options]`. `-f` row: "one or more task files or folders; several make a [batch](#batch-runs)". New "#### Batch runs" subsection at the end of "Task files": the four commands from the spec's Goal, folder rules (root level, `.md`/`.txt`, hidden files skipped, sorted), "all files are checked before anything runs", flags apply to every task, sequential order, the summary example, and the note that a task after `-f` is read as a file (put flags or `--` between them). Exit codes table: add to `1` "in a batch, at least one task failed", to `2` "a bad task folder", to `130` "a batch stops at the interrupted task".

- [ ] **Step 7: Run the full suite**

Run: `pytest -q`
Expected: all PASS (`test_e2e.py` may skip without `claude`/`playwright-cli`)

- [ ] **Step 8: Commit**

```bash
git add duckwright/__main__.py tests/test_main.py README.md
git commit -m "feat: run several task files or a folder with -f"
```
