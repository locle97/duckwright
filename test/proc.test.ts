import assert from "node:assert/strict";
import { test } from "node:test";

import { AbortedError, runProcess } from "../src/proc.ts";
import { tmpDir } from "./helpers.ts";

test("run_process_uses_utf8_replace", async () => {
  const r = await runProcess(
    ["node", "-e", "process.stdout.write('o'); process.stderr.write('e')"], null, 10,
  );
  assert.deepEqual(r, { code: 0, stdout: "o", stderr: "e" });
});

test("run_process_never_uses_a_shell", async () => {
  const r = await runProcess(["node", "-e", "process.stdout.write(process.argv[1])", "$HOME;x"], null, 10);
  assert.equal(r.stdout, "$HOME;x");
});

test("run_process_decodes_bad_bytes", async () => {
  const r = await runProcess(
    ["node", "-e", "process.stdout.write(Buffer.from([0x61, 0xff, 0x62]))"], null, 10,
  );
  assert.equal(r.stdout, "a�b");
});

test("run_process_passes_cwd", async () => {
  const dir = tmpDir();
  const r = await runProcess(["node", "-e", "process.stdout.write(process.cwd())"], null, 10, { cwd: dir });
  assert.equal(r.stdout, dir);
  const here = await runProcess(["node", "-e", "process.stdout.write(process.cwd())"], null, 10);
  assert.equal(here.stdout, process.cwd());
});

test("run_process_reports_exit_code", async () => {
  const r = await runProcess(["node", "-e", "process.exit(3)"], null, 10);
  assert.equal(r.code, 3);
});

test("runProcess times out with code -1", async () => {
  const r = await runProcess(["node", "-e", "setTimeout(()=>{}, 5000)"], null, 0.2);
  assert.deepEqual(r, { code: -1, stdout: "", stderr: "timeout" });
});

test("runProcess rejects with AbortedError when aborted", async () => {
  const ac = new AbortController();
  const p = runProcess(["node", "-e", "setTimeout(()=>{}, 5000)"], null, 10, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, AbortedError);
});

test("runProcess rejects at once when already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runProcess(["node", "-e", ""], null, 10, { signal: ac.signal }), AbortedError);
});

test("runProcess rejects on spawn failure", async () => {
  await assert.rejects(runProcess(["duckwright-no-such-binary"], null, 5), /ENOENT/);
});

test("runProcess passes stdin and closes it", async () => {
  const r = await runProcess(["node", "-e", "process.stdin.pipe(process.stdout)"], "héllo", 5);
  assert.equal(r.stdout, "héllo");
});

test("runProcess gives no stdin when stdin is null", async () => {
  const r = await runProcess(
    ["node", "-e", "let n=0; process.stdin.on('data', d => n += d.length).on('end', () => process.stdout.write(String(n)))"],
    null, 5,
  );
  assert.equal(r.stdout, "0");
});
