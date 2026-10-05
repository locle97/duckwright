import type { Phase } from "../events.ts";
import type { TaskState } from "../runs/manager.ts";

// Plain text has no role: it uses the terminal's default foreground, so light themes stay readable.
export const ROLE: Record<"muted" | "accent" | "border" | "error", string> = {
  muted: "gray",
  accent: "cyan",
  border: "gray",
  error: "red",
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

export type ThemeName = "auto" | "dark" | "light";
export const THEME_NAMES: readonly ThemeName[] = ["auto", "dark", "light"];

export type ColorRole =
  | "muted"
  | "accent"
  | "border"
  | "error"
  | "idle"
  | "running"
  | "paused"
  | "passed"
  | "failed"
  | "stopped"
  | "warn"
  | "done";

type StepKind = "ok" | "warn" | "brain" | "done";
type Icon = { icon: string; color: string | undefined };

export interface Theme {
  color: boolean;
  role: Record<ColorRole, string | undefined>;
  taskIcon(state: TaskState): Icon;
  stepIcon(kind: StepKind): Icon;
}

// Columns: dark16, light16, darkTrue, lightTrue.
const PALETTES: Record<ColorRole, [string, string, string, string]> = {
  muted: ["gray", "gray", "#808080", "#6c6c6c"],
  accent: ["cyan", "blue", "#5fd7ff", "#005f87"],
  border: ["gray", "gray", "#585858", "#a8a8a8"],
  error: ["red", "red", "#ff5f5f", "#d70000"],
  idle: ["gray", "gray", "#808080", "#6c6c6c"],
  running: ["yellow", "magenta", "#ffd75f", "#af8700"],
  paused: ["blue", "blue", "#5f87ff", "#005fd7"],
  passed: ["green", "green", "#5fd75f", "#008700"],
  failed: ["red", "red", "#ff5f5f", "#d70000"],
  stopped: ["#ff8700", "#af5f00", "#ff8700", "#d75f00"],
  warn: ["yellow", "magenta", "#ffd75f", "#af8700"],
  done: ["cyan", "blue", "#5fd7ff", "#005f87"],
};
const ROLE_NAMES = Object.keys(PALETTES) as ColorRole[];

const TASK_GLYPH: Record<TaskState, string> = {
  idle: "○",
  running: "●",
  paused: "‖",
  passed: "✓",
  failed: "✗",
  stopping: "■",
  stopped: "■",
};
const STEP_GLYPH: Record<StepKind, string> = { ok: "✓", warn: "!", brain: "✗", done: "◆" };
const STEP_ROLE: Record<StepKind, ColorRole> = { ok: "passed", warn: "warn", brain: "failed", done: "done" };

export function isLightBackground(colorfgbg: string | undefined): boolean {
  if (colorfgbg === undefined) return false;
  const last = colorfgbg.split(";").pop() ?? "";
  if (!/^\d+$/.test(last)) return false;
  const n = Number(last);
  return n === 7 || (n >= 9 && n <= 15);
}

function makeTheme(role: Record<ColorRole, string | undefined>, color: boolean): Theme {
  return {
    color,
    role,
    taskIcon: (state) => ({ icon: TASK_GLYPH[state], color: role[state === "stopping" ? "stopped" : state] }),
    stepIcon: (kind) => ({ icon: STEP_GLYPH[kind], color: role[STEP_ROLE[kind]] }),
  };
}

export function resolveTheme(name: ThemeName, env: Record<string, string | undefined>): Theme {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return makeTheme(Object.fromEntries(ROLE_NAMES.map((r) => [r, undefined])) as Record<ColorRole, undefined>, false);
  }
  const light = name === "light" || (name === "auto" && isLightBackground(env.COLORFGBG));
  const ct = (env.COLORTERM ?? "").toLowerCase();
  const truecolor = ct === "truecolor" || ct === "24bit";
  const col = (truecolor ? 2 : 0) + (light ? 1 : 0);
  return makeTheme(Object.fromEntries(ROLE_NAMES.map((r) => [r, PALETTES[r][col]])) as Record<ColorRole, string>, true);
}

export function paneBorder(theme: Theme, focused: boolean): { borderStyle: "round" | "bold"; borderColor?: string } {
  if (!theme.color) return { borderStyle: focused ? "bold" : "round" };
  return { borderStyle: "round", borderColor: focused ? theme.role.accent : theme.role.border };
}

export const DEFAULT_THEME: Theme = resolveTheme("dark", {});
