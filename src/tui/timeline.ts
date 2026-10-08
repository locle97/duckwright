// The step timeline of one run: a row per step, the expanded steps' details, then the end banner.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { RunOutcome } from "../events.ts";
import { fixed4 } from "../text.ts";
import { callFailed, formatCall, MAX_CALLS } from "./netline.ts";
import { sanitize } from "./sanitize.ts";
import type { RunView, StepView } from "./state.ts";
import { PHASE_LABEL, spinnerFrame } from "./theme.ts";
import type { Theme } from "./theme.ts";
import { useTheme } from "./themeContext.ts";

/** One screen row; `step` is the index of the step it belongs to (null for the banner). */
interface Line { key: string; step: number | null; el: ReactElement }

const row = (...children: (ReactElement | string | null)[]): ReactElement => h(Text, { wrap: "truncate-end" }, ...children);

function stepRow(v: StepView, i: number, now: number, selected: boolean, theme: Theme): Line {
  const icon = v.status === "running"
    ? h(Text, { color: theme.role.running }, spinnerFrame(now))
    : h(Text, { color: theme.stepIcon(v.status).color }, theme.stepIcon(v.status).icon);
  let right: ReactElement | null = null;
  if (v.status === "running") {
    right = v.phase !== null ? h(Text, { color: theme.role.muted }, PHASE_LABEL[v.phase]) : null;
  } else {
    const cost = v.cost !== null ? `$${v.cost.toFixed(3)}` : "";
    const time = v.durationMs !== null ? `${(v.durationMs / 1000).toFixed(1)}s` : "";
    right = h(Text, {}, [cost, time].filter((x) => x !== "").join("  "));
  }
  const el = h(Box, { flexDirection: "row" },
    h(Box, { flexGrow: 1, flexShrink: 1 },
      row(icon, " ", h(Text, { inverse: selected }, `${v.step}  ${sanitize(v.goal)}`))),
    h(Box, { flexShrink: 0, marginLeft: 1 }, right));
  return { key: `s${i}`, step: i, el };
}

function detailRows(v: StepView, i: number, now: number, theme: Theme, workdir: string): Line[] {
  const items: (ReactElement | string)[][] = [];
  const decided = v.goal !== "" || v.actions.length > 0;
  const label = (text: string): ReactElement => h(Text, { color: theme.role.muted }, text);
  if (decided) {
    items.push([label("eval  "), sanitize(v.evaluation)]);
    items.push([label("goal  "), sanitize(v.goal)]);
    if (v.memory !== null) items.push([label("memory  "), sanitize(v.memory)]);
  }
  v.actions.forEach((a, j) => {
    const action = sanitize(a.label);
    if (v.runningAction === j) items.push([`${action} `, h(Text, { color: theme.role.running }, spinnerFrame(now))]);
    else if (a.result !== null) items.push([`${action} → `, sanitize(a.result)]);
    else items.push([h(Text, { color: theme.role.muted }, action)]);
  });
  v.network.slice(0, MAX_CALLS).forEach((c) => {
    const text = sanitize(formatCall(c));
    items.push([label("net  "), callFailed(c) ? h(Text, { color: theme.role.error }, text) : text]);
  });
  if (v.network.length > MAX_CALLS) items.push([label("net  "), `…and ${v.network.length - MAX_CALLS} more`]);
  if (v.networkErrors.length > 0) {
    const more = v.networkErrors.length > 1 ? ` (+${v.networkErrors.length - 1} more)` : "";
    items.push([h(Text, { color: theme.role.error }, `net error  ${sanitize(v.networkErrors[0]!)}${more}`)]);
  }
  if (v.screenshot !== null) items.push([label("shot  "), sanitize(`${workdir}/${v.screenshot}`)]);
  else if (v.screenshotError !== null) items.push([h(Text, { color: theme.role.error }, `shot error  ${sanitize(v.screenshotError)}`)]);
  if (v.error !== null) items.push([h(Text, { color: theme.role.error }, `error  ${sanitize(v.error)}`)]);
  return items.map((parts, j) => ({
    key: `s${i}d${j}`, step: i, el: row(`  ${j === items.length - 1 ? "└" : "├"} `, ...parts),
  }));
}

const RESULT: Record<RunOutcome["status"], { text: string; state: "passed" | "failed" | "stopped" }> = {
  pass: { text: "✓ success", state: "passed" },
  fail: { text: "✗ failure", state: "failed" },
  stop: { text: "■ stopped", state: "stopped" },
};

function testLine(o: RunOutcome): string | null {
  switch (o.export.kind) {
    case "off":
      return null;
    case "written":
      return `Test: ${sanitize(o.export.path)}`;
    case "skipped":
      return "Test: not exported";
    case "failed":
      return `Test: not exported (${sanitize(o.export.message)})`;
  }
}

function banner(o: RunOutcome, run: RunView, theme: Theme): Line[] {
  const result = RESULT[o.status];
  const els: ReactElement[] = [
    row(" "),
    h(Text, { color: theme.taskIcon(result.state).color, bold: true }, result.text),
    ...(o.error !== null ? [row(h(Text, { color: theme.role.error }, `Error: ${sanitize(o.error)}`))] : []),
    row(`Answer: ${sanitize(o.answer)}`),
    row(`Steps: ${o.steps}`),
    row(`Cost: $${fixed4(o.costUsd)}`),
    row(`History: ${o.historyPath !== null ? sanitize(o.historyPath) : "-"}`),
  ];
  if (run.video) els.push(row(`video  ${sanitize(`${run.workdir}/${run.video}`)}`));
  const test = testLine(o);
  if (test !== null) els.push(row(test));
  return els.map((el, i) => ({ key: `b${i}`, step: null, el }));
}

/** First line to show: the bottom under follow, otherwise a window that keeps the selected step in view. */
function windowStart(lines: Line[], run: RunView, height: number): number {
  const max = Math.max(0, lines.length - height);
  if (run.follow) return max;
  const first = lines.findIndex((l) => l.step === run.selected);
  if (first < 0) return 0;
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].step === run.selected) last++;
  return Math.min(max, first, Math.max(0, last - height + 1));
}

export function Timeline({ run, now, height, focused }: {
  run: RunView; now: number; height: number; focused: boolean;
}): ReactElement {
  const theme = useTheme();
  const lines: Line[] = [];
  run.steps.forEach((v, i) => {
    lines.push(stepRow(v, i, now, focused && run.selected === i, theme));
    if (run.expanded.includes(i)) lines.push(...detailRows(v, i, now, theme, run.workdir));
  });
  if (run.outcome !== null) lines.push(...banner(run.outcome, run, theme));
  const start = windowStart(lines, run, Math.max(0, height));
  return h(Box, { flexDirection: "column", height: Math.max(0, height), overflow: "hidden" },
    ...lines.slice(start, start + Math.max(0, height)).map((l) => h(Box, { key: l.key, flexDirection: "column" }, l.el)));
}
