import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THEME,
  isLightBackground,
  paneBorder,
  PHASE_LABEL,
  resolveTheme,
  ROLE,
  SPINNER,
  spinnerFrame,
  STEP_ICON,
  TASK_ICON,
  THEME_NAMES,
  type ColorRole,
  type ThemeName,
} from "../../src/tui/theme.ts";

test("theme_icons_cover_states", () => {
  assert.deepEqual(TASK_ICON, {
    idle: { icon: "○", color: "gray" },
    running: { icon: "●", color: "yellow" },
    paused: { icon: "‖", color: "blue" },
    passed: { icon: "✓", color: "green" },
    failed: { icon: "✗", color: "red" },
    stopping: { icon: "■", color: "#ff8700" },
    stopped: { icon: "■", color: "#ff8700" },
  });
  assert.deepEqual(STEP_ICON, {
    ok: { icon: "✓", color: "green" },
    warn: { icon: "!", color: "yellow" },
    brain: { icon: "✗", color: "red" },
    done: { icon: "◆", color: "cyan" },
  });
  assert.equal(ROLE.muted, "gray");
  assert.equal(ROLE.accent, "cyan");
  assert.deepEqual(PHASE_LABEL, { observing: "snapshot…", thinking: "thinking…", acting: "acting…" });
});

test("spinner_frames", () => {
  assert.equal(SPINNER, "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");
  assert.equal(spinnerFrame(0), "⠋");
  assert.equal(spinnerFrame(79), "⠋");
  assert.equal(spinnerFrame(80), "⠙");
  assert.equal(spinnerFrame(80 * 10), "⠋");
});

const ROLES: ColorRole[] = ["muted", "accent", "border", "error", "idle", "running", "paused", "passed", "failed", "stopped", "warn", "done"];
const COLS: Record<ColorRole, [string, string, string, string]> = {
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
function column(i: number): Record<ColorRole, string> {
  return Object.fromEntries(ROLES.map((r) => [r, COLS[r][i]])) as Record<ColorRole, string>;
}

test("theme_palettes", () => {
  assert.deepEqual(THEME_NAMES, ["auto", "dark", "light"]);
  const cases: [ThemeName, Record<string, string>, number][] = [
    ["dark", {}, 0],
    ["light", {}, 1],
    ["dark", { COLORTERM: "truecolor" }, 2],
    ["light", { COLORTERM: "24bit" }, 3],
    ["dark", { COLORTERM: "TrueColor" }, 2],
    ["light", { COLORTERM: "yes" }, 1],
  ];
  for (const [name, env, col] of cases) {
    const t = resolveTheme(name, env);
    assert.equal(t.color, true);
    assert.deepEqual(t.role, column(col), `${name} ${JSON.stringify(env)}`);
  }
});

test("theme_auto", () => {
  const dark = column(0);
  const light = column(1);
  const role = (v: string | undefined) => resolveTheme("auto", v === undefined ? {} : { COLORFGBG: v }).role;
  assert.deepEqual(role("15;0"), dark);
  assert.deepEqual(role("0;15"), light);
  assert.deepEqual(role("0;7"), light);
  assert.deepEqual(role("0;8"), dark);
  assert.deepEqual(role("default;0"), dark);
  assert.deepEqual(role(undefined), dark);
  assert.equal(isLightBackground("0;9"), true);
  assert.equal(isLightBackground("0;16"), false);
  assert.equal(isLightBackground("abc"), false);
});

test("theme_no_color", () => {
  for (const name of THEME_NAMES) {
    const t = resolveTheme(name, { NO_COLOR: "1", COLORTERM: "truecolor" });
    assert.equal(t.color, false);
    for (const r of ROLES) assert.equal(t.role[r], undefined);
    assert.deepEqual(t.taskIcon("passed"), { icon: "✓", color: undefined });
    assert.deepEqual(paneBorder(t, true), { borderStyle: "bold" });
    assert.deepEqual(paneBorder(t, false), { borderStyle: "round" });
  }
  assert.equal(resolveTheme("dark", { NO_COLOR: "" }).color, true);
});

test("theme_default_matches_constants", () => {
  for (const s of Object.keys(TASK_ICON) as (keyof typeof TASK_ICON)[]) {
    assert.deepEqual(DEFAULT_THEME.taskIcon(s), TASK_ICON[s]);
  }
  for (const k of Object.keys(STEP_ICON) as (keyof typeof STEP_ICON)[]) {
    assert.deepEqual(DEFAULT_THEME.stepIcon(k), STEP_ICON[k]);
  }
  for (const r of ["muted", "accent", "border", "error"] as const) assert.equal(DEFAULT_THEME.role[r], ROLE[r]);
  assert.deepEqual(paneBorder(DEFAULT_THEME, true), { borderStyle: "round", borderColor: "cyan" });
  assert.deepEqual(paneBorder(DEFAULT_THEME, false), { borderStyle: "round", borderColor: "gray" });
});
