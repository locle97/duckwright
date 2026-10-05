// The step timeline of one run: a row per step, the expanded steps' details, then the end banner.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { RunOutcome } from "../events.ts";
import { fixed4 } from "../text.ts";
import { sanitize } from "./sanitize.ts";
import type { RunView, StepView } from "./state.ts";
import { PHASE_LABEL, ROLE, spinnerFrame, STEP_ICON, TASK_ICON } from "./theme.ts";

/** One screen row; `step` is the index of the step it belongs to (null for the banner). */
interface Line { key: string; step: number | null; el: ReactElement }

const row = (...children: (ReactElement | string | null)[]): ReactElement => h(Text, { wrap: "truncate-end" }, ...children);

function stepRow(v: StepView, i: number, now: number, selected: boolean): Line {
  const icon = v.status === "running"
    ? h(Text, { color: TASK_ICON.running.color }, spinnerFrame(now))
    : h(Text, { color: STEP_ICON[v.status].color }, STEP_ICON[v.status].icon);
  let right: ReactElement | null = null;
  if (v.status === "running") {
    right = v.phase !== null ? h(Text, { color: ROLE.muted }, PHASE_LABEL[v.phase]) : null;
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

function detailRows(v: StepView, i: number, now: number): Line[] {
  const items: (ReactElement | string)[][] = [];
  const decided = v.goal !== "" || v.actions.length > 0;
  const label = (text: string): ReactElement => h(Text, { color: ROLE.muted }, text);
  if (decided) {
    items.push([label("eval  "), sanitize(v.evaluation)]);
    items.push([label("goal  "), sanitize(v.goal)]);
    if (v.memory !== null) items.push([label("memory  "), sanitize(v.memory)]);
  }
  v.actions.forEach((a, j) => {
    const action = sanitize(a.label);
    if (v.runningAction === j) items.push([`${action} `, h(Text, { color: TASK_ICON.running.color }, spinnerFrame(now))]);
    else if (a.result !== null) items.push([`${action} → `, sanitize(a.result)]);
    else items.push([h(Text, { color: ROLE.muted }, action)]);
  });
  if (v.error !== null) items.push([h(Text, { color: ROLE.error }, `error  ${sanitize(v.error)}`)]);
  return items.map((parts, j) => ({
    key: `s${i}d${j}`, step: i, el: row(`  ${j === items.length - 1 ? "└" : "├"} `, ...parts),
  }));
}

const RESULT: Record<RunOutcome["status"], { text: string; color: string }> = {
  pass: { text: "✓ success", color: TASK_ICON.passed.color },
  fail: { text: "✗ failure", color: TASK_ICON.failed.color },
  stop: { text: "■ stopped", color: TASK_ICON.stopped.color },
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

function banner(o: RunOutcome): Line[] {
  const result = RESULT[o.status];
  const els: ReactElement[] = [
    row(" "),
    h(Text, { color: result.color, bold: true }, result.text),
    ...(o.error !== null ? [row(h(Text, { color: ROLE.error }, `Error: ${sanitize(o.error)}`))] : []),
    row(`Answer: ${sanitize(o.answer)}`),
    row(`Steps: ${o.steps}`),
    row(`Cost: $${fixed4(o.costUsd)}`),
    row(`History: ${o.historyPath !== null ? sanitize(o.historyPath) : "-"}`),
  ];
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
  const lines: Line[] = [];
  run.steps.forEach((v, i) => {
    lines.push(stepRow(v, i, now, focused && run.selected === i));
    if (run.expanded.includes(i)) lines.push(...detailRows(v, i, now));
  });
  if (run.outcome !== null) lines.push(...banner(run.outcome));
  const start = windowStart(lines, run, Math.max(0, height));
  return h(Box, { flexDirection: "column", height: Math.max(0, height), overflow: "hidden" },
    ...lines.slice(start, start + Math.max(0, height)).map((l) => h(Box, { key: l.key, flexDirection: "column" }, l.el)));
}
