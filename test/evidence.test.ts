import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  screenshotName, screenshotRel, startVideo, stopVideo, takeScreenshot,
} from "../src/evidence.ts";
import { AbortedError } from "../src/proc.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import { fakeRunner, ok, tmpDir } from "./helpers.ts";

function filenameArg(argv: string[]): string {
  return argv.find((a) => a.startsWith("--filename="))!.split("=").slice(1).join("=");
}

test("screenshot_name", () => {
  assert.equal(screenshotName(1), "step-001.png");
  assert.equal(screenshotName(1000), "step-1000.png");
  assert.equal(screenshotRel(12), "screenshots/step-012.png");
});

test("take_screenshot_success", async () => {
  const dir = tmpDir();
  const pw = new PlaywrightCLI({
    runner: fakeRunner((argv) => {
      fs.writeFileSync(filenameArg(argv), "png");
      return ok();
    }),
  });
  assert.deepEqual(await takeScreenshot(pw, dir, 1), { rel: "screenshots/step-001.png" });
  assert.ok(fs.existsSync(path.join(dir, "screenshots", "step-001.png")));
});

test("take_screenshot_nonzero_exit", async () => {
  const pw = new PlaywrightCLI({ runner: fakeRunner({ code: 1, stdout: "", stderr: "line one\nline two" }) });
  assert.deepEqual(await takeScreenshot(pw, tmpDir(), 1), { error: "line one" });
  const long = new PlaywrightCLI({ runner: fakeRunner({ code: 1, stdout: "", stderr: "x".repeat(300) }) });
  const res = await takeScreenshot(long, tmpDir(), 1);
  assert.ok("error" in res && res.error.length === 200);
});

test("take_screenshot_missing_file", async () => {
  const pw = new PlaywrightCLI({ runner: fakeRunner(ok()) });
  assert.deepEqual(await takeScreenshot(pw, tmpDir(), 1), { error: "no file was written" });
});

test("take_screenshot_mkdir_failure", async () => {
  const file = path.join(tmpDir(), "f");
  fs.writeFileSync(file, "x");
  const pw = new PlaywrightCLI({ runner: fakeRunner(ok()) });
  const res = await takeScreenshot(pw, file, 1);
  assert.ok("error" in res && /ENOTDIR|EEXIST/.test(res.error));
});

test("take_screenshot_abort_rethrows", async () => {
  const thrower = new PlaywrightCLI({
    runner: fakeRunner(() => {
      throw new AbortedError();
    }),
  });
  await assert.rejects(takeScreenshot(thrower, tmpDir(), 1), AbortedError);
  const ac = new AbortController();
  ac.abort();
  const failing = new PlaywrightCLI({ runner: fakeRunner({ code: 1, stdout: "", stderr: "x" }), signal: ac.signal });
  await assert.rejects(takeScreenshot(failing, tmpDir(), 1, ac.signal), AbortedError);
});

test("start_video_failure", async () => {
  const bad = new PlaywrightCLI({ runner: fakeRunner({ code: 1, stdout: "", stderr: "no ffmpeg" }) });
  assert.equal(await startVideo(bad, tmpDir()), "video failed to start: no ffmpeg");
  assert.equal(await startVideo(new PlaywrightCLI({ runner: fakeRunner(ok()) }), tmpDir()), null);
});

test("stop_video_cases", async () => {
  const stuck = new PlaywrightCLI({ runner: fakeRunner({ code: 1, stdout: "", stderr: "stuck" }) });
  assert.deepEqual(await stopVideo(stuck, tmpDir()), { video: null, warning: "video failed to stop: stuck" });

  const missing = "video was not saved: video.webm is missing or empty";
  const pw = new PlaywrightCLI({ runner: fakeRunner(ok()) });
  assert.deepEqual(await stopVideo(pw, tmpDir()), { video: null, warning: missing });
  const empty = tmpDir();
  fs.writeFileSync(path.join(empty, "video.webm"), "");
  assert.deepEqual(await stopVideo(pw, empty), { video: null, warning: missing });
  const full = tmpDir();
  fs.writeFileSync(path.join(full, "video.webm"), "data");
  assert.deepEqual(await stopVideo(pw, full), { video: "video.webm", warning: null });
});
