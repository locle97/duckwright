import { useEffect, useRef } from "react";
import type { Ref } from "react";

import type { Phase } from "../../src/events.ts";
import type { RunView, StepView } from "../../src/runviews.ts";
import { clean } from "./clean.ts";
import type { Action } from "./store.ts";
import { Button, Tag } from "./ui.tsx";

const PHASE: Record<Phase, string> = { observing: "snapshot…", thinking: "thinking…", acting: "acting…" };
const ICON: Record<StepView["status"], string> = { running: "⋯", ok: "✓", warn: "!", brain: "✗", done: "◆" };
/** A step lists at most this many calls, then "…and N more". */
const MAX_CALLS = 8;

const ms = (n: number | null): string => (n === null ? "" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function StepCard(p: { step: StepView; open: boolean; selected: boolean; onToggle(): void; innerRef?: Ref<HTMLDivElement> }) {
  const v = p.step;
  const cls = ["step", p.open ? "open" : "", p.selected ? "sel" : "", v.status === "warn" ? "warn" : "", v.status === "brain" ? "brain" : ""]
    .filter(Boolean).join(" ");
  const calls = v.network.slice(0, MAX_CALLS);
  return (
    <div className={cls} ref={p.innerRef}>
      <div className="step-head" role="button" tabIndex={0} aria-expanded={p.open} onClick={p.onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onToggle(); } }}>
        <b>{ICON[v.status]} {v.step}</b>
        <span className="grow">{clean(v.goal) || "…"}</span>
        {v.phase && v.status === "running" ? <Tag tone="run">{PHASE[v.phase]}</Tag> : null}
        {v.cost !== null ? <span className="muted">${v.cost.toFixed(4)}</span> : null}
        {v.durationMs !== null ? <span className="muted">{ms(v.durationMs)}</span> : null}
      </div>
      {p.open ? (
        <div className="step-body">
          {v.evaluation ? <div><b>Evaluation:</b> {clean(v.evaluation)}</div> : null}
          {v.memory ? <div><b>Memory:</b> {clean(v.memory)}</div> : null}
          {v.actions.map((a, i) => (
            <div key={i} className="mono">{v.runningAction === i ? "▶ " : "· "}{clean(a.label)}{a.result !== null ? ` → ${clean(a.result)}` : ""}</div>
          ))}
          {v.error ? <div className="error">{clean(v.error)}</div> : null}
          {calls.length > 0 ? (
            <div className="net" aria-label="Network calls">
              {calls.map((c) => (
                <Tag key={c.id} tone={c.status === null || c.status >= 400 ? "fail" : "pass"}>
                  {clean(c.method)} {clean(c.url)} {c.status ?? "—"}{c.durationMs !== null ? ` ${ms(c.durationMs)}` : ""}
                </Tag>
              ))}
              {v.network.length > MAX_CALLS ? <span className="muted">…and {v.network.length - MAX_CALLS} more</span> : null}
            </div>
          ) : null}
          {v.networkErrors.map((m, i) => <div key={i} className="muted">{clean(m)}</div>)}
        </div>
      ) : null}
    </div>
  );
}

export function Timeline(p: { run: RunView; dispatch(a: Action): void }) {
  const { run, dispatch } = p;
  const lastRef = useRef<HTMLDivElement>(null);
  const last = run.steps.length - 1;
  // Following the run keeps the newest step in view.
  useEffect(() => {
    if (run.follow) lastRef.current?.scrollIntoView({ block: "nearest" });
  }, [run.steps.length, run.follow]);
  if (run.steps.length === 0) return <p className="muted">No steps yet.</p>;
  const toggle = (i: number): void => {
    dispatch({ type: "timeline", op: "move", delta: i - run.selected });
    dispatch({ type: "timeline", op: "toggle" });
  };
  return (
    <section aria-label="Timeline" className="main" style={{ padding: 0, overflow: "visible" }}>
      <div className="row-actions">
        <Button small onClick={() => dispatch({ type: "timeline", op: "expandAll" })}>Expand all</Button>
        <Button small onClick={() => dispatch({ type: "timeline", op: "collapseAll" })}>Collapse all</Button>
        <Button small kind={run.follow ? "green" : "default"} onClick={() => dispatch({ type: "timeline", op: "last" })} title="Jump to the newest step and follow the run">
          {run.follow ? "Following" : "Follow"}
        </Button>
      </div>
      {run.steps.map((step, i) => (
        <StepCard key={step.step} step={step} open={run.expanded.includes(i)} selected={run.selected === i}
          onToggle={() => toggle(i)} innerRef={i === last ? lastRef : undefined} />
      ))}
    </section>
  );
}
