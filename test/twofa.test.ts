import assert from "node:assert/strict";
import { test } from "node:test";

import { RunEvents } from "../src/events.ts";
import type { RunEvent } from "../src/events.ts";
import { AbortedError } from "../src/proc.ts";
import {
  CancelledError, MAX_TWOFA_ATTEMPTS, NO_HUMAN, SECRET_ENV, TwoFactorError, checkTwofaArgs, createTwoFactor, secretProblem,
} from "../src/twofa.ts";
import type { Human } from "../src/twofa.ts";
import { CODE_MASK } from "../src/scrub.ts";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const AT_59 = "287082"; // the RFC 6238 code for t=59 s

function human(over: Partial<Human> = {}): Human & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    secret: async () => { asked.push("secret"); return SECRET; },
    code: async (kind) => { asked.push(kind); return "493817"; },
    approve: async () => { asked.push("passkey"); },
    ...over,
  };
}

const hangs = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new AbortedError()), { once: true }));

const make = (o: Partial<Parameters<typeof createTwoFactor>[0]> = {}) =>
  createTwoFactor({ secret: null, human: null, timeoutSec: 5, signal: new AbortController().signal, now: () => 59_000, ...o });

test("totp_uses_the_env_secret_without_asking_and_scrubs_the_code", async () => {
  const h = human();
  const tf = make({ secret: SECRET, human: h });
  assert.equal(await tf.totp(), AT_59);
  assert.deepEqual(h.asked, []);
  assert.equal(tf.scrubber.scrub(`fill('${AT_59}') ${SECRET}`), `fill('${CODE_MASK}') [REDACTED]`);
});

test("totp_works_with_no_human_when_the_env_secret_is_set", async () => {
  assert.equal(await make({ secret: SECRET }).totp(), AT_59);
});

test("totp_asks_for_the_secret_once_and_keeps_it_in_memory", async () => {
  const h = human();
  const tf = make({ human: h });
  assert.equal(await tf.totp(), AT_59);
  assert.equal(await tf.totp(), AT_59);
  assert.deepEqual(h.asked, ["secret"]);
  assert.equal(tf.scrubber.scrub(SECRET), "[REDACTED]");
});

test("a_bad_typed_secret_is_refused_without_quoting_it", async () => {
  const tf = make({ human: human({ secret: async () => "hunter2!" }) });
  await assert.rejects(tf.totp(), (e: unknown) =>
    e instanceof TwoFactorError && e.message === "not a valid TOTP secret" && !e.message.includes("hunter2"));
});

test("an_invalid_env_secret_throws_when_the_provider_is_built", () => {
  assert.throws(() => make({ secret: "!!" }), /not a valid TOTP secret/);
});

test("sms_and_email_codes_come_from_the_human_and_are_scrubbed", async () => {
  const h = human();
  const tf = make({ human: h });
  assert.equal(await tf.code("sms"), "493817");
  assert.equal(await tf.code("email"), "493817");
  assert.deepEqual(h.asked, ["sms", "email"]);
  assert.equal(tf.scrubber.scrub("got 493817"), `got ${CODE_MASK}`);
});

test("empty_code_is_refused", async () => {
  const tf = make({ human: human({ code: async () => "   " }) });
  await assert.rejects(tf.code("sms"), (e: unknown) => e instanceof TwoFactorError && /empty/.test(e.message));
});

test("passkey_waits_for_the_human", async () => {
  const h = human();
  await make({ human: h }).approve();
  assert.deepEqual(h.asked, ["passkey"]);
});

test("no_human_means_a_clear_error_for_every_human_call", async () => {
  const tf = make();
  for (const call of [() => tf.totp(), () => tf.code("sms"), () => tf.approve()]) {
    await assert.rejects(call(), (e: unknown) => e instanceof TwoFactorError && e.message === NO_HUMAN);
  }
});

test("a_human_wait_times_out_and_emits_wait_then_done", async () => {
  const events = new RunEvents();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const tf = make({ human: human({ code: (_k, signal) => hangs(signal) }), timeoutSec: 0.05, events });
  await assert.rejects(tf.code("sms"), (e: unknown) =>
    e instanceof TwoFactorError && e.message === "timed out waiting for the 2FA code");
  assert.deepEqual(seen.map((e) => e.type), ["twofa:wait", "twofa:done"]);
  assert.equal(seen[0].type === "twofa:wait" && seen[0].kind, "sms");
  assert.equal(seen[1].type === "twofa:done" && seen[1].outcome, "timeout");
});

test("aborting_the_run_rejects_with_aborted_error", async () => {
  const run = new AbortController();
  const tf = make({ human: human({ code: (_k, signal) => hangs(signal) }), signal: run.signal });
  const p = tf.code("sms");
  run.abort();
  await assert.rejects(p, AbortedError);
});

test("cancel_becomes_an_error_result", async () => {
  const tf = make({ human: human({ approve: async () => { throw new CancelledError(); } }) });
  await assert.rejects(tf.approve(), (e: unknown) => e instanceof TwoFactorError && e.message === "cancelled");
});

test("the_sixth_attempt_is_refused", async () => {
  const tf = make({ human: human() });
  for (let i = 0; i < MAX_TWOFA_ATTEMPTS; i++) await tf.code("sms");
  await assert.rejects(tf.code("sms"), (e: unknown) =>
    e instanceof TwoFactorError && e.message === "too many 2FA attempts in this run");
});

test("check_twofa_args", () => {
  assert.equal(checkTwofaArgs(["totp", "e12"]), null);
  assert.equal(checkTwofaArgs(["sms", "f1e3"]), null);
  assert.equal(checkTwofaArgs(["email", "e1"]), null);
  assert.equal(checkTwofaArgs(["passkey"]), null);
  assert.equal(checkTwofaArgs([]), "error: twofa needs a kind: totp, sms, email, passkey");
  assert.equal(checkTwofaArgs(["fax", "e1"]), "error: twofa needs a kind: totp, sms, email, passkey");
  assert.equal(checkTwofaArgs(["totp"]), "error: twofa totp needs the element ref of the code field");
  assert.equal(checkTwofaArgs(["sms", "e1", "x"]), "error: twofa sms needs the element ref of the code field");
  assert.equal(checkTwofaArgs(["totp", "e1; rm -rf"]), "error: twofa totp needs the element ref of the code field");
  assert.equal(checkTwofaArgs(["passkey", "e1"]), "error: twofa passkey takes no other argument");
});

test("secret_problem", () => {
  assert.equal(secretProblem({}), null);
  assert.equal(secretProblem({ [SECRET_ENV]: "" }), null);
  assert.equal(secretProblem({ [SECRET_ENV]: SECRET }), null);
  assert.equal(secretProblem({ [SECRET_ENV]: "!!" }), "DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret");
});
