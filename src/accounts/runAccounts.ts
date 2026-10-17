// The accounts one run may use: a read-only copy of an environment's accounts, optionally narrowed to
// the ids a task pinned. Secrets stay here; the agent only ever sees `promptText()`.
import { envLabel } from "../environment.ts";
import type { RunArgs } from "../args.ts";
import { Scrubber, secretMarker } from "../scrub.ts";
import type { Resolver } from "./placeholders.ts";
import { AccountError, AccountStore } from "./store.ts";
import type { Account } from "./store.ts";

export class RunAccounts implements Resolver {
  readonly env: string;
  readonly allowedOrigins: string[];
  readonly #all: Account[];
  readonly #visible: Map<string, Account>;

  constructor(env: string, all: Account[], visible: Account[], allowedOrigins: string[]) {
    this.env = env;
    this.#all = all;
    this.#visible = new Map(visible.map((a) => [a.id, a]));
    this.allowedOrigins = allowedOrigins;
  }

  get(id: string): { username: string; password: string } | null {
    const a = this.#visible.get(id);
    return a ? { username: a.username, password: a.password } : null;
  }

  totpSecret(id: string): string | null {
    return this.#visible.get(id)?.totpSecret ?? null;
  }

  has(id: string): boolean {
    return this.#visible.has(id);
  }

  /** What the agent is told: ids, labels, roles, usernames and whether a TOTP exists; never a secret. */
  promptText(): string {
    const lines = [...this.#visible.values()].map((a) => {
      const role = a.role === "" ? "" : ` (${a.role})`;
      return `- ${a.id}: ${a.label}${role} — username ${a.username}${a.totpSecret ? " — TOTP" : ""}`;
    });
    return [
      ...lines,
      "",
      "To log in, use {{<id>.username}} and {{<id>.password}} as fill or type arguments; the password placeholder must be the whole argument.",
      "Never type a password any other way, and never ask for one.",
      "For a TOTP prompt, use `twofa totp <ref> <id>`.",
      "To switch accounts, log out first.",
      "Never type a placeholder into a field that is not a login field.",
    ].join("\n");
  }

  /**
   * Masks every account of the environment, pinned or not. Placeholders (and the generic ones in
   * the rules text) are protected, so a short password never mangles one before it is substituted.
   */
  seed(s: Scrubber): void {
    for (const id of ["<id>", ...this.#all.map((a) => a.id)]) {
      s.addProtected(`{{${id}.username}}`);
      s.addProtected(`{{${id}.password}}`);
    }
    for (const a of this.#all) {
      s.addNamedSecret(a.password, secretMarker(a.id));
      if (a.totpSecret) s.addSecret(a.totpSecret);
    }
  }
}

/**
 * The accounts of `env` for a run, or null when there are none (and nothing is pinned).
 * Throws AccountError when a pinned id is missing or the environment has accounts but no base URL.
 */
export function loadRunAccounts(cwd: string, env: string, pinned: string[] | null): RunAccounts | null {
  const missing = (id: string) => new AccountError(`environment '${env}' has no account '${id}'`);
  const store = AccountStore.open(cwd, { create: false });
  if (store === null) {
    if (pinned !== null && pinned.length > 0) throw missing(pinned[0]!);
    return null;
  }
  let settings;
  let all: Account[];
  try {
    settings = store.envSettings(env);
    all = store.accounts(env);
  } finally {
    store.close();
  }
  if (all.length === 0) {
    if (pinned !== null && pinned.length > 0) throw missing(pinned[0]!);
    return null;
  }
  if (settings.baseUrl === null) throw new AccountError(`environment '${env}' has accounts but no base URL`);
  for (const id of pinned ?? []) if (!all.some((a) => a.id === id)) throw missing(id);
  const visible = pinned === null ? all : all.filter((a) => pinned.includes(a.id));
  const origins = [new URL(settings.baseUrl).origin, ...settings.loginOrigins];
  return new RunAccounts(env, all, visible, [...new Set(origins)]);
}

/** Why a run's accounts cannot be used (for preflight), or null. Reads the database only when the run has an environment. */
export function accountsProblem(args: RunArgs, cwd: string): string | null {
  const pinned = args.accounts !== null && args.accounts.length > 0;
  const env = envLabel(args.env);
  if (env === null || args.env === "none") {
    return pinned ? "accounts: needs an environment (set env: or --env)" : null;
  }
  try {
    loadRunAccounts(cwd, env, args.accounts);
  } catch (e) {
    if (e instanceof AccountError) return e.message;
    throw e;
  }
  return null;
}
