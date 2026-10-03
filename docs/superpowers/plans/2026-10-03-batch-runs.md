# Batch Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `duckwright batch tasks.txt` runs every task in the file, each as its own run in its own playwright-cli session, optionally several at a time, and writes one summary for the batch.

**Architecture:** Each task runs as a child process, `python -m duckwright ... --session <name> --run-dir <dir> -- <task>`, so it reuses the whole run path (preflight, history, `--export`, exit codes, Ctrl-C handling) unchanged. The run gets one new flag, `--run-dir`, so the batch picks where each run lands. A new standard-library module, `duckwright/batch.py`, reads the task file, launches children through a `ThreadPoolExecutor` (one thread per running child), reads each child's `history.json`, and writes `summary.json`. `__main__.py` dispatches `argv[0] == "batch"` the same way it already dispatches `export`.

**Tech Stack:** Python ≥3.11 standard library (`subprocess`, `concurrent.futures`, `argparse`, `json`); pytest.

**Spec:** No separate spec file. The requirement is the README roadmap line: "**Batch runs**: run many tasks from a file, each in its own session." The decisions below fill in the rest.

## Decisions (made here; do not re-litigate)

- **Command:** `duckwright batch FILE [--parallel N] [--session PREFIX] [run options]`. Run options are every run flag except `--session` and `--run-dir` (`--max-steps`, `--model`, `--headed`, `--skill`, `--state`, `--allow-file-access`, `--export`) and are forwarded verbatim to every child.
- **Task file:** UTF-8 text, one task per line. Each line is stripped; empty lines and lines whose stripped text starts with `#` are skipped. Order is kept; duplicates are allowed. No stdin, no JSON format.
- **Layout:** the batch writes `runs/batch-<%Y%m%d-%H%M%S-%f>/`. Task `i` (1-based) runs in `<batch>/<NN>/` with its combined stdout/stderr in `<batch>/<NN>.log`, where `NN` is `i` zero-padded to `len(str(len(tasks)))` digits. `<batch>/summary.json` is written at the end, also after Ctrl-C.
- **Sessions:** task `i` uses session `<prefix>-<NN>`. Default prefix is `dwb-<timestamp>` (the batch dir name without `batch-`), so two batches never share a browser by default. `--session PREFIX` overrides it.
- **Parallelism:** `--parallel N`, default `1` (one task after another). `N < 1` is an argparse error.
- **Children** are `[sys.executable, "-m", "duckwright", *forwarded, "--session", <session>, "--run-dir", <dir>, "--", <task>]`. The `--` makes a task such as `export` or `--help` a plain task.
- **Run flag `--run-dir DIR`:** write the run to `DIR` instead of `runs/<timestamp>`. If `DIR` already exists the run prints `run directory already exists: DIR` and exits `2` (after the other preflight checks, before anything runs). `batch` refuses a forwarded `--run-dir` with exit `2`.
- **Per-task status**, decided from the child's `history.json` and exit code:
  - `success`: `history.json` readable and `success` is `true`.
  - `failure`: `history.json` readable and `success` is `false` (includes a child interrupted with Ctrl-C).
  - `error`: no readable `history.json` (child preflight failed, crashed, or could not be launched).
  - `not run`: the batch was interrupted before the task started.
- **Terminal output** (stdout, printed only from the main thread, in completion order):
  - first line `Batch: <batch-dir> (<n> tasks, <parallel> at a time)`
  - per task `[<NN>/<n>] <status>  <detail>  <task>`, where detail is `<steps> steps  $<cost:.4f>` for `success`/`failure` and `see <log>` for `error`
  - then `Passed: <successes>/<n>  Cost: $<total:.4f>` and `Summary: <batch-dir>/summary.json`.
- **`summary.json`:** `{"file": str, "interrupted": bool, "passed": int, "total": int, "cost_usd": float, "tasks": [...]}`; each task, in file order: `{"index", "task", "session", "status", "exit_code", "answer", "steps", "cost_usd", "run_dir", "log"}` (`exit_code` is `null` when the child never returned one; `answer` `null` and `steps`/`cost_usd` `0` without a readable history).
- **Exit codes for `batch`:** `0` every task `success`; `1` any other outcome; `2` the file is missing, unreadable or holds no tasks, a forwarded option is invalid, or the batch-level preflight fails (no `runs/` dir is created in any of these); `130` interrupted.
- **Preflight once:** `batch` runs the existing `_preflight(skill, state)` before creating anything, so a missing `claude` fails once, not once per task. Children still run their own preflight.
- **Ctrl-C:** the terminal delivers SIGINT to the whole process group, so running children write their history and exit `130` on their own. The batch stops starting tasks, waits for running children, marks the rest `not run`, writes `summary.json`, and exits `130`. No explicit signal forwarding.

## Global Constraints

- Runtime stays standard-library only (`dependencies = []`).
- Existing run and `export` invocations behave exactly as before; `batch` is dispatched only when `argv[0] == "batch"` (a task that is only the word `batch` is run as `duckwright -- batch`, documented next to the existing `export` note).
- No traceback reaches the user from `batch`; a child that fails to launch is a task `error`, not a crash.
- Only the main thread prints.

## Review Focus

1. **A task line that looks like an option or a subcommand** (`--help`, `export`, `-x`). Expected: it runs as a task. Pinned by Task 2 `test_child_argv_treats_task_as_positional` (real child process).
2. **A task file with blank lines, comments, CRLF line endings, a BOM, or nothing but comments.** Expected: only real tasks run; an effectively empty file exits `2` with `no tasks in <file>`. Pinned by Task 2 `test_read_tasks_skips_blanks_and_comments` and `test_read_tasks_empty_is_error`.
3. **A child that dies without `history.json`, or cannot be launched at all.** Expected: that task is `error` pointing at its log, the other tasks still run, and the batch exits `1`. Pinned by Task 2 `test_missing_history_is_error` and `test_launch_oserror_is_error_and_batch_continues`.
4. **Ctrl-C partway through.** Expected: no new tasks start, unstarted tasks are `not run`, `summary.json` is still written, exit `130`. Pinned by Task 2 `test_interrupt_marks_rest_not_run`.
5. **Two parallel tasks.** Expected: different sessions and run dirs, and `summary.json` lists tasks in file order whatever order they finished in. Pinned by Task 2 `test_parallel_sessions_unique_and_summary_in_file_order`.

---

### Task 1: `--run-dir` on the run

**Files:**
- Modify: `duckwright/__main__.py` (`_parse`, `main`)
- Test: `tests/test_main.py`

**Interfaces:**
- Produces: run flag `--run-dir DIR` (`args.run_dir: str | None`). Task 2 passes it to every child.

- [ ] **Step 1: Write the failing tests** in `tests/test_main.py`, using the existing `env` fixture and the `R` result-class pattern from `test_run_dirs_do_not_collide`:

```python
def test_run_dir_flag_sets_workdir(env, monkeypatch):
    tmp, argv = env
    monkeypatch.setattr(Agent, "run", lambda self: R())
    assert m.main(argv + ["--run-dir", "out/one"]) == 0
    assert json.loads((tmp / "out/one/history.json").read_text())["success"] is True
    assert not (tmp / "runs").exists()


def test_run_dir_existing_exits_2(env, monkeypatch, capsys):
    tmp, argv = env
    (tmp / "taken").mkdir()
    monkeypatch.setattr(Agent, "run", lambda self: pytest.fail("should not run"))
    assert m.main(argv + ["--run-dir", "taken"]) == 2
    assert "run directory already exists: taken" in capsys.readouterr().err
```

(Define `R` once at module level if it is not already shared.)

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest tests/test_main.py -k run_dir -v`
Expected: FAIL, `unrecognized arguments: --run-dir`.

- [ ] **Step 3: Implement.** Add `p.add_argument("--run-dir", metavar="DIR", help="write this run to DIR instead of runs/<timestamp>; DIR must not exist")` to `_parse`. In `main`, after `_preflight` passes: `workdir = Path(args.run_dir) if args.run_dir else <existing timestamp path>`; if `args.run_dir` and `workdir.exists()`, print `run directory already exists: {args.run_dir}` to stderr and return `2`; then the existing `workdir.mkdir(parents=True)`.

- [ ] **Step 4: Run the suite**

Run: `python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add duckwright/__main__.py tests/test_main.py
git commit -m "feat: --run-dir chooses where a run is written"
```

---

### Task 2: `batch.py`, which reads tasks and runs them as child runs

**Files:**
- Create: `duckwright/batch.py`
- Test: `tests/test_batch.py`

**Interfaces:**
- Consumes: run flags `--session`, `--run-dir` (Task 1).
- Produces (all in `duckwright/batch.py`):
  - `class BatchError(Exception)` with `.exit_code: int` (same shape as `ExportError`).
  - `read_tasks(path: Path) -> list[str]`; raises `BatchError(..., 2)`.
  - `Launch = Callable[[list[str], Path], int]` — runs argv with stdout+stderr to the log path, returns the exit code.
  - `launch_child(argv: list[str], log: Path) -> int` — the real `Launch`: `subprocess.run(argv, stdin=DEVNULL, stdout=<log file>, stderr=STDOUT).returncode`.
  - `child_argv(task: str, session: str, run_dir: Path, forwarded: list[str]) -> list[str]`.
  - `@dataclass TaskOutcome`: `index: int, task: str, session: str, status: str, exit_code: int | None, answer: str | None, steps: int, cost_usd: float, run_dir: str, log: str`.
  - `@dataclass BatchResult`: `tasks: list[TaskOutcome], interrupted: bool`; property `exit_code -> int` (`130` if interrupted, else `0` if every status is `success`, else `1`).
  - `run_batch(tasks: list[str], batch_dir: Path, forwarded: list[str], session_prefix: str, parallel: int = 1, launch: Launch = launch_child, out: Callable[[str], None] = print, source: str = "") -> BatchResult` — creates `batch_dir`, prints the lines from **Decisions**, writes `summary.json` (with `"file": source`), returns the result.

Tests use a fake `launch` that writes a `history.json` into the `--run-dir` it finds in argv (helper `_fake(results: dict[str, tuple[int, dict | None]])` keyed by task, where `None` means write no history) and records the argv it got.

- [ ] **Step 1: Write the failing tests** in `tests/test_batch.py`:

```python
def test_read_tasks_skips_blanks_and_comments(tmp_path):
    f = tmp_path / "t.txt"
    f.write_bytes("﻿Open a\r\n\n  # note\n  Open b  \r\n".encode("utf-8"))
    assert read_tasks(f) == ["Open a", "Open b"]

def test_read_tasks_empty_is_error(tmp_path):
    f = tmp_path / "t.txt"; f.write_text("# only\n\n")
    with pytest.raises(BatchError, match="no tasks in") as e: read_tasks(f)
    assert e.value.exit_code == 2

def test_read_tasks_missing_is_error(tmp_path):
    with pytest.raises(BatchError, match="task file not found") as e: read_tasks(tmp_path / "nope")
    assert e.value.exit_code == 2

def test_child_argv_shape():
    assert child_argv("t", "s-1", Path("b/1"), ["--model", "opus"]) == [
        sys.executable, "-m", "duckwright", "--model", "opus",
        "--session", "s-1", "--run-dir", "b/1", "--", "t"]

def test_child_argv_treats_task_as_positional(tmp_path):
    # real child: the bogus skill fails its preflight, proving "--help" was read as the task
    log = tmp_path / "1.log"
    code = launch_child(child_argv("--help", "s", tmp_path / "1", ["--skill", "/nope"]), log)
    assert code == 2 and "playwright-cli skill not found" in log.read_text()

def test_runs_each_task_in_own_session_and_dir(tmp_path):
    # 2 tasks, both success: sessions "p-1","p-2"; run dirs batch/1, batch/2; logs batch/1.log, batch/2.log
    # result.exit_code == 0; summary.json passed == 2, total == 2, cost_usd == sum
    ...

def test_zero_padding_matches_task_count(tmp_path):
    # 10 tasks -> sessions "p-01".."p-10", dirs "01".."10"

def test_failure_status_and_exit_1(tmp_path):
    # one history success:false, exit 1 -> status "failure", line contains "failure", result.exit_code == 1

def test_missing_history_is_error(tmp_path):
    # child exits 2 with no history -> status "error", answer None, steps 0,
    # printed line contains f"see {batch}/1.log"

def test_launch_oserror_is_error_and_batch_continues(tmp_path):
    # launch raises OSError for task 1 -> task 1 "error" with exit_code None; task 2 still "success"

def test_interrupt_marks_rest_not_run(tmp_path):
    # parallel=1, 3 tasks; launch raises KeyboardInterrupt on task 2
    # -> task 1 "success", task 3 "not run", result.interrupted, exit_code == 130,
    #    summary.json exists with "interrupted": true

def test_parallel_sessions_unique_and_summary_in_file_order(tmp_path):
    # parallel=2, 2 tasks; task 1's fake launch waits on a threading.Event that task 2 sets,
    # so task 2 finishes first; printed lines are [2/2] then [1/2];
    # summary "tasks" indexes == [1, 2]; sessions differ

def test_output_lines(tmp_path):
    # exact first line "Batch: <dir> (2 tasks, 1 at a time)",
    # task line "[1/2] success  3 steps  $0.0100  Open a",
    # last two lines "Passed: 2/2  Cost: $0.0200" and f"Summary: {dir}/summary.json"
```

Write each `...`/comment test out in full with the values given.

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest tests/test_batch.py -v`
Expected: FAIL, `ModuleNotFoundError: duckwright.batch`.

- [ ] **Step 3: Implement `duckwright/batch.py`** with the interfaces above.
  - `read_tasks`: read with `encoding="utf-8-sig"`; `FileNotFoundError` → `task file not found: <path>`; other `OSError`/`UnicodeDecodeError` → `cannot read <path>: <e>`; all exit `2`.
  - `run_batch`: submit every task to `ThreadPoolExecutor(max_workers=parallel)`; each worker calls `launch` and returns its code, or the exception for `OSError`. Iterate `as_completed` in the main thread, build the `TaskOutcome` from the code plus `<run_dir>/history.json` (read with `json.loads`; ignore any read/parse error and any field of the wrong type, treating it as missing), and print its line. On `KeyboardInterrupt` (raised in the main thread, or re-raised from `future.result()`): set `interrupted`, call `executor.shutdown(wait=True, cancel_futures=True)`, collect the futures that did finish, and mark cancelled ones `not run`. Always write `summary.json` (sorted by index, `indent=2`) and print the footer.

- [ ] **Step 4: Run the tests**

Run: `python -m pytest tests/test_batch.py -v && python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add duckwright/batch.py tests/test_batch.py
git commit -m "feat: run a file of tasks as separate runs, each in its own session"
```

---

### Task 3: `duckwright batch` subcommand and docs

**Files:**
- Modify: `duckwright/__main__.py` (new `_parse_batch`, `_batch_main`; dispatch in `main`; parser epilog)
- Modify: `README.md` (Usage synopsis, a `### Batch runs` section after `### Authenticated pages`, Exit codes note, module table row, roadmap tick)
- Test: `tests/test_main.py`

**Interfaces:**
- Consumes: `read_tasks`, `run_batch`, `BatchError`, `BatchResult.exit_code` (Task 2); `_parse`, `_preflight` (existing).
- Produces: `_batch_main(argv: list[str]) -> int`, and the CLI `duckwright batch FILE [--parallel N] [--session PREFIX] [run options]`.

- [ ] **Step 1: Write the failing tests** in `tests/test_main.py`, monkeypatching `m.run_batch` with a fake that records its kwargs and returns a `BatchResult`:

```python
def test_batch_dispatch_forwards_options(env, monkeypatch):
    # tasks.txt with 2 tasks; main(["batch", "tasks.txt", "--parallel", "2",
    #   "--model", "opus", "--export", "--skill", <skill>]) == 0
    # fake got tasks ["a", "b"], parallel 2, forwarded == ["--model", "opus", "--export", "--skill", <skill>],
    # batch_dir parent == Path("runs") and name starts with "batch-",
    # session_prefix == "dwb-" + batch_dir.name.removeprefix("batch-")

def test_batch_session_prefix_override(env, monkeypatch):
    # "--session", "ci" -> session_prefix == "ci", and "--session" not in forwarded

def test_batch_rejects_run_dir(env, monkeypatch, capsys):
    # "--run-dir", "x" -> exit 2, "--run-dir cannot be used with batch" in stderr, run_batch not called

def test_batch_invalid_forwarded_option_exits_2(env):
    # "--max-steps", "lots" -> SystemExit with code 2 (argparse), run_batch not called

def test_batch_missing_file_exits_2_without_runs_dir(env, monkeypatch, capsys):
    # main(["batch", "nope.txt"]) == 2, "task file not found" in stderr, not (tmp / "runs").exists()

def test_batch_preflight_failure_exits_2_once(env, monkeypatch, capsys):
    # which() returns None for "claude" -> exit 2, "claude CLI not found" printed once, run_batch not called

def test_batch_exit_code_from_result(env, monkeypatch):
    # fake returns BatchResult with one "failure" -> main returns 1; interrupted -> 130

def test_parallel_must_be_positive(env):
    # "--parallel", "0" -> SystemExit 2
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python -m pytest tests/test_main.py -k batch -v`
Expected: FAIL (`batch` is taken as the task).

- [ ] **Step 3: Implement.**
  - `_parse_batch(argv) -> tuple[Namespace, list[str], Namespace]`: parser `prog="duckwright batch"` with `file`, `--parallel` (type: int ≥ 1, else `argparse.ArgumentTypeError("must be at least 1")`) and `--session PREFIX`; `parse_known_args`; validate the leftovers with `run_args = _parse([*rest, "--", "x"])`; return `(args, rest, run_args)`.
  - `_batch_main`: `run_args.run_dir` set → stderr `--run-dir cannot be used with batch`, return `2`; `read_tasks` (on `BatchError` print and return its code); `_preflight(Path(run_args.skill), Path(run_args.state) if run_args.state else None)` → print and return `2`; batch dir `Path("runs") / f"batch-{datetime.now():%Y%m%d-%H%M%S-%f}"`; call `run_batch(..., source=args.file)`; return `result.exit_code`.
  - `main`: `if argv and argv[0] == "batch": return _batch_main(argv[1:])` next to the `export` dispatch. Extend `_parse`'s epilog with `Run a file of tasks: duckwright batch tasks.txt`.
  - README: add `duckwright batch FILE [--parallel N] [--session PREFIX] [run options]` to the Usage synopsis; extend the `export` NOTE to cover `batch`; new `### Batch runs` section with an example file (a comment line, two tasks), the command, the layout from **Decisions**, the status meanings, the exit codes, and a `[!WARNING]` that `--parallel` multiplies Claude spend and open browsers; add `batch.py` to the module table; tick the roadmap item and reword it to `duckwright batch FILE` runs each line as its own run and session, with `--parallel N`.

- [ ] **Step 4: Run the suite and a manual smoke**

Run: `python -m pytest -q`
Expected: all pass.

Run (from a scratch dir, `claude` on PATH not required):
`printf 'a\n--help\n' > t.txt && python -m duckwright batch t.txt --skill /nope; echo $?`
Expected: `playwright-cli skill not found: /nope`, exit `2`, no `runs/` created.

- [ ] **Step 5: Commit**

```bash
git add duckwright/__main__.py tests/test_main.py README.md
git commit -m "feat: duckwright batch subcommand and docs"
```
