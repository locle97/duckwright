"""Opt-in live benchmark: Claude-only vs --jev. Run with PW_AGENT_BENCH=1."""
import json
import os
import time
from datetime import datetime
from pathlib import Path

import pytest

from pw_agent.brain import Brain
from pw_agent.jev import HybridBrain, JevClient
from pw_agent.loop import Agent
from pw_agent.pw import PlaywrightCLI
from tests.bench.bench import BenchRun, meets_targets, summarize

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
REPEATS = 3

TASKS = [
    (
        "multipage",
        "multipage.html",
        "Open file://{p}, go to Shop, then Hardware, then Keyboards, and report the product code shown.",
        "KX-4471",
    ),
    (
        "settings",
        "settings.html",
        "Open file://{p}, turn on Email notifications and Weekly digest, click Save, and report the confirmation text.",
        "Saved: email, digest",
    ),
    (
        "form",
        "form.html",
        "Open file://{p}, enter the name Linh, submit, and report the greeting.",
        "Hello, Linh!",
    ),
]


def _claude_brain() -> Brain:
    return Brain(
        system_files=[
            ROOT / "prompts" / "system.md",
            ROOT / "prompts" / "playwright-cli.md",
        ]
    )


def _print_table(summary: dict) -> None:
    print()
    for key, modes in summary.items():
        print(f"== {key}")
        for mode, s in modes.items():
            print(
                f"  {mode:6} pass {s['passes']}/{s['runs']}  "
                f"cost ${s['mean_cost']:.4f}  {s['mean_seconds']:.1f}s  "
                f"jev_share {s['jev_share']:.0%}"
            )


@pytest.mark.skipif(
    os.environ.get("PW_AGENT_BENCH") != "1", reason="set PW_AGENT_BENCH=1 to run live benchmark"
)
def test_bench(tmp_path):
    modes = ["claude", "jev"]
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        pytest.skip("TYPESAFE_API_KEY not set; cannot benchmark --jev mode")

    runs: list[BenchRun] = []
    for name, fixture, template, expected in TASKS:
        path = (FIXTURES / fixture).resolve()
        task = template.format(p=path)
        for mode in modes:
            for i in range(REPEATS):
                claude = _claude_brain()
                brain = HybridBrain(JevClient(key), claude) if mode == "jev" else claude
                workdir = tmp_path / f"{name}-{mode}-{i}"
                workdir.mkdir()
                pw = PlaywrightCLI(session=f"pw-bench-{name}-{mode}-{i}", allow_file_access=True)
                start = time.monotonic()
                try:
                    result = Agent(task, pw, brain, workdir, max_steps=12).run()
                finally:
                    pw.close()
                seconds = time.monotonic() - start
                runs.append(
                    BenchRun(
                        task=name,
                        mode=mode,
                        success=bool(result.success and expected in (result.answer or "")),
                        cost=result.cost_usd,
                        seconds=seconds,
                        steps=result.steps,
                        jev_steps=sum(
                            1 for r in result.history if r.decision.source == "jev"
                        ),
                    )
                )

    summary = summarize(runs)
    _print_table(summary)
    out = ROOT / "runs"
    out.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (out / f"bench-{stamp}.json").write_text(json.dumps(summary, indent=2))
    assert meets_targets(summary) == (True, True)
