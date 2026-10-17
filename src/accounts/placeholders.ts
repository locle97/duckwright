/** Account placeholders (`{{<id>.username}}`, `{{<id>.password}}`) and the origin guard. */

export const PLACEHOLDER = /\{\{([a-z0-9-]+)\.(username|password)\}\}/g;

export interface Ref {
  id: string;
  field: "username" | "password";
}

/** What substitution needs from a run's accounts. */
export interface Resolver {
  get(id: string): { username: string; password: string } | null;
  allowedOrigins: readonly string[];
}

/** Every placeholder in `arg`, in order. */
export function findRefs(arg: string): Ref[] {
  return [...arg.matchAll(PLACEHOLDER)].map((m) => ({
    id: m[1]!,
    field: m[2] as Ref["field"],
  }));
}

/**
 * Replace placeholders in `args` (a new array; the input is not mutated).
 * Passwords must be the whole argument and only on an allowed origin;
 * usernames may be embedded and work on any origin. Errors start with
 * "error: " so they can be used directly as an action result.
 */
export function substitute(
  args: string[],
  r: Resolver | null,
  origin: string | null,
): { args: string[]; used: Ref[] } | { error: string } {
  const used: Ref[] = [];
  const out: string[] = [];
  for (const arg of args) {
    const refs = findRefs(arg);
    if (refs.length === 0) {
      out.push(arg);
      continue;
    }
    if (!r) return { error: "error: no accounts are configured for this run" };
    const values = new Map<string, string>();
    for (const ref of refs) {
      const acct = r.get(ref.id);
      if (!acct) return { error: `error: no account '${ref.id}' for this run` };
      if (ref.field === "password") {
        if (arg !== `{{${ref.id}.password}}`) {
          return { error: "error: a password placeholder must be the whole argument" };
        }
        if (origin === null) {
          return { error: "error: refusing to enter a password: no page origin" };
        }
        if (!r.allowedOrigins.includes(origin)) {
          return { error: `error: refusing to enter a password on ${origin}: not an allowed origin` };
        }
      }
      values.set(`${ref.id}.${ref.field}`, acct[ref.field]);
      used.push(ref);
    }
    out.push(arg.replace(PLACEHOLDER, (_m, id: string, f: string) => values.get(`${id}.${f}`)!));
  }
  return { args: out, used };
}
