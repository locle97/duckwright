import assert from "node:assert/strict";
import { test } from "node:test";

import { key } from "../../src/tui/keypress.ts";
import { twofaKey } from "../../src/tui/twofaInput.ts";

test("typing_appends_and_backspace_removes", () => {
  assert.deepEqual(twofaKey("sms", "12", key("3")), { buffer: "123" });
  assert.deepEqual(twofaKey("sms", "123", key("backspace")), { buffer: "12" });
  assert.deepEqual(twofaKey("sms", "", key("backspace")), { buffer: "" });
});

test("a_paste_keeps_printable_characters_only", () => {
  assert.deepEqual(twofaKey("totp", "", { ...key("x"), input: "GEZD\n GNBV\x1b" }), { buffer: "GEZD GNBV" });
});

test("return_submits_a_trimmed_non_empty_code_and_ignores_an_empty_one", () => {
  assert.deepEqual(twofaKey("sms", " 123456 ", key("return")), { answer: "123456" });
  assert.deepEqual(twofaKey("sms", "  ", key("return")), { buffer: "  " });
});

test("escape_cancels", () => {
  assert.deepEqual(twofaKey("email", "12", key("escape")), { answer: null });
  assert.deepEqual(twofaKey("passkey", "", key("escape")), { answer: null });
});

test("passkey_takes_y_or_return_to_approve_and_n_to_cancel", () => {
  assert.deepEqual(twofaKey("passkey", "", key("y")), { answer: "" });
  assert.deepEqual(twofaKey("passkey", "", key("return")), { answer: "" });
  assert.deepEqual(twofaKey("passkey", "", key("n")), { answer: null });
  assert.deepEqual(twofaKey("passkey", "", key("x")), { buffer: "" });
});

test("control_keys_are_ignored", () => {
  assert.deepEqual(twofaKey("sms", "1", key("ctrl+a")), { buffer: "1" });
  assert.deepEqual(twofaKey("sms", "1", key("up")), { buffer: "1" });
});
