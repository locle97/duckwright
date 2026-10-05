import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE_LABEL, ROLE, SPINNER, spinnerFrame, STEP_ICON, TASK_ICON } from "../../src/tui/theme.ts";

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
