import assert from "node:assert/strict";
import { test } from "node:test";

import { TotpSecretError, parseSecret, totpAt, totpNow } from "../src/totp.ts";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890", reduced to 6 digits.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const VECTORS: [number, string][] = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
  [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
];

test("rfc6238_vectors", () => {
  for (const [seconds, expected] of VECTORS) {
    assert.equal(totpNow(RFC_SECRET, seconds * 1000), expected, `t=${seconds}`);
  }
});

test("code_is_stable_inside_a_step_and_changes_after", () => {
  const key = parseSecret(RFC_SECRET);
  assert.equal(totpAt(key, 30_000), totpAt(key, 59_999));
  assert.notEqual(totpAt(key, 59_999), totpAt(key, 60_000));
});

test("secret_forms_are_equivalent", () => {
  const expected = totpNow(RFC_SECRET, 59_000);
  assert.equal(totpNow("gezd gnbv-gy3tqojq GEZDGNBVGY3TQOJQ====", 59_000), expected);
  assert.equal(totpNow(`  ${RFC_SECRET}\n`, 59_000), expected);
  assert.equal(totpNow(`otpauth://totp/Acme:linh?secret=${RFC_SECRET}&issuer=Acme`, 59_000), expected);
  assert.equal(totpNow(`OTPAUTH://TOTP/x?issuer=Acme&secret=${RFC_SECRET}`, 59_000), expected);
});

test("invalid_secrets_throw_without_quoting_the_input", () => {
  for (const bad of ["", "   ", "abc!def", "otpauth://totp/x?issuer=y", "otpauth://", "1890"]) {
    assert.throws(() => parseSecret(bad), (e: unknown) =>
      e instanceof TotpSecretError && e.message === "not a valid TOTP secret" && !e.message.includes(bad.trim() || "\0"));
  }
});
