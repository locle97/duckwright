import type { Phase } from "../events.ts";
import type { TaskState } from "../runs/manager.ts";

export const ROLE: Record<"text" | "muted" | "accent" | "border", string> = {
  text: "white",
  muted: "gray",
  accent: "cyan",
  border: "gray",
};

export const TASK_ICON: Record<TaskState, { icon: string; color: string }> = {
  idle: { icon: "○", color: "gray" },
  running: { icon: "●", color: "yellow" },
  paused: { icon: "‖", color: "blue" },
  passed: { icon: "✓", color: "green" },
  failed: { icon: "✗", color: "red" },
  stopping: { icon: "■", color: "#ff8700" },
  stopped: { icon: "■", color: "#ff8700" },
};

export const STEP_ICON: Record<"ok" | "warn" | "brain" | "done", { icon: string; color: string }> = {
  ok: { icon: "✓", color: "green" },
  warn: { icon: "!", color: "yellow" },
  brain: { icon: "✗", color: "red" },
  done: { icon: "◆", color: "cyan" },
};

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const FRAMES = [...SPINNER];

export function spinnerFrame(now: number): string {
  return FRAMES[Math.floor(now / 80) % FRAMES.length];
}

export const PHASE_LABEL: Record<Phase, string> = {
  observing: "snapshot…",
  thinking: "thinking…",
  acting: "acting…",
};
