import assert from "node:assert/strict";
import { test } from "node:test";

import type { Effective } from "../../src/runs/manager.ts";
import { formKey, formResult, openForm } from "../../src/tui/form.ts";
import type { FormState } from "../../src/tui/form.ts";
import { key } from "../../src/tui/keypress.ts";

const EFF: Effective = { model: "m-default", maxSteps: 30, headed: false, export: false, snapshot: "hybrid" };

function press(f: FormState, ...specs: string[]): FormState {
  return specs.reduce((s, spec) => formKey(s, key(spec)), f);
}

test("form_open_prefills_effective_and_overrides", () => {
  const f = openForm(7, EFF, { maxSteps: 5, headed: true });
  assert.equal(f.taskId, 7);
  assert.equal(f.focus, 0);
  assert.deepEqual(f.fields.map((x) => x.key), ["model", "maxSteps", "headed", "export", "snapshot"]);
  assert.deepEqual(f.fields.map((x) => x.label), ["model", "max steps", "headed", "export", "snapshot mode"]);
  assert.deepEqual(f.fields.map((x) => x.raw), ["m-default", "5", "true", "false", "hybrid"]);
  assert.deepEqual(f.fields.map((x) => x.overridden), [false, true, true, false, false]);
  assert.ok(f.fields.every((x) => x.error === null));
});

test("form_toggle_and_cycle", () => {
  let f = openForm(1, EFF, {});
  f = press(f, "down", "down", "space");
  assert.equal(f.focus, 2);
  assert.equal(f.fields[2].raw, "true");
  assert.equal(f.fields[2].overridden, true);
  f = press(f, "left");
  assert.equal(f.fields[2].raw, "false");
  f = press(f, "tab", "right");
  assert.equal(f.focus, 3);
  assert.equal(f.fields[3].raw, "true");
  f = press(f, "down", "space");
  assert.equal(f.fields[4].raw, "full");
  f = press(f, "space");
  assert.equal(f.fields[4].raw, "grep");
  f = press(f, "right");
  assert.equal(f.fields[4].raw, "hybrid");
  f = press(f, "up", "up", "up", "up", "up");
});

test("form_text_editing", () => {
  let f = openForm(1, EFF, {});
  f = press(f, "backspace", "x");
  assert.equal(f.fields[0].raw, "m-defaulx");
  assert.equal(f.fields[0].overridden, true);
});

test("form_invalid_max_steps_blocks", () => {
  let f = openForm(1, EFF, {});
  f = press(f, "down", "backspace", "backspace", "0");
  assert.equal(f.fields[1].raw, "0");
  assert.equal(f.fields[1].error, "max-steps must be a whole number of at least 1, got \"0\"");
  assert.deepEqual(formResult(f), { ok: false });
  f = press(f, "backspace", "9");
  assert.equal(f.fields[1].error, null);
  assert.deepEqual(formResult(f), { ok: true, overrides: { maxSteps: 9 } });
});

test("form_ctrl_r_clears_override", () => {
  let f = openForm(1, EFF, { maxSteps: 5 });
  f = press(f, "down", "backspace", "x");
  assert.notEqual(f.fields[1].error, null);
  f = press(f, "ctrl+r");
  assert.equal(f.fields[1].raw, "30");
  assert.equal(f.fields[1].overridden, false);
  assert.equal(f.fields[1].error, null);
  assert.deepEqual(formResult(f), { ok: true, overrides: {} });
});

test("form_result_only_overridden", () => {
  let f = openForm(1, EFF, { model: "m2" });
  f = press(f, "down", "down", "space", "down", "down", "space");
  const r = formResult(f);
  assert.deepEqual(r, { ok: true, overrides: { model: "m2", headed: true, snapshot: "full" } });
});
