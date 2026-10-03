import pytest

from tests.bench.bench import BenchRun, meets_targets, summarize


def test_summarize_and_targets():
    runs = [
        BenchRun("a", "claude", True, 0.10, 5, 4, 0),
        BenchRun("a", "claude", False, 0.30, 7, 6, 0),
        BenchRun("a", "jev", True, 0.04, 4, 4, 3),
        BenchRun("a", "jev", True, 0.06, 6, 6, 3),
    ]
    s = summarize(runs)
    assert s["a"]["claude"] == {
        "passes": 1,
        "runs": 2,
        "mean_cost": pytest.approx(0.2),
        "mean_seconds": 6,
        "jev_share": 0.0,
    }
    assert s["total"]["jev"]["jev_share"] == pytest.approx(0.6)
    assert meets_targets(s) == (True, True)


def test_targets_fail_on_cost():
    runs = [
        BenchRun("a", "claude", True, 0.20, 5, 4, 0),
        BenchRun("a", "jev", True, 0.11, 4, 4, 3),
    ]
    assert meets_targets(summarize(runs)) == (True, False)


def test_targets_fail_on_passes():
    runs = [
        BenchRun("a", "claude", True, 0.20, 5, 4, 0),
        BenchRun("a", "jev", False, 0.01, 4, 4, 3),
    ]
    assert meets_targets(summarize(runs)) == (False, True)


def test_zero_steps_jev_share():
    s = summarize([BenchRun("a", "jev", False, 0.0, 1, 0, 0)])
    assert s["total"]["jev"]["jev_share"] == 0
