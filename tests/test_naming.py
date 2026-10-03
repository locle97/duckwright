from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEGACY = ("duckwright", "pw-agent", "PW_AGENT", "playwright-agent-loop", "playwright_agent_loop")
SKIP_DIRS = {".git", "docs", "build", "dist", ".pytest_cache", "runs", "__pycache__"}


def _files():
    for path in ROOT.rglob("*"):
        rel = path.relative_to(ROOT)
        if any(p in SKIP_DIRS or p.endswith(".egg-info") for p in rel.parts):
            continue
        if path.is_file() and path != Path(__file__).resolve():
            yield path, rel


def test_no_legacy_name():
    hits = []
    for path, rel in _files():
        try:
            lines = path.read_text().splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        hits += [f"{rel}:{i}" for i, line in enumerate(lines, 1) if any(t in line for t in LEGACY)]
    assert hits == []
