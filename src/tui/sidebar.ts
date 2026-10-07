// Task list: one row per task with its state icon, name and (when wide enough) the latest run's cost;
// a plan is a header row (fold mark, name, progress) with its tasks indented under it in run order.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { PlanSnapshot, TaskSnapshot } from "../runs/manager.ts";
import { sanitize } from "./sanitize.ts";
import { activeQuery, planTally, selectedRowIndex, visibleRows } from "./state.ts";
import type { ViewState } from "./state.ts";
import { paneBorder, spinnerFrame } from "./theme.ts";
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

function TaskRow({ t, cost, selected, focused, showCost, indent, queued }: {
  t: TaskSnapshot; cost: number | null; selected: boolean; focused: boolean; showCost: boolean; indent: boolean; queued: boolean;
}): ReactElement {
  const theme = useTheme();
  // A task waiting its turn in a plan run.
  const icon = queued ? { icon: "◌", color: theme.role.running } : theme.taskIcon(t.state);
  const marks = h(Text, { wrap: "truncate-end" },
    Object.keys(t.overrides).length > 0 ? h(Text, { color: theme.role.accent }, " ↻") : null,
    t.error !== null ? h(Text, { color: theme.role.error, bold: true }, " !") : null,
    t.twofa !== null ? h(Text, { color: theme.role.accent, bold: true }, " ?") : null,
    showCost && cost !== null ? `  $${cost.toFixed(3)}` : null);
  return h(Box, { flexDirection: "row" },
    h(Box, { flexGrow: 1, flexShrink: 1 },
      h(Text, { wrap: "truncate-end" },
        indent ? "  " : "",
        h(Text, { color: icon.color }, icon.icon), " ",
        h(Text, {
          inverse: selected && focused, bold: selected && !focused,
          color: t.past !== undefined && t.runCount === 0 ? theme.role.muted : undefined,
        }, sanitize(t.name)))),
    h(Box, { flexShrink: 0 }, marks));
}

function PlanRow({ s, p, selected, focused }: { s: ViewState; p: PlanSnapshot; selected: boolean; focused: boolean }): ReactElement {
  const theme = useTheme();
  const tally = planTally(s, p);
  const fold = s.collapsed.includes(p.id) ? "▸" : "▾";
  let status: ReactElement;
  if (p.state === "planning") status = h(Text, { color: theme.role.running }, ` ${spinnerFrame(s.now)} planning`);
  else if (p.state === "failed") status = h(Text, { color: theme.role.error, bold: true }, " ✗");
  else {
    status = h(Text, {},
      tally.running ? h(Text, { color: theme.role.running }, ` ${spinnerFrame(s.now)}`) : null,
      ` ${tally.passed}/${tally.total}`,
      tally.failed > 0 ? h(Text, { color: theme.role.failed }, ` ✗${tally.failed}`) : null);
  }
  // No cost here: the name needs the room, and the plan's detail shows it.
  return h(Box, { flexDirection: "row" },
    h(Box, { flexGrow: 1, flexShrink: 1 },
      h(Text, { wrap: "truncate-end" }, h(Text, { color: theme.role.accent }, fold), " ",
        h(Text, { inverse: selected && focused, bold: true }, sanitize(p.name)))),
    h(Box, { flexShrink: 0 }, h(Text, { wrap: "truncate-end" }, status)));
}

export function Sidebar({ s, width, height, focused, showCost }: SidebarProps): ReactElement {
  const framed = height >= 3;
  const size = Math.max(0, height - (framed ? 2 : 0) - 1);
  const theme = useTheme();
  const visible = visibleRows(s);
  const at = selectedRowIndex(s, visible);
  const position = Math.max(0, at);
  const start = scrollStart(position, visible.length, size);
  const query = activeQuery(s);
  const shownTasks = visible.filter((r) => r.kind === "task").length;
  const title = query !== "" ? `TASKS /${sanitize(query)} ${shownTasks}/${s.tasks.length}` : "TASKS";
  const rows = visible.slice(start, start + size).map((r, i) => {
    const selected = start + i === at;
    if (r.kind === "plan") return h(PlanRow, { key: `p${r.plan.id}`, s, p: r.plan, selected, focused });
    const t = s.tasks[r.index]!;
    const run = t.runId !== null ? s.runs[t.runId] : undefined;
    const queued = r.planId !== null && (s.plans.find((p) => p.id === r.planId)?.queued.includes(t.id) ?? false);
    return h(TaskRow, {
      key: t.id, t, cost: run ? run.cost : null, selected, focused, showCost, indent: r.planId !== null, queued,
    });
  });
  return h(Box, {
    flexDirection: "column", width, height, flexShrink: 0, overflow: "hidden", paddingX: 1,
    ...(framed ? paneBorder(theme, focused) : {}),
  },
  h(Text, { color: theme.role.muted, bold: true, wrap: "truncate-end" }, title),
  ...rows);
}
