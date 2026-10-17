import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountStore } from "../../src/accounts/store.ts";
import { projectScrubber } from "../../src/chat/secrets.ts";
import { secretMarker } from "../../src/scrub.ts";
import { tmpDir } from "../helpers.ts";

test("masks every environment's account passwords and TOTP secrets, and DUCKWRIGHT_TOTP_SECRET", () => {
  const root = tmpDir();
  const store = AccountStore.open(root, { create: true })!;
  for (const env of ["dev", "staging"]) store.setEnvSettings({ name: env, baseUrl: "https://app.test", loginOrigins: [] });
  store.saveAccount({ env: "dev", id: "admin", label: "Admin", role: "", username: "a", password: "devpass123", totpSecret: "JBSWY3DPEHPK3PXP" });
  store.saveAccount({ env: "staging", id: "buyer", label: "Buyer", role: "", username: "b", password: "stagepass9" });
  store.close();
  const s = projectScrubber(root, { DUCKWRIGHT_TOTP_SECRET: "GEZDGNBVGY3TQOJQ" });
  assert.equal(s.scrub("devpass123 stagepass9 JBSWY3DPEHPK3PXP GEZDGNBVGY3TQOJQ"),
    `${secretMarker("admin")} ${secretMarker("buyer")} [REDACTED] [REDACTED]`);
  assert.equal(s.scrub("{{admin.password}}"), "{{admin.password}}");
});

test("no database and no env: masks nothing", () => {
  assert.equal(projectScrubber(tmpDir(), {}).empty, true);
});
