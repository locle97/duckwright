// The add box under the panes: a `› ` prompt, the typed text with a cursor while focused,
// or the placeholder. Shows at most MAX_LINES lines and scrolls to keep the cursor in view.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { lines } from "./compose.ts";
import type { ComposeState } from "./compose.ts";
import { sanitize } from "./sanitize.ts";
import { ROLE } from "./theme.ts";

export const MAX_LINES = 6;
const PLACEHOLDER = "Describe a task to add…";

/** Rows the box takes, border included. */
export function addBoxHeight(c: ComposeState): number {
  return Math.min(MAX_LINES, lines(c).lines.length) + 2;
}

export function AddBox({ compose, focused, width }: { compose: ComposeState; focused: boolean; width: number }): ReactElement {
  const { lines: all, row, col } = lines(compose);
  const first = Math.min(Math.max(0, row - MAX_LINES + 1), Math.max(0, all.length - MAX_LINES));
  // Border and padding take 4 columns, the prompt 2; keep one more for the cursor.
  const room = Math.max(1, width - 6 - 1);
  const shown = all.slice(first, first + MAX_LINES).map((line, i) => {
    const prompt = first + i === 0 ? "› " : "  ";
    if (compose.text === "") {
      // While focused the cursor sits on the placeholder's first letter.
      return h(Text, { key: i, wrap: "truncate-end" }, prompt,
        h(Text, { dimColor: true, inverse: focused }, PLACEHOLDER[0]), h(Text, { dimColor: true }, PLACEHOLDER.slice(1)));
    }
    if (!focused || first + i !== row) {
      return h(Text, { key: i, wrap: "truncate-end", dimColor: !focused }, prompt, sanitize(line));
    }
    const from = Math.max(0, col - room + 1);
    const code = line.codePointAt(col);
    const under = code === undefined ? "" : String.fromCodePoint(code);
    return h(Text, { key: i, wrap: "truncate-end" }, prompt, sanitize(line.slice(from, col)),
      h(Text, { inverse: true }, sanitize(under) || " "), sanitize(line.slice(col + under.length)));
  });
  return h(Box, {
    flexDirection: "column", width, flexShrink: 0, paddingX: 1,
    borderStyle: "round", borderColor: focused ? ROLE.accent : ROLE.border,
  }, ...shown);
}
