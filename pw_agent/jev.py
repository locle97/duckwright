"""JEV snapshot target extraction and API client."""

import re
from dataclasses import dataclass


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
