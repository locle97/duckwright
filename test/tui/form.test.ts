import assert from "node:assert/strict";
import { test } from "node:test";

import type { Effective } from "../../src/runs/manager.ts";
import { formKey, formResult, openForm } from "../../src/tui/form.ts";
import type { FormState } from "../../src/tui/form.ts";
import { key } from "../../src/tui/keypress.ts";

const EFF: Effective = { model: "m-default", maxSteps: 30, headed: false, snapshot: "hybrid", video: false, screenshot: false, env: null };

function press(f: FormState, ...specs: string[]): FormState {
  return specs.reduce((s, spec) => formKey(s, key(spec)), f);
}

test("form_open_prefills_effective_and_overrides", () => {
  const f = openForm(7, EFF, { maxSteps: 5, headed: true });
  assert.equal(f.taskId, 7);
  assert.equal(f.focus, 0);
  assert.deepEqual(f.fields.map((x) => x.key), ["model", "maxSteps", "headed", "snapshot", "video", "screenshot", "env"]);
  assert.deepEqual(f.fields.map((x) => x.label), ["model", "max steps", "headed", "snapshot mode", "video", "screenshot", "environment"]);
  assert.deepEqual(f.fields.map((x) => x.raw), ["m-default", "5", "true", "hybrid", "false", "false", "none"]);
  assert.deepEqual(f.fields.map((x) => x.overridden), [false, true, true, false, false, false, false]);
  assert.ok(f.fields.every((x) => x.error === null));
});

test("form_evidence_fields", () => {
  let f = openForm(null, EFF, {});
  assert.deepEqual(f.fields.map((x) => x.key), ["model", "maxSteps", "headed", "snapshot", "video", "screenshot", "env"]);
  assert.deepEqual(f.fields.slice(-3, -1).map((x) => x.label), ["video", "screenshot"]);
  f = press(f, "down", "down", "down", "down");
  assert.equal(f.fields[4].key, "video");
  f = press(f, "x");
  assert.equal(f.fields[4].raw, "false", "other input is ignored");
  assert.equal(f.fields[4].overridden, false);
  f = press(f, "space");
  assert.equal(f.fields[4].raw, "true");
  assert.equal(f.fields[4].overridden, true);
  assert.deepEqual(formResult(f), { ok: true, overrides: { video: true } });
  f = press(f, "left");
  assert.equal(f.fields[4].raw, "false");
  f = press(f, "right");
  assert.equal(f.fields[4].raw, "true");
  f = press(f, "ctrl+r");
  assert.equal(f.fields[4].raw, "false");
  assert.equal(f.fields[4].overridden, false);
  f = press(f, "down", "space");
  assert.deepEqual(formResult(f), { ok: true, overrides: { screenshot: true } });
});

test("form_toggle_and_cycle", () => {
  let f = openForm(1, EFF, {});
  f = press(f, "down", "down", "space");
  assert.equal(f.focus, 2);
  assert.equal(f.fields[2].raw, "true");
  assert.equal(f.fields[2].overridden, true);
  f = press(f, "left");
  assert.equal(f.fields[2].raw, "false");
  f = press(f, "tab", "space");
  assert.equal(f.focus, 3);
  assert.equal(f.fields[3].raw, "full");
  f = press(f, "space");
  assert.equal(f.fields[3].raw, "grep");
  f = press(f, "right");
  assert.equal(f.fields[3].raw, "hybrid");
  f = press(f, "up", "up", "up", "up");
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
  f = press(f, "down", "down", "space", "down", "space");
  const r = formResult(f);
  assert.deepEqual(r, { ok: true, overrides: { model: "m2", headed: true, snapshot: "full" } });
});

test("form_env_field_open", () => {
  const eff = { ...EFF, env: null };
  const last = (o: Parameters<typeof openForm>[2]) => openForm(null, eff, o, 0, ["qa", "staging"]).fields.at(-1);
  assert.deepEqual(last({}), { key: "env", label: "environment", raw: "none", overridden: false, error: null, effective: "none" });
  assert.deepEqual([last({ env: null })?.raw, last({ env: null })?.overridden], ["none", true]);
  assert.deepEqual([last({ env: "qa" })?.raw, last({ env: "qa" })?.overridden], ["qa", true]);
});

test("form_env_cycles_and_resets", () => {
  let f = openForm(null, { ...EFF, env: "eu" }, {}, 6, ["qa", "staging"]);
  const raw = () => f.fields[6].raw;
  f = press(f, "space");
  assert.equal(raw(), "none");
  f = press(f, "right");
  assert.equal(raw(), "qa");
  f = press(f, "left");
  assert.equal(raw(), "staging");
  f = press(f, "space");
  assert.equal(raw(), "eu");
  f = press(f, "space", "x", "backspace");
  assert.equal(raw(), "none");
  assert.deepEqual(formResult(f), { ok: true, overrides: { env: null } });
  f = press(f, "right");
  assert.deepEqual(formResult(f), { ok: true, overrides: { env: "qa" } });
  f = press(f, "ctrl+r");
  assert.equal(raw(), "eu");
  assert.equal(f.fields[6].overridden, false);
  assert.deepEqual(formResult(f), { ok: true, overrides: {} });
});
