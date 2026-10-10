import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  EnvError, envLabel, isEnvName, isEnvPath, listEnvironments, loadEnvironment, resolveEnv,
} from "../src/environment.ts";
import { tmpDir } from "./helpers.ts";

function envFile(cwd: string, name: string, content: string | Uint8Array): string {
  const p = path.join(cwd, "environments", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function loadError(value: string, cwd: string): string {
  try {
    loadEnvironment(value, cwd);
  } catch (e) {
    assert.ok(e instanceof EnvError);
    assert.equal(e.name, "EnvError");
    return e.message;
  }
  assert.fail("expected EnvError");
}

test("env_classify", () => {
  for (const v of ["dir/x", "a.MD", "a.md", "/abs/x"]) assert.equal(isEnvPath(v), true, v);
  for (const v of ["staging", "a.b"]) assert.equal(isEnvPath(v), false, v);
  for (const v of ["staging", "qa_1-x.y", "none"]) assert.equal(isEnvName(v), true, v);
  for (const v of [".", "..", ".hidden", "a b", "", "dir/x", "a.MD"]) assert.equal(isEnvName(v), false, v);
});

test("env_resolve_and_label", () => {
  const tmp = tmpDir();
  assert.deepEqual(resolveEnv("staging", tmp), {
    name: "staging", path: path.join(tmp, "environments", "staging.md"),
  });
  assert.deepEqual(resolveEnv("x/prod.MD", tmp), { name: "prod", path: path.join(tmp, "x", "prod.MD") });
  assert.equal(envLabel("../envs/eu-west"), "eu-west");
  assert.equal(envLabel(null), null);
  assert.throws(() => resolveEnv("a b", tmp), (e: Error) =>
    e instanceof EnvError && e.message === "invalid environment: 'a b'");
});

test("env_load_errors", () => {
  const tmp = tmpDir();
  const p = path.join(tmp, "environments", "staging.md");
  assert.equal(loadError("staging", tmp), `environment file not found: ${p}`);
  fs.mkdirSync(path.join(tmp, "environments", "dir.md"), { recursive: true });
  const d = path.join(tmp, "environments", "dir.md");
  assert.equal(loadError("environments/dir.md", tmp),
    `environment file cannot be read: ${d}: not a file`);
  envFile(tmp, "staging.md", new Uint8Array([0xff, 0xfe, 0x41]));
  assert.equal(loadError("staging", tmp), `environment file cannot be read: ${p}: not valid UTF-8`);
  envFile(tmp, "staging.md", "a".repeat(16385));
  assert.equal(loadError("staging", tmp), `environment file too large: ${p} is 16385 bytes (limit 16384)`);
  envFile(tmp, "staging.md", " \n\t\n");
  assert.equal(loadError("staging", tmp), `environment file is empty: ${p}`);
});

test("env_load_limit_and_normalise", () => {
  const tmp = tmpDir();
  envFile(tmp, "staging.md", "a".repeat(16384));
  assert.equal(loadEnvironment("staging", tmp).text.length, 16384);
  envFile(tmp, "staging.md", "﻿\r\n  Base URL: x\r\nAccounts: y  \r\n\r\n");
  const r = loadEnvironment("staging", tmp);
  assert.equal(r.text, "Base URL: x\nAccounts: y");
  assert.equal(r.name, "staging");
  assert.ok(path.isAbsolute(r.path));
});

test("env_list_filters_and_sorts", () => {
  const tmp = tmpDir();
  assert.deepEqual(listEnvironments(tmp), []);
  for (const f of ["b.md", "a.md", "A.md", ".hidden.md", "none.md", "x.MD.md", "notes.txt", "UP.MD", "bad name.md"]) {
    envFile(tmp, f, "x");
  }
  fs.mkdirSync(path.join(tmp, "environments", "dir.md"));
  assert.deepEqual(listEnvironments(tmp), ["A", "a", "b"]);
});
