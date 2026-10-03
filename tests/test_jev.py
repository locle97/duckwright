"""Tests for JEV snapshot target extraction and the API client."""

import json

import pytest

from pw_agent.jev import JevAuthError, JevClient, JevError, Target, extract_targets


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
