// Python's str.splitlines() separators. Python counts and slices text by code point, so the
// harness does too: limits and line counts must not depend on how JavaScript stores a string.
// Written with escapes only: a raw U+2028 in the source would end the line.
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\v\\f\\r\\x1c-\\x1e\\x85\\u2028\\u2029]");

/** Python's universal newlines: \r\n and a lone \r become \n, as text-mode reads do. */
export function universalNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Python's f"{x:.4f}" for a non-negative x: toFixed, but an exact tie rounds to even. */
export function fixed4(x: number): string {
  const up = x.toFixed(4);
  // A tie at the fifth decimal is always an odd multiple of 1/32, which toFixed(20) shows exactly.
  const exact = x.toFixed(20);
  const cut = exact.indexOf(".") + 5;
  if (!/^50*$/.test(exact.slice(cut))) return up;
  const down = exact.slice(0, cut);
  return Number(down.at(-1)) % 2 === 0 ? down : up;
}

/** Python's sorted() order for strings: by code point, not UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
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

/** Collapse every line break to a space, so untrusted text stays on one line. */
export function flat(s: string): string {
  return s ? splitLines(String(s)).join(" ") : "";
}

const HARNESS_TAG = /<(?=\/?(?:page_snapshot|tabs|task|memory|history|network|environment))/gi;

/** Escape harness section tags inside untrusted page data so it cannot close its block. */
export function neutralise(body: string): string {
  return body.replace(HARNESS_TAG, "&lt;");
}

/** How a path is written as an add-box mention: `@path`, quoted when it holds whitespace. */
export function mentionToken(p: string): string {
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}
