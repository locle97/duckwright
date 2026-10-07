import { clean } from "./clean.ts";
import { planTally, visibleRows } from "./store.ts";
import type { Action, Row, WebState } from "./store.ts";
import { Button, STATE_TAG, Tag } from "./ui.tsx";

export function Sidebar(p: { state: WebState; dispatch(a: Action): void; open: boolean; onPicked(): void }) {
  const { state: s, dispatch } = p;
  const rows = visibleRows(s);

  const renderRow = (r: Row) => {
    if (r.kind === "plan") {
      const t = planTally(s, r.plan);
      const sel = s.selection?.kind === "plan" && s.selection.id === r.plan.id;
      const closed = s.collapsed.includes(r.plan.id);
      return (
        <div key={`p${r.plan.id}`} className={`row plan ${sel ? "sel" : ""}`} onClick={() => { dispatch({ type: "select", selection: { kind: "plan", id: r.plan.id } }); p.onPicked(); }}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter") dispatch({ type: "select", selection: { kind: "plan", id: r.plan.id } }); }}>
          <span className="name">
            <span onClick={(e) => { e.stopPropagation(); dispatch({ type: "collapse", id: r.plan.id }); }} title={closed ? "Expand" : "Collapse"}>{closed ? "▸" : "▾"} </span>
            {clean(r.plan.name)}
          </span>
          <span className="row-actions">
            {r.plan.state === "planning" ? <Tag tone="run">planning</Tag> : null}
            {r.plan.state === "failed" ? <Tag tone="fail">failed</Tag> : null}
            {r.plan.state === "ready" ? <Tag tone={t.running ? "run" : t.failed > 0 ? "fail" : t.passed === t.total && t.total > 0 ? "pass" : "idle"}>{t.passed}/{t.total}</Tag> : null}
          </span>
        </div>
      );
    }
    const task = r.task;
    const sel = s.selection?.kind === "task" && s.selection.id === task.id;
    const tag = STATE_TAG[task.state];
    return (
      <div key={`t${task.id}`} className={`row ${r.planId !== null ? "child" : ""} ${task.past && task.runCount === 0 ? "past" : ""} ${sel ? "sel" : ""}`}
        onClick={() => { dispatch({ type: "select", selection: { kind: "task", id: task.id } }); p.onPicked(); }}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") dispatch({ type: "select", selection: { kind: "task", id: task.id } }); }}>
        <span className="name" title={clean(task.text)}>{task.past && task.runCount === 0 ? "past: " : ""}{clean(task.name)}</span>
        <span className="row-actions">
          {task.twofa ? <Tag tone="ask">?</Tag> : null}
          <Tag tone={tag.tone}>{tag.label}</Tag>
        </span>
      </div>
    );
  };

  return (
    <aside className={`sidebar ${p.open ? "open" : ""}`} aria-label="Tasks">
      <div className="row-actions">
        <Button onClick={() => dispatch({ type: "dialog", value: { kind: "add", mode: "task" } })}>+ Add task</Button>
        <Button kind="pink" onClick={() => dispatch({ type: "dialog", value: { kind: "add", mode: "plan" } })}>Plan a file</Button>
      </div>
      <input className="input" placeholder="Filter tasks (/)" aria-label="Filter tasks" value={s.filter}
        onChange={(e) => dispatch({ type: "filter", value: e.target.value })} data-filter />
      <div className="list">
        {rows.length === 0 ? <p className="muted">{s.filter === "" ? "No tasks yet. Add one to start." : "No task matches the filter."}</p> : rows.map(renderRow)}
      </div>
    </aside>
  );
}
