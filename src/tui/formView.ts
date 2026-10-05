// A settings form (one task's, or the global options as a dialog): one row per field, overridden values in the accent colour,
// an invalid field's error under it.
import { Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { Centered, Dialog } from "./dialog.ts";
import type { FormState } from "./form.ts";
import { sanitize } from "./sanitize.ts";
import { useTheme } from "./themeContext.ts";

const DIALOG_WIDTH = 56;

export function FormView({ form, title, width, height }: { form: FormState; title: string; width: number; height: number }): ReactElement {
  const { role } = useTheme();
  const labelWidth = Math.max(...form.fields.map((f) => f.label.length)) + 2;
  const rows: ReactElement[] = [h(Text, { bold: true, wrap: "truncate-end" }, title)];
  form.fields.forEach((f, i) => {
    const focused = i === form.focus;
    rows.push(h(Text, { wrap: "truncate-end" },
      focused ? h(Text, { color: role.accent }, "› ") : "  ",
      h(Text, { color: role.muted }, f.label.padEnd(labelWidth)),
      h(Text, { color: f.overridden ? role.accent : undefined, inverse: focused }, sanitize(f.raw) || " ")));
    if (f.error !== null) rows.push(h(Text, { color: role.error, wrap: "truncate-end" }, `    ${sanitize(f.error)}`));
  });
  rows.push(h(Text, { color: role.muted, wrap: "truncate-end" }, "ctrl+r reset field"));
  return h(Centered, {
    width, height,
    child: h(Dialog, { width: Math.min(width, DIALOG_WIDTH), borderColor: role.accent, rows: rows.slice(0, Math.max(1, height - 2)) }),
  });
}
