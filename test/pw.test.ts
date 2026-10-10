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

test("screenshot_argv", async () => {
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).screenshot("/x/s.png");
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "screenshot", "--filename=/x/s.png"]);
});

test("video_start_argv", async () => {
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).videoStart("/x/video.webm");
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "video-start", "/x/video.webm"]);
});

test("video_stop_no_signal_60s", async () => {
  const fake = fakeRunner(ok());
  const ac = new AbortController();
  await new PlaywrightCLI({ session: "t", runner: fake, signal: ac.signal }).videoStop();
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "video-stop"]);
  assert.equal(fake.calls[0].timeoutSec, 60);
  assert.equal(fake.calls[0].signal, undefined);
});

test("evidence_commands_throw_on_nonzero", async () => {
  const cmds: Array<(p: PlaywrightCLI) => Promise<void>> = [
    (p) => p.screenshot("/x/s.png"),
    (p) => p.videoStart("/x/v.webm"),
    (p) => p.videoStop(),
  ];
  for (const cmd of cmds) {
    await assert.rejects(
      cmd(new PlaywrightCLI({ runner: fakeRunner({ code: 1, stdout: "", stderr: "boom" }) })),
      (e: Error) => e instanceof PlaywrightError && e.message === "boom",
    );
    await assert.rejects(
      cmd(new PlaywrightCLI({ runner: fakeRunner({ code: 3, stdout: "", stderr: "" }) })),
      (e: Error) => e instanceof PlaywrightError && e.message === "exit 3",
    );
  }
});

test("state_save_argv", async () => {
  const fake = fakeRunner(ok());
  await new PlaywrightCLI({ session: "t", runner: fake }).stateSave("/tmp/s.json");
  assert.deepEqual(fake.calls[0].argv, ["playwright-cli", "-s=t", "state-save", "/tmp/s.json"]);
});

test("state_save_failure_raises", async () => {
  const fake = fakeRunner({ code: 1, stdout: "out", stderr: "nope" });
  await assert.rejects(
    new PlaywrightCLI({ runner: fake }).stateSave("/tmp/s.json"),
    (e: Error) => e instanceof PlaywrightError && e.message === "nope",
  );
});
