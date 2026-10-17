import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { handleApi } from "../../src/web/api.ts";
import type { ApiContext, ApiResponse } from "../../src/web/api.ts";
import { createEnvironments } from "../../src/web/environments.ts";
import { RunManager } from "../../src/runs/manager.ts";
import { tmpDir } from "../helpers.ts";
import { FakeManager, snapshot } from "../tui/fake-manager.ts";

function setup() {
  const cwd = tmpDir();
  const m = new FakeManager([snapshot(1, "one")]);
  const ctx: ApiContext = {
    manager: m, maxParallel: 3, notices: [], theme: "dark", quit: () => {}, candidates: () => ({ items: [], truncated: false }),
    runs: () => [], environments: createEnvironments(cwd),
  };
  return { cwd, ctx };
}
const call = (ctx: ApiContext, method: string, url: string, body?: unknown): Promise<ApiResponse> => {
  const u = new URL(url, "http://x");
  return handleApi(ctx, { method, path: u.pathname, query: u.searchParams, body });
};
const ACCOUNT = { label: "Admin", role: "admin", username: "root", password: "hunter2-secret", totpSecret: "JBSWY3DPEHPK3PXP" };

async function withAccount() {
  const s = setup();
  await call(s.ctx, "POST", "/api/environments", { name: "dev", context: "" });
  await call(s.ctx, "PUT", "/api/environments/dev", { baseUrl: "https://dev.example.com", loginOrigins: [] });
  assert.equal((await call(s.ctx, "PUT", "/api/environments/dev/accounts/admin", ACCOUNT)).status, 200);
  return s;
}

test("list_never_returns_secrets", async () => {
  const { ctx } = await withAccount();
  for (const url of ["/api/environments", "/api/environments/dev"]) {
    const text = JSON.stringify(await call(ctx, "GET", url));
    assert.ok(!text.includes("hunter2-secret") && !text.includes("JBSWY3DPEHPK3PXP"));
    assert.ok(text.includes('"hasPassword":true') && text.includes('"hasTotp":true'));
  }
});

test("put_account_empty_password_keeps", async () => {
  const { ctx, cwd } = await withAccount();
  const r = await call(ctx, "PUT", "/api/environments/dev/accounts/admin", { ...ACCOUNT, label: "Boss", password: "", totpSecret: "" });
  assert.equal(r.status, 200);
  const { AccountStore } = await import("../../src/accounts/store.ts");
  const st = AccountStore.open(cwd, { create: false })!;
  const [a] = st.accounts("dev");
  st.close();
  assert.equal(a.label, "Boss");
  assert.equal(a.password, "hunter2-secret");
  assert.equal(a.totpSecret, "JBSWY3DPEHPK3PXP");
});

test("put_account_null_totp_clears", async () => {
  const { ctx } = await withAccount();
  await call(ctx, "PUT", "/api/environments/dev/accounts/admin", { ...ACCOUNT, password: undefined, totpSecret: null });
  const e = (await call(ctx, "GET", "/api/environments/dev")).body as { environment: { accounts: { hasTotp: boolean; hasPassword: boolean }[] } };
  assert.equal(e.environment.accounts[0].hasTotp, false);
  assert.equal(e.environment.accounts[0].hasPassword, true);
});

test("put_new_account_empty_password_400", async () => {
  const { ctx } = await withAccount();
  const r = await call(ctx, "PUT", "/api/environments/dev/accounts/other", { ...ACCOUNT, password: "" });
  assert.equal(r.status, 400);
  assert.equal((await call(ctx, "PUT", "/api/environments/dev/accounts/other", { label: 1 })).status, 400);
  assert.equal((await call(ctx, "PUT", "/api/environments/nope/accounts/x", ACCOUNT)).status, 404);
});

test("create_writes_md_and_conflicts_on_existing", async () => {
  const { ctx, cwd } = setup();
  assert.equal((await call(ctx, "POST", "/api/environments", { name: "dev", context: "" })).status, 200);
  assert.equal(fs.readFileSync(path.join(cwd, "environments", "dev.md"), "utf8"), "# dev\n");
  assert.equal((await call(ctx, "POST", "/api/environments", { name: "dev", context: "x" })).status, 409);
  const g = (await call(ctx, "GET", "/api/environments/dev")).body as { environment: { context: string } };
  assert.equal(g.environment.context, "# dev\n");
  assert.equal((await call(ctx, "GET", "/api/environments/zzz")).status, 404);
});

test("create_rejects_none_name", async () => {
  const { ctx } = setup();
  assert.equal((await call(ctx, "POST", "/api/environments", { name: "none", context: "x" })).status, 400);
  assert.equal((await call(ctx, "POST", "/api/environments", { name: "a/b", context: "x" })).status, 400);
});

test("remove_with_file_flag_deletes_md_only_then", async () => {
  const { ctx, cwd } = await withAccount();
  const md = path.join(cwd, "environments", "dev.md");
  assert.equal((await call(ctx, "DELETE", "/api/environments/dev")).status, 200);
  assert.ok(fs.existsSync(md));
  const e = (await call(ctx, "GET", "/api/environments/dev")).body as { environment: { baseUrl: unknown; accounts: unknown[] } };
  assert.equal(e.environment.baseUrl, null);
  assert.equal(e.environment.accounts.length, 0);
  assert.equal((await call(ctx, "DELETE", "/api/environments/dev?file=1")).status, 200);
  assert.ok(!fs.existsSync(md));
  assert.equal((await call(ctx, "DELETE", "/api/environments/dev?file=1")).status, 404);
});

test("context_over_16kb_400", async () => {
  const { ctx } = setup();
  assert.equal((await call(ctx, "POST", "/api/environments", { name: "big", context: "a".repeat(16385) })).status, 400);
  await call(ctx, "POST", "/api/environments", { name: "dev", context: "" });
  const r = await call(ctx, "PUT", "/api/environments/dev", { baseUrl: null, loginOrigins: [], context: "a".repeat(16385) });
  assert.equal(r.status, 400);
});

test("null_base_url_with_accounts_400", async () => {
  const { ctx } = await withAccount();
  const r = await call(ctx, "PUT", "/api/environments/dev", { baseUrl: null, loginOrigins: [] });
  assert.equal(r.status, 400);
  assert.equal((r.body as { error: string }).error, "environment 'dev' has accounts; it needs a base URL");
  assert.equal((await call(ctx, "DELETE", "/api/environments/dev/accounts/admin")).status, 200);
  assert.equal((await call(ctx, "DELETE", "/api/environments/dev/accounts/admin")).status, 404);
});

test("globals_environments_lists_new_env", async () => {
  const cwd = tmpDir();
  const manager = new RunManager({
    argv: [], defaultSkill: "skill.md", maxParallel: 1, preflight: () => null, cwd,
    startRun: () => { throw new Error("not used"); },
  });
  const ctx = { manager, maxParallel: 1, notices: [], theme: "dark", quit: () => {}, candidates: () => ({ items: [], truncated: false }),
    runs: () => [], environments: createEnvironments(cwd) } as ApiContext;
  assert.deepEqual(manager.globals().environments, []);
  await call(ctx, "POST", "/api/environments", { name: "dev", context: "" });
  assert.deepEqual(manager.globals().environments, ["dev"]);
});
