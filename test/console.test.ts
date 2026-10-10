import assert from "node:assert/strict";
import { test } from "node:test";

import { CONSOLE_MESSAGE_MAX, CONSOLE_STEP_MAX, captureConsoleErrors, parseConsoleErrors, redactConsole } from "../src/console.ts";
import { AbortedError } from "../src/proc.ts";
import type { ProcResult } from "../src/proc.ts";
import type { PlaywrightCLI } from "../src/pw.ts";

function fakePw(fn: (cmd: string, args: string[]) => Promise<ProcResult>): { pw: PlaywrightCLI; calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  const pw = { run: (cmd: string, args: string[]) => { calls.push([cmd, args]); return fn(cmd, args); } } as unknown as PlaywrightCLI;
  return { pw, calls };
}

test("parse strips result header", () => {
  assert.deepEqual(parseConsoleErrors("### Result\n[ERROR] boom\n"), ["[ERROR] boom"]);
});

test("parse stops at next heading", () => {
  assert.deepEqual(parseConsoleErrors("### Result\none\ntwo\n### Events\nthree\n"), ["one", "two"]);
});

test("parse drops blank, continuation, total and returning lines", () => {
  const out = "### Result\nTotal messages: 3 (Errors: 2)\nReturning 2 messages\n\nfirst\n    at foo (a.js:1)\n\tat bar\nsecond\n";
  assert.deepEqual(parseConsoleErrors(out), ["first", "second"]);
});

test("parse clips to 500 code points", () => {
  const long = "\u{1F600}".repeat(600);
  const [m] = parseConsoleErrors(`### Result\n${long}\n`);
  assert.equal(CONSOLE_MESSAGE_MAX, 500);
  assert.equal(Array.from(m!).length, 500);
});

test("parse caps at 50 per step", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `m${i}`).join("\n");
  const got = parseConsoleErrors(`### Result\n${lines}\n`);
  assert.equal(CONSOLE_STEP_MAX, 50);
  assert.equal(got.length, 50);
  assert.equal(got[49], "m49");
});

test("redaction hides bearer token and url secrets", () => {
  assert.ok(!redactConsole("Authorization: Bearer abc123").includes("abc123"));
  assert.ok(!redactConsole("failed https://x.test/a?token=SECRET now").includes("SECRET"));
});

test("capture success", async () => {
  const { pw, calls } = fakePw(async () => ({ code: 0, stdout: "### Result\nAuthorization: Bearer abc123\n", stderr: "" }));
  const r = await captureConsoleErrors(pw);
  assert.deepEqual(calls, [["console", ["error"]]]);
  assert.equal(r.error, null);
  assert.equal(r.messages.length, 1);
  assert.ok(!r.messages[0]!.includes("abc123"));
});

test("capture non-zero exit uses stderr, then stdout, clipped to 300", async () => {
  let r = await captureConsoleErrors(fakePw(async () => ({ code: 1, stdout: "out", stderr: " bad \n" })).pw);
  assert.deepEqual(r, { messages: [], error: "bad" });
  r = await captureConsoleErrors(fakePw(async () => ({ code: 1, stdout: " only out\n", stderr: "" })).pw);
  assert.equal(r.error, "only out");
  r = await captureConsoleErrors(fakePw(async () => ({ code: 1, stdout: "", stderr: "x".repeat(400) })).pw);
  assert.equal(r.error!.length, 300);
});

test("capture thrown error becomes error; abort re-thrown", async () => {
  const r = await captureConsoleErrors(fakePw(async () => { throw new Error("kaput"); }).pw);
  assert.equal(r.error, "kaput");
  await assert.rejects(captureConsoleErrors(fakePw(async () => { throw new AbortedError(); }).pw), AbortedError);
});
