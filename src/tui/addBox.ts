// The add box under the panes: a `› ` prompt, the typed text with a cursor while focused,
// or the placeholder. Shows at most MAX_LINES lines and scrolls to keep the cursor in view.
// Mentions are drawn in the accent colour, or red when their path does not exist; the errors of
// a refused submission are listed under the text.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { lines, spans } from "./compose.ts";
import type { ComposeState, SpanKind } from "./compose.ts";
import { sanitize } from "./sanitize.ts";
import { DEFAULT_THEME, paneBorder } from "./theme.ts";
import type { Theme } from "./theme.ts";

export const MAX_LINES = 6;
const MAX_ERRORS = 3;
const PLACEHOLDER = "Describe a task, or @ a task file or folder…";
const PLAN_PLACEHOLDER = "@ a plan file to break into tasks, or a planned folder…";

/** The error rows shown: up to MAX_ERRORS, then `…and N more`. */
function errorRows(errors: string[]): string[] {
  if (errors.length <= MAX_ERRORS) return errors;
  return [...errors.slice(0, MAX_ERRORS - 1), `…and ${errors.length - MAX_ERRORS + 1} more`];
}

/** Rows the box takes, border included. */
export function addBoxHeight(c: ComposeState, errors: string[] = []): number {
  return Math.min(MAX_LINES, lines(c).lines.length) + errorRows(errors).length + 2;
}

const colorOf = (theme: Theme): Record<SpanKind, string | undefined> => (
  { text: undefined, mention: theme.role.accent, missing: theme.role.error });

interface Piece { text: string; kind: SpanKind }

/** The parts of one line (starting at `offset` in the text), cut where the span kinds change. */
function linePieces(all: { start: number; text: string; kind: SpanKind }[], offset: number, line: string): Piece[] {
  const end = offset + line.length;
  const out: Piece[] = [];
  for (const sp of all) {
    const from = Math.max(sp.start, offset);
    const to = Math.min(sp.start + sp.text.length, end);
    if (to > from) out.push({ text: sp.text.slice(from - sp.start, to - sp.start), kind: sp.kind });
  }
  return out;
}

/** Pieces of `[from, to)` in line coordinates, as coloured Text. */
function draw(pieces: Piece[], from: number, to: number, dim: boolean, key: string, theme: Theme): ReactElement[] {
  const COLOR = colorOf(theme);
  const out: ReactElement[] = [];
  let at = 0;
  pieces.forEach((p, i) => {
    const a = Math.max(from, at);
    const b = Math.min(to, at + p.text.length);
    if (b > a) out.push(h(Text, { key: `${key}${i}`, color: COLOR[p.kind], dimColor: dim }, sanitize(p.text.slice(a - at, b - at))));
    at += p.text.length;
  });
  return out;
}

export interface AddBoxProps {
  compose: ComposeState;
  focused: boolean;
  width: number;
  exists(path: string): boolean;
  errors: string[];
  /** Default: the dark 16-colour theme. A plain function, so it takes the theme as a prop. */
  theme?: Theme;
  /** The box takes a plan file rather than a task. */
  forPlan?: boolean;
}

export function AddBox({ compose, focused, width, exists, errors, theme = DEFAULT_THEME, forPlan = false }: AddBoxProps): ReactElement {
  const placeholder = forPlan ? PLAN_PLACEHOLDER : PLACEHOLDER;
  const { lines: all, row, col } = lines(compose);
  const first = Math.min(Math.max(0, row - MAX_LINES + 1), Math.max(0, all.length - MAX_LINES));
  const marked = spans(compose.text, exists);
  const offsets: number[] = [];
  all.reduce((at, line) => (offsets.push(at), at + line.length + 1), 0);
  // Border and padding take 4 columns, then the prompt; keep one more for the cursor.
  const room = Math.max(1, width - 4 - (forPlan ? 7 : 2) - 1);
  const shown = all.slice(first, first + MAX_LINES).map((line, i) => {
    const n = first + i;
    const prompt = n === 0 ? (forPlan ? "plan › " : "› ") : forPlan ? "       " : "  ";
    if (compose.text === "") {
      // While focused the cursor sits on the placeholder's first letter.
      return h(Text, { key: i, wrap: "truncate-end" }, prompt,
        h(Text, { dimColor: true, inverse: focused }, placeholder[0]), h(Text, { dimColor: true }, placeholder.slice(1)));
    }
    const pieces = linePieces(marked, offsets[n] ?? 0, line);
    if (!focused || n !== row) {
      return h(Text, { key: i, wrap: "truncate-end", dimColor: !focused }, prompt, ...draw(pieces, 0, line.length, !focused, "p", theme));
    }
    const from = Math.max(0, col - room + 1);
    const code = line.codePointAt(col);
    const under = code === undefined ? "" : String.fromCodePoint(code);
    return h(Text, { key: i, wrap: "truncate-end" }, prompt, ...draw(pieces, from, col, false, "a", theme),
      h(Text, { key: "cursor", inverse: true }, sanitize(under) || " "),
      ...draw(pieces, col + under.length, line.length, false, "b", theme));
  });
  const problems = errorRows(errors).map((e, i) => h(Text, { key: `e${i}`, color: theme.role.error, wrap: "truncate-end" }, sanitize(e)));
  return h(Box, {
    flexDirection: "column", width, flexShrink: 0, paddingX: 1,
    ...paneBorder(theme, focused),
  }, ...shown, ...problems);
}
