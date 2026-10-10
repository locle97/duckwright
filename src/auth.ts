// Automatic login: one AuthBroker per process logs in once per environment and caches the
// storage state under <cwd>/.duckwright/auth/. This module must not import src/runs/run.ts at
// runtime (run.ts imports this one); anything it needs from a run arrives in LoginRunContext.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunArgs } from "./args.ts";
import type { LoginCheck, LoginConfig } from "./environment.ts";
import type { AgentOptions } from "./loop.ts";
import { AbortedError, runProcess } from "./proc.ts";
import type { Runner } from "./proc.ts";
import { PlaywrightCLI, PlaywrightError } from "./pw.ts";
import type { RunDeps } from "./runs/run.ts";
import { RunEvents } from "./events.ts";
import { Scrubber, scrubTree } from "./scrub.ts";
import { SECRET_ENV, createTwoFactor } from "./twofa.ts";

export const AUTH_DIR = path.join(".duckwright", "auth");
/** A cookie that expires within this many ms counts as already expired. */
const EXPIRY_MARGIN_MS = 60_000;

/** Appended to the agent login's instructions (C1): the agent types placeholders, never credentials. */
const AGENT_PARAGRAPH = "Type {{username}} where the username or email goes and {{password}} where the password goes; "
  + "Duckwright replaces them with the real values. Never type real credentials. "
  + "When you are logged in, finish with done success.";

/** The login failed; the message is the REASON only (callers add `login failed: ENV: `). */
export class LoginError extends Error {
  override name = "LoginError";
}

/** What an agent login needs from the run that triggered it. Supplied by startRun (Tasks 7-8). */
export interface LoginRunContext {
  args: RunArgs;
  deps: Pick<RunDeps, "prompts" | "signal" | "createAgent" | "runner" | "jevTransport" | "humanFor" | "onWarning">;
  /** Builds the brain for a run folder; injected by run.ts so this module needs no runtime import of it. */
  makeBrain: (workdir: string) => AgentOptions["brain"];
}

export interface EnsureOptions {
  /** `text` is the environment file body, given to the login agent as context. */
  env: { name: string; login: LoginConfig; text?: string };
  cwd?: string;
  signal: AbortSignal;
  headed: boolean;
  /** Only agent logins need it; script logins ignore it. */
  run?: LoginRunContext;
  /** Called with the C3 REASON when a login has to run (not when a saved state is reused). */
  onReason?: (reason: string) => void;
}

export interface BrokerOptions {
  /** Where username/password variables are read, at login time only. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Runs playwright-cli (default `runProcess`); a test seam. */
  runner?: Runner;
  now?: () => number;
  createPw?: (session: string, signal: AbortSignal) => PlaywrightCLI;
}

export interface EnsureResult {
  /** Absolute path of the cached state. */
  path: string;
  reused: boolean;
  costUsd: number;
}

export function authLabel(envName: string): string {
  // `envName` is already an environment label (see envLabel in environment.ts).
  return envName.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function cachePath(envName: string, cwd: string): string {
  return path.join(cwd, AUTH_DIR, `${authLabel(envName)}.json`);
}

export function stateProblem(file: string, now: number): "missing" | "unreadable" | "expired" | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  const cookies = (data as { cookies?: unknown } | null)?.cookies;
  if (data === null || typeof data !== "object" || !Array.isArray(cookies)) return "unreadable";
  for (const c of cookies) {
    const expires = (c as { expires?: unknown } | null)?.expires;
    if (typeof expires === "number" && expires > 0 && expires * 1000 <= now + EXPIRY_MARGIN_MS) return "expired";
  }
  return null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type StepResult = { code: number; stdout: string; stderr: string } | void;
export type Step = (name: string, run: () => Promise<StepResult>) => Promise<void>;

/** Runs one login step; any failure becomes a scrubbed `LoginError("NAME failed: ...")`. */
function makeStep(scrubber: Scrubber): Step {
  return async (name, run) => {
    try {
      const res = await run();
      if (res && res.code !== 0) throw new Error(res.stderr || res.stdout || `exit ${res.code}`);
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      throw new LoginError(scrubber.scrub(`${name} failed: ${messageOf(e)}`));
    }
  };
}

/** Shared tail of every login: the optional check, then saving the state to `tmp`. */
export async function finishLogin(
  pw: PlaywrightCLI, check: LoginCheck | null, tmp: string, snapshotFile: string, step: Step,
): Promise<void> {
  if (check !== null) await checkPage(pw, check, snapshotFile, step);
  await step("state-save", () => pw.stateSave(tmp));
}

export class AuthBroker {
  readonly #env: Record<string, string | undefined>;
  readonly #runner: Runner;
  readonly #now: () => number;
  readonly #createPw: (session: string, signal: AbortSignal) => PlaywrightCLI;
  readonly #inflight = new Map<string, Promise<EnsureResult>>();
  /** Cache path -> mtime of the state file whose check already passed in this process (D11). */
  readonly #checked = new Map<string, number>();

  constructor(o: BrokerOptions = {}) {
    this.#env = o.env ?? process.env;
    this.#runner = o.runner ?? runProcess;
    this.#now = o.now ?? Date.now;
    this.#createPw = o.createPw
      ?? ((session, signal) => new PlaywrightCLI({ session, runner: this.#runner, signal }));
  }

  ensure(opts: EnsureOptions): Promise<EnsureResult> {
    const cwd = opts.cwd ?? process.cwd();
    const key = cachePath(opts.env.name, cwd);
    const running = this.#inflight.get(key);
    if (running) return this.#join(running, opts);
    const p = this.#ensure(opts, cwd, key).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  /**
   * Wait for a login another caller started. That login is driven by the starter's signal only:
   * if it ends aborted while this caller is still live, start a fresh one; if this caller's own
   * signal aborts, stop waiting at once.
   */
  #join(running: Promise<EnsureResult>, opts: EnsureOptions): Promise<EnsureResult> {
    const { signal } = opts;
    return new Promise<EnsureResult>((resolve, reject) => {
      if (signal.aborted) return reject(new AbortedError());
      const onAbort = (): void => reject(new AbortedError());
      signal.addEventListener("abort", onAbort, { once: true });
      running.then(resolve, (e) => {
        if (e instanceof AbortedError && !signal.aborted) this.ensure(opts).then(resolve, reject);
        else reject(e);
      }).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async #ensure(opts: EnsureOptions, cwd: string, file: string): Promise<EnsureResult> {
    const { env, signal } = opts;
    const label = authLabel(env.name);
    const problem = stateProblem(file, this.#now());
    let reason: string;
    if (problem === null) {
      if (await this.#checkPassed(file, label, env.login.check, signal)) {
        return { path: file, reused: true, costUsd: 0 };
      }
      reason = "saved state failed the check";
    } else {
      reason = { missing: "no saved state", unreadable: "saved state unreadable", expired: "saved state expired" }[problem];
    }
    opts.onReason?.(reason);
    const costUsd = await this.#login(opts, cwd, file, label);
    this.#markChecked(file);
    return { path: file, reused: false, costUsd };
  }

  #mtime(file: string): number | null {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  #markChecked(file: string): void {
    const m = this.#mtime(file);
    if (m !== null) this.#checked.set(file, m);
  }

  /** D10 (c): a fresh session loads the state and looks for the check text. Never throws except on abort. */
  async #checkPassed(file: string, label: string, check: LoginCheck | null, signal: AbortSignal): Promise<boolean> {
    if (check === null) return true;
    const m = this.#mtime(file);
    if (m !== null && this.#checked.get(file) === m) return true;
    const pw = this.#createPw(`duckwright-check-${label}`, signal);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-check-"));
    try {
      const opened = await pw.open(false);
      if (opened.code !== 0) return false;
      await pw.stateLoad(file);
      await checkPage(pw, check, path.join(dir, "snapshot.yml"));
      this.#markChecked(file);
      return true;
    } catch (e) {
      if (e instanceof AbortedError || signal.aborted) throw new AbortedError();
      return false;
    } finally {
      await pw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  #credentials(login: LoginConfig): { username: string; password: string } {
    const read = (name: string): string => {
      const v = this.#env[name];
      if (v === undefined || v === "") throw new LoginError(`environment variable ${name} is not set`);
      return v;
    };
    return { username: read(login.usernameEnv), password: read(login.passwordEnv) };
  }

  async #login(opts: EnsureOptions, cwd: string, file: string, label: string): Promise<number> {
    const { login } = opts.env;
    const creds = this.#credentials(login);
    const scrubber = new Scrubber();
    scrubber.addSecret(creds.password);
    scrubber.addSecret(creds.username);
    prepareCacheDir(cwd, file);
    const tmp = `${file}.tmp`;
    try {
      if (login.method === "script") {
        await this.#scriptLogin(opts, label, login, creds, scrubber, tmp);
        publish(tmp, file);
        return 0;
      }
      const costUsd = await this.#agentLogin(opts, login, creds, scrubber, label, file, tmp);
      publish(tmp, file);
      return costUsd;
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      if (opts.signal.aborted) throw new AbortedError();
      throw new LoginError(scrubber.scrub(messageOf(e)));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** Drives a `Agent` through the login with placeholders; returns its cost. Work folder is kept on failure. */
  async #agentLogin(
    opts: EnsureOptions, login: Extract<LoginConfig, { method: "agent" }>,
    creds: { username: string; password: string }, scrubber: Scrubber, label: string, file: string, tmp: string,
  ): Promise<number> {
    const run = opts.run;
    if (!run) throw new LoginError("agent login needs a run context");
    const workdir = path.join(path.dirname(file), `${label}.login`);
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
    const pw = this.#createPw(`duckwright-login-${label}`, opts.signal);
    const events = new RunEvents();
    const twofa = createTwoFactor({
      secret: this.#env[SECRET_ENV] ?? null,
      human: run.deps.humanFor?.({ signal: opts.signal, events }) ?? null,
      timeoutSec: run.args.twofaTimeout, signal: opts.signal, events, scrubber,
    });
    const step = makeStep(scrubber);
    const agent = run.deps.createAgent({
      task: `${login.task}\n\n${AGENT_PARAGRAPH}`,
      pw, brain: run.makeBrain(workdir), workdir,
      maxSteps: run.args.maxSteps, headed: opts.headed, snapshotMode: run.args.snapshot,
      signal: opts.signal, twofa, events, environment: opts.env.text ?? null,
      fillValues: { "{{username}}": creds.username, "{{password}}": creds.password },
      beforeClose: () => finishLogin(pw, login.check, tmp, path.join(workdir, "check-snapshot.yml"), step),
    });
    try {
      let result;
      try {
        result = await agent.run();
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        if (e instanceof PlaywrightError) throw new LoginError(scrubber.scrub(`playwright error: ${e.message}`));
        if (e instanceof LoginError) throw e;
        throw new LoginError(scrubber.scrub(`login agent did not finish: ${messageOf(e)}`));
      }
      if (!result.success) throw new LoginError(scrubber.scrub(`login agent did not finish: ${result.answer}`));
    } catch (e) {
      // The folder is kept for debugging, but it must not hold the credentials.
      scrubTree(workdir, scrubber);
      throw e;
    }
    fs.rmSync(workdir, { recursive: true, force: true });
    return agent.costUsd;
  }

  async #scriptLogin(
    opts: EnsureOptions, label: string, login: Extract<LoginConfig, { method: "script" }>,
    creds: { username: string; password: string }, scrubber: Scrubber, tmp: string,
  ): Promise<void> {
    const pw = this.#createPw(`duckwright-login-${label}`, opts.signal);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-login-"));
    const step = makeStep(scrubber);
    try {
      await step("open", () => pw.open(opts.headed));
      await step("goto", () => pw.run("goto", [login.url]));
      await step("fill username", () => pw.run("fill", [login.usernameSelector, creds.username]));
      await step("fill password", () => pw.run("fill", [login.passwordSelector, creds.password]));
      await step("click submit", () => pw.run("click", [login.submitSelector]));
      await finishLogin(pw, login.check, tmp, path.join(dir, "snapshot.yml"), step);
    } finally {
      await pw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Go to the check URL and look for the text. The snapshot call is `pw.snapshot(file)`, i.e.
 * `playwright-cli -s=SESSION snapshot --filename=FILE`.
 */
export async function checkPage(
  pw: PlaywrightCLI, check: LoginCheck, snapshotFile: string,
  step: Step = makeStep(new Scrubber()),
): Promise<void> {
  await step("goto", () => pw.run("goto", [check.url]));
  let snapshot = "";
  await step("snapshot", async () => { snapshot = await pw.snapshot(snapshotFile); });
  if (!snapshot.includes(check.text)) {
    throw new LoginError(`check failed: "${check.text}" not found at ${check.url}`);
  }
}

/** Creates `.duckwright/auth` (0o700) and `.duckwright/.gitignore` (`*`, only if absent). */
function prepareCacheDir(cwd: string, file: string): void {
  try {
    const authDir = path.dirname(file);
    const root = path.dirname(authDir);
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    fs.chmodSync(authDir, 0o700);
    const ignore = path.join(root, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  } catch (e) {
    throw new LoginError(`cannot write ${file}: ${messageOf(e)}`);
  }
}

/** Moves the saved temp file onto the cache path with mode 0o600. */
function publish(tmp: string, file: string): void {
  try {
    if (!fs.existsSync(tmp)) throw new Error("state-save wrote no file");
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    throw new LoginError(`cannot write ${file}: ${messageOf(e)}`);
  }
}
