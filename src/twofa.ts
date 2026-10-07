// 2FA for a run: where the code comes from (the env secret, or a human), how long to wait for a
// human, and how many tries. Front ends only supply a Human; nothing here knows about terminals or Ink.
import type { RunEvents, RunEventInput, TwofaWait } from "./events.ts";
import { AbortedError } from "./proc.ts";
import { Scrubber } from "./scrub.ts";
import { parseSecret, totpAt } from "./totp.ts";

export const SECRET_ENV = "DUCKWRIGHT_TOTP_SECRET";
export const TWOFA_KINDS = ["totp", "sms", "email", "passkey"] as const;
export const MAX_TWOFA_ATTEMPTS = 5;
export const DEFAULT_TWOFA_TIMEOUT_SEC = 300;
/** The longest wait setTimeout can hold: Node clamps delays above 2^31-1 ms to 1 ms. */
export const MAX_TWOFA_TIMEOUT_SEC = 2147483;
export const NO_HUMAN = "no way to ask for a code (stdin is not a terminal)";
const BAD_SECRET = "not a valid TOTP secret";
const REF = /^[A-Za-z0-9_-]+$/;

export class TwoFactorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoFactorError";
  }
}

/** A Human rejects with this when the user cancels the request. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Whoever can be asked: a terminal reader in print mode, a dialog in the TUI. Each call rejects with
 * AbortedError when `signal` aborts (run stopped, or the wait timed out) and with CancelledError on cancel.
 */
export interface Human {
  secret(signal: AbortSignal): Promise<string>;
  code(kind: "sms" | "email", signal: AbortSignal): Promise<string>;
  approve(signal: AbortSignal): Promise<void>;
}

export interface TwoFactor {
  readonly scrubber: Scrubber;
  totp(): Promise<string>;
  code(kind: "sms" | "email"): Promise<string>;
  approve(): Promise<void>;
}

export interface TwoFactorOptions {
  /** `DUCKWRIGHT_TOTP_SECRET` as given, or null when it is unset. Throws if it is not valid. */
  secret: string | null;
  human: Human | null;
  timeoutSec: number;
  /** The run's signal: aborting it rejects every wait with AbortedError. */
  signal: AbortSignal;
  events?: RunEvents;
  scrubber?: Scrubber;
  /** Clock in ms, for tests. Default `Date.now`. */
  now?: () => number;
}

export function createTwoFactor(o: TwoFactorOptions): TwoFactor {
  const scrubber = o.scrubber ?? new Scrubber();
  const now = o.now ?? Date.now;
  const emit = (e: RunEventInput): void => o.events?.emit(e);
  let key: Buffer | null = null;
  let attempts = 0;
  if (o.secret !== null && o.secret.trim() !== "") {
    key = parseSecret(o.secret);
    scrubber.addSecret(o.secret);
  }

  const count = (): void => {
    if (++attempts > MAX_TWOFA_ATTEMPTS) throw new TwoFactorError("too many 2FA attempts in this run");
  };

  async function ask<T>(kind: TwofaWait, call: (human: Human, signal: AbortSignal) => Promise<T>): Promise<T> {
    const human = o.human;
    if (human === null) throw new TwoFactorError(NO_HUMAN);
    const sec = Number.isFinite(o.timeoutSec) && o.timeoutSec > 0 ? o.timeoutSec : DEFAULT_TWOFA_TIMEOUT_SEC;
    const ms = Math.round(Math.min(sec, MAX_TWOFA_TIMEOUT_SEC) * 1000);
    // A ref'd timer (AbortSignal.timeout is unref'd, so a lone wait would let the process exit).
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), ms);
    const signal = AbortSignal.any([o.signal, timeout.signal]);
    emit({ type: "twofa:wait", kind, deadline: now() + ms });
    let outcome: "answered" | "cancelled" | "timeout" = "answered";
    try {
      return await call(human, signal);
    } catch (e) {
      if (o.signal.aborted) {
        outcome = "cancelled";
        throw new AbortedError();
      }
      if (e instanceof CancelledError) {
        outcome = "cancelled";
        throw new TwoFactorError("cancelled");
      }
      if (timeout.signal.aborted) {
        outcome = "timeout";
        throw new TwoFactorError("timed out waiting for the 2FA code");
      }
      throw e;
    } finally {
      clearTimeout(timer);
      emit({ type: "twofa:done", outcome });
    }
  }

  return {
    scrubber,
    async totp() {
      count();
      if (key === null) {
        const typed = await ask("secret", (h, signal) => h.secret(signal));
        try {
          key = parseSecret(typed);
        } catch {
          throw new TwoFactorError(BAD_SECRET);
        }
        scrubber.addSecret(typed);
      }
      const code = totpAt(key, now());
      scrubber.addCode(code);
      return code;
    },
    async code(kind) {
      count();
      const typed = (await ask(kind, (h, signal) => h.code(kind, signal))).trim();
      if (typed === "") throw new TwoFactorError("empty code");
      scrubber.addCode(typed);
      return typed;
    },
    async approve() {
      count();
      await ask("passkey", (h, signal) => h.approve(signal));
    },
  };
}

/** Static check of a `twofa` action's args; the message is the action's result. */
export function checkTwofaArgs(args: string[]): string | null {
  const kind = args[0];
  if (kind === "passkey") return args.length === 1 ? null : "error: twofa passkey takes no other argument";
  if (kind !== "totp" && kind !== "sms" && kind !== "email") {
    return `error: twofa needs a kind: ${TWOFA_KINDS.join(", ")}`;
  }
  if (args.length !== 2 || !REF.test(args[1])) return `error: twofa ${kind} needs the element ref of the code field`;
  return null;
}

/** A message when the env secret is set but unusable, so a run can refuse to start. */
export function secretProblem(env: Record<string, string | undefined>): string | null {
  const v = env[SECRET_ENV];
  if (v === undefined || v.trim() === "") return null;
  try {
    parseSecret(v);
    return null;
  } catch {
    return `${SECRET_ENV} is not a valid TOTP secret`;
  }
}
