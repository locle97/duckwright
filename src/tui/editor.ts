// The editor drawn over the panes: a task file, typed task or shared setup as text, with line
// numbers, a cursor, and the reason the last save was refused. Scrolls to keep the cursor in view.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { lines } from "./compose.ts";
import { Dialog } from "./dialog.ts";
import { sanitize } from "./sanitize.ts";
import type { EditState } from "./state.ts";
import { useTheme } from "./themeContext.ts";

/** The first line shown, so that `row` stays inside a window of `size` lines. */
export function firstLine(row: number, count: number, size: number): number {
  if (size <= 0 || count <= size) return 0;
  return Math.min(Math.max(0, row - size + 1), count - size);
}

export function Editor({ edit, width, height }: { edit: EditState; width: number; height: number }): ReactElement {
  const { role } = useTheme();
  const { lines: all, row, col } = lines(edit.compose);
  const errorRows = edit.error !== null ? 1 : 0;
  // The dialog's border takes two rows; the rest is text, then the error.
  const size = Math.max(1, height - 2 - errorRows);
  const first = Math.min(firstLine(row, all.length, size), Math.max(0, all.length - 1));
  const gutter = String(all.length).length + 1;
  // Border and padding take 4 columns, then the gutter; keep one more for the cursor.
  const room = Math.max(1, width - 4 - gutter - 1);
  const rows: ReactElement[] = [];
  for (let n = first; n < first + size; n++) {
    const line = all[n];
    if (line === undefined) {
      rows.push(h(Text, { key: n, color: role.muted }, "~"));
      continue;
    }
    const num = h(Text, { color: role.muted }, String(n + 1).padStart(gutter - 1) + " ");
    if (n !== row) {
      rows.push(h(Text, { key: n, wrap: "truncate-end" }, num, sanitize(line)));
      continue;
    }
    // The cursor's line scrolls sideways to keep the cursor in view.
    const from = Math.max(0, col - room + 1);
    const code = line.codePointAt(col);
    const under = code === undefined ? "" : String.fromCodePoint(code);
    rows.push(h(Text, { key: n, wrap: "truncate-end" }, num, sanitize(line.slice(from, col)),
      h(Text, { inverse: true }, sanitize(under) || " "), sanitize(line.slice(col + under.length))));
  }
  if (edit.error !== null) rows.push(h(Text, { key: "error", color: role.error, wrap: "truncate-end" }, `! ${sanitize(edit.error)}`));
  const changed = edit.compose.text !== edit.original ? " (changed)" : "";
  return h(Box, { position: "absolute", top: 0, left: 0, width, height },
    h(Dialog, { width, borderColor: role.accent, rows, title: `edit ${sanitize(edit.title)}${changed}` }));
}
