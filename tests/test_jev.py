"""Tests for JEV snapshot target extraction and the API client."""

import json

import pytest

from pw_agent.brain import Action, BrainError, Decision, StepContext
from pw_agent.jev import (
    ACTION_OPTIONS,
    HybridBrain,
    JevAuthError,
    JevClient,
    JevError,
    Target,
    extract_targets,
)
from pw_agent.loop import Agent
from pw_agent.observe import Observation


SNAP = '''- generic [ref=e1]:
  - link "Home" [ref=e2] [cursor=pointer]:
    - /url: /
  - button "Submit" [ref=e3] [cursor=pointer]
  - textbox "Name" [ref=e4]
  - checkbox "Agree" [checked] [ref=e5]
  - button [ref=e6] [cursor=pointer]
  - button [ref=e7]
  - link "Home" [ref=e2] [cursor=pointer]
  - heading "Title" [level=1] [ref=e8]
  - button "Say \\"hi\\" [ref=e99]" [ref=e9]
…[snapshot truncated]'''


def test_extract_targets():
    assert extract_targets(SNAP) == [
        Target("e2", "link", "Home"),
        Target("e3", "button", "Submit"),
        Target("e5", "checkbox", "Agree"),
        Target("e6", "button", ""),
        Target("e9", "button", 'Say "hi" [ref=e99]'),
    ]


def test_extract_targets_empty():
    assert extract_targets("") == [] and extract_targets("- page") == []


def test_extract_targets_empty_names():
    """Test that empty quoted names are handled like missing names."""
    snap = '''- button "" [ref=e10]
  - button "" [ref=e11] [cursor=pointer]'''
    assert extract_targets(snap) == [
        Target("e11", "button", ""),
    ]


# --- JevClient ---

Q = {"type": "choice", "instructions": "x", "criteria": {"x": None}}

OK = (200, json.dumps({
    "answers": {"a": {"type": "choice", "choice": "x", "probabilities": {"x": 1.0}, "confidence": 1.0}},
    "usage": {"input_tokens": 1000, "output_tokens": 50},
}).encode())


class FakeTransport:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append((url, headers, json.loads(body), timeout))
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


@pytest.fixture
def sleeps():
    return []


def test_ask_request_and_cost(sleeps):
    t = FakeTransport([OK])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    answers, cost = c.ask({"s": 1}, {"a": Q})
    url, headers, body, timeout = t.calls[0]
    assert url == "https://api.typesafe.ai/v1/systemone" and timeout == 10
    assert headers["Authorization"] == "Bearer k" and headers["Content-Type"] == "application/json"
    assert headers["User-Agent"] == "pw_agent"
    assert body == {"model": "jev-latest", "state": {"s": 1}, "questions": {"a": Q}}
    assert answers["a"]["choice"] == "x"
    assert cost == pytest.approx(1000 * 42e-9)


def test_retries_429_then_succeeds(sleeps):
    t = FakeTransport([(429, b""), OK])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    answers, _ = c.ask({}, {"a": Q})
    assert answers["a"]["choice"] == "x"
    assert sleeps == [1] and len(t.calls) == 2


def test_529_three_times_raises(sleeps):
    t = FakeTransport([(529, b"")] * 3)
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError):
        c.ask({}, {"a": Q})
    assert sleeps == [1, 3] and len(t.calls) == 3


def test_401_raises_auth_error(sleeps):
    t = FakeTransport([(401, b"{}")])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevAuthError):
        c.ask({}, {"a": Q})
    assert len(t.calls) == 1 and sleeps == []


def test_auth_error_not_jev_error():
    assert not issubclass(JevAuthError, JevError)


def test_422_raises_jev_error(sleeps):
    t = FakeTransport([(422, b"{}")])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError):
        c.ask({}, {"a": Q})
    assert len(t.calls) == 1 and sleeps == []


def test_timeout_raises_jev_error(sleeps):
    t = FakeTransport([TimeoutError("slow")])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError):
        c.ask({}, {"a": Q})


def test_malformed_json_raises_jev_error(sleeps):
    t = FakeTransport([(200, b"not json")])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError) as ei:
        c.ask({}, {"a": Q})
    assert ei.value.cost == 0.0


def test_missing_answers_keeps_cost(sleeps):
    body = json.dumps({"usage": {"input_tokens": 1000, "output_tokens": 5}}).encode()
    t = FakeTransport([(200, body)])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError) as ei:
        c.ask({}, {"a": Q})
    assert ei.value.cost == pytest.approx(1000 * 42e-9)


def test_missing_usage_costs_zero(sleeps):
    body = json.dumps({"answers": {"a": {"choice": "x"}}}).encode()
    t = FakeTransport([(200, body)])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    answers, cost = c.ask({}, {"a": Q})
    assert answers == {"a": {"choice": "x"}} and cost == 0.0


# ---- HybridBrain ----

class FakeJev:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def ask(self, state, questions):
        self.calls.append((state, questions))
        r = self.script.pop(0)
        if isinstance(r, Exception):
            raise r
        return r, 1e-6


class FakeClaude:
    def __init__(self, script=None):
        self.script = list(script or [])
        self.calls = []

    def decide(self, prompt, obs=None, ctx=None):
        self.calls.append((prompt, obs, ctx))
        r = self.script.pop(0) if self.script else Decision("", "", "claude goal", [Action("click", ["e2"])])
        if isinstance(r, Exception):
            raise r
        return r, 0.5


PAGE = Observation("tabs", '- link "Home" [ref=e2]\n- button "Submit" [ref=e3]', False)


def ctx(**kw):
    d = dict(step=2, task="t", memory="mem", history_lines=["h"], nudged=False, previous_failed=False)
    d.update(kw)
    return StepContext(**d)


def ans(action, ac, target="e3", tc=0.9):
    return {
        "action": {"type": "choice", "choice": action, "confidence": ac},
        "target": {"type": "choice", "choice": target, "confidence": tc},
    }


def run(script, obs=PAGE, c=None, claude=None):
    jev, claude = FakeJev(script), claude or FakeClaude()
    hb = HybridBrain(jev, claude)
    return hb, jev, claude, hb.decide("p", obs, c or ctx())


def test_accepted_click():
    _, jev, claude, (d, cost) = run([ans("click", .93, "e3", .88)])
    assert claude.calls == []
    assert d.actions == [Action("click", ["e3"])]
    assert d.source == "jev" and d.memory == "mem" and d.evaluation_previous_goal == ""
    assert d.next_goal == 'jev: click button "Submit" (0.88)'
    assert d.jev == {"action": "click", "action_confidence": .93, "target": "e3",
                     "target_confidence": .88, "routed": "accepted"}
    assert cost == 1e-6


def test_accepted_press_ignores_target_conf():
    _, _, _, (d, _) = run([ans("press_enter", .95, tc=.1)])
    assert d.actions == [Action("press", ["Enter"])]
    assert d.next_goal == "jev: press_enter (0.95)"


def test_accepted_go_back():
    _, _, _, (d, _) = run([ans("go_back", .9)])
    assert d.actions == [Action("go-back", [])]


def test_low_action_confidence():
    _, _, claude, (d, cost) = run([ans("click", .79)])
    assert len(claude.calls) == 1 and claude.calls[0][0] == "p" and claude.calls[0][1] is PAGE
    assert d.source == "claude" and d.jev["routed"] == "low_confidence"
    assert cost == pytest.approx(0.5 + 1e-6)


def test_low_target_confidence():
    _, _, _, (d, _) = run([ans("click", .95, tc=.5)])
    assert d.jev["routed"] == "low_confidence"


@pytest.mark.parametrize("action", ["needs_text", "done"])
def test_text_actions_go_to_claude(action):
    _, _, claude, (d, _) = run([ans(action, .99)])
    assert len(claude.calls) == 1 and d.jev["routed"] == action


@pytest.mark.parametrize("kw", [dict(step=1), dict(nudged=True), dict(previous_failed=True)])
def test_skip_conditions(kw):
    _, jev, claude, (d, cost) = run([], c=ctx(**kw))
    assert jev.calls == [] and d.jev is None and cost == 0.5


def test_skip_none_obs_or_ctx():
    hb = HybridBrain(FakeJev([]), FakeClaude())
    assert hb.decide("p")[0].jev is None
    assert hb.decide("p", PAGE)[0].jev is None
    assert hb.jev.calls == []


def test_skip_no_targets():
    _, jev, _, _ = run([], obs=Observation("t", "- page", False))
    assert jev.calls == []


def _many(n):
    return Observation("t", "\n".join(f'- button "b{i}" [ref=e{i}]' for i in range(n)), False)


def test_skip_256_targets():
    _, jev, claude, _ = run([], obs=_many(256))
    assert jev.calls == [] and len(claude.calls) == 1


def test_255_targets_calls_jev():
    _, jev, _, _ = run([ans("click", .99, "e3", .99)], obs=_many(255))
    assert len(jev.calls) == 1


def test_jev_error_falls_back():
    _, _, _, (d, cost) = run([JevError("boom", 1e-6)])
    assert d.jev == {"action": None, "action_confidence": None, "target": None,
                     "target_confidence": None, "routed": "error: boom"}
    assert d.source == "claude"
    assert cost == pytest.approx(0.5 + 1e-6)


def test_unknown_target_ref_falls_back():
    _, _, claude, (d, cost) = run([ans("click", .99, "e404", .99)])
    assert len(claude.calls) == 1 and d.jev["routed"].startswith("error:")
    assert cost == pytest.approx(0.5 + 1e-6)


def test_missing_confidence_falls_back():
    a = ans("click", .99)
    del a["action"]["confidence"]
    _, _, claude, (d, _) = run([a])
    assert len(claude.calls) == 1 and d.jev["routed"].startswith("error:")


def test_brain_error_carries_both_costs():
    claude = FakeClaude([BrainError("x", cost=.25)])
    hb = HybridBrain(FakeJev([ans("click", .5)]), claude)
    with pytest.raises(BrainError) as ei:
        hb.decide("p", PAGE, ctx())
    assert ei.value.cost == pytest.approx(.25 + 1e-6)


def test_auth_error_propagates():
    claude = FakeClaude()
    hb = HybridBrain(FakeJev([JevAuthError("bad")]), claude)
    with pytest.raises(JevAuthError):
        hb.decide("p", PAGE, ctx())
    assert claude.calls == []


def test_request_shape():
    _, jev, _, _ = run([ans("click", .9)])
    state, q = jev.calls[0]
    assert set(state) == {"task", "memory", "history", "tabs", "snapshot"}
    assert state["history"] == ["h"]
    assert set(q["action"]["criteria"]) == set(ACTION_OPTIONS)
    assert q["target"]["criteria"] == {"e2": 'link "Home"', "e3": 'button "Submit"'}


def test_repeat_nudge_hands_step_to_claude(tmp_path):
    from tests.test_loop import FakePW

    class PagePW(FakePW):
        def snapshot(self, path):
            return PAGE.snapshot

    jev = FakeJev([ans("click", .99, "e3", .99)] * 10)
    claude = FakeClaude([Decision("", "", "", [Action("goto", ["u"])]),
                         Decision("", "", "", [Action("done", ["success", "x"])])])
    r = Agent("t", PagePW(), HybridBrain(jev, claude), tmp_path).run()
    assert [h.decision.source for h in r.history] == ["claude", "jev", "jev", "jev", "claude"]


# ---- final-review fixes ----

def test_ask_value_error_does_not_leak_key(sleeps):
    t = FakeTransport([ValueError("Invalid header value b'Bearer SECRET123\\r'")])
    c = JevClient("SECRET123", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError) as ei:
        c.ask({}, {"a": Q})
    assert "SECRET" not in str(ei.value)


def test_ask_http_exception_is_jev_error(sleeps):
    import http.client
    t = FakeTransport([http.client.IncompleteRead(b"")])
    c = JevClient("k", transport=t, sleep=sleeps.append)
    with pytest.raises(JevError) as ei:
        c.ask({}, {"a": Q})
    assert "IncompleteRead" in str(ei.value)


def test_urllib_post_maps_http_error(monkeypatch):
    import io
    import urllib.error
    import urllib.request
    from pw_agent.jev import _urllib_post

    def boom(req, timeout):
        raise urllib.error.HTTPError("u", 422, "x", {}, io.BytesIO(b"bad"))

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert _urllib_post("http://x", {}, b"{}", 1) == (422, b"bad")


@pytest.mark.parametrize("conf", [float("nan"), 1.5, -0.1, float("inf")])
def test_bad_confidence_falls_back(conf):
    _, _, claude, (d, _) = run([ans("click", conf)])
    assert len(claude.calls) == 1 and d.jev["routed"].startswith("error:")


@pytest.mark.parametrize("n", [float("nan"), -5, float("inf")])
def test_bad_token_counts_cost_zero(sleeps, n):
    body = json.dumps({"answers": {"a": {"choice": "x"}},
                       "usage": {"input_tokens": n, "output_tokens": n}}).encode()
    c = JevClient("k", transport=FakeTransport([(200, body)]), sleep=sleeps.append)
    assert c.ask({}, {"a": Q})[1] == 0.0


def test_brain_error_after_jev_carries_record():
    claude = FakeClaude([BrainError("x", cost=.25)])
    hb = HybridBrain(FakeJev([ans("click", .5)]), claude)
    with pytest.raises(BrainError) as ei:
        hb.decide("p", PAGE, ctx())
    assert ei.value.jev["routed"] == "low_confidence"
