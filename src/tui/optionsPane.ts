// The global options pane under the task list: the options every task's next run starts from,
// set values in the accent colour. h/l focus it, ⏎ (or `O` from anywhere) edits it in place.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { openForm } from "./form.ts";
import { sanitize } from "./sanitize.ts";
import { scrollStart } from "./sidebar.ts";
import { editingGlobals } from "./state.ts";
import type { ViewState } from "./state.ts";
import { paneBorder } from "./theme.ts";
import { useTheme } from "./themeContext.ts";

/** `text` in lines of at most `width` characters, broken at spaces where it can be. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= width || line === "") {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  lines.push(line);
  return lines.flatMap((l) => (l.length <= width ? [l] : l.match(new RegExp(`.{1,${width}}`, "gu")) ?? []));
}

/** Rows the pane takes from a left column of `paneHeight` rows; 0 when there is no room for it. */
export function optionsHeight(paneHeight: number, columns: number): number {
  if (columns < 60 || paneHeight < 10) return 0;
  return Math.round(paneHeight * 0.3);
}

export function OptionsPane({ s, width, height }: { s: ViewState; width: number; height: number }): ReactElement {
  const theme = useTheme();
  const { role } = theme;
  const g = s.globals;
  if (g === null) return h(Box, { width, height, flexShrink: 0 });
  const editing = editingGlobals(s);
  // Navigating: the pane has the focus and a highlighted row, but nothing is being edited.
  const navigating = !editing && s.focus === "options" && s.mode !== "compose";
  const form = editing && s.form !== null ? s.form : openForm(null, g.base, g.overrides, 0, g.environments);
  const labelWidth = Math.max(...form.fields.map((f) => f.label.length)) + 2;
  const rows: ReactElement[] = [];
  let focusedRow = 0;
  form.fields.forEach((f, i) => {
    const focused = (editing && i === form.focus) || (navigating && i === s.optionsSelected);
    if (focused) focusedRow = rows.length;
    rows.push(h(Text, { key: f.key, wrap: "truncate-end" },
      focused ? h(Text, { color: role.accent }, "› ") : "  ",
      h(Text, { color: role.muted }, f.label.padEnd(labelWidth)),
      h(Text, { color: f.overridden ? role.accent : undefined, inverse: focused && editing }, sanitize(f.raw) || " ")));
    if (editing && f.error !== null) {
      // The column is narrow: the error wraps over as many rows as it needs, so it can be read.
      wrapWords(sanitize(f.error), Math.max(1, width - 8)).forEach((line, j) => {
        rows.push(h(Text, { key: `${f.key}-error-${j}`, color: role.error, wrap: "truncate-end" }, `    ${line}`));
      });
    }
  });
  const size = Math.max(0, height - 3);
  const start = scrollStart(focusedRow, rows.length, size);
  return h(Box, {
    flexDirection: "column", width, height, flexShrink: 0, overflow: "hidden", paddingX: 1,
    ...paneBorder(theme, editing || navigating),
  },
  h(Text, { color: role.muted, bold: true, wrap: "truncate-end" }, "OPTIONS"),
  ...rows.slice(start, start + size));
}
