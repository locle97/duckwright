# Readable Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Runs are stored as `runs/<task-name>/<timestamp>/` instead of a flat `runs/<timestamp>/`, and a new `duckwright runs [QUERY]` command lists past runs (newest first, filterable), so a run can be found by what it was about rather than when it started.

**Architecture:** A new module `duckwright/runs.py` owns everything about the `runs/` folder: turning a label into a folder-safe slug, creating a run's directory, and reading back a summary of every run. `__main__._run_one` asks it for the run directory (label = `--name`, else the task file's stem, else the task text); a new `runs` subcommand, dispatched like `export`, prints the listing. `history.json` and `export` are untouched.

**Tech Stack:** Python ≥3.11 standard library (`unicodedata`, `re`, `pathlib`, `argparse`, `dataclasses`); pytest.

**Spec:** No separate spec; the **Design** section below is normative for this plan.

## Design

Layout:

```
runs/
  greet/                                  # from tasks/greet.md
    20261003-101500-123456/history.json
    20261003-114200-000042/history.json
  go-to-example-com-and-report-the-page/  # from an inline task
    20261003-101612-654321/history.json
  20261001-090000-000001/history.json     # old flat run, still listed and exportable
```

Run label, first that applies: `--name NAME` (or task-file key `name:`), the task file's stem (`tasks/login.md` → `login`), the task text.

Slug rules (`slugify`): NFKD-normalise and drop non-ASCII; lowercase; every run of characters outside `[a-z0-9]` becomes one `-`; strip leading/trailing `-`; if longer than 40 characters, cut at 40 and then back to the last `-` if there is one inside the cut, strip `-` again; empty result → `task`; a Windows reserved device name (`con prn aux nul com1-com9 lpt1-lpt9`) gets `-task` appended.

Listing (`duckwright runs [QUERY] [-n N] [--status pass|fail]`):

```console
$ duckwright runs greet
2026-10-03 11:42  pass   3 steps  $0.0310  runs/greet/20261003-114200-000042  Open https://example.com/form, enter the…
2026-10-03 10:15  fail  25 steps  $0.2104  runs/greet/20261003-101500-123456  Open https://example.com/form, enter the…
```

- Scans `runs/*/history.json` (legacy flat) and `runs/*/*/history.json` (grouped) in the current directory; sorted newest first by the timestamp folder name.
- `QUERY` is a case-insensitive substring match against the group slug, `task_file`, and `task`.
- Columns, two spaces apart: `YYYY-MM-DD HH:MM` (parsed from the timestamp folder name; the raw name if it does not parse), `pass`/`fail`, steps right-aligned to width 2 + ` steps`, `$` cost to 4 decimals, run directory, task text with whitespace collapsed and, when longer than 40 characters, cut to 40, right-stripped, plus `…`.
- `-n` default `20`, must be ≥1. `--status` filters on `success`.
- A `history.json` that is unreadable or not a duckwright history (reuse `export.load_history`) is skipped with `warning: skipped <path>: <reason>` on stderr.
- No `runs/` folder, or nothing matches: prints `No runs found.` and exits `0`.
- `duckwright runs` as the exact first argument is the subcommand; `duckwright -- runs` runs a task named `runs` (same rule as `export`).

## Global Constraints

- Runtime stays standard-library only (`dependencies = []`).
- `history.json` content and `duckwright export` behaviour are unchanged; `duckwright export runs/<old-flat-id>` keeps working.
- The timestamp folder keeps the exact format `%Y%m%d-%H%M%S-%f`.
- `allow-file-access` is still not a task-file key; `name` becomes one, of kind `str`.
- Existing tests change only where they glob or regex the run path (`runs/*/history.json` → `runs/*/*/history.json`, `_summary`'s `runs/[^/]+/` → `runs/\S+/history.json` replaced by `runs/<id>/history.json`). No other assertion is edited.

## Review Focus

1. **A task that is all punctuation or non-Latin script** (`"検索して"`, `"!!!"`). Expected: folder `runs/task/<ts>/`, never `runs/<ts>/` or an empty name. Pinned by Task 1 `test_slugify_falls_back_to_task`.
2. **A very long inline task.** Expected: slug ≤40 characters, not ending in `-`, not cut mid-word when a `-` exists. Pinned by Task 1 `test_slugify_truncates_on_word_boundary`.
3. **A `--name` containing `../` or `/`.** Expected: it is slugified, so the run stays inside `runs/`. Pinned by Task 1 `test_slugify_cannot_escape`.
4. **A `runs/` folder holding old flat runs, a corrupt `history.json`, and stray files.** Expected: old runs listed, the corrupt one warned about and skipped, stray files ignored, exit `0`. Pinned by Task 3 `test_find_runs_mixed_layouts` and `test_runs_command_skips_bad_history`.
5. **Two tasks in a batch with the same file stem** (`a/login.md`, `b/login.md`). Expected: both land under `runs/login/` in separate timestamp folders, and the batch summary shows two different paths. Pinned by Task 2 `test_batch_same_stem_shares_group`.

---

### Task 1: Slugs and run directories in `runs.py`

**Files:**
- Create: `duckwright/runs.py`
- Test: `tests/test_runs.py`

**Interfaces:**
- Produces:
  - `RUNS_DIR = Path("runs")`
  - `TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S-%f"`
  - `slugify(text: str, max_len: int = 40) -> str` (rules in **Design**)
  - `new_run_dir(label: str, root: Path = RUNS_DIR, now: datetime | None = None) -> Path` — creates and returns `root / slugify(label) / now.strftime(TIMESTAMP_FORMAT)` with `mkdir(parents=True)` (no `exist_ok`, matching today's collision behaviour); `now` defaults to `datetime.now()`.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_runs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'duckwright.runs'`

- [ ] **Step 3: Implement `slugify` and `new_run_dir` in `duckwright/runs.py`**

`unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()`, then `re.sub(r"[^a-z0-9]+", "-", lower)`. Reserved names as a module-level `frozenset`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_runs.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add duckwright/runs.py tests/test_runs.py
git commit -m "feat: add run-name slugs and grouped run directories"
```

---

### Task 2: Group runs by task name (`--name`, `name:` key, new layout)

**Files:**
- Modify: `duckwright/__main__.py` (`_run_parser`, `_run_one`; drop the `datetime` import)
- Modify: `duckwright/taskfile.py` (`KEYS`)
- Modify: `examples/task.md` (commented `# name: greet` line)
- Modify: `README.md` (example output line 31, options table, task-file keys table, batch summary example, **Output** section, `runs/<id>` mentions)
- Test: `tests/test_main.py`, `tests/test_taskfile.py`

**Interfaces:**
- Consumes: `new_run_dir(label: str) -> Path` from Task 1.
- Produces: `args.name: str | None` (argparse `--name NAME`, default `None`, help `"group this run's history under runs/<NAME>/ (default: task file name or task text)"`); task-file key `"name": ("name", "str")`; helper `_run_label(args: argparse.Namespace, task_file: str | None) -> str` returning `args.name`, else `Path(task_file).stem`, else `args.task`.

- [ ] **Step 1: Update the existing run-path globs/regex** in `tests/test_main.py` per **Global Constraints** (`_history`, `test_run_dirs_do_not_collide`, the export `--export` tests, `_histories`, `_summary`). Leave `tests/test_export.py` alone (it builds its own directory).

- [ ] **Step 2: Write the failing tests** in `tests/test_main.py`

```python
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
```

In `tests/test_taskfile.py`: `test_name_key_is_text` asserting `load_task_file` of `"---\nname: Login flow\n---\nx"` gives `settings == {"name": "Login flow"}`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tests/test_main.py tests/test_taskfile.py -v`
Expected: the five new tests and `test_name_key_is_text` FAIL (unrecognized `--name`, unknown setting `"name"`, or folder-name asserts); the updated existing tests FAIL on the glob until Step 4.

- [ ] **Step 4: Implement** `--name` in `_run_parser`, `"name"` in `KEYS`, `_run_label`, and replace the `workdir = ...; workdir.mkdir(...)` lines in `_run_one` with `workdir = new_run_dir(_run_label(args, task_file))`. Update the `--export` help and epilog to say `runs/<name>/<id>`.

- [ ] **Step 5: Run the whole suite**

Run: `python -m pytest -q`
Expected: all pass.

- [ ] **Step 6: Update docs.** README: every `runs/<id>` → `runs/<name>/<id>`; example paths like `runs/greet/20261003-101500-123456/...`; add `--name` row to the options table and `name` (text) row to the task-file keys table; in **Output**, describe the layout and label precedence from **Design**, and note that runs from older versions stay in the flat `runs/<timestamp>/` layout and still work with `export`. `examples/task.md`: add a commented `# name: greet` line with a one-line comment.

- [ ] **Step 7: Commit**

```bash
git add duckwright/__main__.py duckwright/taskfile.py tests/test_main.py tests/test_taskfile.py README.md examples/task.md
git commit -m "feat: group run history by task name under runs/<name>/<timestamp>"
```

---

### Task 3: `duckwright runs` listing command

**Files:**
- Modify: `duckwright/runs.py`
- Modify: `duckwright/__main__.py` (`main` dispatch, new `_parse_runs`, `_runs_main`, epilog)
- Modify: `README.md` (usage block, new **Finding past runs** subsection under **Output**, note next to the `export` NOTE about `duckwright -- runs`, **How it works** module table row for `runs.py`)
- Test: `tests/test_runs.py`, `tests/test_main.py`

**Interfaces:**
- Consumes: `RUNS_DIR`, `TIMESTAMP_FORMAT` from Task 1; `load_history(path: Path) -> tuple[Path, dict]` and `ExportError` from `duckwright/export.py`.
- Produces:
  - `@dataclass(frozen=True) class RunInfo: path: Path; group: str | None; started: str; success: bool; steps: int; cost_usd: float; task: str; task_file: str | None` — `group` is `None` for a legacy flat run; `started` is the timestamp folder name.
  - `find_runs(root: Path = RUNS_DIR) -> tuple[list[RunInfo], list[str]]` — runs newest first by `started` (descending string sort), plus warning strings `f"skipped {file}: {reason}"`. Missing `steps`/`cost_usd` read as `0` / `0.0`.
  - `matches(run: RunInfo, query: str) -> bool`
  - `format_run(run: RunInfo) -> str` (columns in **Design**)

- [ ] **Step 1: Write the failing tests** in `tests/test_runs.py` (helper `_hist(dir, task, success=True, steps=2, cost=0.01, task_file=None)` writes a valid `history.json` with `"history": []`)

```python
def test_find_runs_mixed_layouts(tmp_path):
    root = tmp_path / "runs"
    _hist(root / "20261001-090000-000001", "old")
    _hist(root / "greet" / "20261003-101500-123456", "new", task_file="tasks/greet.md")
    (root / "notes.txt").write_text("x")
    (root / "greet" / "stray.json").write_text("{}")
    runs, warnings = find_runs(root)
    assert [r.task for r in runs] == ["new", "old"]
    assert [r.group for r in runs] == ["greet", None]
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
```

In `tests/test_main.py` (no `env`-style preflight needed; use `monkeypatch.chdir(tmp_path)` and the `_hist` helper imported from `tests/test_runs.py` or duplicated):

```python
def test_runs_command_lists_newest_first(tmp_path, monkeypatch, capsys): ...
    # two runs in different groups → exit 0, two lines, newer first

def test_runs_command_query_and_status(tmp_path, monkeypatch, capsys): ...
    # "runs greet --status fail" prints only the failed greet run

def test_runs_command_limit(tmp_path, monkeypatch, capsys): ...
    # three runs, "runs -n 2" → two lines; "runs -n 0" → SystemExit code 2

def test_runs_command_empty(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert m.main(["runs"]) == 0
    assert capsys.readouterr().out == "No runs found.\n"

def test_runs_command_skips_bad_history(tmp_path, monkeypatch, capsys): ...
    # one good, one corrupt → exit 0, one line on stdout, "warning: skipped" on stderr

def test_runs_command_skips_preflight(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(m.shutil, "which", lambda n: None)
    assert m.main(["runs"]) == 0

def test_task_named_runs_still_runs(env, monkeypatch):
    # mirror test_task_named_export_still_runs with ["--", "runs"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_runs.py tests/test_main.py -v -k "runs"`
Expected: FAIL with `ImportError` for `find_runs`/`RunInfo` and, in `test_main.py`, `runs` treated as a task.

- [ ] **Step 3: Implement `RunInfo`, `find_runs`, `matches`, `format_run` in `duckwright/runs.py`**

`find_runs` globs `root.glob("*/history.json")` and `root.glob("*/*/history.json")`, loads each with `load_history` (catch `ExportError` → warning). `group` is `file.parent.parent.name` when `file.parent.parent != root`, else `None`. Date column: `datetime.strptime(started, TIMESTAMP_FORMAT).strftime("%Y-%m-%d %H:%M")`, falling back to `started` on `ValueError`.

- [ ] **Step 4: Implement `_parse_runs(argv) -> argparse.Namespace` and `_runs_main(argv) -> int` in `__main__.py`**

Parser `prog="duckwright runs"`, positional `query` (`nargs="?"`), `-n/--limit` (type validating ≥1 via `argparse.ArgumentTypeError`, default `20`), `--status` (`choices=["pass", "fail"]`). In `main`, dispatch `argv[0] == "runs"` next to `export`. Print warnings to stderr as `warning: …`, then up to `limit` formatted lines, or `No runs found.`. Add `duckwright runs [QUERY]` to the epilog.

- [ ] **Step 5: Run the whole suite**

Run: `python -m pytest -q`
Expected: all pass.

- [ ] **Step 6: Update README**: usage block gains `duckwright runs [QUERY] [-n N] [--status pass|fail]`; new **Finding past runs** subsection with the example from **Design** and its rules; extend the `export` NOTE to cover `runs` / `duckwright -- runs`; add `runs.py` to the module table; tick a new Roadmap item `- [x] **Readable run history**: runs grouped by task name, listed with duckwright runs`.

- [ ] **Step 7: Commit**

```bash
git add duckwright/runs.py duckwright/__main__.py tests/test_runs.py tests/test_main.py README.md
git commit -m "feat: add duckwright runs to list and search past runs"
```
