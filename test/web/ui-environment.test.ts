import assert from "node:assert/strict";
import { test } from "node:test";

import { accountBody, duplicateAccountWarning, envBody, envDraft, envOptions, envValue, shortPasswordWarning } from "../../web/src/environment.ts";

test("envValue shows none for no environment", () => {
  assert.equal(envValue(null), "none");
  assert.equal(envValue("qa"), "qa");
});

test("envDraft maps overrides to a select value", () => {
  assert.equal(envDraft({}), "");
  assert.equal(envDraft({ env: null }), "none");
  assert.equal(envDraft({ env: "qa" }), "qa");
});

test("envBody maps a select value to override fields", () => {
  assert.deepEqual(envBody(""), {});
  assert.deepEqual(envBody("none"), { env: null });
  assert.deepEqual(envBody("qa"), { env: "qa" });
});

test("envOptions lists inherit, none, names and an unlisted draft", () => {
  assert.deepEqual(envOptions(null, [], ""), [
    { value: "", label: "inherit (none)" },
    { value: "none", label: "none" },
  ]);
  assert.deepEqual(
    envOptions("staging", ["qa", "staging"], "old").map((o) => o.value),
    ["", "none", "qa", "staging", "old"],
  );
  assert.equal(envOptions("staging", ["qa", "staging"], "old")[0]?.label, "inherit (staging)");
});

const draft = { id: "admin", label: "Admin", role: "admin", username: "root", password: "", totpSecret: "", clearTotp: false };

test("account_body_omits_empty_secrets", () => {
  assert.deepEqual(accountBody(draft), { label: "Admin", role: "admin", username: "root" });
  assert.deepEqual(accountBody({ ...draft, password: "hunter22x" }), { label: "Admin", role: "admin", username: "root", password: "hunter22x" });
  assert.deepEqual(accountBody({ ...draft, totpSecret: "JBSW" }), { label: "Admin", role: "admin", username: "root", totpSecret: "JBSW" });
});

test("account_body_clear_totp_sends_null", () => {
  assert.equal(accountBody({ ...draft, clearTotp: true }).totpSecret, null);
  assert.equal(accountBody({ ...draft, clearTotp: true, totpSecret: "JBSW" }).totpSecret, null);
});

test("short_password_warns_under_8", () => {
  assert.equal(shortPasswordWarning(""), null);
  assert.match(shortPasswordWarning("abc") ?? "", /8/);
  assert.equal(shortPasswordWarning("12345678"), null);
});

test("duplicateAccountWarning flags an id already in the list only when adding", () => {
  assert.equal(duplicateAccountWarning("admin", ["admin", "user-e"], false), "An account admin already exists; edit it instead.");
  assert.equal(duplicateAccountWarning("admin", ["admin"], true), null);
  assert.equal(duplicateAccountWarning("other", ["admin"], false), null);
  assert.equal(duplicateAccountWarning("", [], false), null);
});
