import assert from "node:assert/strict";
import { test } from "node:test";

import { HumanBridge } from "../../src/runs/humanBridge.ts";
import { AbortedError } from "../../src/proc.ts";
import { CancelledError } from "../../src/twofa.ts";

const live = () => new AbortController().signal;

test("a_request_is_pending_until_answered", async () => {
  let changes = 0;
  const b = new HumanBridge(() => { changes++; });
  assert.equal(b.pending, null);
  const p = b.code("sms", live());
  assert.deepEqual(b.pending, { kind: "sms" });
  assert.equal(b.answer("123456"), true);
  assert.equal(await p, "123456");
  assert.equal(b.pending, null);
  assert.equal(changes, 2);
});

test("secret_and_passkey_kinds", async () => {
  const b = new HumanBridge(() => {});
  const s = b.secret(live());
  assert.deepEqual(b.pending, { kind: "secret" });
  b.answer("GEZD");
  assert.equal(await s, "GEZD");
  const a = b.approve(live());
  assert.deepEqual(b.pending, { kind: "passkey" });
  b.answer("");
  await a;
});

test("null_cancels", async () => {
  const b = new HumanBridge(() => {});
  const p = b.code("email", live());
  b.answer(null);
  await assert.rejects(p, CancelledError);
  assert.equal(b.pending, null);
});

test("abort_clears_pending", async () => {
  const b = new HumanBridge(() => {});
  const ac = new AbortController();
  const p = b.code("sms", ac.signal);
  ac.abort();
  await assert.rejects(p, AbortedError);
  assert.equal(b.pending, null);
});

test("an_already_aborted_signal_never_becomes_pending", async () => {
  const b = new HumanBridge(() => {});
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(b.code("sms", ac.signal), AbortedError);
  assert.equal(b.pending, null);
});

test("answer_with_nothing_pending_is_a_no_op", () => {
  assert.equal(new HumanBridge(() => {}).answer("x"), false);
});
