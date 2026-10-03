import os
import subprocess
import sys
from pathlib import Path

import pytest

from duckwright.brain import Brain
from duckwright.loop import Agent
from duckwright.observe import page_dir
from duckwright.pw import PlaywrightCLI

ROOT = Path(__file__).resolve().parent.parent


def test_missing_skill_exits():
    r = subprocess.run(
        [sys.executable, "-m", "duckwright", "x", "--skill", "/nope"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 2
    assert "playwright-cli skill not found" in r.stderr


@pytest.mark.skipif(
    os.environ.get("DUCKWRIGHT_E2E") != "1", reason="set DUCKWRIGHT_E2E=1 to run live e2e"
)
@pytest.mark.parametrize("full_snapshot", [True, False], ids=["full", "grep"])
def test_e2e_form(tmp_path, full_snapshot):
    form = (ROOT / "tests" / "fixtures" / "form.html").resolve()
    task = f"Open file://{form}, enter the name Linh, submit, and report the greeting."
    prompts = ROOT / "duckwright" / "prompts"
    mode_md = "snapshot-full.md" if full_snapshot else "snapshot-grep.md"
    brain = Brain(
        system_files=[prompts / "system.md", prompts / mode_md, prompts / "playwright-cli.md"],
        snapshot_dir=None if full_snapshot else page_dir(tmp_path),
    )
    mode = "full" if full_snapshot else "grep"
    pw = PlaywrightCLI(session=f"duckwright-e2e-{mode}", allow_file_access=True)
    try:
        result = Agent(
            task, pw, brain, tmp_path, max_steps=8, on_step=lambda r: print(r.line()),
            full_snapshot=full_snapshot,
        ).run()
    finally:
        pw.close()
    print(f"mode={mode} steps={result.steps} cost=${result.cost_usd:.4f} answer={result.answer}")
    assert result.success
    assert "Hello, Linh!" in result.answer
    assert result.steps <= 8
    codes = [c for rec in result.history for c in rec.codes if c]
    assert any("page.goto(" in c for c in codes)
    assert any("Linh" in c for c in codes)
    assert any(c.startswith("await expect(") and "Hello, Linh!" in c for c in codes)
