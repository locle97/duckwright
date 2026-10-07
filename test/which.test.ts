import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { quoteForCmd, which } from "../src/which.ts";
import { tmpDir } from "./helpers.ts";

test("which_finds_a_windows_command_through_pathext", { skip: process.platform !== "win32" }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "claude.cmd"), "");
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(which("claude", env, "win32"), path.join(dir, "claude.cmd"));
});

test("which_finds_a_posix_executable", () => {
  const dir = tmpDir();
  const p = path.join(dir, "tool");
  fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(which("tool", { PATH: dir }, "linux"), p);
});

test("quote_for_cmd_escapes_metacharacters", () => {
  assert.equal(quoteForCmd("a b"), '^^^"a^^^ b^^^"');
  assert.ok(!/[^^]&/.test(quoteForCmd('x&y"z')));
});
