from pw_agent.brain import Action, Decision
from pw_agent.observe import Observation
from pw_agent.prompt import HISTORY_WINDOW, StepRecord, build_prompt


def rec(n, actions=None, results=None):
    d = Decision("ok", "mem", f"goal{n}", actions if actions is not None else [Action("click", ["e1"])])
    return StepRecord(n, d, results if results is not None else ["done"])


OBS = Observation(tabs="tab0", snapshot="SNAPSHOT_TEXT", truncated=False)


def test_prompt_contains_sections():
    p = build_prompt("do it", 3, 25, [], "", OBS)
    for s in ["<task>\ndo it\n</task>", "Step 3/25", "<memory>\n(empty)\n</memory>",
              "<tabs>\ntab0\n</tabs>", "<history>\n(none)\n</history>",
              "<page_snapshot>\nSNAPSHOT_TEXT\n</page_snapshot>"]:
        assert s in p
    assert p.rstrip().endswith("</page_snapshot>")


def test_history_window():
    p = build_prompt("t", 21, 25, [rec(i) for i in range(1, 21)], "m", OBS, window=15)
    assert "(5 earlier steps omitted)" in p
    assert "step 6 |" in p and "step 20 |" in p
    assert "step 5 |" not in p
    assert HISTORY_WINDOW == 15
    assert "<memory>\nm\n</memory>" in p


def test_nudge_included():
    p = build_prompt("t", 1, 5, [], "", OBS, nudge="try different")
    assert "try different" in p
    assert p.index("try different") < p.index("<page_snapshot>")


def test_line_format():
    d = Decision("e\nx", "m", "g\nh", [Action("fill", ["e9", "hi"]), Action("click", ["e2"])])
    r = StepRecord(2, d, ["ok\nline"])
    assert r.line() == "step 2 | e x | g h | fill e9 hi → ok line; click e2 → (no result)"


def test_line_brain_error():
    r = StepRecord(1, Decision("", "m", "", []), ["brain error: boom\nx", "y"])
    assert r.line() == "step 1 |  |  | brain error: boom x; y"
