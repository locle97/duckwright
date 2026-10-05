// The @ completion list: ranked task files and folders for the mention under the cursor, drawn
// over the bottom of the panes, just above the add box.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { mentionAt } from "./compose.ts";
import { Dialog } from "./dialog.ts";
import { sanitize } from "./sanitize.ts";
import { scrollStart } from "./sidebar.ts";
import { completionItems } from "./state.ts";
import type { ViewState } from "./state.ts";
import { useTheme } from "./themeContext.ts";

export const MAX_ROWS = 8;

/** Rows of entries shown: at most 8, or half the pane height if that is less, and at least 1. */
export function completionRows(paneHeight: number): number {
  return Math.max(1, Math.min(MAX_ROWS, Math.floor(paneHeight / 2)));
}

export function Completion({ s, width, paneHeight }: { s: ViewState; width: number; paneHeight: number }): ReactElement | null {
  const { role } = useTheme();
  if (s.completion === null) return null;
  const items = completionItems(s);
  const size = completionRows(paneHeight);
  const highlight = Math.min(s.completion.highlight, Math.max(0, items.length - 1));
  const start = scrollStart(highlight, items.length, size);
  const rows: ReactElement[] = items.length === 0
    ? [h(Text, { color: role.muted }, "no matches")]
    : items.slice(start, start + size).map((c, i) => {
      const on = start + i === highlight;
      return h(Box, { flexDirection: "row", flexGrow: 1 },
        h(Box, { flexShrink: 0 }, h(Text, { color: role.accent }, on ? "▸ " : "  ")),
        h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, { wrap: "truncate-middle", bold: on }, sanitize(c.path))),
        c.folder ? h(Box, { flexShrink: 0, marginLeft: 2 }, h(Text, { color: role.muted }, `folder · ${c.count}`)) : null);
    });
  if (s.completion.index.truncated) rows.push(h(Text, { color: role.muted }, "first 5,000 entries only"));
  const query = mentionAt(s.compose.text, s.compose.cursor)?.path ?? "";
  const boxWidth = Math.max(10, Math.min(60, width - 4));
  const height = rows.length + 2;
  // Inside the panes' borders, sitting on the bottom one, just above the add box.
  return h(Box, { position: "absolute", top: Math.max(0, paneHeight - 1 - height), left: 2, width: boxWidth },
    h(Dialog, { width: boxWidth, borderColor: role.accent, rows, title: query === "" ? "@" : sanitize(query) }));
}
