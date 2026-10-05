import assert from "node:assert/strict";
import { test } from "node:test";
import { RunEvents, type RunEvent } from "../src/events.ts";

test("events_stamp_and_order", () => {
  const hub = new RunEvents(() => 42);
  const seen: string[] = [];
  const got: RunEvent[] = [];
  hub.subscribe((e) => {
    seen.push("a");
    got.push(e);
  });
  hub.subscribe((e) => {
    seen.push("b");
    got.push(e);
  });
  hub.emit({ type: "step:start", step: 1 });
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(got, [
    { type: "step:start", step: 1, at: 42 },
    { type: "step:start", step: 1, at: 42 },
  ]);
});

test("events_unsubscribe", () => {
  const hub = new RunEvents(() => 1);
  const got: RunEvent[] = [];
  const off = hub.subscribe((e) => got.push(e));
  hub.emit({ type: "step:start", step: 1 });
  off();
  hub.emit({ type: "step:start", step: 2 });
  assert.equal(got.length, 1);
});

test("events_throwing_listener_isolated", () => {
  const hub = new RunEvents(() => 1);
  const got: RunEvent[] = [];
  hub.subscribe(() => {
    throw new Error("boom");
  });
  hub.subscribe((e) => got.push(e));
  assert.doesNotThrow(() => hub.emit({ type: "step:start", step: 1 }));
  assert.equal(got.length, 1);
});
