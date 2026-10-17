import { PLACEHOLDER, substitute } from "./accounts/placeholders.ts";
import type { Ref } from "./accounts/placeholders.ts";
import type { RunAccounts } from "./accounts/runAccounts.ts";
import { ALLOWED_COMMANDS } from "./brain.ts";
import type { Action } from "./brain.ts";
import { checkArgs, runExpect } from "./expect.ts";
import { checkRequestArgs, runExpectRequest } from "./expectRequest.ts";
import type { RequestContext } from "./expectRequest.ts";
import { checkRequestCallArgs, runRequest } from "./request.ts";
import type { RequestCallContext } from "./request.ts";
import { PlaywrightCLI } from "./pw.ts";
import type { WriteGuard } from "./explore/guard.ts";
import type { NoteSink } from "./explore/notes.ts";
import { TwoFactorError, checkTwofaArgs } from "./twofa.ts";
import type { TwoFactor } from "./twofa.ts";
import { Scrubber, secretMarker } from "./scrub.ts";
import { sliceCodePoints } from "./text.ts";

export const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_COMMANDS);
export const ALLOWED_LIST = ALLOWED_COMMANDS.join(", ");
export const PAGE_CHANGING: ReadonlySet<string> = new Set([
  "goto", "click", "dblclick", "press", "tab-new", "tab-select", "tab-close", "go-back", "twofa",
]);

// Harmless flags per command (from `playwright-cli <cmd> --help`). Any other flag,
// including global ones like -s/--session and --filename, is rejected.
export const ALLOWED_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  fill: new Set(["--submit"]),
  type: new Set(["--submit"]),
  click: new Set(["--modifiers"]),
  dblclick: new Set(["--modifiers"]),
  screenshot: new Set(["--type", "--full-page", "--hires"]),
};
const FLAG = /^-{1,2}[A-Za-z]/;

// playwright-cli prints the code it ran as "### Ran Playwright code" + a fenced block.
// (?<![^\n]) is Python's MULTILINE ^: JS's /m would also start a line after \r, U+2028 or U+2029.
const RAN_CODE = /(?<![^\n])### Ran Playwright code\n```\w*\n((?:(?!```)[^\n]*\n)*?(?!```)[^\n]+)\n```/;

export const MAX_ERROR_CHARS = 300;
export const EARLIER_FAILED = "error: an earlier action failed; verify before finishing";

const clip = (msg: string) => sliceCodePoints(msg, "error: ".length + MAX_ERROR_CHARS);

function badFlag(cmd: string, args: string[]): string | null {
  const allowed = Object.hasOwn(ALLOWED_FLAGS, cmd) ? ALLOWED_FLAGS[cmd] : new Set<string>();
  for (const arg of args) {
    if (FLAG.test(arg) && !allowed.has(arg.split("=", 1)[0])) return arg;
  }
  return null;
}

/** Commands whose arguments may carry account placeholders. */
const SUBSTITUTED: ReadonlySet<string> = new Set(["fill", "type"]);

/** The run's accounts and the current tab's origin, for substituting placeholders. */
export interface ActionAccounts {
  run: RunAccounts;
  origin: string | null;
}

const hasPlaceholder = (arg: string): boolean => new RegExp(PLACEHOLDER.source).test(arg);

/** Static allowlist check, so a rejected action is reported even when skipped. */
function rejection(a: Action): string | null {
  if (!ALLOWED.has(a.cmd)) return `error: command '${a.cmd}' not allowed (allowed: ${ALLOWED_LIST})`;
  if (!SUBSTITUTED.has(a.cmd) && a.args.some(hasPlaceholder)) return "error: account placeholders are allowed only in fill or type";
  // Its args never reach playwright-cli as given, so expected text may look like a flag.
  if (a.cmd === "expect") return checkArgs(a.args);
  if (a.cmd === "expect-request") return checkRequestArgs(a.args);
  if (a.cmd === "request") return checkRequestCallArgs(a.args);
  if (a.cmd === "twofa") return checkTwofaArgs(a.args);
  if (a.cmd === "note") return null; // validated by the sink; its text may look like a flag
  const bad = badFlag(a.cmd, a.args);
  return bad !== null ? `error: flag '${bad}' not allowed` : null;
}

/** `text` with every password `used` put in replaced by its marker (in one pass). */
function maskPasswords(text: string, used: Ref[], run: RunAccounts | null): string {
  const s = new Scrubber();
  for (const ref of used) {
    const value = ref.field === "password" ? run?.get(ref.id)?.password : undefined;
    if (value) s.addNamedSecret(value, secretMarker(ref.id));
  }
  return s.scrub(text);
}

export function extractCode(stdout: string): string | null {
  return RAN_CODE.exec(stdout)?.[1] ?? null;
}

export interface Executed {
  results: string[];
  done: { success: boolean; answer: string } | null;
  origins: (string | null)[];
}

export interface ExecuteHooks {
  start?(index: number): void;
  result?(index: number, result: string, code: string | null): void;
}

/** The account's TOTP secret, or the error result when it cannot be used here. Never asks a human. */
function accountTotp(id: string, accounts: ActionAccounts | null): { secret: string } | { error: string } {
  if (accounts === null || !accounts.run.has(id)) return { error: `error: no account '${id}' in this run` };
  const secret = accounts.run.totpSecret(id);
  if (secret === null) return { error: `error: account '${id}' has no TOTP secret` };
  const { origin } = accounts;
  if (origin === null) return { error: "error: refusing to enter a TOTP code: no page origin" };
  if (!accounts.run.allowedOrigins.includes(origin)) {
    return { error: `error: refusing to enter a TOTP code on ${origin}: not an allowed origin` };
  }
  return { secret };
}

/**
 * Run one `twofa` action: [result, recorded code, whether the page may have changed]. Neither the
 * result nor the code ever contains the code itself. `twofa totp <ref> <id>` uses that account's secret.
 */
async function runTwofa(
  pw: PlaywrightCLI, tf: TwoFactor | null, args: string[], accounts: ActionAccounts | null,
): Promise<[string, string | null, boolean]> {
  if (tf === null) return ["error: 2FA is not available in this run", null, false];
  const kind = args[0];
  try {
    if (kind === "passkey") {
      await tf.approve();
      return ["ok", null, false];
    }
    let code: string;
    if (kind === "totp" && args.length === 3) {
      const found = accountTotp(args[2], accounts);
      if ("error" in found) return [found.error, null, false];
      code = await tf.totpFor(found.secret);
    } else {
      code = kind === "totp" ? await tf.totp() : await tf.code(kind as "sms" | "email");
    }
    const res = await pw.run("fill", [args[1], code, "--submit"]);
    // A timeout (-1) may still have submitted the form.
    if (res.code !== 0) return [tf.scrubber.scrub(`error: ${res.stderr.trim() || res.stdout.trim()}`), null, res.code === -1];
    const ran = extractCode(res.stdout);
    return ["ok", ran === null ? null : tf.scrubber.scrub(ran), true];
  } catch (e) {
    // AbortedError and anything unexpected propagate: the run stops.
    if (e instanceof TwoFactorError) return [`error: ${e.message}`, null, false];
    throw e;
  }
}

/**
 * Run allowed actions. If `codes` is given, it is extended with one entry per
 * action: the Playwright code playwright-cli ran for it, or null if none ran.
 * `requests` is what expect-request checks against; null or absent means capture is off.
 * `call` is the request context for running request actions.
 * `twofa` supplies 2FA codes for `twofa` actions.
 * `notes` receives `note` actions; null or absent means this is not an explore run.
 * `guard` vets each action before it runs (explore --allow-writes); a refused action reports its error and is not run.
 * `accounts` fills `{{<id>.username}}`/`{{<id>.password}}` in fill and type args (the actions keep the
 * placeholders). A substituted action's code holds the real value: the caller scrubs codes and results
 * with the run scrubber before keeping them. An error never echoes a substituted password.
 */
export async function execute(
  pw: PlaywrightCLI, actions: Action[], codes?: (string | null)[], hooks?: ExecuteHooks,
  requests?: RequestContext | null, call?: RequestCallContext | null, twofa?: TwoFactor | null,
  notes?: NoteSink | null, guard?: WriteGuard | null, accounts?: ActionAccounts | null,
): Promise<Executed> {
  const results: string[] = [];
  let done: Executed["done"] = null;
  let skip: string | null = null;
  const ran = new Map<number, string>();
  const origins = new Map<number, string>();
  const handle = async (i: number, a: Action): Promise<void> => {
    const rejected = rejection(a);
    if (rejected !== null) {
      results.push(rejected);
      return;
    }
    if (skip) {
      results.push(skip);
      return;
    }
    if (a.cmd === "done") {
      if (!a.args.length || (a.args[0] !== "success" && a.args[0] !== "failure")) {
        const got = a.args.map((x) => JSON.stringify(x)).join(", ");
        results.push(`error: done needs ["success"|"failure", "<answer>"], got [${got}]`);
        return;
      }
      const success = a.args[0] === "success";
      if (success && results.some((r) => r.startsWith("error:"))) {
        results.push(EARLIER_FAILED);
        return;
      }
      done = { success, answer: a.args.length > 1 ? a.args[1] : "" };
      results.push("done");
      skip = "skipped: done";
      return;
    }
    if (a.cmd === "expect") {
      const [result, code] = await runExpect(pw, a.args);
      results.push(clip(result));
      if (code !== null) ran.set(i, code);
      return;
    }
    if (a.cmd === "expect-request") {
      const [result, code] = runExpectRequest(requests ?? null, a.args);
      results.push(clip(result));
      if (code !== null) ran.set(i, code);
      return;
    }
    if (a.cmd === "request") {
      const [result, code, origin] = await runRequest(pw, call ?? null, a.args);
      results.push(result.startsWith("ok") ? result : clip(result));
      if (code !== null) ran.set(i, code);
      if (origin !== null && code !== null) origins.set(i, origin);
      return;
    }
    if (a.cmd === "twofa") {
      const [result, code, changed] = await runTwofa(pw, twofa ?? null, a.args, accounts ?? null);
      results.push(clip(result));
      if (code !== null) ran.set(i, code);
      // The form was submitted (or may have been), so the page may have changed.
      if (changed) skip = "skipped: page may have changed";
      return;
    }
    if (a.cmd === "note") {
      results.push(notes ? clip(notes.add(a.args)) : "error: command 'note' not allowed outside explore runs");
      return;
    }
    let args = a.args;
    let used: Ref[] = [];
    if (SUBSTITUTED.has(a.cmd)) {
      const sub = substitute(a.args, accounts?.run ?? null, accounts?.origin ?? null);
      if ("error" in sub) {
        results.push(sub.error);
        return;
      }
      ({ args, used } = sub);
    }
    if (guard) {
      const refused = guard.check(a);
      if (refused !== null) {
        results.push(clip(refused));
        return;
      }
    }
    const res = await pw.run(a.cmd, args);
    if (res.code === 0) {
      results.push("ok");
      const code = extractCode(res.stdout);
      if (code !== null) ran.set(i, code);
    } else {
      // Masked before clipping, so a cut can never leave part of a password behind.
      const message = maskPasswords(`error: ${res.stderr.trim() || res.stdout.trim()}`, used, accounts?.run ?? null);
      results.push(clip(message));
    }
    // A timeout (-1) may still have navigated, so treat it like success here.
    if (PAGE_CHANGING.has(a.cmd) && (res.code === 0 || res.code === -1)) {
      skip = "skipped: page may have changed";
    }
  };
  for (const [i, a] of actions.entries()) {
    hooks?.start?.(i);
    await handle(i, a);
    hooks?.result?.(i, results[results.length - 1], ran.get(i) ?? null);
  }
  codes?.push(...actions.map((_, i) => ran.get(i) ?? null));
  return { results, done, origins: actions.map((_, i) => origins.get(i) ?? null) };
}
