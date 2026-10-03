"""JEV snapshot target extraction and HTTP client for the Jev API."""

import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from pw_agent.brain import Action, Brain, BrainError, Decision, StepContext
from pw_agent.observe import Observation


JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_INPUT_USD_PER_TOKEN = 42e-9
JEV_OUTPUT_USD_PER_TOKEN = 0.0


TARGET_ROLES = ("link", "button", "checkbox", "radio", "tab", "menuitem", "option")

# Regex to parse snapshot lines: role, optional quoted name, rest of line
_LINE = re.compile(r'^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$')
# Regex to extract ref from the rest of the line
_REF = re.compile(r"\[ref=([^\]\s]+)\]")


@dataclass(frozen=True)
class Target:
    """A clickable target extracted from a snapshot."""
    ref: str
    role: str
    name: str


def extract_targets(snapshot: str) -> list[Target]:
    """Extract clickable targets from a Playwright snapshot.

    Args:
        snapshot: The snapshot text from a Playwright test

    Returns:
        A list of Target objects, deduplicated by ref, in order of appearance
    """
    targets = []
    seen_refs = set()

    for line in snapshot.split('\n'):
        match = _LINE.match(line)
        if not match:
            continue

        role, raw_name, rest = match.groups()

        # Only process lines with roles we care about
        if role not in TARGET_ROLES:
            continue

        # Extract ref from the rest of the line
        ref_match = _REF.search(rest)
        if not ref_match:
            continue

        ref = ref_match.group(1)

        # Skip duplicate refs (keep only first occurrence)
        if ref in seen_refs:
            continue
        seen_refs.add(ref)

        # Determine name: use provided name or empty string
        name = ""
        if raw_name is not None:
            # Unescape the name: convert backslash-escaped characters to the character itself
            name = re.sub(r"\\(.)", r"\1", raw_name)

        # Skip if no name and no cursor=pointer (applies to both missing and empty names)
        if not name and "[cursor=pointer]" not in rest:
            continue

        targets.append(Target(ref, role, name))

    return targets


class JevError(Exception):
    """A failed Jev call; `cost` is any spend already incurred."""

    def __init__(self, msg: str = "", cost: float = 0.0):
        super().__init__(msg)
        self.cost = cost


class JevAuthError(Exception):
    """Bad API key. Deliberately not a JevError so it is never swallowed."""


# (url, headers, body, timeout) -> (status, body); raises OSError on network failure.
Transport = Callable[[str, dict[str, str], bytes, float], tuple[int, bytes]]


def _urllib_post(url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _count(usage: object, key: str) -> float:
    if not isinstance(usage, dict):
        return 0
    n = usage.get(key)
    return n if isinstance(n, (int, float)) and not isinstance(n, bool) else 0


class JevClient:
    def __init__(
        self,
        api_key: str,
        model: str = "jev-latest",
        timeout: float = 10,
        transport: Transport = _urllib_post,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self._transport = transport
        self._sleep = sleep

    def ask(self, state: object, questions: dict) -> tuple[dict, float]:
        """Send questions about `state`; return (answers, cost_usd)."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "pw_agent",
        }
        body = json.dumps({"model": self.model, "state": state, "questions": questions}).encode()
        for attempt in range(3):
            try:
                status, raw = self._transport(JEV_URL, headers, body, self.timeout)
            except OSError as e:
                raise JevError(f"jev network error: {e}") from e
            if status in (429, 529):
                if attempt < 2:
                    self._sleep((1, 3)[attempt])
                    continue
                raise JevError(f"jev busy (HTTP {status})")
            if status == 401:
                raise JevAuthError("jev rejected the API key (HTTP 401)")
            if status != 200:
                raise JevError(f"jev HTTP {status}")
            break
        try:
            data = json.loads(raw)
        except ValueError as e:
            raise JevError("jev returned invalid JSON") from e
        if not isinstance(data, dict):
            raise JevError("jev response is not an object")
        usage = data.get("usage")
        cost = (
            _count(usage, "input_tokens") * JEV_INPUT_USD_PER_TOKEN
            + _count(usage, "output_tokens") * JEV_OUTPUT_USD_PER_TOKEN
        )
        answers = data.get("answers")
        if not isinstance(answers, dict):
            raise JevError("jev response has no answers", cost)
        return answers, cost


ACTION_INSTRUCTIONS = (
    "You control a web browser to complete `task`. `snapshot` is the current page, "
    "`history` the steps so far, `memory` the agent's notes. Which single next action best advances the task?"
)
TARGET_INSTRUCTIONS = (
    "If the next action clicks, checks, unchecks or hovers an element of `snapshot`, which element should it be?"
)
# option: (description, cmd, args, needs_target); args None means [target ref]
ACTION_OPTIONS = {
    "click":        ("Click a link, button, tab or menu item on the page", "click", None, True),
    "check":        ("Tick an unticked checkbox or select a radio button", "check", None, True),
    "uncheck":      ("Untick a ticked checkbox", "uncheck", None, True),
    "hover":        ("Hover over an element to reveal a menu or tooltip", "hover", None, True),
    "press_enter":  ("Press Enter to submit the focused field", "press", ["Enter"], False),
    "press_tab":    ("Press Tab to move focus to the next field", "press", ["Tab"], False),
    "press_escape": ("Press Escape to close a dialog or menu", "press", ["Escape"], False),
    "go_back":      ("Go back to the previous page", "go-back", [], False),
    "needs_text":   ("The next action needs typed text: open a URL, fill or type into a field, or choose a value", None, None, False),
    "done":         ("The task is complete or cannot be completed", None, None, False),
}
MAX_CHOICES = 255


def _choice(answers: dict, qid: str, options) -> tuple[str, float]:
    """Read (choice, confidence) for `qid`; raise JevError if malformed."""
    a = answers.get(qid)
    if not isinstance(a, dict):
        raise JevError(f"jev answer {qid!r} missing or malformed")
    choice = a.get("choice")
    if not isinstance(choice, str) or choice not in options:
        raise JevError(f"jev answer {qid!r} has unknown choice {choice!r}")
    conf = a.get("confidence")
    if not isinstance(conf, (int, float)) or isinstance(conf, bool):
        raise JevError(f"jev answer {qid!r} has no numeric confidence")
    return choice, float(conf)


class HybridBrain:
    """Ask Jev for text-free steps; fall back to Claude when it is unsure."""

    def __init__(self, jev: JevClient, claude: Brain, min_confidence: float = 0.8):
        self.jev = jev
        self.claude = claude
        self.min_confidence = min_confidence

    def _claude(self, prompt, obs, ctx, record, jev_cost):
        try:
            decision, cost = self.claude.decide(prompt, obs, ctx)
        except BrainError as e:
            e.cost += jev_cost
            raise
        decision.source = "claude"
        decision.jev = record
        return decision, jev_cost + cost

    def decide(
        self, prompt: str, obs: Observation | None = None, ctx: StepContext | None = None
    ) -> tuple[Decision, float]:
        if obs is None or ctx is None or ctx.step == 1 or ctx.nudged or ctx.previous_failed:
            return self.claude.decide(prompt, obs, ctx)
        targets = extract_targets(obs.snapshot)
        if not targets or len(targets) > MAX_CHOICES:
            return self.claude.decide(prompt, obs, ctx)

        by_ref = {t.ref: t for t in targets}
        state = {"task": ctx.task, "memory": ctx.memory, "history": ctx.history_lines,
                 "tabs": obs.tabs, "snapshot": obs.snapshot}
        questions = {
            "action": {"type": "choice", "instructions": ACTION_INSTRUCTIONS,
                       "criteria": {k: v[0] for k, v in ACTION_OPTIONS.items()}},
            "target": {"type": "choice", "instructions": TARGET_INSTRUCTIONS,
                       "criteria": {t.ref: f'{t.role} "{t.name}"' for t in targets}},
        }
        record = {"action": None, "action_confidence": None, "target": None,
                  "target_confidence": None, "routed": ""}
        try:
            answers, cost = self.jev.ask(state, questions)
        except JevError as e:
            record["routed"] = f"error: {e}"
            return self._claude(prompt, obs, ctx, record, e.cost)
        try:
            action, ac = _choice(answers, "action", ACTION_OPTIONS)
            record["action"], record["action_confidence"] = action, ac
            target, tc = _choice(answers, "target", by_ref)
            record["target"], record["target_confidence"] = target, tc
        except JevError as e:
            record["routed"] = f"error: {e}"
            return self._claude(prompt, obs, ctx, record, cost)

        _, cmd, args, needs_target = ACTION_OPTIONS[action]
        mc = self.min_confidence
        if action in ("needs_text", "done"):
            record["routed"] = action
        elif ac < mc or (needs_target and tc < mc):
            record["routed"] = "low_confidence"
        else:
            record["routed"] = "accepted"
        if record["routed"] != "accepted":
            return self._claude(prompt, obs, ctx, record, cost)

        if needs_target:
            t = by_ref[target]
            goal = f'jev: {action} {t.role} "{t.name}" ({min(ac, tc):.2f})'
            acts = [Action(cmd, [target])]
        else:
            goal = f"jev: {action} ({ac:.2f})"
            acts = [Action(cmd, list(args))]
        return Decision("", ctx.memory, goal, acts, source="jev", jev=record), cost
