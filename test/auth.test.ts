import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { AUTH_DIR, AuthBroker, LoginError, authLabel, cachePath, stateProblem } from "../src/auth.ts";
import type { LoginConfig } from "../src/environment.ts";
import { AbortedError } from "../src/proc.ts";
import type { ProcResult } from "../src/proc.ts";
import { fakeRunner, ok, tmpDir } from "./helpers.ts";

const NOW = 1_700_000_000_000;
const PASSWORD = "s3cret-pw";

const SCRIPT: LoginConfig = {
  method: "script",
  url: "https://staging.example.com/login",
  usernameSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "button[type=submit]",
  usernameEnv: "STAGING_USER",
  passwordEnv: "STAGING_PASSWORD",
  check: null,
};
const CHECK = { url: "https://staging.example.com/account", text: "Sign out" };
const ENV = { STAGING_USER: "u@x.com", STAGING_PASSWORD: PASSWORD };

/** The command word of a playwright-cli argv: ["playwright-cli", "-s=S", CMD, ...]. */
const cmd = (argv: string[]): string => argv[2];
const arg = (argv: string[], flag: string): string =>
  argv.find((a) => a.startsWith(flag))!.slice(flag.length);

interface Opts {
  snapshot?: string;
  fail?: Record<string, ProcResult>;
  stateJson?: string;
}

/** A fake playwright-cli: state-save and snapshot write their files; `fail` maps a command to its result. */
function fake(o: Opts = {}) {
  return fakeRunner((argv) => {
    const c = cmd(argv);
    if (o.fail?.[c]) return o.fail[c];
    if (c === "state-save") {
      fs.writeFileSync(argv[3], o.stateJson ?? JSON.stringify({ cookies: [], origins: [] }));
    }
    if (c === "snapshot") fs.writeFileSync(arg(argv, "--filename="), o.snapshot ?? "- text: Sign out");
    return ok();
  });
}

const sig = () => new AbortController().signal;

function broker(runner: ReturnType<typeof fake>, env: Record<string, string | undefined> = ENV) {
  return new AuthBroker({ env, runner, now: () => NOW });
}

function ensure(b: AuthBroker, cwd: string, login: LoginConfig = SCRIPT, extra: object = {}) {
  return b.ensure({ env: { name: "staging", login }, cwd, signal: sig(), headed: false, ...extra });
}

function writeCache(cwd: string, state: unknown): string {
  const p = cachePath("staging", cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof state === "string" ? state : JSON.stringify(state));
  return p;
}

test("auth_label_and_cache_path_sanitise", () => {
  assert.equal(authLabel("a b/c"), "a_b_c");
  assert.equal(authLabel("ok.name-1_x"), "ok.name-1_x");
  assert.equal(cachePath("a b/c", "/w"), path.join("/w", AUTH_DIR, "a_b_c.json"));
});

test("state_problem_cases", () => {
  const dir = tmpDir();
  const f = path.join(dir, "s.json");
  assert.equal(stateProblem(f, NOW), "missing");
  fs.writeFileSync(f, "{not json");
  assert.equal(stateProblem(f, NOW), "unreadable");
  fs.writeFileSync(f, JSON.stringify({ origins: [] }));
  assert.equal(stateProblem(f, NOW), "unreadable");
  const withCookie = (expires: number) => JSON.stringify({ cookies: [{ name: "a", expires }] });
  fs.writeFileSync(f, withCookie(NOW / 1000 + 30));
  assert.equal(stateProblem(f, NOW), "expired");
  fs.writeFileSync(f, withCookie(-1));
  assert.equal(stateProblem(f, NOW), null);
  fs.writeFileSync(f, withCookie(NOW / 1000 + 61));
  assert.equal(stateProblem(f, NOW), null);
});

test("script_login_issues_exact_steps_and_saves_cache", async () => {
  const cwd = tmpDir();
  const r = fake();
  const res = await ensure(broker(r), cwd);
  const calls = r.calls.map((c) => c.argv);
  const cache = cachePath("staging", cwd);
  const S = "-s=duckwright-login-staging";
  assert.deepEqual(calls, [
    ["playwright-cli", S, "open", "about:blank"],
    ["playwright-cli", S, "goto", SCRIPT.url],
    ["playwright-cli", S, "fill", "#email", "u@x.com"],
    ["playwright-cli", S, "fill", "#password", PASSWORD],
    ["playwright-cli", S, "click", "button[type=submit]"],
    ["playwright-cli", S, "state-save", `${cache}.tmp`],
    ["playwright-cli", S, "close"],
  ]);
  assert.deepEqual(res, { path: cache, reused: false, costUsd: 0 });
  assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(cache)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(cwd, ".duckwright")).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(cwd, ".duckwright", ".gitignore"), "utf8"), "*\n");
  assert.equal(fs.existsSync(`${cache}.tmp`), false);
});

test("headed_login_opens_headed", async () => {
  const r = fake();
  await ensure(broker(r), tmpDir(), SCRIPT, { headed: true });
  assert.deepEqual(r.calls[0].argv.slice(-3), ["open", "about:blank", "--headed"]);
});

test("existing_gitignore_is_kept", async () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, ".duckwright"));
  fs.writeFileSync(path.join(cwd, ".duckwright", ".gitignore"), "mine\n");
  await ensure(broker(fake()), cwd);
  assert.equal(fs.readFileSync(path.join(cwd, ".duckwright", ".gitignore"), "utf8"), "mine\n");
});

for (const [step, failing, message] of [
  ["open", "open", "open failed: boom"],
  ["goto", "goto", "goto failed: boom"],
  ["fill username", "fill", "fill username failed: boom"],
  ["click submit", "click", "click submit failed: boom"],
  ["state-save", "state-save", "state-save failed: boom"],
] as const) {
  test(`step_failure_${step.replace(" ", "_")}`, async () => {
    const r = fake({ fail: { [failing]: { code: 1, stdout: "", stderr: "boom" } } });
    await assert.rejects(ensure(broker(r), tmpDir()), (e: Error) => {
      assert.ok(e instanceof LoginError);
      assert.equal(e.message, message);
      return true;
    });
    assert.equal(cmd(r.calls.at(-1)!.argv), "close");
  });
}

test("fill_password_failure_is_scrubbed_and_password_only_in_its_argv", async () => {
  const cwd = tmpDir();
  let n = 0;
  const r = fakeRunner((argv) => {
    if (cmd(argv) === "fill" && ++n === 2) return { code: 1, stdout: "", stderr: `bad value ${PASSWORD}` };
    return ok();
  });
  await assert.rejects(ensure(broker(r as never), cwd), (e: Error) => {
    assert.equal(e.message, "fill password failed: bad value [REDACTED]");
    return true;
  });
  const withPw = r.calls.filter((c) => c.argv.includes(PASSWORD));
  assert.equal(withPw.length, 1);
  assert.equal(cmd(withPw[0].argv), "fill");
  assert.equal(fs.existsSync(cachePath("staging", cwd)), false);
});

test("check_passes_then_saves", async () => {
  const cwd = tmpDir();
  const r = fake({ snapshot: "- link 'Sign out'" });
  await ensure(broker(r), cwd, { ...SCRIPT, check: CHECK });
  const cmds = r.calls.map((c) => cmd(c.argv));
  assert.deepEqual(cmds, ["open", "goto", "fill", "fill", "click", "goto", "snapshot", "state-save", "close"]);
  assert.equal(r.calls[5].argv[3], CHECK.url);
  assert.ok(fs.existsSync(cachePath("staging", cwd)));
});

test("check_fails_writes_no_cache", async () => {
  const cwd = tmpDir();
  const r = fake({ snapshot: "- text: Log in" });
  await assert.rejects(ensure(broker(r), cwd, { ...SCRIPT, check: CHECK }), (e: Error) => {
    assert.equal(e.message, `check failed: "Sign out" not found at ${CHECK.url}`);
    return true;
  });
  assert.equal(fs.existsSync(cachePath("staging", cwd)), false);
  assert.equal(r.calls.some((c) => cmd(c.argv) === "state-save"), false);
});

test("missing_env_var_fails_before_any_runner_call", async () => {
  const r = fake();
  await assert.rejects(ensure(broker(r, { STAGING_USER: "u" }), tmpDir()), (e: Error) => {
    assert.ok(e instanceof LoginError);
    assert.equal(e.message, "environment variable STAGING_PASSWORD is not set");
    return true;
  });
  await assert.rejects(ensure(broker(r, { STAGING_USER: "", STAGING_PASSWORD: "x" }), tmpDir()),
    /environment variable STAGING_USER is not set/);
  assert.equal(r.calls.length, 0);
});

test("unwritable_cache_dir_fails_with_cannot_write", async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, ".duckwright"), "a file where the folder should be");
  const r = fake();
  await assert.rejects(ensure(broker(r), cwd), (e: Error) => {
    assert.ok(e instanceof LoginError);
    assert.match(e.message, /^cannot write .+: /);
    return true;
  });
});

test("concurrent_ensure_logs_in_once_and_second_call_reuses", async () => {
  const cwd = tmpDir();
  const r = fake();
  const b = broker(r);
  const [a, c] = await Promise.all([ensure(b, cwd), ensure(b, cwd)]);
  assert.equal(r.calls.filter((x) => cmd(x.argv) === "open").length, 1);
  assert.equal(a.path, c.path);
  const again = await ensure(b, cwd);
  assert.equal(again.reused, true);
  assert.equal(again.costUsd, 0);
  assert.equal(r.calls.filter((x) => cmd(x.argv) === "open").length, 1);
});

test("check_not_rerun_for_same_path_and_mtime", async () => {
  const cwd = tmpDir();
  const r = fake();
  const b = broker(r);
  writeCache(cwd, { cookies: [] });
  const login = { ...SCRIPT, check: CHECK };
  await ensure(b, cwd, login);
  const snaps = () => r.calls.filter((x) => cmd(x.argv) === "snapshot").length;
  assert.equal(snaps(), 1);
  const second = await ensure(b, cwd, login);
  assert.equal(second.reused, true);
  assert.equal(snaps(), 1);
});

test("cached_state_checked_in_fresh_check_session", async () => {
  const cwd = tmpDir();
  const cache = writeCache(cwd, { cookies: [] });
  const r = fake();
  const res = await ensure(broker(r), cwd, { ...SCRIPT, check: CHECK });
  assert.equal(res.reused, true);
  const S = "-s=duckwright-check-staging";
  assert.deepEqual(r.calls.map((c) => c.argv.slice(0, 4)), [
    ["playwright-cli", S, "open", "about:blank"],
    ["playwright-cli", S, "state-load", cache],
    ["playwright-cli", S, "goto", CHECK.url],
    ["playwright-cli", S, "snapshot", r.calls[3].argv[3]],
    ["playwright-cli", S, "close"],
  ]);
});

test("failed_check_on_cache_triggers_login_with_reason", async () => {
  const cwd = tmpDir();
  writeCache(cwd, { cookies: [] });
  let snaps = 0;
  const r = fakeRunner((argv) => {
    if (cmd(argv) === "state-save") fs.writeFileSync(argv[3], '{"cookies":[]}');
    if (cmd(argv) === "snapshot") {
      fs.writeFileSync(arg(argv, "--filename="), ++snaps === 1 ? "- text: Log in" : "- text: Sign out");
    }
    return ok();
  });
  const reasons: string[] = [];
  const res = await ensure(broker(r as never), cwd, { ...SCRIPT, check: CHECK }, { onReason: (x: string) => reasons.push(x) });
  assert.deepEqual(reasons, ["saved state failed the check"]);
  assert.equal(res.reused, false);
});

for (const [name, setup, reason] of [
  ["missing", () => undefined, "no saved state"],
  ["expired", (cwd: string) => writeCache(cwd, { cookies: [{ expires: NOW / 1000 + 5 }] }), "saved state expired"],
  ["unreadable", (cwd: string) => writeCache(cwd, "nope"), "saved state unreadable"],
] as const) {
  test(`reason_${name}`, async () => {
    const cwd = tmpDir();
    setup(cwd);
    const reasons: string[] = [];
    await ensure(broker(fake()), cwd, SCRIPT, { onReason: (x: string) => reasons.push(x) });
    assert.deepEqual(reasons, [reason]);
  });
}

test("valid_cache_reused_without_reading_env", async () => {
  const cwd = tmpDir();
  const cache = writeCache(cwd, { cookies: [] });
  const r = fake();
  const res = await ensure(broker(r, {}), cwd);
  assert.deepEqual(res, { path: cache, reused: true, costUsd: 0 });
  assert.equal(r.calls.length, 0);
});

test("failed_login_is_not_memoized", async () => {
  const cwd = tmpDir();
  let failing = true;
  const r = fakeRunner((argv) => {
    if (cmd(argv) === "goto" && failing) return { code: 1, stdout: "", stderr: "down" };
    if (cmd(argv) === "state-save") fs.writeFileSync(argv[3], '{"cookies":[]}');
    return ok();
  });
  const b = broker(r as never);
  await assert.rejects(ensure(b, cwd), LoginError);
  failing = false;
  const res = await ensure(b, cwd);
  assert.equal(res.reused, false);
});

test("aborted_signal_rejects_with_aborted_error", async () => {
  const ac = new AbortController();
  const r = fakeRunner(() => {
    ac.abort();
    throw new AbortedError();
  });
  const b = broker(r as never);
  await assert.rejects(
    b.ensure({ env: { name: "staging", login: SCRIPT }, cwd: tmpDir(), signal: ac.signal, headed: false }),
    (e: Error) => e instanceof AbortedError && !(e instanceof LoginError),
  );
});

test("check_snapshot_failure_is_scrubbed_login_error", async () => {
  const r = fakeRunner((argv) => {
    if (cmd(argv) === "snapshot") return { code: 1, stdout: "", stderr: `page said ${PASSWORD}` };
    return ok();
  });
  await assert.rejects(ensure(broker(r as never), tmpDir(), { ...SCRIPT, check: CHECK }), (e: Error) => {
    assert.ok(e instanceof LoginError);
    assert.match(e.message, /\[REDACTED\]/);
    assert.ok(!e.message.includes(PASSWORD));
    return true;
  });
});

test("state_save_failure_with_empty_stderr_reports_exit_code", async () => {
  const r = fake({ fail: { "state-save": { code: 3, stdout: "", stderr: "" } } });
  await assert.rejects(ensure(broker(r), tmpDir()), (e: Error) => {
    assert.ok(e instanceof LoginError);
    assert.equal(e.message, "state-save failed: exit 3");
    return true;
  });
});

test("joiner_survives_first_caller_abort_with_one_extra_login", async () => {
  const cwd = tmpDir();
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  let first = true;
  const r = fakeRunner((argv) => {
    if (cmd(argv) === "goto" && first) {
      first = false;
      ac1.abort();
      throw new AbortedError();
    }
    if (cmd(argv) === "state-save") fs.writeFileSync(argv[3], '{"cookies":[]}');
    return ok();
  });
  const b = broker(r as never);
  const mk = (signal: AbortSignal) =>
    b.ensure({ env: { name: "staging", login: SCRIPT }, cwd, signal, headed: false });
  const a = mk(ac1.signal);
  const c = mk(ac2.signal);
  await assert.rejects(a, AbortedError);
  const res = await c;
  assert.equal(res.reused, false);
  assert.equal(r.calls.filter((x) => cmd(x.argv) === "open").length, 2);
});

test("joiner_own_abort_rejects_promptly", async () => {
  const cwd = tmpDir();
  const ac2 = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const r = async (argv: string[]) => {
    if (cmd(argv) === "goto") await gate;
    if (cmd(argv) === "state-save") fs.writeFileSync(argv[3], '{"cookies":[]}');
    return ok();
  };
  const b = new AuthBroker({ env: ENV, runner: r as never, now: () => NOW });
  const a = ensure(b, cwd);
  const c = b.ensure({ env: { name: "staging", login: SCRIPT }, cwd, signal: ac2.signal, headed: false });
  ac2.abort();
  await assert.rejects(c, AbortedError);
  release();
  await a;
});
