// Python's str.splitlines() separators. Python counts and slices text by code point, so the
// harness does too: limits and line counts must not depend on how JavaScript stores a string.
// Written with escapes only: a raw U+2028 in the source would end the line.
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\v\\f\\r\\x1c-\\x1e\\x85\\u2028\\u2029]");

export function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function sliceCodePoints(s: string, end: number): string {
  let i = 0;
  let units = 0;
  for (const ch of s) {
    if (i === end) return s.slice(0, units);
    i++;
    units += ch.length;
  }
  return s;
}
