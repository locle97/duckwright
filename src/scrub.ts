// Removes the TOTP secret and every 2FA code from text the run is about to keep or send.
import fs from "node:fs";
import path from "node:path";

export const CODE_MASK = "[2FA CODE]";
export const SECRET_MASK = "[REDACTED]";
/** A shorter value would mangle unrelated text. */
const MIN_CODE_LENGTH = 4;

const byLength = (values: Set<string>): string[] => [...values].sort((a, b) => b.length - a.length);

export class Scrubber {
  #codes = new Set<string>();
  #secrets = new Set<string>();

  get empty(): boolean {
    return this.#codes.size === 0 && this.#secrets.size === 0;
  }

  addCode(code: string): void {
    if (code.length >= MIN_CODE_LENGTH) this.#codes.add(code);
  }

  /** The secret as supplied, its compact upper-case base32 form, and the `secret` of an otpauth URI. */
  addSecret(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === "") return;
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

  scrub(text: string): string {
    if (this.empty) return text;
    let out = text;
    for (const s of byLength(this.#secrets)) out = out.split(s).join(SECRET_MASK);
    for (const c of byLength(this.#codes)) out = out.split(c).join(CODE_MASK);
    return out;
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
