// The help overlay: every binding of the screen it was opened from.
import { Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { Centered, Dialog } from "./dialog.ts";
import { helpBindings } from "./keys.ts";
import type { ViewState } from "./state.ts";
import { ROLE } from "./theme.ts";

export function Help({ s, width, height }: { s: ViewState; width: number; height: number }): ReactElement {
  const bindings = [...helpBindings(s), { key: "ctrl+c", label: "quit (3× force exit)" }];
  const keyWidth = Math.max(...bindings.map((b) => b.key.length)) + 2;
  const rows = [
    h(Text, { bold: true, wrap: "truncate-end" }, "Keys"),
    ...bindings.map((b) => h(Text, { wrap: "truncate-end" }, h(Text, { color: ROLE.accent }, b.key.padEnd(keyWidth)), b.label)),
    h(Text, { color: ROLE.muted, wrap: "truncate-end" }, "esc close"),
  ].slice(0, Math.max(1, height - 2));
  const dialogWidth = Math.min(width, keyWidth + Math.max(...bindings.map((b) => b.label.length)) + 4);
  return h(Centered, { width, height, child: h(Dialog, { width: dialogWidth, borderColor: ROLE.accent, rows }) });
}
