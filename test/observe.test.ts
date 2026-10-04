import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { TRUNCATION_MARKER, observe, pasteSnapshot } from "../src/observe.ts";
import type { Observation } from "../src/observe.ts";
import type { ProcResult } from "../src/proc.ts";
import { PlaywrightCLI, PlaywrightError } from "../src/pw.ts";
import { tmpDir } from "./helpers.ts";

function makePw(snapshotText: string, tabs = "0: [current] Example", tabCode = 0): PlaywrightCLI {
  const runner = async (argv: string[]): Promise<ProcResult> => {
    const cmd = argv[2];
    if (cmd === "tab-list") {
      if (tabCode) return { code: tabCode, stdout: "", stderr: "tab boom" };
      return { code: 0, stdout: tabs, stderr: "" };
    }
    if (cmd === "snapshot") {
      const arg = argv.find((a) => a.startsWith("--filename="))!;
      fs.writeFileSync(arg.slice("--filename=".length), snapshotText);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return new PlaywrightCLI({ session: "t", runner });
}

test("observe_small_page", async () => {
  const obs = await observe(makePw("abc"), tmpDir());
  assert.equal(obs.truncated, false);
  assert.equal(obs.snapshot, "abc");
});

test("observe_truncates", async () => {
  const obs = await observe(makePw("x".repeat(50)), tmpDir(), 10);
  assert.equal(obs.snapshot, "x".repeat(10) + "\n…[snapshot truncated]");
  assert.equal(obs.truncated, true);
});

test("observe_exact_limit_not_truncated", async () => {
  const obs = await observe(makePw("x".repeat(10)), tmpDir(), 10);
  assert.equal(obs.snapshot, "x".repeat(10));
  assert.equal(obs.truncated, false);
});

test("observe_includes_tabs", async () => {
  const obs = await observe(makePw("abc"), tmpDir());
  assert.ok(obs.tabs.includes("0: [current] Example"));
});

test("observe_tab_list_failure", async () => {
  await assert.rejects(
    observe(makePw("abc", undefined, 1), tmpDir()),
    (e: Error) => e instanceof PlaywrightError && /tab boom/.test(e.message),
  );
});

test("observe_page_dir_holds_only_snapshot", async () => {
  const dir = tmpDir();
  await observe(makePw("a\nb\n"), dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, "page")), ["snapshot.yml"]);
  assert.equal(fs.existsSync(path.join(dir, "snapshot.yml")), false);
});

test("observe_counts_untruncated_size", async () => {
  const obs = await observe(makePw("x".repeat(50) + "\ny"), tmpDir(), 10);
  assert.deepEqual([obs.lines, obs.chars, obs.truncated], [2, 52, true]);
});

test("observe counts and truncates by code point", async () => {
  // 40_001 code points, 40_003 UTF-16 units
  const obs = await observe(makePw("a".repeat(39_999) + "😀😀"), tmpDir());
  assert.equal(obs.chars, 40_001);
  assert.equal(obs.snapshot, "a".repeat(39_999) + "😀" + TRUNCATION_MARKER);
});

test("paste_snapshot by mode", () => {
  const obs = (chars: number): Observation => ({ tabs: "", snapshot: "", truncated: false, lines: 1, chars });
  assert.equal(pasteSnapshot("full", obs(99_999)), true);
  assert.equal(pasteSnapshot("grep", obs(1)), false);
  assert.equal(pasteSnapshot("hybrid", obs(5_000)), true);
  assert.equal(pasteSnapshot("hybrid", obs(5_001)), false);
});
