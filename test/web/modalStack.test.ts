import assert from "node:assert/strict";
import { test } from "node:test";

import { isTopModal, popModal, pushModal } from "../../web/src/modalStack.ts";

test("only the most recently opened modal is on top", () => {
  const a = pushModal();
  const b = pushModal();
  assert.equal(isTopModal(a), false);
  assert.equal(isTopModal(b), true);
  popModal(b);
  assert.equal(isTopModal(a), true);
  popModal(a);
  assert.equal(isTopModal(a), false);
});

test("popping a modal that is not on top keeps the top one", () => {
  const a = pushModal();
  const b = pushModal();
  popModal(a);
  assert.equal(isTopModal(b), true);
  popModal(b);
});
