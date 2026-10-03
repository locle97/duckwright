"""Tests for JEV snapshot target extraction."""

from pw_agent.jev import Target, extract_targets


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
