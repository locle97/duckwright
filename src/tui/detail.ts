// Detail pane: the selected task's text and settings, or its latest run's header and timeline;
// for a plan's header row, the plan: its state, shared setup, notes, tasks in order and skipped scenarios.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { Effective, PlanSnapshot, TaskSnapshot } from "../runs/manager.ts";
import { sanitize } from "./sanitize.ts";
import { planOf, planTally, selectedPlan, selectedRun, selectedTask } from "./state.ts";
import type { RunView, ViewState } from "./state.ts";
import { paneBorder, spinnerFrame } from "./theme.ts";
import type { Theme } from "./theme.ts";
import { useTheme } from "./themeContext.ts";
import { Timeline } from "./timeline.ts";

export interface DetailProps {
  s: ViewState;
  width: number;
  height: number;
  focused: boolean;
}

const SETTINGS: readonly [keyof Effective, string][] = [
  ["model", "model"], ["maxSteps", "max steps"], ["headed", "headed"], ["snapshot", "snapshot mode"],
  ["video", "video"], ["screenshot", "screenshot"], ["env", "environment"],
];

const row = (...children: (ReactElement | string | null)[]): ReactElement => h(Text, { wrap: "truncate-end" }, ...children);

/** `M:SS`, or `H:MM:SS` from an hour. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const ss = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function PlanDetail({ s, p }: { s: ViewState; p: PlanSnapshot }): ReactElement {
  const theme = useTheme();
  const { role } = theme;
  const tally = planTally(s, p);
  const muted = (text: string): ReactElement => h(Text, { color: role.muted }, text);
  let state: ReactElement;
  if (p.state === "planning") {
    state = h(Text, { color: role.running }, `${spinnerFrame(s.now)} planning ${duration(s.now - p.startedAt)}`);
  } else if (p.state === "failed") {
    state = h(Text, { color: role.error }, "✗ planning failed");
  } else {
    const parts = [`${tally.passed}/${tally.total} passed`];
    if (tally.failed > 0) parts.push(`${tally.failed} failed`);
    if (tally.running) parts.push(p.queued.length > 0 ? `running, ${p.queued.length} to go` : "running");
    state = h(Text, {}, parts.join("  "));
  }
  const cost = p.cost + tally.cost;
  const out: (ReactElement | null)[] = [
    h(Box, { flexDirection: "row" },
      h(Box, { flexShrink: 1 }, row(h(Text, { bold: true }, sanitize(p.name)))),
      h(Box, { flexShrink: 0, marginLeft: 2 }, row(state, `  $${cost.toFixed(3)}`))),
    row(muted("plan: "), sanitize(p.source), p.folder !== null ? muted("  tasks: ") : null, p.folder !== null ? sanitize(p.folder) : null),
  ];
  if (p.error !== null) out.push(row(h(Text, { color: role.error }, `! ${sanitize(p.error)}`)), row(muted("space plan again · d remove")));
  if (p.state === "planning") out.push(row(muted("Claude is splitting the plan into one task per scenario. s cancels.")));
  const section = (key: string, title: string, items: (ReactElement | string)[]): void => {
    if (items.length === 0) return;
    out.push(row(" "), row(h(Text, { bold: true }, title)), ...items.map((x) => (typeof x === "string" ? row(x) : x)));
  };
  if (p.setup !== null) {
    section("setup", "Shared setup, done first in every task (e edits)", sanitize(p.setup, { multiline: true }).split("\n").map((l) => `  ${l}`));
  }
  section("notes", "Before you run (the agent can't do these)", p.notes.map((n) => `  - ${sanitize(n)}`));
  section("skipped", "Not planned: they need more than a browser", p.skipped.map((x) => `  - ${sanitize(x.id)} ${sanitize(x.title)}: ${sanitize(x.reason)}`));
  section("tasks", "Tasks, in run order (J/K move a task)", p.taskIds.flatMap((id, i) => {
    const t = s.tasks.find((x) => x.id === id);
    if (!t) return [];
    const icon = p.queued.includes(id) ? { icon: "◌", color: role.running } : theme.taskIcon(t.state);
    return [row(`  ${String(i + 1).padStart(String(p.taskIds.length).length)}. `, h(Text, { color: icon.color }, icon.icon), ` ${sanitize(t.name)}`)];
  }));
  // Rows never shrink: a plan longer than the pane is cut at the bottom, never squeezed.
  return h(Box, { flexDirection: "column" }, ...out.map((x, i) => h(Box, { key: i, flexShrink: 0 }, x)));
}

function IdleTask({ s, t }: { s: ViewState; t: TaskSnapshot }): ReactElement {
  const { role } = useTheme();
  const plan = planOf(s, t);
  const text = sanitize(t.text, { multiline: true }).split("\n");
  const width = Math.max(...SETTINGS.map(([, label]) => label.length)) + 2;
  return h(Box, { flexDirection: "column" },
    ...text.map((line, i) => h(Box, { key: `t${i}` }, row(line || " "))),
    row(" "),
    row(h(Text, { color: role.muted }, "source: "), t.source.kind === "file" ? sanitize(t.source.path) : "typed"),
    plan !== null
      ? row(h(Text, { color: role.muted }, "plan: "), `${sanitize(plan.name)}, task ${plan.taskIds.indexOf(t.id) + 1} of ${plan.taskIds.length}`)
      : null,
    row(" "),
    ...SETTINGS.map(([key, label]) => {
      const value = sanitize(String(t.effective[key] ?? "none"));
      return h(Box, { key },
        row(h(Text, { color: role.muted }, label.padEnd(width)),
          t.overrides[key] !== undefined ? h(Text, { color: role.accent }, value) : value));
    }),
    t.error !== null ? row(" ") : null,
    t.error !== null ? row(h(Text, { color: role.error }, `! ${sanitize(t.error)}`)) : null);
}

const OUTCOME_STATE = { pass: "passed", fail: "failed", stop: "stopped" } as const;

function runHeader(t: TaskSnapshot, run: RunView, now: number, theme: Theme): ReactElement {
  // A finished past run shows its outcome, never the replayed "running" control state.
  const state = run.outcome !== null && run.past ? OUTCOME_STATE[run.outcome.status] : t.state;
  const icon = theme.taskIcon(state);
  const last = run.steps[run.steps.length - 1];
  const paused = run.pausedMs + (run.pausedSince !== null ? now - run.pausedSince : 0);
  const first = run.past ? `past run ${sanitize(run.runId)}` : `step ${last ? last.step : 0}/${run.maxSteps}`;
  const parts = [first, `$${run.cost.toFixed(3)}`];
  if (run.outcome === null) parts.push(duration(now - run.startedAt - paused));
  if (run.pausedSince !== null) parts.push(`paused ${duration(paused)}`);
  // The name gives way first, so the state and numbers stay readable.
  return h(Box, { flexDirection: "row" },
    h(Box, { flexShrink: 1 }, row(sanitize(t.name))),
    h(Box, { flexShrink: 0, marginLeft: 2 }, row(
      h(Text, { color: icon.color }, `${icon.icon} ${state}`), `  ${parts.join("  ")}`,
      run.brainFailures > 0 ? h(Text, { color: theme.role.error }, `  brain ✗ ${run.brainFailures}/3`) : null)));
}

export function Detail({ s, width, height, focused }: DetailProps): ReactElement {
  const theme = useTheme();
  const framed = height >= 3;
  const inner = Math.max(0, height - (framed ? 2 : 0));
  const t = selectedTask(s);
  const p = selectedPlan(s);
  const run = selectedRun(s);
  let body: ReactElement;
  if (p !== null) {
    body = h(PlanDetail, { s, p });
  } else if (t === null) {
    body = row(h(Text, { color: theme.role.muted }, "No tasks yet. Press i to add one, or P to plan a test plan file."));
  } else if (run === null) {
    body = h(IdleTask, { s, t });
  } else {
    body = h(Box, { flexDirection: "column" },
      runHeader(t, run, s.now, theme),
      row(sanitize(t.text)),
      h(Timeline, { run, now: s.now, height: inner - 2, focused }));
  }
  return h(Box, {
    flexDirection: "column", width, height, flexShrink: 0, overflow: "hidden", paddingX: 1,
    ...(framed ? paneBorder(theme, focused) : {}),
  }, body);
}
