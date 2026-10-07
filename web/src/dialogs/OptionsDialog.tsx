import { useState } from "react";

import type { Overrides, TaskId } from "../../../src/runs/manager.ts";
import { checked } from "../actions.ts";
import type { Dispatch } from "../actions.ts";
import { api } from "../api.ts";
import { clean } from "../clean.ts";
import type { WebState } from "../store.ts";
import { Button, Modal } from "../ui.tsx";

type Draft = { model: string; maxSteps: string; headed: string; export: string; snapshot: string };

/** Options for one task (`taskId`) or, with null, the global options. An empty field inherits. */
export function OptionsDialog(p: { state: WebState; taskId: TaskId | null; dispatch: Dispatch }) {
  const task = p.taskId === null ? null : (p.state.tasks.find((t) => t.id === p.taskId) ?? null);
  const g = p.state.globals;
  const overrides: Overrides = task ? task.overrides : (g?.overrides ?? {});
  const effective = task ? task.effective : g ? { ...g.base, ...g.overrides } : null;
  const onOff = (v: boolean | undefined): string => (v === undefined ? "" : v ? "on" : "off");
  const [draft, setDraft] = useState<Draft>({
    model: overrides.model ?? "", maxSteps: overrides.maxSteps === undefined ? "" : String(overrides.maxSteps),
    headed: onOff(overrides.headed), export: onOff(overrides.export), snapshot: overrides.snapshot ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!effective || (p.taskId !== null && !task)) return null;

  const close = (): void => p.dispatch({ type: "dialog", value: null });
  const set = (k: keyof Draft, v: string): void => {
    setDraft({ ...draft, [k]: v });
    setError(null);
  };
  const save = async (): Promise<void> => {
    const o: Record<string, unknown> = {};
    if (draft.model.trim() !== "") o.model = draft.model.trim();
    if (draft.maxSteps.trim() !== "") {
      const n = Number(draft.maxSteps);
      if (!Number.isInteger(n) || n < 1) return setError("max steps must be a whole number of at least 1");
      o.maxSteps = n;
    }
    if (draft.headed !== "") o.headed = draft.headed === "on";
    if (draft.export !== "") o.export = draft.export === "on";
    if (draft.snapshot !== "") o.snapshot = draft.snapshot;
    setBusy(true);
    const r = task ? await checked(p.dispatch, api.put(`/api/tasks/${task.id}/overrides`, o)) : await checked(p.dispatch, api.put("/api/globals", o));
    setBusy(false);
    if (r.ok) close();
    else setError(r.error);
  };
  const onOffSelect = (k: "headed" | "export", label: string, now: boolean) => (
    <div className="field">
      <label htmlFor={`opt-${k}`}>{label}</label>
      <select id={`opt-${k}`} value={draft[k]} onChange={(e) => set(k, e.target.value)}>
        <option value="">inherit ({now ? "on" : "off"})</option>
        <option value="on">on</option>
        <option value="off">off</option>
      </select>
    </div>
  );

  return (
    <Modal
      title={task ? `Options: ${clean(task.name)}` : "Global options"}
      onClose={close}
      footer={
        <>
          <Button onClick={() => setDraft({ model: "", maxSteps: "", headed: "", export: "", snapshot: "" })}>Reset all</Button>
          <Button onClick={close}>Cancel</Button>
          <Button kind="green" disabled={busy} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="opt-model">model</label>
        <input id="opt-model" value={draft.model} placeholder={`inherit (${effective.model})`} onChange={(e) => set("model", e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="opt-max">max steps</label>
        <input id="opt-max" inputMode="numeric" value={draft.maxSteps} placeholder={`inherit (${effective.maxSteps})`} onChange={(e) => set("maxSteps", e.target.value)} />
      </div>
      {onOffSelect("headed", "headed", effective.headed)}
      {onOffSelect("export", "export", effective.export)}
      <div className="field">
        <label htmlFor="opt-snapshot">snapshot mode</label>
        <select id="opt-snapshot" value={draft.snapshot} onChange={(e) => set("snapshot", e.target.value)}>
          <option value="">inherit ({effective.snapshot})</option>
          <option value="hybrid">hybrid</option>
          <option value="full">full</option>
          <option value="grep">grep</option>
        </select>
      </div>
      <span className="hint">
        {task ? "Applies to this task's next run, above the global options." : "Applies to every task's next run, below a task's own options."}
      </span>
      {error ? <p className="error">{clean(error)}</p> : null}
    </Modal>
  );
}
