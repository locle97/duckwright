import assert from "node:assert/strict";
import { test } from "node:test";

import { newestFirst } from "../../src/tui/order.ts";

test("order_newest_first", () => {
  assert.deepEqual(newestFirst([{ id: 1, createdAt: 1 }, { id: 2, createdAt: 2 }, { id: 3, createdAt: 3 }]), [2, 1, 0]);
});

test("order_ties_by_higher_id", () => {
  assert.deepEqual(newestFirst([{ id: 1, createdAt: 7 }, { id: 2, createdAt: 7 }, { id: 3, createdAt: 7 }]), [2, 1, 0]);
});

test("order_past_above_typed", () => {
  assert.deepEqual(newestFirst([{ id: 1, createdAt: 5 }, { id: 2, createdAt: 4 }]), [0, 1]);
});

test("order_does_not_mutate", () => {
  const input = [{ id: 1, createdAt: 1 }, { id: 2, createdAt: 2 }];
  const copy = structuredClone(input);
  newestFirst(input);
  assert.deepEqual(input, copy);
});
