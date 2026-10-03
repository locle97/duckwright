"""JEV snapshot target extraction and HTTP client for the Jev API."""

import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass


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
