// The yes/no question for quitting with active runs or removing a task.
import { Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { Centered, Dialog } from "./dialog.ts";
import { sanitize } from "./sanitize.ts";
import type { ViewState } from "./state.ts";
import { useTheme } from "./themeContext.ts";

export function question(s: ViewState): string {
  const c = s.confirm;
  if (c === null) return "";
  if (c.kind === "quit") return `stop ${c.count} run${c.count === 1 ? "" : "s"} and quit?`;
  const t = s.tasks.find((x) => x.id === c.taskId);
  return `remove ${t ? sanitize(t.name) : "this task"}?`;
}

export function Confirm({ s, width, height }: { s: ViewState; width: number; height: number }): ReactElement {
  const { role } = useTheme();
  const text = question(s);
  const rows = [
    h(Text, { bold: true, wrap: "truncate-end" }, text),
    h(Text, { color: role.muted, wrap: "truncate-end" }, "y yes · n no"),
  ];
  const dialogWidth = Math.min(width, Math.max(20, [...text].length + 4));
  return h(Centered, { width, height, child: h(Dialog, { width: dialogWidth, borderColor: role.accent, rows }) });
}
