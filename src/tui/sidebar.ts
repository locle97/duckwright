// Task list: one row per task with its state icon, name and (when wide enough) the latest run's cost.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { TaskSnapshot } from "../runs/manager.ts";
import { sanitize } from "./sanitize.ts";
import { activeQuery, visibleTasks } from "./state.ts";
import type { ViewState } from "./state.ts";
import { paneBorder } from "./theme.ts";
import { useTheme } from "./themeContext.ts";

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
  const theme = useTheme();
  const icon = theme.taskIcon(t.state);
  const marks = h(Text, { wrap: "truncate-end" },
    Object.keys(t.overrides).length > 0 ? h(Text, { color: theme.role.accent }, " ↻") : null,
    t.error !== null ? h(Text, { color: theme.role.error, bold: true }, " !") : null,
    showCost && cost !== null ? `  $${cost.toFixed(3)}` : null);
  return h(Box, { flexDirection: "row" },
    h(Box, { flexGrow: 1, flexShrink: 1 },
      h(Text, { wrap: "truncate-end" },
        h(Text, { color: icon.color }, icon.icon), " ",
        h(Text, {
          inverse: selected && focused, bold: selected && !focused,
          color: t.past !== undefined && t.runCount === 0 ? theme.role.muted : undefined,
        }, sanitize(t.name)))),
    h(Box, { flexShrink: 0 }, marks));
}

export function Sidebar({ s, width, height, focused, showCost }: SidebarProps): ReactElement {
  const framed = height >= 3;
  const size = Math.max(0, height - (framed ? 2 : 0) - 1);
  const theme = useTheme();
  const visible = visibleTasks(s);
  const position = Math.max(0, visible.indexOf(s.selected));
  const start = scrollStart(position, visible.length, size);
  const query = activeQuery(s);
  const title = query !== "" ? `TASKS /${sanitize(query)} ${visible.length}/${s.tasks.length}` : "TASKS";
  const rows = visible.slice(start, start + size).map((idx) => {
    const t = s.tasks[idx]!;
    const run = t.runId !== null ? s.runs[t.runId] : undefined;
    return h(TaskRow, {
      key: t.id, t, cost: run ? run.cost : null, selected: idx === s.selected, focused, showCost,
    });
  });
  return h(Box, {
    flexDirection: "column", width, height, flexShrink: 0, overflow: "hidden", paddingX: 1,
    ...(framed ? paneBorder(theme, focused) : {}),
  },
  h(Text, { color: theme.role.muted, bold: true, wrap: "truncate-end" }, title),
  ...rows);
}
