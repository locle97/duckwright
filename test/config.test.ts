import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { main } from "../src/cli.ts";
import type { AgentLike } from "../src/cli.ts";
import type { AgentOptions } from "../src/loop.ts";
import { TaskFileError } from "../src/taskfile.ts";
import { tmpDir } from "./helpers.ts";

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

function conf(tmp: string, text: string): string {
  const dir = path.join(tmp, "config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "duckwright.conf"), text);
  return dir;
}

test("a missing config folder is an empty config", () => {
  assert.deepEqual(loadConfig(path.join(tmpDir(), "config")), {});
});

test("config reads run settings and TUI options; paths resolve from the config folder", () => {
  const tmp = tmpDir();
  const dir = conf(tmp, "# defaults\nmodel: opus\nmax-steps: 7\nheaded: true  # watch it\nstate: auth.json\n"
    + "max-parallel: 2\npast: 0\ntheme: dark\n");
  assert.deepEqual(loadConfig(dir), {
    model: "opus", maxSteps: 7, headed: true, state: path.join(fs.realpathSync(dir), "auth.json"),
    maxParallel: 2, past: 0, theme: "dark",
  });
});

test("config rejects unknown keys, setup and allow-file-access with the line", () => {
  for (const key of ["colour: red", "setup: s.md", "allow-file-access: true", "theme: pink"]) {
    const dir = conf(tmpDir(), `model: opus\n${key}\n`);
    assert.throws(() => loadConfig(dir), (e) => e instanceof TaskFileError && /duckwright\.conf:2:/.test(e.message), key);
  }
});

function setup(confText: string) {
  const tmp = tmpDir();
  process.chdir(tmp);
  conf(tmp, confText);
  const skill = path.join(tmp, "SKILL.md");
  fs.writeFileSync(skill, "x");
  const err: string[] = [];
  const seen: AgentOptions[] = [];
  const deps = {
    which: (n: string) => "/usr/bin/" + n,
    createAgent: (o: AgentOptions): AgentLike => {
      seen.push(o);
      return { costUsd: 0, run: async () => ({ success: true, answer: "a", steps: 1, costUsd: 0, history: [] }) };
    },
    isTTY: () => false, stdout: () => {}, stderr: (l: string) => err.push(l), env: {},
  };
  return { tmp, skill, err, seen, deps };
}

test("config supplies defaults; task file and flags override them in turn", async () => {
  const s = setup("headed: true\nmax-steps: 7\n");
  assert.equal(await main(["-p", "task", "--skill", s.skill], s.deps), 0);
  assert.equal(s.seen[0].headed, true);
  assert.equal(s.seen[0].maxSteps, 7);

  fs.writeFileSync("t.md", "---\nmax-steps: 9\n---\ndo it\n");
  assert.equal(await main(["-p", "-f", "t.md", "--skill", s.skill, "--no-headed"], s.deps), 0);
  assert.equal(s.seen[1].headed, false);
  assert.equal(s.seen[1].maxSteps, 9);
});

test("an invalid config stops before anything runs", async () => {
  const s = setup("max-steps: lots\n");
  assert.equal(await main(["-p", "task", "--skill", s.skill], s.deps), 2);
  assert.match(s.err.join("\n"), /duckwright\.conf:1:/);
  assert.equal(s.seen.length, 0);
});

test("config TUI options do not trip the -p checks", async () => {
  const s = setup("theme: dark\npast: 5\nmax-parallel: 2\n");
  assert.equal(await main(["-p", "task", "--skill", s.skill], s.deps), 0);
});
