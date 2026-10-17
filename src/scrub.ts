// Removes the TOTP secret and every 2FA code from text the run is about to keep or send.
import fs from "node:fs";
import path from "node:path";

export const CODE_MASK = "[2FA CODE]";
export const SECRET_MASK = "[REDACTED]";
/** A shorter value would mangle unrelated text. */
const MIN_CODE_LENGTH = 4;

/** The text a named secret is replaced with in recorded code. */
export const secretMarker = (id: string): string => `[SECRET ${id}.password]`;

/**
 * `value` as typed, as it appears inside a JSON string and a single-quoted JS string (the form
 * Playwright prints its code in), and URL-encoded (a captured login form or query), so an escaped
 * password is still found.
 */
export function secretForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  const single = json.replace(/\\"/g, '"').replace(/'/g, "\\'");
  const url = encodeURIComponent(value);
  const form = url.replace(/%20/g, "+");
  return [...new Set([value, json, single, url, form])];
}

export class Scrubber {
  #codes = new Set<string>();
  #secrets = new Set<string>();
  #named = new Map<string, string>();
  #cache: { re: RegExp; masks: Map<string, string> } | null = null;

  get empty(): boolean {
    return this.#codes.size === 0 && this.#secrets.size === 0 && this.#named.size === 0;
  }

  addCode(code: string): void {
    if (code.length >= MIN_CODE_LENGTH) {
      this.#codes.add(code);
      this.#cache = null;
    }
  }

  /** The secret as supplied, its compact upper-case base32 form, and the `secret` of an otpauth URI. */
  addSecret(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    this.#cache = null;
    this.#secrets.add(trimmed);
    const compact = trimmed.replace(/[\s-]/g, "").toUpperCase();
    if (compact !== trimmed) this.#secrets.add(compact);
    if (/^otpauth:\/\//i.test(trimmed)) {
      try {
        const inner = new URL(trimmed).searchParams.get("secret");
        if (inner) this.addSecret(inner);
      } catch {
        // an unparseable URI is still scrubbed as typed
      }
    }
  }

  /**
   * A value replaced with its own `marker` instead of the generic mask; any length. Its forms inside
   * a quoted string (as printed Playwright code shows it) or a URL-encoded form are replaced too.
   */
  addNamedSecret(value: string, marker: string): void {
    if (value === "") return;
    for (const form of secretForms(value)) this.#named.set(form, marker);
    this.#cache = null;
  }

  /** One longest-first alternation over every value, rebuilt only after an add. */
  #compiled(): { re: RegExp; masks: Map<string, string> } {
    if (this.#cache) return this.#cache;
    // Named marker wins over the generic mask, which wins over the code mask.
    const masks = new Map<string, string>();
    for (const c of this.#codes) masks.set(c, CODE_MASK);
    for (const v of this.#secrets) masks.set(v, SECRET_MASK);
    for (const [v, m] of this.#named) masks.set(v, m);
    const alt = [...masks.keys()].sort((x, y) => y.length - x.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.#cache = { re: new RegExp(alt.join("|"), "g"), masks };
    return this.#cache;
  }

  scrub(text: string): string {
    if (this.empty) return text;
    const { re, masks } = this.#compiled();
    // A single pass, so a mask is never itself matched by a shorter value.
    return text.replace(re, (m) => masks.get(m)!);
  }

  /** A copy of `value` with every string scrubbed; keys, numbers and booleans are kept. */
  deep<T>(value: T): T {
    if (this.empty) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.scrub(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      }
      return v;
    };
    return walk(value) as T;
  }
}

function entriesOf(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Rewrites every UTF-8 text file under `dir` in place. Binary and unreadable files are left alone. */
export function scrubTree(dir: string, scrubber: Scrubber): void {
  if (scrubber.empty) return;
  for (const entry of entriesOf(dir)) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scrubTree(p, scrubber);
      continue;
    }
    try {
      const bytes = fs.readFileSync(p);
      if (bytes.includes(0)) continue;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const clean = scrubber.scrub(text);
      if (clean !== text) fs.writeFileSync(p, clean);
    } catch {
      // not text, or unreadable: leave it
    }
  }
}
