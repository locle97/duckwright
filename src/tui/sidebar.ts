// Task list: one row per task with its state icon, name and (when wide enough) the latest run's cost.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { TaskSnapshot } from "../runs/manager.ts";
import { sanitize } from "./sanitize.ts";
import type { ViewState } from "./state.ts";
import { ROLE, TASK_ICON } from "./theme.ts";

export interface SidebarProps {
  s: ViewState;
  width: number;
  height: number;
  focused: boolean;
  showCost: boolean;
}

/** The first visible row, so that `selected` stays inside a window of `size` rows. */
export function scrollStart(selected: number, count: number, size: number): number {
  if (size <= 0 || count <= size) return 0;
  return Math.min(Math.max(0, selected - size + 1), count - size);
}

function TaskRow({ t, cost, selected, focused, showCost }: {
  t: TaskSnapshot; cost: number | null; selected: boolean; focused: boolean; showCost: boolean;
}): ReactElement {
  const icon = TASK_ICON[t.state];
  const marks = h(Text, { wrap: "truncate-end" },
    Object.keys(t.overrides).length > 0 ? h(Text, { color: ROLE.accent }, " ↻") : null,
    t.error !== null ? h(Text, { color: ROLE.error, bold: true }, " !") : null,
    showCost && cost !== null ? `  $${cost.toFixed(3)}` : null);
  return h(Box, { flexDirection: "row" },
    h(Box, { flexGrow: 1, flexShrink: 1 },
      h(Text, { wrap: "truncate-end" },
        h(Text, { color: icon.color }, icon.icon), " ",
        h(Text, { inverse: selected && focused, bold: selected && !focused }, sanitize(t.name)))),
    h(Box, { flexShrink: 0 }, marks));
}

export function Sidebar({ s, width, height, focused, showCost }: SidebarProps): ReactElement {
  const framed = height >= 3;
  const size = Math.max(0, height - (framed ? 2 : 0) - 1);
  const start = scrollStart(s.selected, s.tasks.length, size);
  const rows = s.tasks.slice(start, start + size).map((t, i) => {
    const run = t.runId !== null ? s.runs[t.runId] : undefined;
    return h(TaskRow, {
      key: t.id, t, cost: run ? run.cost : null, selected: start + i === s.selected, focused, showCost,
    });
  });
  return h(Box, {
    flexDirection: "column", width, height, flexShrink: 0, overflow: "hidden", paddingX: 1,
    ...(framed ? { borderStyle: "round" as const, borderColor: focused ? ROLE.accent : ROLE.border } : {}),
  },
  h(Text, { color: ROLE.muted, bold: true, wrap: "truncate-end" }, "TASKS"),
  ...rows);
}
