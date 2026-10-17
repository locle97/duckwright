import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRunAccounts } from "../../src/accounts/runAccounts.ts";
import { AccountError, AccountStore } from "../../src/accounts/store.ts";
import { Scrubber } from "../../src/scrub.ts";
import { tmpDir } from "../helpers.ts";

const TOTP = "JBSWY3DPEHPK3PXP";

function seeded(over: { baseUrl?: string | null; loginOrigins?: string[] } = {}): string {
  const dir = tmpDir();
  const s = AccountStore.open(dir, { create: true });
  assert.ok(s);
  s.setEnvSettings({ name: "dev", baseUrl: over.baseUrl === undefined ? "https://dev.example.com/app" : over.baseUrl, loginOrigins: over.loginOrigins ?? ["https://sso.example.com"] });
  s.saveAccount({ env: "dev", id: "admin-c", label: "Admin C", role: "admin", username: "c@example.com", password: "pw-admin-c", totpSecret: TOTP });
  s.saveAccount({ env: "dev", id: "user-e", label: "User E", role: "", username: "e@example.com", password: "pw-user-e" });
  s.saveAccount({ env: "dev", id: "user-f", label: "User F", role: "member", username: "f@example.com", password: "pw-user-f" });
  s.close();
  return dir;
}

test("load_returns_null_without_db", () => {
  assert.equal(loadRunAccounts(tmpDir(), "dev", null), null);
  assert.equal(loadRunAccounts(tmpDir(), "dev", []), null);
});

test("load_returns_null_for_env_without_accounts", () => {
  assert.equal(loadRunAccounts(seeded(), "stage", null), null);
});

test("load_reads_accounts_and_origins", () => {
  const ra = loadRunAccounts(seeded(), "dev", null)!;
  assert.equal(ra.env, "dev");
  assert.deepEqual(ra.allowedOrigins, ["https://dev.example.com", "https://sso.example.com"]);
  assert.deepEqual(ra.get("user-e"), { username: "e@example.com", password: "pw-user-e" });
  assert.equal(ra.get("nope"), null);
  assert.equal(ra.totpSecret("admin-c"), TOTP);
  assert.equal(ra.totpSecret("user-e"), null);
});

test("allowed_origins_are_deduplicated", () => {
  const ra = loadRunAccounts(seeded({ loginOrigins: ["https://dev.example.com"] }), "dev", null)!;
  assert.deepEqual(ra.allowedOrigins, ["https://dev.example.com"]);
});

test("load_pins_narrow", () => {
  const ra = loadRunAccounts(seeded(), "dev", ["admin-c"])!;
  assert.equal(ra.has("admin-c"), true);
  assert.equal(ra.has("user-e"), false);
  assert.equal(ra.get("user-e"), null);
  assert.equal(ra.totpSecret("user-e"), null);
  const text = ra.promptText();
  assert.match(text, /admin-c/);
  assert.doesNotMatch(text, /user-e/);
});

test("load_unknown_pin_throws", () => {
  assert.throws(() => loadRunAccounts(seeded(), "dev", ["admin-c", "zz"]), (e: unknown) =>
    e instanceof AccountError && /environment 'dev' has no account 'zz'/.test(e.message));
  assert.throws(() => loadRunAccounts(tmpDir(), "dev", ["zz"]), /environment 'dev' has no account 'zz'/);
  assert.throws(() => loadRunAccounts(seeded(), "stage", ["zz"]), /environment 'stage' has no account 'zz'/);
});

test("load_without_base_url_throws", () => {
  assert.throws(() => loadRunAccounts(seeded({ baseUrl: null }), "dev", null), AccountError);
});

test("seed_adds_every_account_secret", () => {
  const ra = loadRunAccounts(seeded(), "dev", ["admin-c"])!;
  const s = new Scrubber();
  ra.seed(s);
  assert.equal(s.scrub("pw-user-e"), "[SECRET user-e.password]");
  assert.equal(s.scrub("pw-user-f"), "[SECRET user-f.password]");
  assert.equal(s.scrub(TOTP), "[REDACTED]");
});

test("prompt_text_has_no_secrets", () => {
  const text = loadRunAccounts(seeded(), "dev", null)!.promptText();
  assert.match(text, /- admin-c: Admin C \(admin\) — username c@example\.com — TOTP/);
  assert.match(text, /- user-e: User E — username e@example\.com$/m);
  assert.match(text, /user-f/);
  assert.match(text, /\{\{<id>\.username\}\}/);
  assert.match(text, /\{\{<id>\.password\}\}/);
  assert.match(text, /twofa totp <ref> <id>/);
  assert.match(text, /log out/i);
  assert.match(text, /not a login field/);
  for (const secret of ["pw-admin-c", "pw-user-e", "pw-user-f", TOTP]) assert.ok(!text.includes(secret));
});
