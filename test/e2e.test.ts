import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";

import { Brain } from "../src/brain.ts";
import { PROMPTS } from "../src/cli.ts";
import { Agent } from "../src/loop.ts";
import { pageDir } from "../src/observe.ts";
import type { SnapshotMode } from "../src/observe.ts";
import { stepLine } from "../src/prompt.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import { runRequest } from "../src/request.ts";
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

test("e2e_request_probe", { skip: !live && "set DUCKWRIGHT_E2E=1 to run live e2e" }, async () => {
  // Probe for spec D12: does page.request traffic appear in `playwright-cli requests`? And do
  // cookies and maxRedirects: 0 work through run-code?
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=abc; Path=/" });
      res.end("<title>probe</title><script>fetch('/api/items',{method:'POST'})</script>ok");
    } else if (req.url === "/api/items") {
      const authed = (req.headers.cookie ?? "").includes("sid=abc");
      res.writeHead(authed ? 201 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 7, token: "secret" }));
    } else if (req.url === "/old") {
      res.writeHead(302, { location: "https://evil.example.net/login" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const pw = new PlaywrightCLI({ session: `probe-${process.pid}` });
  try {
    assert.equal((await pw.open(false)).code, 0);
    assert.equal((await pw.run("goto", [origin + "/"])).code, 0);
    const ctx = { seen: [{ id: "0001", method: "POST", url: origin + "/api/items", status: 201, statusText: "Created", type: "fetch", durationMs: 1 }], origin };
    const [ok201] = await runRequest(pw, ctx, ["POST", "/api/items", "{}", "201"]);
    assert.equal(ok201, 'ok 201 {"id":7,"token":"[REDACTED]"}');
    const ctx302 = { seen: [{ ...ctx.seen[0], method: "GET", url: origin + "/old" }], origin };
    const [r302] = await runRequest(pw, ctx302, ["GET", "/old"]);
    assert.equal(r302, "ok 302 (redirect to /login)");
    // Record whether the harness's own call shows up in the capture (spec D12).
    const listed = await pw.run("requests", []);
    console.log("requests after page.request calls:\n" + listed.stdout);
  } finally {
    await pw.close();
    server.close();
  }
});
