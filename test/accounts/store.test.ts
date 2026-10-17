import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { AccountError, AccountStore, envVarBase } from "../../src/accounts/store.ts";
import { openDatabase } from "../../src/accounts/sqlite.ts";
import { tmpDir } from "../helpers.ts";

function open(): AccountStore {
  const s = AccountStore.open(tmpDir(), { create: true });
  assert.ok(s);
  return s;
}

function withEnv(s: AccountStore, name = "dev"): void {
  s.setEnvSettings({ name, baseUrl: "https://dev.example.com", loginOrigins: [] });
}

const ADMIN = {
  env: "dev", id: "admin-c", label: "Admin C", role: "admin", username: "c@example.com",
  password: "pw-123456", totpSecret: "JBSWY3DPEHPK3PXP",
};

test("open_without_create_returns_null_and_creates_nothing", () => {
  const dir = tmpDir();
  assert.equal(AccountStore.open(dir, { create: false }), null);
  assert.ok(!fs.existsSync(path.join(dir, ".duckwright")));
});

test("create_writes_self_ignoring_folder", () => {
  const dir = tmpDir();
  const s = AccountStore.open(dir, { create: true });
  assert.ok(s);
  s.close();
  assert.equal(fs.readFileSync(path.join(dir, ".duckwright/local/.gitignore"), "utf8"), "*\n");
  assert.ok(fs.existsSync(path.join(dir, ".duckwright/local/duckwright.db")));
  const again = AccountStore.open(dir, { create: false });
  assert.ok(again);
  again.close();
});

test("user_version_is_1", async () => {
  const dir = tmpDir();
  AccountStore.open(dir, { create: true })?.close();
  const { openDatabase } = await import("../../src/accounts/sqlite.ts");
  const db = openDatabase(path.join(dir, ".duckwright/local/duckwright.db"));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  db.close();
});

test("save_and_read_account_round_trip", () => {
  const s = open();
  s.setEnvSettings({ name: "dev", baseUrl: "https://dev.example.com", loginOrigins: [] });
  s.saveAccount(ADMIN);
  assert.deepEqual(s.accounts("dev")[0], ADMIN);
  const sum = s.summaries("dev")[0] as Record<string, unknown>;
  assert.equal(sum.hasPassword, true);
  assert.equal(sum.hasTotp, true);
  assert.ok(!("password" in sum) && !("totpSecret" in sum));
  assert.equal(s.envSettings("dev").baseUrl, "https://dev.example.com");
  s.close();
});

test("save_keeps_secrets_when_omitted_and_clears_totp_on_null", () => {
  const s = open();
  withEnv(s);
  s.saveAccount(ADMIN);
  s.saveAccount({ env: "dev", id: "admin-c", label: "Renamed", role: "admin", username: "c@example.com" });
  assert.deepEqual(s.accounts("dev")[0], { ...ADMIN, label: "Renamed" });
  s.saveAccount({ env: "dev", id: "admin-c", label: "Renamed", role: "admin", username: "c@example.com", totpSecret: null });
  assert.equal(s.accounts("dev")[0].totpSecret, null);
  assert.equal(s.accounts("dev")[0].password, "pw-123456");
  s.close();
});

test("new_account_needs_password", () => {
  const s = open();
  withEnv(s);
  assert.throws(() => s.saveAccount({ ...ADMIN, password: undefined }), AccountError);
  assert.throws(() => s.saveAccount({ ...ADMIN, password: "" }), AccountError);
  s.close();
});

test("bad_id_rejected", () => {
  const s = open();
  withEnv(s);
  for (const id of ["Admin", "-a", "a_b"]) assert.throws(() => s.saveAccount({ ...ADMIN, id }), AccountError);
  s.close();
});

test("bad_env_name_rejected", () => {
  const s = open();
  assert.throws(() => s.setEnvSettings({ name: "none", baseUrl: "https://x.test", loginOrigins: [] }), AccountError);
  assert.throws(() => s.setEnvSettings({ name: "a/b", baseUrl: "https://x.test", loginOrigins: [] }), AccountError);
  s.close();
});

test("bad_totp_rejected", () => {
  const s = open();
  withEnv(s);
  assert.throws(() => s.saveAccount({ ...ADMIN, totpSecret: "not base32!" }), AccountError);
  s.close();
});

test("account_needs_base_url", () => {
  const s = open();
  assert.throws(() => s.saveAccount(ADMIN), AccountError);
  s.setEnvSettings({ name: "dev", baseUrl: null, loginOrigins: [] });
  assert.throws(() => s.saveAccount(ADMIN), AccountError);
  s.close();
});

test("base_url_must_be_http", () => {
  const s = open();
  assert.throws(() => s.setEnvSettings({ name: "dev", baseUrl: "ftp://x", loginOrigins: [] }), AccountError);
  assert.throws(() => s.setEnvSettings({ name: "dev", baseUrl: "nonsense", loginOrigins: [] }), AccountError);
  s.close();
});

test("login_origins_are_normalised_and_validated", () => {
  const s = open();
  s.setEnvSettings({ name: "dev", baseUrl: null, loginOrigins: ["https://sso.example.com/path?x=1"] });
  assert.deepEqual(s.envSettings("dev").loginOrigins, ["https://sso.example.com"]);
  assert.throws(() => s.setEnvSettings({ name: "dev", baseUrl: null, loginOrigins: ["ftp://x"] }), AccountError);
  s.close();
});

test("env_var_collision_rejected", () => {
  const s = open();
  withEnv(s, "dev-1");
  withEnv(s, "dev");
  s.saveAccount({ ...ADMIN, env: "dev-1", id: "a" });
  assert.throws(() => s.saveAccount({ ...ADMIN, env: "dev", id: "1-a" }), AccountError);
  s.saveAccount({ ...ADMIN, env: "dev-1", id: "a", label: "again" });
  s.close();
});

test("remove_account_reports_whether_it_existed", () => {
  const s = open();
  withEnv(s);
  s.saveAccount(ADMIN);
  assert.equal(s.removeAccount("dev", "admin-c"), true);
  assert.equal(s.removeAccount("dev", "admin-c"), false);
  s.close();
});

test("remove_env_drops_rows", () => {
  const s = open();
  withEnv(s);
  s.saveAccount(ADMIN);
  s.removeEnv("dev");
  assert.deepEqual(s.accounts("dev"), []);
  assert.equal(s.envSettings("dev").baseUrl, null);
  s.close();
});

test("env_var_base_folds_punctuation", () => {
  assert.equal(envVarBase("stage.eu", "user-e"), "DW_STAGE_EU_USER_E");
  assert.equal(envVarBase("dev", "admin-c"), "DW_DEV_ADMIN_C");
});

test("unreadable_database_is_an_account_error", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, ".duckwright", "local"), { recursive: true });
  const file = path.join(dir, ".duckwright", "local", "duckwright.db");
  fs.writeFileSync(file, "garbage, not a database\n".repeat(50));
  for (const create of [false, true]) {
    assert.throws(() => AccountStore.open(dir, { create }), (e: unknown) =>
      e instanceof AccountError && e.message.startsWith(`account database unreadable: ${file}: `));
  }
});

test("corrupt_login_origins_is_an_account_error", () => {
  const dir = tmpDir();
  const s = AccountStore.open(dir, { create: true })!;
  s.setEnvSettings({ name: "dev", baseUrl: "https://dev.example.com", loginOrigins: [] });
  s.close();
  const db = openDatabase(path.join(dir, ".duckwright", "local", "duckwright.db"));
  db.exec("UPDATE environments SET login_origins = '{oops'");
  db.close();
  const t = AccountStore.open(dir, { create: false })!;
  assert.throws(() => t.envSettings("dev"), (e: unknown) => e instanceof AccountError && /account database unreadable: .*duckwright\.db: /.test(e.message));
  t.close();
});
