# Batch runs (`-f` with many files or a folder) design

Status: draft for review, 2026-10-03.

## Goal

Run several task files in one command by reusing `-f/--file`:

```bash
duckwright -f tasks/login.md tasks/greet.md   # several files
duckwright -f tasks/*.md                       # shell glob
duckwright -f tasks/                           # every task file at the folder's root
duckwright -f tasks/ extra/one.md --headed     # mixed; flags apply to every task
```

This replaces the `duckwright batch ...` subcommand suggested as follow-up in `2026-10-03-task-files-design.md`. Everything in that spec still holds for each individual file.

Out of scope:

- Running tasks in parallel. Tasks run one after another, so they can share the default `--session`.
- Recursing into subfolders, or glob patterns expanded by duckwright itself.
- A machine-readable batch report file. Each task still writes its own `runs/<id>/history.json`.
- Batch input to the `export` subcommand.

## Command line

- `-f/--file` takes one or more paths (`nargs="+"`, `action="extend"`), so `-f a.md b.md` and `-f a.md -f b.md` are the same.
- A positional task together with `-f` is still `give a task or --file, not both`; neither is still `give a task or --file`. Because `-f` is greedy, `duckwright -f a.md "Open the site"` reads `Open the site` as a second file and fails with `Open the site: file not found`, exit `2`, before anything runs.
- Flags given on the command line apply to every task and still win over each file's front matter. One file's settings never carry over to another file.

## Expanding paths

Each `-f` argument, in command-line order:

- **A directory:** replaced by its root-level entries that are files (symlinks to files count) whose suffix is `.md` or `.txt` (any case), whose name does not start with `.`, sorted by name. Subfolders and other files (for example `auth.json` next to the tasks) are ignored. The entry is named as `<argument as typed>/<name>`, so `tasks` and `tasks/` give `tasks/a.md`.
  - No matching files: `<dir>: no task files (.md or .txt)`.
  - Cannot be listed: `<dir>: cannot read: <reason>`.
- **Anything else:** kept as typed; `load_task_file` reports a missing or bad file as today.

The same file reached twice (same resolved path) runs once, at its first position.

## One file versus many

- When expansion yields **exactly one** file, the run behaves exactly as today: same output, same exit codes, same `history.json`.
- When it yields **two or more**, it is a batch, described below.

## Batch flow

1. **Load every file first.** Every `TaskFileError` (including expansion errors) is printed, one line each, in order. If there was any, exit `2`; nothing runs and no `runs/` folder is created.
2. **Preflight every task** with its own settings. Each failure prints `<file>: <preflight message>`. If any failed, exit `2` before anything runs.
3. **Run the tasks in order.** Before each task print `[<i>/<n>] <file>`. Then the task prints exactly what a single run prints (step lines, `Result:`, `Answer:`, `Steps:`, `History:`, `Test:`). A failing or crashing task does not stop the batch.
4. **Ctrl-C** during a task writes that task's `history.json` as `interrupted` (as today), stops the batch, and the remaining tasks do not run.
5. **Summary**, printed after the last task (or after the interruption):

   ```
   Batch: 2 passed, 1 failed, 0 not run
   pass  tasks/a.md  runs/20261003-101500-123456/history.json
   fail  tasks/b.md  runs/20261003-101530-654321/history.json
   ```

   One line per task in run order, with a status word of `pass`, `fail`, `stop` (interrupted) or `skip` (not run, shown with `-` instead of a history path). Columns are separated by two spaces.

### Exit codes

| Code | Batch meaning |
| --- | --- |
| `0` | Every task passed |
| `1` | At least one task failed (any single-run exit `1`) |
| `2` | A file, folder or preflight check was bad; nothing ran |
| `130` | Interrupted with Ctrl-C |

## Components

- **`duckwright/taskfile.py`:** `expand_task_paths(paths: list[str]) -> list[str]` implements **Expanding paths**, raising `TaskFileError` for the two folder errors.
- **`duckwright/__main__.py`:** the code from creating the run folder to the final return becomes `_run_one(args, task_file: str | None) -> tuple[int, Path]`. Per-file arguments come from a fresh parser per file, so settings never leak between files. The batch flow lives in `_run_batch`.
- **README:** synopsis, the `-f` row, a "Batch runs" subsection under "Task files", and batch exit codes.

## Testing

- `tests/test_taskfile.py`: folder expansion (filtering, hidden files, sorting, case-insensitive suffix, subfolders ignored, empty folder, the path kept as typed, de-duplication, unreadable folder).
- `tests/test_main.py`: one file unchanged; several files run in order with their own settings and no leakage; command-line flags apply to all; a bad file or a failing preflight stops everything with exit `2` and no `runs/`; a failing task does not stop the batch; exit codes `0`/`1`/`130`; the summary text; a positional task swallowed by `-f`.
