# Task files (`--file`) design

Status: approved design, 2026-10-03.

## Goal

Run a task from a file: `duckwright -f tasks/login.md`. The file holds the task text and, optionally, the run's settings, so a task can be kept, reviewed and re-run without shell quoting or remembering flags. `duckwright "task"` keeps working unchanged.

This is groundwork for batch runs, which will take a set of these files.

Out of scope:

- Expected outcomes or required assertions in the file.
- A setting for the exported test's title (it stays the task text, JSON-escaped).
- Task files for `export` or `batch`.
- Globs, folders, or stdin as input.

## Command line

```bash
duckwright "<task>" [options]
duckwright -f FILE [options]
```

- New run flag `-f/--file PATH`. The positional `task` becomes optional.
- Exactly one of `task` and `--file` is required:
  - both given: `give a task or --file, not both`, exit `2`
  - neither given: `give a task or --file`, exit `2`
  
  Both errors go through `parser.error()`, so they print the usage line plus `duckwright: error: <message>`, the same as any other argument error.
- `--headed` and `--export` become `argparse.BooleanOptionalAction`, which adds `--no-headed` and `--no-export`, so the command line can override a file's `true`. Their defaults stay off.
- Command-line flags always win over the file.
- `.txt`, `.md` and any other extension are read the same way.
- The `export` subcommand dispatch (`argv[0] == "export"`) is unchanged. `-f` never collides with it.

## File format

A UTF-8 text file (a BOM is allowed, and CRLF line endings are treated as LF), made of optional front matter followed by the task body.

```md
---
model: opus
max-steps: 15
state: auth.json
export: true
---
Open https://example.com/form, enter the name Linh, submit,
and check the greeting says "Hello, Linh!".
```

### Front matter

- **Opening and closing:** front matter is present only when the file's first line is exactly `---`. It ends at the next line that is exactly `---`. Trailing whitespace is allowed on both lines. If no closing line is found, that is an error.
- **Lines:** each line inside is one of:
  - blank
  - a full-line comment (first non-space character is `#`)
  - `key: value`, where the key is everything before the first `:`, stripped, and the value is everything after it, stripped
- **Comments after a value:**
  - In an unquoted value, ` #` (whitespace then `#`) starts a comment that runs to the end of the line.
  - A value that starts with `"` or `'` must have a matching closing quote. The text between the quotes is the value, with no escape sequences. After the closing quote only whitespace or a comment may follow.
- **Rejected:** nesting, lists and multi-line values. Any line that isn't one of the forms above is an error.

### Keys and values

| Key | Type | Notes |
| --- | --- | --- |
| `max-steps` | whole number ≥ 1 | |
| `model` | text | |
| `headed` | `true` / `false` | |
| `skill` | path | relative to the file's folder; `~` expanded |
| `session` | text | |
| `state` | path | relative to the file's folder; `~` expanded |
| `export` | `true` / `false` | |

- `allow-file-access` is rejected with `allow-file-access must be passed on the command line`. A task file can be shared or downloaded, and must not be able to grant the browser unrestricted file access silently.
- Any other key gives `unknown setting "<key>"`. There are no aliases (`max_steps` is unknown).
- A repeated key is an error.
- An empty value is an error.
- **Values:**
  - Quotes are removed before the type check, so `export: "true"` and `max-steps: "15"` are accepted.
  - An empty value, quoted or not (`model: ""`), gives `"<key>" has no value`.
  - Text values keep their case.
  - `true`/`false` are lowercase only.
  - Numbers are base-10 digits, with no sign and no underscores.

### Body

- The body is everything after the closing `---`, or the whole file when there is no front matter, with leading and trailing whitespace stripped.
- A `---` line inside the body (for example a Markdown horizontal rule) is part of the task.
- An empty body is an error: `no task text`.

## Components

### `duckwright/taskfile.py` (new, standard library only)

- `class TaskFileError(Exception)`: the message is already formatted as `<path>[:<line>]: <problem>`, where `<path>` is the `-f` argument as typed.
- `@dataclass(frozen=True) class TaskFile`, with fields:
  - `task: str`
  - `settings: dict[str, object]`: keys are argparse dests (`max_steps`, `model`, `headed`, `skill`, `session`, `state`, `export`), and values are already converted to `int`, `bool`, or `str`. Path values are absolute strings.
  - `base_dir: Path`
- `load_task_file(path: Path) -> TaskFile`: raises `TaskFileError` for every error in this spec, and never lets an `OSError` or `UnicodeDecodeError` escape.

### `duckwright/__main__.py`

- The run parser's construction is split from parsing (`_run_parser() -> ArgumentParser`) so `main` can call `set_defaults`.
- **Flow in `main`, after the `export` dispatch:**
  1. Parse the arguments.
  2. Check that exactly one of task and `--file` was given.
  3. If `--file` was given:
     - load the file
     - `parser.set_defaults(**tf.settings)`
     - parse the same arguments again
     - set `args.task = tf.task`, so every later use of `args.task` (both `_history_json` calls, the `Agent`) gets the body
  4. Run preflight and everything after it unchanged.
- `TaskFileError` prints its message to stderr and returns `2`. That happens before preflight, so no `runs/` folder is created.
- **`history.json`** gets a new key, `"task_file"`, placed after `"task"`. Its value is the `--file` argument as given, or `null` for a task given on the command line. It is written on every path: success, failure, error and interrupt. `export` ignores it.

### `examples/task.md` (new)

This file is in the repository and linked from the README; it is not installed with the package. It must parse with `load_task_file`. Content:

```md
---
# Settings for this task. Every line is optional; delete what you don't need.
# Flags on the command line override these. Relative paths are resolved
# from this file's folder. allow-file-access can only be set on the command line.
model: sonnet        # model passed to claude -p
max-steps: 25        # stop after this many steps
# state: auth.json   # storage state loaded before the first step
# session: login     # playwright-cli session name
# headed: true       # show the browser window
# export: true       # write duckwright.spec.ts after a successful run
---
Open https://example.com/form.
Enter the name Linh in the Name field and submit the form.
Check that the page greets "Hello, Linh!".
```

### README

- **Usage:** add `duckwright -f FILE [options]` to the synopsis, `-f/--file` to the options table, and `--no-headed`/`--no-export` to the existing rows.
- **New section, "Task files"**, after "Authenticated pages". It covers:
  - the format
  - the key table
  - command-line precedence
  - path resolution
  - the `allow-file-access` rule
  - a link to `examples/task.md`
- **Output:** document `task_file` in `history.json`.
- **Exit codes:** add "unreadable or invalid task file" to the `2` row.
- **Module table:** add `taskfile.py`.

## Errors

Every case prints one line to stderr, `<file>[:<line>]: <message>`, and exits `2`. There is no traceback, and no `runs/` folder is created.

| Case | Message (after the location) |
| --- | --- |
| Missing file | `file not found` |
| Unreadable, a directory, or not UTF-8 | `cannot read: <reason>` |
| No closing `---` | `front matter is not closed with ---` |
| Bad line | `expected "key: value"` |
| Unclosed quote, or text after a closing quote | `bad quoted value` |
| Unknown key | `unknown setting "<key>"` |
| `allow-file-access` | `allow-file-access must be passed on the command line` |
| Repeated key | `"<key>" is set twice` |
| Empty value | `"<key>" has no value` |
| Wrong type | `<key> must be a whole number of at least 1, got "<v>"` / `<key> must be true or false, got "<v>"` |
| Empty body | `no task text` |

Missing-file, unreadable and empty-body errors have no line number.

Exit codes are otherwise unchanged.

## Testing

**`tests/test_taskfile.py`**

- Body only (no front matter).
- Front matter plus body.
- Full-line and trailing comments.
- A quoted value containing ` #`.
- A BOM, and CRLF line endings.
- Relative and `~` paths resolved for `skill` and `state`.
- A `---` line inside the body is kept.
- Every row of the Errors table, including its line number.

**`tests/test_main.py`**

- `-f` runs the body as the task, with the file's settings applied.
- A command-line flag wins over the file, including `--no-export` over `export: true`.
- Task and `-f` together exit `2`.
- Neither task nor `-f` exits `2`.
- A file error exits `2`, with no `runs/` folder and the agent never started.
- `history.json` has `task_file` both on success and on a failure path.
- `duckwright "task"` writes `task_file: null`.

**Template check:** a test loads `examples/task.md` and asserts its task and settings, so the template cannot drift from the parser.

## Follow-up

Batch runs come after this. They should run task files (for example `duckwright batch tasks/*.md`), starting each child run with `-f <file>`.
