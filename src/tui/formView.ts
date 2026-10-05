// The per-task settings form: one row per field, overridden values in the accent colour,
// an invalid field's error under it.
import { Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { Centered, Dialog } from "./dialog.ts";
import type { FormState } from "./form.ts";
import { sanitize } from "./sanitize.ts";
import { ROLE } from "./theme.ts";

const DIALOG_WIDTH = 56;

export function FormView({ form, width, height }: { form: FormState; width: number; height: number }): ReactElement {
  const labelWidth = Math.max(...form.fields.map((f) => f.label.length)) + 2;
  const rows: ReactElement[] = [h(Text, { bold: true, wrap: "truncate-end" }, "Settings")];
  form.fields.forEach((f, i) => {
    const focused = i === form.focus;
    rows.push(h(Text, { wrap: "truncate-end" },
      focused ? h(Text, { color: ROLE.accent }, "› ") : "  ",
      h(Text, { color: ROLE.muted }, f.label.padEnd(labelWidth)),
      h(Text, { color: f.overridden ? ROLE.accent : undefined, inverse: focused }, sanitize(f.raw) || " ")));
    if (f.error !== null) rows.push(h(Text, { color: ROLE.error, wrap: "truncate-end" }, `    ${sanitize(f.error)}`));
  });
  rows.push(h(Text, { color: ROLE.muted, wrap: "truncate-end" }, "ctrl+r reset field"));
  return h(Centered, {
    width, height,
    child: h(Dialog, { width: Math.min(width, DIALOG_WIDTH), borderColor: ROLE.accent, rows: rows.slice(0, Math.max(1, height - 2)) }),
  });
}
