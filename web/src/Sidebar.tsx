import type { KeyboardEvent } from "react";
import { clean } from "./clean.ts";
import { planTally, tabOf, visibleRows } from "./store.ts";
import type { Action, Row, Selection, Tab, WebState } from "./store.ts";
import { Button, STATE_TAG, Tag } from "./ui.tsx";

export function Sidebar(p: { state: WebState; dispatch(a: Action): void; open: boolean; onPicked(): void }) {
  const { state: s, dispatch } = p;
  const rows = visibleRows(s);

  const pick = (selection: Exclude<Selection, null>) => {
    dispatch({ type: "select", selection });
    p.onPicked();
  };

  const handleKeyDown = (e: KeyboardEvent, selection: Exclude<Selection, null>) => {
    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      pick(selection);
    }
  };

  const renderRow = (r: Row) => {
    if (r.kind === "plan") {
      const t = planTally(s, r.plan);
      const sel = s.selection?.kind === "plan" && s.selection.id === r.plan.id;
      const closed = s.collapsed.includes(r.plan.id);
      const rowClasses = ["row", "plan", sel ? "sel" : ""].filter(Boolean).join(" ");
      return (
        <div key={`p${r.plan.id}`} className={rowClasses} aria-current={sel ? "true" : undefined}>
          <button
            type="button"
            onClick={() => { dispatch({ type: "collapse", id: r.plan.id }); }}
            aria-expanded={!closed}
            aria-label={closed ? "Expand plan" : "Collapse plan"}
            title={closed ? "Expand" : "Collapse"}
            className="caret-button">
            {closed ? "▸" : "▾"}
          </button>
          <div
            className="selection-control"
            onClick={() => { pick({ kind: "plan", id: r.plan.id }); }}
            role="button" tabIndex={0}
            onKeyDown={(e) => { handleKeyDown(e, { kind: "plan", id: r.plan.id }); }}>
            <span className="name">
              {clean(r.plan.name)}
            </span>
            <span className="row-actions">
              {r.plan.state === "planning" ? <Tag tone="run">planning</Tag> : null}
              {r.plan.state === "failed" ? <Tag tone="fail">failed</Tag> : null}
              {r.plan.state === "ready" ? <Tag tone={t.running ? "run" : t.failed > 0 ? "fail" : t.passed === t.total && t.total > 0 ? "pass" : "idle"}>{t.passed}/{t.total}</Tag> : null}
            </span>
          </div>
        </div>
      );
    }
    const task = r.task;
    const sel = s.selection?.kind === "task" && s.selection.id === task.id;
    const tag = STATE_TAG[task.state];
    const rowClasses = ["row", r.planId !== null ? "child" : "", sel ? "sel" : ""].filter(Boolean).join(" ");
    return (
      <div key={`t${task.id}`} className={rowClasses}
        onClick={() => { pick({ kind: "task", id: task.id }); }}
        role="button" tabIndex={0}
        onKeyDown={(e) => { handleKeyDown(e, { kind: "task", id: task.id }); }}
        aria-current={sel ? "true" : undefined}>
        <span className="name" title={clean(task.text)}>{clean(task.name)}</span>
        <span className="row-actions">
          {task.twofa ? <span title="waiting for a code"><Tag tone="ask">?</Tag></span> : null}
          <Tag tone={tag.tone}>{tag.label}</Tag>
        </span>
      </div>
    );
  };

  return (
    <aside className={`sidebar ${p.open ? "open" : ""}`} aria-label="Tasks and history">
      <div className="tabs" role="tablist" aria-label="Sidebar tabs">
        {(["tasks", "history"] as Tab[]).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={s.tab === tab} className={`tab ${s.tab === tab ? "active" : ""}`}
            onClick={() => { if (s.tab !== tab) dispatch({ type: "tab" }); }}>
            {tab === "tasks" ? "Tasks" : "History"} <span className="count">{s.tasks.filter((t) => tabOf(t) === tab).length}</span>
          </button>
        ))}
      </div>
      <div className="row-actions">
        <Button onClick={() => dispatch({ type: "dialog", value: { kind: "add", mode: "task" } })}>+ Add task</Button>
        <Button kind="pink" onClick={() => dispatch({ type: "dialog", value: { kind: "add", mode: "plan" } })}>Plan a file</Button>
      </div>
      <input className="input" placeholder={s.tab === "history" ? "Filter history (/)" : "Filter tasks (/)"} aria-label="Filter tasks" value={s.filter}
        onChange={(e) => dispatch({ type: "filter", value: e.target.value })} data-filter />
      <div className="list">
        {rows.length === 0 ? <p className="muted">{s.filter === "" ? (s.tab === "history" ? "No past runs." : "No tasks yet. Add one to start.") : "No task matches the filter."}</p> : rows.map(renderRow)}
      </div>
    </aside>
  );
}
