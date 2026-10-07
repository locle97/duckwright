// The browser's operations on the server: each is one API call whose failure is shown as a toast.
import type { EditTarget, PlanId, TaskId, TaskSnapshot } from "../../src/runs/manager.ts";
import { api } from "./api.ts";
import type { Reply } from "./api.ts";
import type { Action, EditDraft } from "./store.ts";

export type Dispatch = (a: Action) => void;

/** Waits for `call`; a 401 means the page's token no longer works, so the session has expired. */
export async function checked(d: Dispatch, call: Promise<Reply>): Promise<Reply> {
  const r = await call;
  if (!r.ok && r.unauthorized === true) d({ type: "expired" });
  return r;
}

/** Waits for `call`; a failure becomes an error toast. */
export async function shown(d: Dispatch, call: Promise<Reply>): Promise<Reply> {
  const r = await checked(d, call);
  if (!r.ok) d({ type: "toast", level: "error", message: r.error });
  return r;
}

export const taskControl = (d: Dispatch, id: TaskId, verb: "start" | "pause" | "resume" | "step" | "stop") =>
  shown(d, api.post(`/api/tasks/${id}/${verb}`));
export const planControl = (d: Dispatch, id: PlanId, verb: "retry" | "cancel" | "stop") =>
  shown(d, api.post(`/api/plans/${id}/${verb}`));
export const runPlan = (d: Dispatch, id: PlanId, which: "all" | "failed") =>
  shown(d, api.post(`/api/plans/${id}/run`, { which }));
export const removeTask = (d: Dispatch, id: TaskId) => shown(d, api.del(`/api/tasks/${id}`));
export const removePlan = (d: Dispatch, id: PlanId) => shown(d, api.del(`/api/plans/${id}`));
export const moveTask = (d: Dispatch, id: TaskId, delta: number) => shown(d, api.post(`/api/tasks/${id}/move`, { delta }));

export const replaySpec = (d: Dispatch, id: TaskId) => shown(d, api.post(`/api/tasks/${id}/replay`));

/** The Replay spec button's title, or null when the button is hidden (the task is live). */
export function replayTitle(task: TaskSnapshot): string | null {
  if (task.state === "running" || task.state === "paused" || task.state === "stopping") return null;
  return task.hasSpec ? "Open duckwright.spec.ts in the Playwright Inspector" : "No spec yet: only a passed run writes duckwright.spec.ts";
}

export async function openEditor(d: Dispatch, target: EditTarget, title: string): Promise<void> {
  const q = target.kind === "task" ? `kind=task&id=${target.id}` : `kind=setup&planId=${target.planId}`;
  const r = await shown(d, api.get(`/api/source?${q}`));
  if (!r.ok) return;
  const text = String(r.text);
  d({ type: "dialog", value: { kind: "edit", draft: { target, title, original: text, text, error: null } } });
}

export async function saveEditor(d: Dispatch, draft: EditDraft): Promise<boolean> {
  const r = await checked(d, api.put("/api/source", { target: draft.target, text: draft.text }));
  if (r.ok) {
    d({ type: "dialog", value: null });
    return true;
  }
  d({ type: "editFailed", error: r.error });
  return false;
}

export async function quitServer(d: Dispatch): Promise<void> {
  const r = await shown(d, api.post("/api/quit"));
  if (r.ok) d({ type: "ended" });
}
