import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ROOT } from "./helpers.ts";

const LEGACY = ["pw_agent", "pw-agent", "PW_AGENT", "playwright-agent-loop", "playwright_agent_loop"];
// Lines that must mention the old name on purpose (migration instructions).
const ALLOWED = ["Upgrading from `pw_agent`", "pipx uninstall playwright-agent-loop"];
const SKIP_DIRS = new Set([
  ".git", "docs", "build", "dist", ".pytest_cache", "runs", "__pycache__", "node_modules", "legacy",
]);
const SELF = path.join(ROOT, "test", "naming.test.ts");

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.endsWith(".egg-info")) yield* files(p);
    } else if (entry.isFile() && p !== SELF) {
      yield p;
    }
  }
}

test("no_legacy_name", () => {
  const hits: string[] = [];
  for (const p of files(ROOT)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (LEGACY.some((t) => line.includes(t)) && !ALLOWED.some((a) => line.includes(a))) {
        hits.push(`${path.relative(ROOT, p)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});
