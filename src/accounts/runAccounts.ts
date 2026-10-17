// The accounts one run may use: a read-only copy of an environment's accounts, optionally narrowed to
// the ids a task pinned. Secrets stay here; the agent only ever sees `promptText()`.
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

  /** Masks every account of the environment, pinned or not. */
  seed(s: Scrubber): void {
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
