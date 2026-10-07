import type { PlanSnapshot, TaskSnapshot } from "../../src/runs/manager.ts";
import type { RunView } from "../../src/runviews.ts";
import {
  moveTask, openEditor, planControl, runPlan, taskControl,
} from "./actions.ts";
import type { Dispatch } from "./actions.ts";
import { clean } from "./clean.ts";
import { planTally, selectedPlan, selectedTask } from "./store.ts";
import type { WebState } from "./store.ts";
import { Timeline } from "./Timeline.tsx";
import { Button, STATE_TAG, Tag } from "./ui.tsx";

export function MainPane(p: { state: WebState; dispatch: Dispatch }) {
  const task = selectedTask(p.state);
  if (task) return <TaskView state={p.state} task={task} dispatch={p.dispatch} />;
  const plan = selectedPlan(p.state);
  if (plan) return <PlanView state={p.state} plan={plan} dispatch={p.dispatch} />;
  return (
    <main className="main">
      <div className="card">
        <b>Nothing selected.</b>
        <p className="muted">Add a task with “+ Add task”, or pick one in the list.</p>
      </div>
    </main>
  );
}

function RunSummary(p: { run: RunView; now: number }) {
  const { run } = p;
  const paused = run.pausedMs + (run.pausedSince !== null ? p.now - run.pausedSince : 0);
  const elapsed = run.outcome ? null : Math.max(0, p.now - run.startedAt - paused);
  return (
    <div className="row-actions muted">
      <span>step {run.steps.length}/{run.maxSteps || "?"}</span>
      <span>${run.cost.toFixed(4)}</span>
      {elapsed !== null ? <span>{Math.round(elapsed / 1000)}s</span> : null}
      {!run.outcome && run.control !== "running" ? <Tag tone="paused">{run.control}</Tag> : null}
      {run.brainFailures > 0 ? <Tag tone="fail">{run.brainFailures} brain failure{run.brainFailures === 1 ? "" : "s"}</Tag> : null}
      {run.past ? <Tag>past run</Tag> : null}
    </div>
  );
}

function Outcome(p: { run: RunView }) {
  const o = p.run.outcome!;
  const tone = o.status === "pass" ? "pass" : o.status === "fail" ? "fail" : "stop";
  const exported = o.export.kind === "written" ? `exported to ${clean(o.export.path)}`
    : o.export.kind === "failed" ? `export failed: ${clean(o.export.message)}`
    : o.export.kind === "skipped" ? "export skipped (the run did not succeed)" : null;
  return (
    <div className="card">
      <div className="row-actions">
        <Tag tone={tone}>{o.status}</Tag>
        <b>Result</b>
        <span className="muted">{o.steps} steps · ${o.costUsd.toFixed(4)}</span>
      </div>
      {o.answer ? <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{clean(o.answer, { multiline: true })}</pre> : null}
      {o.error ? <p className="error">{clean(o.error)}</p> : null}
      {o.historyPath ? <div className="muted">history: {clean(o.historyPath)}</div> : null}
      {exported ? <div className="muted">{exported}</div> : null}
      {o.warnings.map((w, i) => <div key={i} className="muted">⚠ {clean(w)}</div>)}
    </div>
  );
}

function TaskView(p: { state: WebState; task: TaskSnapshot; dispatch: Dispatch }) {
  const { state: s, task, dispatch } = p;
  const run = task.runId !== null ? (s.runs[task.runId] ?? null) : null;
  const live = task.state === "running" || task.state === "paused" || task.state === "stopping";
  const inPlan = task.planId !== undefined && s.plans.some((x) => x.id === task.planId);
  const e = task.effective;
  const tag = STATE_TAG[task.state];
  const id = task.id;
  return (
    <main className="main">
      <div className="card">
        <div className="row-actions">
          <b className="grow">{clean(task.name)}</b>
          {task.twofa ? <Tag tone="ask">waiting for a code</Tag> : null}
          <Tag tone={tag.tone}>{tag.label}</Tag>
        </div>
        <div className="muted">
          {task.source.kind === "file" ? clean(task.source.path) : "typed task"} · {clean(e.model)} · max {e.maxSteps} steps · {e.headed ? "headed" : "headless"} · snapshot {e.snapshot}{e.export ? " · export" : ""}
        </div>
        <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0", maxHeight: 160, overflow: "auto" }}>{clean(task.text, { multiline: true })}</pre>
        {task.error ? <p className="error">{clean(task.error)}</p> : null}
        <div className="row-actions" style={{ marginTop: 10 }}>
          {!live ? <Button kind="green" onClick={() => void taskControl(dispatch, id, "start")}>{task.runCount > 0 || task.past ? "Run again" : "Start"}</Button> : null}
          {task.state === "running" ? <Button kind="blue" onClick={() => void taskControl(dispatch, id, "pause")}>Pause</Button> : null}
          {task.state === "paused" ? <Button kind="blue" onClick={() => void taskControl(dispatch, id, "resume")}>Resume</Button> : null}
          {task.state === "paused" ? <Button onClick={() => void taskControl(dispatch, id, "step")}>Step</Button> : null}
          {live ? <Button kind="red" disabled={task.state === "stopping"} onClick={() => void taskControl(dispatch, id, "stop")}>Stop</Button> : null}
          <Button disabled={live || !!task.past} title={task.past ? "A past run cannot be edited" : "Edit the task"} onClick={() => void openEditor(dispatch, { kind: "task", id }, task.name)}>Edit</Button>
          <Button onClick={() => dispatch({ type: "dialog", value: { kind: "options", taskId: id } })}>Options</Button>
          {inPlan ? <Button small onClick={() => void moveTask(dispatch, id, -1)} title="Move up in the plan">↑</Button> : null}
          {inPlan ? <Button small onClick={() => void moveTask(dispatch, id, 1)} title="Move down in the plan">↓</Button> : null}
          <Button kind="red" disabled={live} onClick={() => dispatch({ type: "dialog", value: { kind: "confirm", confirm: { kind: "remove", taskId: id } } })}>Remove</Button>
        </div>
      </div>
      {run ? <RunSummary run={run} now={s.now} /> : <p className="muted">Not run yet.</p>}
      {run ? <Timeline run={run} dispatch={dispatch} /> : null}
      {run?.outcome ? <Outcome run={run} /> : null}
    </main>
  );
}

function PlanView(p: { state: WebState; plan: PlanSnapshot; dispatch: Dispatch }) {
  const { state: s, plan, dispatch } = p;
  const t = planTally(s, plan);
  const stateTone = plan.state === "failed" ? "fail" : plan.state === "planning" ? "run" : t.running ? "run" : "idle";
  return (
    <main className="main">
      <div className="card">
        <div className="row-actions">
          <b className="grow">{clean(plan.name)}</b>
          <Tag tone={stateTone}>{plan.state === "ready" && t.running ? "running" : plan.state}</Tag>
        </div>
        <div className="muted">
          {clean(plan.source)}{plan.folder ? ` → ${clean(plan.folder)}` : ""} · planning ${plan.cost.toFixed(4)} · {t.passed} passed, {t.failed} failed, {t.live} running of {t.total}
        </div>
        {plan.error ? <p className="error">{clean(plan.error)}</p> : null}
        <div className="row-actions" style={{ marginTop: 10 }}>
          {plan.state === "planning" ? <Button kind="red" onClick={() => void planControl(dispatch, plan.id, "cancel")}>Cancel planning</Button> : null}
          {plan.state === "failed" ? <Button kind="green" onClick={() => void planControl(dispatch, plan.id, "retry")}>Retry planning</Button> : null}
          {plan.state === "ready" && !t.running ? <Button kind="green" onClick={() => void runPlan(dispatch, plan.id, "all")}>Run plan</Button> : null}
          {plan.state === "ready" && t.running ? <Button kind="red" onClick={() => void planControl(dispatch, plan.id, "stop")}>Stop plan</Button> : null}
          {plan.state === "ready" ? <Button kind="blue" disabled={t.running || t.failed === 0} onClick={() => void runPlan(dispatch, plan.id, "failed")}>Run failed</Button> : null}
          {plan.setupPath ? <Button disabled={t.running} onClick={() => void openEditor(dispatch, { kind: "setup", planId: plan.id }, `${plan.name} setup`)}>Edit setup</Button> : null}
          <Button kind="red" disabled={plan.state === "planning" || t.running} onClick={() => dispatch({ type: "dialog", value: { kind: "confirm", confirm: { kind: "removePlan", planId: plan.id } } })}>Remove plan</Button>
        </div>
      </div>
      {plan.setup ? (
        <div className="card">
          <b>Shared setup</b>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", maxHeight: 160, overflow: "auto" }}>{clean(plan.setup, { multiline: true })}</pre>
        </div>
      ) : null}
      {plan.notes.length > 0 ? (
        <div className="card">
          <b>Notes</b>
          {plan.notes.map((n, i) => <div key={i} className="muted">{clean(n)}</div>)}
        </div>
      ) : null}
      {plan.skipped.length > 0 ? (
        <div className="card">
          <b>Skipped</b>
          {plan.skipped.map((x, i) => <div key={i} className="muted">{clean(x.id)}: {clean(x.title)}. {clean(x.reason)}</div>)}
        </div>
      ) : null}
      <div className="card">
        <b>Tasks, in run order</b>
        {plan.taskIds.map((id) => {
          const task = s.tasks.find((x) => x.id === id);
          if (!task) return null;
          const tag = STATE_TAG[task.state];
          return (
            <div key={id} className="row" style={{ marginTop: 6 }} role="button" tabIndex={0}
              onClick={() => dispatch({ type: "select", selection: { kind: "task", id } })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  dispatch({ type: "select", selection: { kind: "task", id } });
                }
              }}>
              <span className="name">{clean(task.name)}</span>
              <Tag tone={tag.tone}>{tag.label}</Tag>
            </div>
          );
        })}
      </div>
    </main>
  );
}
