import assert from "node:assert/strict";
import { test } from "node:test";

import { findRefs, substitute, type Resolver } from "../../src/accounts/placeholders.ts";

const DEV = "https://dev.example.com";
const r: Resolver = {
  get: (id) => (id === "a" ? { username: "alice", password: "pw" } : null),
  allowedOrigins: [DEV],
};

test("arg_without_braces_untouched", () => {
  const args = ["plain", "x"];
  const out = substitute(args, r, DEV);
  assert.deepEqual(out, { args: ["plain", "x"], used: [] });
});

test("username_embedded", () => {
  const out = substitute(["{{a.username}}@x"], r, DEV);
  assert.deepEqual(out, { args: ["alice@x"], used: [{ id: "a", field: "username" }] });
});

test("password_whole_arg", () => {
  const out = substitute(["{{a.password}}"], r, DEV);
  assert.deepEqual(out, { args: ["pw"], used: [{ id: "a", field: "password" }] });
});

test("password_embedded_rejected", () => {
  const out = substitute(["x{{a.password}}"], r, DEV);
  assert.ok("error" in out);
  assert.match(out.error, /whole argument/);
  assert.ok(out.error.startsWith("error: "));
});

test("password_wrong_origin_rejected", () => {
  const out = substitute(["{{a.password}}"], r, "https://evil.test");
  assert.ok("error" in out);
  assert.ok(out.error.includes("https://evil.test"));
});

test("password_null_origin_rejected", () => {
  const out = substitute(["{{a.password}}"], r, null);
  assert.ok("error" in out);
  assert.match(out.error, /no page origin/);
});

test("unknown_id", () => {
  const out = substitute(["{{zz.username}}"], r, DEV);
  assert.ok("error" in out);
  assert.match(out.error, /no account 'zz'/);
});

test("no_accounts_in_run", () => {
  const out = substitute(["{{a.username}}"], null, DEV);
  assert.ok("error" in out);
  assert.match(out.error, /no accounts/);
});

test("username_any_origin_ok", () => {
  for (const origin of [null, "https://evil.test"]) {
    const out = substitute(["{{a.username}}"], r, origin);
    assert.deepEqual(out, { args: ["alice"], used: [{ id: "a", field: "username" }] });
  }
});

test("non_grammar_text_left_untouched_and_input_not_mutated", () => {
  const args = ["{{foo}}", "{{a.email}}"];
  const out = substitute(args, null, null);
  assert.deepEqual(out, { args: ["{{foo}}", "{{a.email}}"], used: [] });
  assert.deepEqual(findRefs("{{a.username}}{{b.password}}"), [
    { id: "a", field: "username" },
    { id: "b", field: "password" },
  ]);
});
