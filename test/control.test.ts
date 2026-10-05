import assert from "node:assert/strict";
import { test } from "node:test";
import { RunControl } from "../src/control.ts";
import { RunEvents, type ControlState } from "../src/events.ts";
import { AbortedError } from "../src/proc.ts";

function make() {
  const controller = new AbortController();
  const events = new RunEvents(() => 0);
  const states: ControlState[] = [];
  events.subscribe((e) => {
    if (e.type === "control") states.push(e.state);
  });
  const c = new RunControl(controller, events);
  return { c, controller, states };
}

async function pending(p: Promise<void>): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setImmediate(r));
  return !settled;
}

test("control_transitions", () => {
  const { c, controller, states } = make();
  assert.equal(c.state, "running");

  c.resume();
  c.step();
  assert.equal(c.state, "running");
  assert.deepEqual(states, []);

  c.pause();
  assert.equal(c.state, "paused");
  c.pause(); // no-op
  c.resume();
  assert.equal(c.state, "running");
  c.pause();
  c.step();
  assert.equal(c.state, "stepping");
  c.step(); // no-op
  c.pause();
  assert.equal(c.state, "paused");
  assert.deepEqual(states, ["paused", "running", "paused", "stepping", "paused"]);

  c.step();
  c.stop();
  assert.equal(c.state, "stopping");
  assert.equal(controller.signal.aborted, true);
  c.stop();
  c.pause();
  c.resume();
  c.step();
  assert.equal(c.state, "stopping");
  assert.deepEqual(states, ["paused", "running", "paused", "stepping", "paused", "stepping", "stopping"]);
});

test("control_stop_from_running_and_paused", () => {
  const a = make();
  a.c.stop();
  assert.equal(a.c.state, "stopping");
  assert.equal(a.controller.signal.aborted, true);
  assert.deepEqual(a.states, ["stopping"]);

  const b = make();
  b.c.pause();
  b.c.stop();
  assert.equal(b.c.state, "stopping");
  assert.deepEqual(b.states, ["paused", "stopping"]);
});

test("control_gate_running_passes", async () => {
  const { c, controller } = make();
  await c.gate(controller.signal);
  assert.equal(c.state, "running");
});

test("control_gate_waits_while_paused", async () => {
  const { c, controller } = make();
  c.pause();
  const p = c.gate(controller.signal);
  assert.equal(await pending(p), true);
  c.resume();
  await p;
  assert.equal(c.state, "running");
});

test("control_step_lets_one_through", async () => {
  const { c, controller, states } = make();
  c.pause();
  c.step();
  await c.gate(controller.signal);
  assert.equal(c.state, "paused");
  assert.deepEqual(states, ["paused", "stepping", "paused"]);
  const second = c.gate(controller.signal);
  assert.equal(await pending(second), true);
  c.resume();
  await second;
});

test("control_step_wakes_waiting_gate", async () => {
  const { c, controller } = make();
  c.pause();
  const p = c.gate(controller.signal);
  assert.equal(await pending(p), true);
  c.step();
  await p;
  assert.equal(c.state, "paused");
});

test("control_stop_while_waiting_rejects", async () => {
  const { c, controller } = make();
  c.pause();
  const p = c.gate(controller.signal);
  c.stop();
  await assert.rejects(p, AbortedError);
  assert.equal(controller.signal.aborted, true);
  assert.equal(c.state, "stopping");
});

test("control_gate_rejects_if_already_aborted", async () => {
  const { c, controller } = make();
  controller.abort();
  await assert.rejects(c.gate(controller.signal), AbortedError);
});

test("control_gate_abort_listener_removed", async () => {
  const { c } = make();
  const other = new AbortController();
  c.pause();
  const p = c.gate(other.signal);
  c.resume();
  await p;
  other.abort(); // must not throw or cause unhandled rejection
  await new Promise((r) => setImmediate(r));
});
