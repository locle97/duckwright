import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";

import type { Phase } from "../../src/events.ts";
import type { RunView, StepView } from "../../src/runviews.ts";
import { clean } from "./clean.ts";
import { screenshotUrl } from "./evidence.ts";
import type { Action } from "./store.ts";
import { Button, Tag } from "./ui.tsx";

const PHASE: Record<Phase, string> = { observing: "snapshot…", thinking: "thinking…", acting: "acting…" };
const ICON: Record<StepView["status"], string> = { running: "⋯", ok: "✓", warn: "!", brain: "✗", done: "◆" };
/** A step lists at most this many calls, then "…and N more". */
const MAX_CALLS = 8;

/** Within this many pixels of the bottom still counts as following. */
const NEAR_BOTTOM = 40;

/** The nearest ancestor that scrolls vertically. */
function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let e = el?.parentElement ?? null; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if (o === "auto" || o === "scroll") return e;
  }
  return null;
}

const ms = (n: number | null): string => (n === null ? "" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function StepCard(p: { runId: string; dispatch(a: Action): void; step: StepView; open: boolean; selected: boolean; onToggle(): void; innerRef?: Ref<HTMLDivElement> }) {
  const v = p.step;
  const cls = ["step", p.open ? "open" : "", p.selected ? "sel" : "", v.status === "warn" ? "warn" : "", v.status === "brain" ? "brain" : ""]
    .filter(Boolean).join(" ");
  const [failed, setFailed] = useState(false);
  const src = v.screenshot ? screenshotUrl(p.runId, v.screenshot) : null;
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
          {src && !failed ? (
            <button type="button" className="thumb" aria-label={`Open screenshot of step ${v.step}`}
              onClick={() => p.dispatch({ type: "dialog", value: { kind: "image", src, title: `Screenshot: step ${v.step}` } })}>
              <img loading="lazy" alt={`Screenshot after step ${v.step}`} src={src} onError={() => setFailed(true)} />
            </button>
          ) : null}
          {src && failed ? <div className="muted">screenshot unavailable</div> : null}
          {v.screenshotError ? <div className="muted">screenshot failed: {clean(v.screenshotError)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Timeline(p: { run: RunView; dispatch(a: Action): void }) {
  const { run, dispatch } = p;
  const lastRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const last = run.steps.length - 1;
  const lastStep = run.steps[last];
  const grown = (lastStep?.actions.length ?? 0) + (lastStep?.network.length ?? 0);
  // Following the run keeps the newest step in view (also as the newest step gains content).
  useEffect(() => {
    if (run.follow) lastRef.current?.scrollIntoView({ block: "nearest" });
  }, [run.steps.length, run.follow, grown]);
  // Scrolling away from the bottom by hand stops following; the Follow button resumes it.
  useEffect(() => {
    if (!run.follow) return;
    const box = scroller(sectionRef.current);
    if (!box) return;
    const onScroll = (): void => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight > NEAR_BOTTOM) dispatch({ type: "timeline", op: "unfollow" });
    };
    box.addEventListener("scroll", onScroll);
    return () => box.removeEventListener("scroll", onScroll);
  }, [run.follow, run.steps.length > 0, dispatch]);
  if (run.steps.length === 0) return <p className="muted">No steps yet.</p>;
  const toggle = (i: number): void => {
    dispatch({ type: "timeline", op: "move", delta: i - run.selected });
    dispatch({ type: "timeline", op: "toggle" });
  };
  return (
    <section aria-label="Timeline" className="main" ref={sectionRef} style={{ padding: 0, overflow: "visible" }}>
      <div className="row-actions">
        <Button small onClick={() => dispatch({ type: "timeline", op: "expandAll" })}>Expand all</Button>
        <Button small onClick={() => dispatch({ type: "timeline", op: "collapseAll" })}>Collapse all</Button>
        <Button small kind={run.follow ? "green" : "default"} onClick={() => dispatch({ type: "timeline", op: "last" })} title="Jump to the newest step and follow the run">
          {run.follow ? "Following" : "Follow"}
        </Button>
      </div>
      {run.steps.map((step, i) => (
        <StepCard key={step.step} runId={run.runId} dispatch={dispatch} step={step} open={run.expanded.includes(i)} selected={run.selected === i}
          onToggle={() => toggle(i)} innerRef={i === last ? lastRef : undefined} />
      ))}
    </section>
  );
}
