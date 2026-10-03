import re
from dataclasses import dataclass
from pathlib import Path

# Front-matter key -> (argparse dest, kind). allow-file-access is deliberately absent:
# a shared task file must not be able to grant the browser unrestricted file access.
KEYS = {
    "max-steps": ("max_steps", "int"),
    "model": ("model", "str"),
    "headed": ("headed", "bool"),
    "skill": ("skill", "path"),
    "session": ("session", "str"),
    "state": ("state", "path"),
    "export": ("export", "bool"),
}
FENCE = "---"
COMMENT = re.compile(r"\s#")


class TaskFileError(Exception):
    pass


@dataclass(frozen=True)
class TaskFile:
    task: str
    settings: dict[str, object]
    base_dir: Path


class _Line(Exception):
    """A problem on one front-matter line; becomes a TaskFileError with its location."""


def _value(raw: str) -> str:
    """`raw` is the text after the colon, unstripped: only whitespace then `#` starts a comment."""
    v = raw.strip()
    if v[:1] in ("'", '"'):
        end = v.find(v[0], 1)
        rest = v[end + 1:].strip() if end != -1 else ""
        if end == -1 or (rest and not rest.startswith("#")):
            raise _Line("bad quoted value")
        return v[1:end]
    m = COMMENT.search(raw)
    return (raw[: m.start()] if m else raw).strip()


def _convert(key: str, kind: str, v: str, base_dir: Path) -> object:
    if kind == "int":
        try:
            n = int(v) if v.isascii() and v.isdigit() else 0
        except ValueError:  # more digits than int() will convert
            n = 0
        if n < 1:
            raise _Line(f'{key} must be a whole number of at least 1, got "{v}"')
        return n
    if kind == "bool":
        if v not in ("true", "false"):
            raise _Line(f'{key} must be true or false, got "{v}"')
        return v == "true"
    if kind == "path":
        try:
            return str((base_dir / Path(v).expanduser()).resolve())
        except (RuntimeError, ValueError, OSError) as e:  # unknown ~user, symlink loop, NUL
            raise _Line(f"{key} is not a usable path: {e}") from None
    return v


def _settings(lines: list[str], base_dir: Path, where) -> dict[str, object]:
    settings: dict[str, object] = {}
    for n, line in lines:
        try:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            key, sep, raw = line.partition(":")
            key = key.strip()
            if not sep or not key:
                raise _Line('expected "key: value"')
            if key == "allow-file-access":
                raise _Line("allow-file-access must be passed on the command line")
            if key not in KEYS:
                raise _Line(f'unknown setting "{key}"')
            dest, kind = KEYS[key]
            if dest in settings:
                raise _Line(f'"{key}" is set twice')
            v = _value(raw)
            if not v:
                raise _Line(f'"{key}" has no value')
            settings[dest] = _convert(key, kind, v, base_dir)
        except _Line as e:
            raise TaskFileError(f"{where}:{n}: {e}") from None
    return settings


def load_task_file(path: str | Path) -> TaskFile:
    """Read a task file: optional `---` front matter of flat settings, then the task text.

    Errors name `path` as given, so pass the user's string to keep it as typed.
    """
    where = str(path)
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        raise TaskFileError(f"{where}: file not found") from None
    except (OSError, UnicodeDecodeError) as e:
        raise TaskFileError(f"{where}: cannot read: {e}") from None
    base_dir = Path(path).parent.resolve()
    lines = text.replace("\r\n", "\n").split("\n")
    settings: dict[str, object] = {}
    body = lines
    if lines[0].rstrip() == FENCE:
        close = next((i for i in range(1, len(lines)) if lines[i].rstrip() == FENCE), None)
        if close is None:
            raise TaskFileError(f"{where}: front matter is not closed with ---")
        settings = _settings([(i + 1, lines[i]) for i in range(1, close)], base_dir, where)
        body = lines[close + 1:]
    task = "\n".join(body).strip()
    if not task:
        raise TaskFileError(f"{where}: no task text")
    return TaskFile(task, settings, base_dir)
