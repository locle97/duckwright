// What a key does outside a text field. Pure, so it is tested with node --test; App.tsx runs the result.
import type { PlanId, TaskId } from "../../src/runs/manager.ts";
import { liveCount, pendingTwofa, planTally, selectedPlan, selectedTask } from "./store.ts";
import type { Action, WebState } from "./store.ts";

export type Command =
  | { type: "action"; action: Action }
  | { type: "task"; id: TaskId; verb: "start" | "pause" | "resume" | "step" | "stop" }
  | { type: "runPlan"; id: PlanId }
  | { type: "editTask"; id: TaskId; name: string }
  | { type: "editSetup"; planId: PlanId; name: string }
  | { type: "focusFilter" }
  | { type: "quit" };

const act = (action: Action): Command => ({ type: "action", action });
const dialog = (value: Extract<Action, { type: "dialog" }>["value"]): Command => act({ type: "dialog", value });

export interface KeyInfo {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** The target is a text field, select or contentEditable. */
  inEditable: boolean;
  /** The target is, or sits inside, a button, role=button, link or summary. */
  inInteractive: boolean;
}

/** Whether the global shortcuts must stay out of the way of this key press. */
export function shouldIgnore(k: KeyInfo, s: WebState): boolean {
  if (k.ctrlKey || k.metaKey || k.altKey || k.defaultPrevented || k.inEditable) return true;
  if (s.dialog !== null || pendingTwofa(s) !== null) return true;
  if (s.ended || s.expired || !s.loaded) return true;
  return k.inInteractive && (k.key === "Enter" || k.key === " ");
}

export function commandFor(key: string, s: WebState): Command | null {
  const task = selectedTask(s);
  const plan = selectedPlan(s);
  const live = task !== null && (task.state === "running" || task.state === "paused" || task.state === "stopping");
  switch (key) {
    case "a": return dialog({ kind: "add", mode: "task" });
    case "P": return dialog({ kind: "add", mode: "plan" });
    case "?": return dialog({ kind: "help" });
    case "/": return { type: "focusFilter" };
    case "o": return task ? dialog({ kind: "options", taskId: task.id }) : null;
    case "O": return dialog({ kind: "options", taskId: null });
    case "j": case "ArrowDown": return act({ type: "move", delta: 1 });
    case "k": case "ArrowUp": return act({ type: "move", delta: -1 });
    case " ":
      if (task) return live ? null : { type: "task", id: task.id, verb: "start" };
      if (plan && plan.state === "ready" && !planTally(s, plan).running) return { type: "runPlan", id: plan.id };
      return null;
    case "p":
      if (task?.state === "running") return { type: "task", id: task.id, verb: "pause" };
      if (task?.state === "paused") return { type: "task", id: task.id, verb: "resume" };
      return null;
    case "n": return task?.state === "paused" ? { type: "task", id: task.id, verb: "step" } : null;
    case "s": return task && live && task.state !== "stopping" ? { type: "task", id: task.id, verb: "stop" } : null;
    case "e":
      if (task) return live || task.past ? null : { type: "editTask", id: task.id, name: task.name };
      if (plan?.setupPath) return planTally(s, plan).running ? null : { type: "editSetup", planId: plan.id, name: `${plan.name} setup` };
      return null;
    case "x":
      if (task) return live ? null : dialog({ kind: "confirm", confirm: { kind: "remove", taskId: task.id } });
      if (plan && plan.state !== "planning" && !planTally(s, plan).running) return dialog({ kind: "confirm", confirm: { kind: "removePlan", planId: plan.id } });
      return null;
    case "q": {
      const count = liveCount(s);
      return count > 0 ? dialog({ kind: "confirm", confirm: { kind: "quit", count } }) : { type: "quit" };
    }
    case "Enter": return act({ type: "timeline", op: "toggle" });
    case "[": return act({ type: "timeline", op: "move", delta: -1 });
    case "]": return act({ type: "timeline", op: "move", delta: 1 });
    case "E": return act({ type: "timeline", op: "expandAll" });
    case "C": return act({ type: "timeline", op: "collapseAll" });
    case "G": return act({ type: "timeline", op: "last" });
    default: return null;
  }
}
