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

const SCRIPT_FM = [
  "---", "login:", "  method: script", "  url: https://staging.example.com/login",
  "  username-env: STAGING_USER", "  password-env: STAGING_PASSWORD",
  '  username-selector: "#email"', '  password-selector: "#password"',
  '  submit-selector: "button[type=submit]"', "  check-url: https://staging.example.com/account",
  "  check-text: Sign out", "---",
];

test("env_login_none", () => {
  const tmp = tmpDir();
  envFile(tmp, "a.md", "# Staging\n");
  const r = loadEnvironment("a", tmp);
  assert.equal(r.text, "# Staging");
  assert.equal(r.login, null);
});

test("env_login_script", () => {
  const tmp = tmpDir();
  envFile(tmp, "a.md", [...SCRIPT_FM, "# Staging", "body"].join("\r\n"));
  const r = loadEnvironment("a", tmp);
  assert.equal(r.text, "# Staging\nbody");
  assert.deepEqual(r.login, {
    method: "script", url: "https://staging.example.com/login", usernameSelector: "#email",
    passwordSelector: "#password", submitSelector: "button[type=submit]", usernameEnv: "STAGING_USER",
    passwordEnv: "STAGING_PASSWORD",
    check: { url: "https://staging.example.com/account", text: "Sign out" },
  });
});

test("env_login_agent_comments_and_open_fence_spaces", () => {
  const tmp = tmpDir();
  envFile(tmp, "a.md", [
    "---   ", "# note", "login:", "  method: agent", "", "  task: 'Log in via SSO' # c",
    "  username-env: U", "  password-env: P", "---", "Body",
  ].join("\n"));
  assert.deepEqual(loadEnvironment("a", tmp).login, {
    method: "agent", task: "Log in via SSO", usernameEnv: "U", passwordEnv: "P", check: null,
  });
});

test("env_login_errors", () => {
  const tmp = tmpDir();
  const p = path.join(tmp, "environments", "a.md");
  const fm = (...l: string[]) => ["---", ...l, "---", "body"].join("\n");
  const ok = ["login:", "  method: agent", "  task: t", "  username-env: U", "  password-env: P"];
  const cases: [string, string][] = [
    ["---\nlogin:\n  method: agent\nbody", `${p}: front matter is not closed with ---`],
    [fm("login:", "  nocolon"), `${p}:3: expected "key: value"`],
    [fm("nocolon"), `${p}:2: expected "key: value"`],
    [fm("foo: bar"), `${p}:2: unknown key "foo" (only login is allowed)`],
    [fm("login:", '  method: "agent'), `${p}:3: bad quoted value`],
    [fm("login:", "  bogus: 1"), `${p}:3: login: unknown key "bogus"`],
    [fm("login:", "  method: agent", "  method: agent"), `${p}:4: login: "method" is set twice`],
    [fm("login:", "  method:"), `${p}:3: login: "method" has no value`],
    [fm("login:", "  task: t"), `${p}: login: method is required`],
    [fm("login:", "  method: ftp"), `${p}:3: login: method must be agent or script, got "ftp"`],
    [fm("login:", "  method: agent", "  username-env: U", "  password-env: P"), `${p}: login: task is required for method agent`],
    [fm(...ok, "  url: https://x.test"), `${p}:7: login: url is not used by method agent`],
    [fm("login:", "  method: agent", "  task: t", "  username-env: 1X", "  password-env: P"),
      `${p}:5: login: username-env must be an environment variable name (letters, digits and _, not starting with a digit), got "1X"`],
    [fm("login:", "  method: script", "  url: ftp://x"), `${p}:4: login: url must be an http or https URL, got "ftp://x"`],
    [fm(...ok, "  check-url: https://x.test"), `${p}: login: check-url and check-text must be set together`],
    [fm(...ok, "  check-text: hi"), `${p}: login: check-url and check-text must be set together`],
    [fm("login: foo"), `${p}:2: login: must be followed by indented "key: value" lines`],
  ];
  for (const [content, msg] of cases) {
    envFile(tmp, "a.md", content);
    assert.equal(loadError("a", tmp), `environment file invalid: ${msg}`, content);
  }
  envFile(tmp, "a.md", fm(...ok).replace("body", ""));
  assert.equal(loadError("a", tmp), `environment file is empty: ${p}`);
  envFile(tmp, "a.md", "---\n" + "x".repeat(20000));
  assert.match(loadError("a", tmp), /too large/);
});
test("sample staging environment parses with a script login", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const env = loadEnvironment(path.join(root, "examples", "environments", "staging.md"), root);
  assert.equal(env.login?.method, "script");
  assert.ok(env.text.trim().length > 0);
  assert.ok(!env.text.includes("--state auth.json"));
});
