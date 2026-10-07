// RFC 6238 time-based one-time passwords (HMAC-SHA1, 30-second step, 6 digits) from `node:crypto` only.
import { createHmac } from "node:crypto";

export class TotpSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpSecretError";
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const INVALID = "not a valid TOTP secret";

/** The key bytes of a base32 secret or an otpauth://totp URI. The error never quotes the input. */
export function parseSecret(input: string): Buffer {
  let raw = input.trim();
  if (/^otpauth:\/\//i.test(raw)) {
    let found: string | null = null;
    try {
      const uri = new URL(raw);
      if (uri.hostname.toLowerCase() === "totp") found = uri.searchParams.get("secret");
    } catch {
      found = null;
    }
    if (!found) throw new TotpSecretError(INVALID);
    raw = found;
  }
  const clean = raw.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean === "" || /[^A-Z2-7]/.test(clean)) throw new TotpSecretError(INVALID);
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = (acc << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  if (bytes.length === 0) throw new TotpSecretError(INVALID);
  return Buffer.from(bytes);
}

export function totpAt(key: Buffer, nowMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The current code for a secret exactly as the user supplied it. */
export function totpNow(secret: string, nowMs: number = Date.now()): string {
  return totpAt(parseSecret(secret), nowMs);
}
