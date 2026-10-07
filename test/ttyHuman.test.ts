import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createTtyHuman } from "../src/report/ttyHuman.ts";
import { AbortedError } from "../src/proc.ts";

const live = () => new AbortController().signal;

function setup(over: { onInterrupt?: () => void } = {}) {
  const stdin = new PassThrough();
  const out: string[] = [];
  const human = createTtyHuman({ label: "[2/3] b.md", stdin, write: (s) => out.push(s), ...over });
  return { stdin, out, human, text: () => out.join("") };
}

test("code_prompts_with_the_label_reads_a_line_and_echoes", async () => {
  const t = setup();
  const p = t.human.code("sms", live());
  t.stdin.write("12");
  t.stdin.write("3456\n");
  assert.equal(await p, "123456");
  assert.ok(t.text().includes("[2/3] b.md: SMS verification code"));
  assert.ok(t.text().includes("123456"), "a code is echoed");
});

test("email_prompt_names_email", async () => {
  const t = setup();
  const p = t.human.code("email", live());
  t.stdin.write("1\n");
  await p;
  assert.ok(t.text().includes("email verification code"));
});

test("totp_prompt_names_the_authenticator_and_echoes_the_code", async () => {
  const t = setup();
  const p = t.human.code("totp", live());
  t.stdin.write("493817\n");
  assert.equal(await p, "493817");
  assert.ok(t.text().includes("authenticator (TOTP) code"));
  assert.ok(t.text().includes("493817"));
});

test("backspace_edits_the_input", async () => {
  const t = setup();
  const p = t.human.code("sms", live());
  t.stdin.write("12\x7f3\n");
  assert.equal(await p, "13");
});

test("approve_waits_for_enter", async () => {
  const t = setup();
  let done = false;
  const p = t.human.approve(live()).then(() => { done = true; });
  t.stdin.write("   ");
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  t.stdin.write("\n");
  await p;
  assert.ok(t.text().includes("approve the passkey prompt"));
});

test("two_prompts_in_a_row", async () => {
  const t = setup();
  const a = t.human.code("sms", live());
  t.stdin.write("1111\n");
  assert.equal(await a, "1111");
  const b = t.human.code("sms", live());
  t.stdin.write("2222\n");
  assert.equal(await b, "2222");
  assert.equal(t.stdin.listenerCount("data"), 0);
});

test("abort_removes_listeners_and_rejects", async () => {
  const t = setup();
  const ac = new AbortController();
  const p = t.human.code("sms", ac.signal);
  ac.abort();
  await assert.rejects(p, AbortedError);
  assert.equal(t.stdin.listenerCount("data"), 0);
});

test("an_already_aborted_signal_rejects_at_once", async () => {
  const t = setup();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(t.human.code("sms", ac.signal), AbortedError);
  assert.equal(t.text(), "");
});

test("ctrl_c_in_raw_mode_raises_the_interrupt", async () => {
  let interrupts = 0;
  const t = setup({ onInterrupt: () => { interrupts++; } });
  const ac = new AbortController();
  const p = t.human.code("sms", ac.signal);
  t.stdin.write("\x03");
  await new Promise((r) => setImmediate(r));
  assert.equal(interrupts, 1);
  ac.abort();
  await assert.rejects(p, AbortedError);
});
