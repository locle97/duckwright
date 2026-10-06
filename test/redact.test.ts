import assert from "node:assert/strict";
import { test } from "node:test";

import { isSecretHeader, isSecretKey, redactBody, redactHeaders, redactText, redactUrl } from "../src/redact.ts";

test("secret_header_exact_names", () => {
  for (const n of ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "Authorization", "COOKIE"]) {
    assert.equal(isSecretHeader(n), true, n);
  }
});

test("secret_header_substrings", () => {
  for (const n of ["x-auth-token", "x-client-secret", "x-session-id", "x-my-api-key", "x-api_key", "x-apikey", "x-password", "x-csrf-token", "x-xsrf-token", ":authority", "x-author"]) {
    assert.equal(isSecretHeader(n), true, n);
  }
  for (const n of ["content-type", "accept", "user-agent"]) assert.equal(isSecretHeader(n), false, n);
});

test("secret_key_contains_and_equals", () => {
  for (const k of ["password", "user_password", "passwd", "client_secret", "access_token", "api-key", "apiKey", "csrf", "xsrfToken", "credentials", "private_key", "session_id", "cookie", "auth", "Authorization", "session", "sid", "pin", "OTP"]) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ["author", "user", "pinned", "sidebar", "sessions_count", "email"]) assert.equal(isSecretKey(k), false, k);
});

test("json_body_nested", () => {
  assert.equal(
    redactBody('{"user":"a","password":"hunter2","nested":{"token":"t1"},"list":[{"apiKey":123},{"pin":{"x":1}}]}', "application/json"),
    '{"user":"a","password":"[REDACTED]","nested":{"token":"[REDACTED]"},"list":[{"apiKey":"[REDACTED]"},{"pin":"[REDACTED]"}]}',
  );
});

test("json_body_unchanged_kept_byte_for_byte", () => {
  assert.equal(redactBody('{ "user" : "a" }', "application/json"), '{ "user" : "a" }');
});

test("json_body_invalid_is_text", () => {
  assert.equal(redactBody('{"password": "x"', "application/json"), '{"password": "x"');
  assert.equal(redactBody("{bad Bearer abc123", "application/json"), "{bad Bearer [REDACTED]");
});

test("json_scalar_not_walked", () => {
  assert.equal(redactBody('"password"', "application/json"), '"password"');
  assert.equal(redactBody("42", "application/json"), "42");
});

test("form_body", () => {
  assert.equal(
    redactBody("user=a&password=hunter2&x=%41", "application/x-www-form-urlencoded; charset=UTF-8"),
    "user=a&password=[REDACTED]&x=%41",
  );
  assert.equal(
    redactBody("my+token=1&pass%77ord=2&%E0%A4%A=3&flag", "application/x-www-form-urlencoded"),
    "my+token=[REDACTED]&pass%77ord=[REDACTED]&%E0%A4%A=3&flag",
  );
});

test("form_rule_needs_content_type", () => {
  assert.equal(redactBody("password=x", null), "password=x");
  assert.equal(redactBody("password=x", "text/plain"), "password=x");
});

test("url_query", () => {
  assert.equal(redactUrl("https://h/p?token=abc&q=1#frag?password=x"), "https://h/p?token=[REDACTED]&q=1#frag?password=x");
  assert.equal(redactUrl("https://h/p"), "https://h/p");
  assert.equal(redactUrl("https://h/p#a?token=1"), "https://h/p#a?token=1");
});

test("bearer", () => {
  assert.equal(redactText("Authorization: Bearer abc123"), "Authorization: Bearer [REDACTED]");
  assert.equal(redactText("bearer eyJ.a-b_c~d+e/f=="), "bearer [REDACTED]");
  assert.equal(redactText("BEARER x"), "BEARER [REDACTED]");
  assert.equal(redactText("a bearer"), "a bearer");
});

test("basic", () => {
  assert.equal(redactText("Basic dXNlcjpwYXNz"), "Basic [REDACTED]");
  assert.equal(redactText("basic Plan"), "basic Plan");
  assert.equal(redactText("Basic Plan includes"), "Basic Plan includes");
  assert.equal(redactText("Basic aGVsbG8="), "Basic aGVsbG8=");
});

test("headers", () => {
  const input = [
    { name: "Authorization", value: "Bearer x" },
    { name: "X-Trace", value: "Bearer abc" },
    { name: "Referer", value: "https://h/?sid=9&a=1" },
    { name: "location", value: "/next?token=z" },
    { name: "Accept", value: "*/*" },
    { name: "accept", value: "x" },
  ];
  const copy = structuredClone(input);
  const out = redactHeaders(input);
  assert.deepEqual(out.map((h) => h.value), ["[REDACTED]", "Bearer [REDACTED]", "https://h/?sid=[REDACTED]&a=1", "/next?token=[REDACTED]", "*/*", "x"]);
  assert.deepEqual(out.map((h) => h.name), input.map((h) => h.name));
  assert.deepEqual(input, copy);
});
