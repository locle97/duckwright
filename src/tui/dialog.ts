// A bordered box drawn over the panes. Ink does not clear what lies under a box, so every row is
// painted with spaces first and its content drawn on top.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

export interface DialogProps {
  /** Outer width, border included. */
  width: number;
  borderColor: string;
  rows: ReactElement[];
  /** Drawn in the top border, as `╭ title ───╮`. Already sanitised. */
  title?: string;
}

export function Dialog({ width, borderColor, rows, title }: DialogProps): ReactElement {
  const inner = Math.max(1, width - 2);
  const body = rows.map((content, i) => h(Box, { key: i, width: inner, height: 1, overflow: "hidden" },
    h(Box, { position: "absolute" }, h(Text, {}, " ".repeat(inner))),
    h(Box, { width: inner, paddingX: 1 }, content)));
  if (title === undefined) {
    return h(Box, { flexDirection: "column", width, flexShrink: 0, borderStyle: "round", borderColor }, ...body);
  }
  const label = [...` ${title} `].slice(0, inner).join("");
  const top = `╭${label}${"─".repeat(Math.max(0, inner - [...label].length))}╮`;
  return h(Box, { flexDirection: "column", width, flexShrink: 0 },
    h(Text, { color: borderColor, wrap: "truncate-end" }, top),
    h(Box, { flexDirection: "column", width, borderStyle: "round", borderColor, borderTop: false }, ...body));
}

/** Centre `child` over an area of the given size. */
export function Centered({ width, height, child }: { width: number; height: number; child: ReactElement }): ReactElement {
  return h(Box, { position: "absolute", top: 0, left: 0, width, height, justifyContent: "center", alignItems: "center" }, child);
}
