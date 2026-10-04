import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { Brain } from "../src/brain.ts";
import { PROMPTS } from "../src/cli.ts";
import { Agent } from "../src/loop.ts";
import { pageDir } from "../src/observe.ts";
import type { SnapshotMode } from "../src/observe.ts";
import { stepLine } from "../src/prompt.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import { ROOT, tmpDir } from "./helpers.ts";

test("missing_skill_exits", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "src", "bin.ts"), "x", "--skill", "/nope"], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("playwright-cli skill not found"));
});

const live = process.env.DUCKWRIGHT_E2E === "1";

for (const mode of ["full", "grep", "hybrid"] as const satisfies readonly SnapshotMode[]) {
  test(`e2e_form ${mode}`, { skip: !live && "set DUCKWRIGHT_E2E=1 to run live e2e" }, async () => {
    const tmp = tmpDir();
    const form = path.join(ROOT, "test", "fixtures", "form.html");
    const task = `Open file://${form}, enter the name Linh, submit, and report the greeting.`;
    const modeMd = { full: PROMPTS.snapshotFull, grep: PROMPTS.snapshotGrep, hybrid: PROMPTS.snapshotHybrid }[mode];
    const brain = new Brain({
      systemFiles: [PROMPTS.system, modeMd, PROMPTS.defaultSkill],
      snapshotDir: mode === "full" ? null : pageDir(tmp),
    });
    const pw = new PlaywrightCLI({ session: `duckwright-e2e-${mode}`, allowFileAccess: true });
    let result;
    try {
      result = await new Agent({
        task, pw, brain, workdir: tmp, maxSteps: 8, onStep: (r) => console.log(stepLine(r)),
        snapshotMode: mode,
      }).run();
    } finally {
      await pw.close();
    }
    console.log(`mode=${mode} steps=${result.steps} cost=$${result.costUsd.toFixed(4)} answer=${result.answer}`);
    assert.ok(result.success);
    assert.ok(result.answer.includes("Hello, Linh!"));
    assert.ok(result.steps <= 8);
    const codes = result.history.flatMap((r) => r.codes).filter((c): c is string => !!c);
    assert.ok(codes.some((c) => c.includes("page.goto(")));
    assert.ok(codes.some((c) => c.includes("Linh")));
    assert.ok(codes.some((c) => c.startsWith("await expect(") && c.includes("Hello, Linh!")));
  });
}
