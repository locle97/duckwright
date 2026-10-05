// Detail pane: the selected task's text and settings, or its latest run's header and timeline.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { Effective, TaskSnapshot } from "../runs/manager.ts";
import { sanitize } from "./sanitize.ts";
import { selectedRun, selectedTask } from "./state.ts";
import type { RunView, ViewState } from "./state.ts";
import { ROLE, TASK_ICON } from "./theme.ts";
import { Timeline } from "./timeline.ts";

export interface DetailProps {
  s: ViewState;
  width: number;
  height: number;
  focused: boolean;
}

const SETTINGS: readonly [keyof Effective, string][] = [
  ["model", "model"], ["maxSteps", "max steps"], ["headed", "headed"], ["export", "export"], ["snapshot", "snapshot mode"],
];

const row = (...children: (ReactElement | string | null)[]): ReactElement => h(Text, { wrap: "truncate-end" }, ...children);

/** `M:SS`, or `H:MM:SS` from an hour. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const ss = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function IdleTask({ t }: { t: TaskSnapshot }): ReactElement {
  const text = sanitize(t.text, { multiline: true }).split("\n");
  const width = Math.max(...SETTINGS.map(([, label]) => label.length)) + 2;
  return h(Box, { flexDirection: "column" },
    ...text.map((line, i) => h(Box, { key: `t${i}` }, row(line))),
    row(" "),
    row(h(Text, { color: ROLE.muted }, "source: "), "typed"),
    row(" "),
    ...SETTINGS.map(([key, label]) => h(Box, { key },
      row(h(Text, { color: ROLE.muted }, label.padEnd(width)),
        t.overrides[key] !== undefined ? h(Text, { color: ROLE.accent }, String(t.effective[key])) : String(t.effective[key])))),
    t.error !== null ? row(" ") : null,
    t.error !== null ? row(h(Text, { color: ROLE.error }, `! ${sanitize(t.error)}`)) : null);
}

function runHeader(t: TaskSnapshot, run: RunView, now: number): ReactElement {
  const icon = TASK_ICON[t.state];
  const last = run.steps[run.steps.length - 1];
  const paused = run.pausedMs + (run.pausedSince !== null ? now - run.pausedSince : 0);
  const parts = [`step ${last ? last.step : 0}/${run.maxSteps}`, `$${run.cost.toFixed(3)}`];
  if (run.outcome === null) parts.push(duration(now - run.startedAt - paused));
  if (run.pausedSince !== null) parts.push(`paused ${duration(paused)}`);
  // The name gives way first, so the state and numbers stay readable.
  return h(Box, { flexDirection: "row" },
    h(Box, { flexShrink: 1 }, row(sanitize(t.name))),
    h(Box, { flexShrink: 0, marginLeft: 2 }, row(
      h(Text, { color: icon.color }, `${icon.icon} ${t.state}`), `  ${parts.join("  ")}`,
      run.brainFailures > 0 ? h(Text, { color: ROLE.error }, `  brain ✗ ${run.brainFailures}/3`) : null)));
}

export function Detail({ s, width, height, focused }: DetailProps): ReactElement {
  const framed = height >= 3;
  const inner = Math.max(0, height - (framed ? 2 : 0));
  const t = selectedTask(s);
  const run = selectedRun(s);
  let body: ReactElement;
  if (t === null) {
    body = row(h(Text, { color: ROLE.muted }, "No tasks yet. Press a to add one."));
  } else if (run === null) {
    body = h(IdleTask, { t });
  } else {
    body = h(Box, { flexDirection: "column" },
      runHeader(t, run, s.now),
      row(sanitize(t.text)),
      h(Timeline, { run, now: s.now, height: inner - 2, focused }));
  }
  return h(Box, {
    flexDirection: "column", width, height, flexShrink: 0, overflow: "hidden", paddingX: 1,
    ...(framed ? { borderStyle: "round" as const, borderColor: focused ? ROLE.accent : ROLE.border } : {}),
  }, body);
}
