import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { DEFAULT_CONFIG, configDir, initConfig, loadConfig } from "../src/config.ts";
import { main } from "../src/cli.ts";
import type { AgentLike } from "../src/cli.ts";
import type { AgentOptions } from "../src/loop.ts";
import { TaskFileError } from "../src/taskfile.ts";
import { tmpDir } from "./helpers.ts";

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

function conf(tmp: string, text: string): string {
  const dir = path.join(tmp, "userconf");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "duckwright.conf"), text);
  return dir;
}

test("a missing config folder is an empty config", () => {
  assert.deepEqual(loadConfig(path.join(tmpDir(), "userconf")), {});
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

test("configDir follows XDG on unix and APPDATA on Windows", () => {
  assert.equal(configDir({}, "linux", "/home/u"), "/home/u/.config/duckwright");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/x" }, "darwin", "/Users/u"), "/x/duckwright");
  assert.equal(configDir({ XDG_CONFIG_HOME: "rel" }, "linux", "/home/u"), "/home/u/.config/duckwright");
  assert.equal(configDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Roaming\\duckwright");
  assert.equal(configDir({}, "win32", "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Roaming\\duckwright");
});

function setup(confText: string) {
  const tmp = tmpDir();
  process.chdir(tmp);
  const dir = conf(tmp, confText);
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
    loadConfig: () => loadConfig(dir), isTTY: () => false, stdout: () => {}, stderr: (l: string) => err.push(l), env: {},
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

test("init writes the default config once and never overwrites it", async () => {
  const dir = path.join(tmpDir(), "new", "duckwright");
  assert.deepEqual(initConfig(dir), { file: path.join(dir, "duckwright.conf"), created: true });
  assert.equal(fs.readFileSync(path.join(dir, "duckwright.conf"), "utf8"), DEFAULT_CONFIG);
  assert.deepEqual(loadConfig(dir), {});
  fs.writeFileSync(path.join(dir, "duckwright.conf"), "model: opus\n");
  assert.equal(initConfig(dir).created, false);
  assert.equal(fs.readFileSync(path.join(dir, "duckwright.conf"), "utf8"), "model: opus\n");
});

test("duckwright init reports what it did", async () => {
  const dir = path.join(tmpDir(), "duckwright");
  const out: string[] = [];
  const deps = { initConfig: () => initConfig(dir), stdout: (l: string) => out.push(l), stderr: () => {} };
  assert.equal(await main(["init"], deps), 0);
  assert.equal(await main(["init"], deps), 0);
  assert.match(out[0], /^Wrote default config: /);
  assert.match(out[1], /^Config already exists: /);
  assert.equal(await main(["init", "x"], deps), 2);
});

test("evidence_defaults_documented_and_loaded", () => {
  assert.ok(DEFAULT_CONFIG.includes("# network: true\n# video: false\n# screenshot: false\n"));
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "duckwright.conf"), "screenshot: true\n");
  assert.deepEqual(loadConfig(dir), { screenshot: true });
});

test("config_env_key", () => {
  const tmp = tmpDir();
  assert.deepEqual(loadConfig(conf(tmp, "env: staging\n")), { env: "staging" });
  const dir = conf(tmp, "env: envs/qa.md\n");
  assert.deepEqual(loadConfig(dir), { env: path.join(fs.realpathSync(dir), "envs", "qa.md") });
  assert.throws(
    () => loadConfig(conf(tmp, "env: a b\n")),
    (e: unknown) => e instanceof TaskFileError
      && e.message.endsWith(':1: env must be an environment name (letters, digits, ".", "_", "-") or a path, got "a b"'),
  );
  assert.ok(DEFAULT_CONFIG.includes("# snapshot: hybrid\n# env: staging\n"));
  assert.ok(DEFAULT_CONFIG.includes("# Relative paths (skill, state, env) are resolved from the folder holding this file."));
});
