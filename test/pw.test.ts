import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { ProcResult } from "../src/proc.ts";
import { PlaywrightCLI, PlaywrightError } from "../src/pw.ts";
import { fakeRunner, ok, tmpDir } from "./helpers.ts";

function writing(write: (argv: string[]) => void, result: ProcResult = ok()) {
  return fakeRunner((argv) => {
    write(argv);
    return result;
  });
}

function filenameArg(argv: string[]): string {
  return argv.find((a) => a.startsWith("--filename="))!.split("=").slice(1).join("=");
}

test("run_builds_argv", async () => {
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).run("click", ["e5"]);
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "click", "e5"]);
});

test("open_headed", async () => {
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).open(true);
  assert.deepEqual(fake.calls[0].argv.slice(-3), ["open", "about:blank", "--headed"]);
});

test("snapshot_reads_file", async () => {
  const p = path.join(tmpDir(), "snap.yml");
  const fake = writing((argv) => fs.writeFileSync(filenameArg(argv), '- button "Go" [ref=e1]'));
  assert.equal(await new PlaywrightCLI({ runner: fake }).snapshot(p), '- button "Go" [ref=e1]');
});

test("snapshot_failure_raises", async () => {
  const fake = fakeRunner({ code: 1, stdout: "", stderr: "boom" });
  await assert.rejects(
    new PlaywrightCLI({ runner: fake }).snapshot(path.join(tmpDir(), "s.yml")),
    (e: Error) => e instanceof PlaywrightError && /boom/.test(e.message),
  );
});

test("open_allow_file_access_prefixes_env", async () => {
  let fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).open(false);
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "open", "about:blank"]);
  fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake, allowFileAccess: true }).open(false);
  assert.deepEqual(fake.calls[0].argv, [
    "env",
    "PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1",
    "playwright-cli",
    "-s=t",
    "open",
    "about:blank",
  ]);
});

test("snapshot_reads_utf8_and_replaces_bad_bytes", async () => {
  const p = path.join(tmpDir(), "snap.yml");
  const fake = writing(() => fs.writeFileSync(p, Buffer.concat([Buffer.from("café "), Buffer.from([0xff])])));
  assert.equal(await new PlaywrightCLI({ runner: fake }).snapshot(p), "café \ufffd");
});

test("state_load_builds_argv", async () => {
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).stateLoad("/x/auth.json");
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "state-load", "/x/auth.json"]);
});

test("state_load_failure_raises", async () => {
  const fake = fakeRunner({ code: 1, stdout: "", stderr: "bad state" });
  await assert.rejects(
    new PlaywrightCLI({ runner: fake }).stateLoad("/x/auth.json"),
    (e: Error) => e instanceof PlaywrightError && /bad state/.test(e.message),
  );
});

test("commands carry the abort signal", async () => {
  const ac = new AbortController();
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ runner: fake, signal: ac.signal }).run("click", ["e1"]);
  assert.equal(fake.calls[0].signal, ac.signal);
});

test("close ignores the abort signal", async () => {
  const ac = new AbortController();
  ac.abort();
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake, signal: ac.signal }).close();
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "close"]);
  assert.equal(fake.calls[0].signal, undefined);
});

test("close never throws", async () => {
  const runner = async (): Promise<ProcResult> => { throw new Error("spawn failed"); };
  await new PlaywrightCLI({ runner }).close();
});

test("snapshot_uses_universal_newlines", async () => {
  const p = path.join(tmpDir(), "snap.yml");
  const fake = writing(() => fs.writeFileSync(p, "- a\r\n- b\r- c"));
  assert.equal(await new PlaywrightCLI({ runner: fake }).snapshot(p), "- a\n- b\n- c");
});
