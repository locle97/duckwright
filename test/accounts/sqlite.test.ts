import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { ROOT } from "../helpers.ts";

test("no_experimental_warning_on_stderr", () => {
  const mod = path.join(ROOT, "src/accounts/sqlite.ts");
  const script = `import { openDatabase } from ${JSON.stringify(mod)}; const db = openDatabase(":memory:"); db.exec("select 1"); db.close();`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});
