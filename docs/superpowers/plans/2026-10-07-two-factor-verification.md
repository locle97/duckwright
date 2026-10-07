# Two-factor verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run can get past 2FA: a new `twofa` action has the harness generate a TOTP code, or ask the human for an SMS/email code or a passkey approval, in both print mode and `--tui`, with no secret or code ever written to disk.

**Architecture:** The agent loop and `execute()` only know a `TwoFactor` provider (`src/twofa.ts`), built per run from the env secret plus a front-end `Human` (a terminal reader in print mode, a `HumanBridge` answered by a masked dialog in the TUI). A per-run `Scrubber` (`src/scrub.ts`) removes the secret and every code from records, events, prompts and network files. The exporter turns `twofa totp` into an inline RFC 6238 helper and the human kinds into manual steps.

**Tech Stack:** TypeScript run directly by Node 22.18+ (type stripping: `import type`, `.ts` extensions, no enums or parameter properties), `node:test`, `node:crypto`, Ink (TUI). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-two-factor-verification-design.md`

## Interface notes (refinements of the spec's D7)

- `TwoFactor` methods carry no `signal` argument: the run's signal is bound when the provider is created (`createTwoFactor({ signal })`). A per-request signal (run signal + timeout) is handed to the front end's `Human`.
- `Human` (front-end hook): `secret(signal)`, `code(kind, signal)`, `approve(signal)`. A `Human` rejects with `AbortedError` when its signal aborts and with `CancelledError` when the user cancels.
- Provider methods are `totp()`, `code(kind)`, `approve()`, plus `scrubber`.

## Global Constraints

- Node `>=22.18`; ES modules; relative imports end in `.ts`; use `import type` for types (`verbatimModuleSyntax`); no enums, no constructor parameter properties (`erasableSyntaxOnly`).
- No new runtime or dev dependencies.
- The secret env var is exactly `DUCKWRIGHT_TOTP_SECRET`; the timeout option is `--twofa-timeout <sec>` (default `300`, task-file key `twofa-timeout`); at most 5 `twofa` actions per run.
- Masks: codes become `[2FA CODE]`, the secret becomes `[REDACTED]`; codes shorter than 4 characters are not scrubbed from free text.
- Error result strings, verbatim: `error: no way to ask for a code (stdin is not a terminal)`, `error: timed out waiting for the 2FA code`, `error: cancelled`, `error: not a valid TOTP secret`, `error: too many 2FA attempts in this run`. Preflight: `DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret`, exit code `2`.
- Tests: `npm test` runs `tsc` then `node --test`. Run `npm ci` once first. Every task ends with `npm test` green.
- Every commit message ends with these two lines (after a blank line):
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Juz6iELNz5aU8SHJqEEwHZ`

## Review Focus

Failure modes the spec implies that no single task's happy path exercises, most likely first:

1. A page echoes the code back (snapshot, tab list, a network URL): the next prompt, the step record, the events and `network/` files must show `[2FA CODE]`. Pinned in Task 5 (`twofa_codes_are_scrubbed…`, `twofa_codes_are_scrubbed_from_network…`) and Task 11 (leak test).
2. The user supplies the secret in a messy form (lowercase, spaces, dashes, `=` padding, an `otpauth://` URI): it still works and the secret is still scrubbed. Pinned in Task 1 and Task 2.
3. Ctrl-C or Stop while a prompt is open leaves the terminal in raw mode or a dialog on screen. Pinned in Task 7 (`abort_removes_listeners…`) and Task 9 (`abort_clears_pending`).
4. The human answers with an empty line. Pinned in Task 3 (`empty_code_is_refused`).
5. Two print-mode prompts in a row (batch), and two TUI runs asking at once. Pinned in Task 7 (`two_prompts_in_a_row`) and Task 10 (`second_request_queues`).

---

### Task 1: TOTP generator

**Files:**
- Create: `src/totp.ts`
- Test: `test/totp.test.ts`

**Interfaces:**
- Produces:
  - `class TotpSecretError extends Error` (message `not a valid TOTP secret`, never the input)
  - `parseSecret(input: string): Buffer` (base32 or `otpauth://totp/...?secret=...`)
  - `totpAt(key: Buffer, nowMs: number): string` (6 digits, SHA-1, 30 s)
  - `totpNow(secret: string, nowMs?: number): string`

- [ ] **Step 1: Install and get a green baseline**

Run: `npm ci && npm test`
Expected: all existing tests pass. If anything fails before you change code, stop and report it.

- [ ] **Step 2: Write the failing test**

Create `test/totp.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { TotpSecretError, parseSecret, totpAt, totpNow } from "../src/totp.ts";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890", reduced to 6 digits.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const VECTORS: [number, string][] = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
  [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
];

test("rfc6238_vectors", () => {
  for (const [seconds, expected] of VECTORS) {
    assert.equal(totpNow(RFC_SECRET, seconds * 1000), expected, `t=${seconds}`);
  }
});

test("code_is_stable_inside_a_step_and_changes_after", () => {
  const key = parseSecret(RFC_SECRET);
  assert.equal(totpAt(key, 30_000), totpAt(key, 59_999));
  assert.notEqual(totpAt(key, 59_999), totpAt(key, 60_000));
});

test("secret_forms_are_equivalent", () => {
  const expected = totpNow(RFC_SECRET, 59_000);
  assert.equal(totpNow("gezd gnbv-gy3tqojq GEZDGNBVGY3TQOJQ====", 59_000), expected);
  assert.equal(totpNow(`  ${RFC_SECRET}\n`, 59_000), expected);
  assert.equal(totpNow(`otpauth://totp/Acme:linh?secret=${RFC_SECRET}&issuer=Acme`, 59_000), expected);
  assert.equal(totpNow(`OTPAUTH://TOTP/x?issuer=Acme&secret=${RFC_SECRET}`, 59_000), expected);
});

test("invalid_secrets_throw_without_quoting_the_input", () => {
  for (const bad of ["", "   ", "abc!def", "otpauth://totp/x?issuer=y", "otpauth://", "1890"]) {
    assert.throws(() => parseSecret(bad), (e: unknown) =>
      e instanceof TotpSecretError && e.message === "not a valid TOTP secret" && !e.message.includes(bad.trim() || "\0"));
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/totp.test.ts`
Expected: FAIL with `Cannot find module '../src/totp.ts'`.

- [ ] **Step 4: Write the implementation**

Create `src/totp.ts`:

```ts
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
      found = new URL(raw).searchParams.get("secret");
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
```

- [ ] **Step 5: Run the test and the full suite**

Run: `node --test test/totp.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/totp.ts test/totp.test.ts
git commit -m "feat: RFC 6238 TOTP generator"
```

---

### Task 2: Scrubber

**Files:**
- Create: `src/scrub.ts`
- Test: `test/scrub.test.ts`

**Interfaces:**
- Produces:
  - `CODE_MASK = "[2FA CODE]"`, `SECRET_MASK = "[REDACTED]"`
  - `class Scrubber { get empty(): boolean; addCode(code: string): void; addSecret(raw: string): void; scrub(text: string): string; deep<T>(value: T): T }`
  - `scrubTree(dir: string, scrubber: Scrubber): void` (rewrites text files under `dir` in place)

- [ ] **Step 1: Write the failing test**

Create `test/scrub.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CODE_MASK, SECRET_MASK, Scrubber, scrubTree } from "../src/scrub.ts";
import { tmpDir } from "./helpers.ts";

const SECRET = "gezd gnbv GY3TQOJQ";

test("empty_scrubber_changes_nothing", () => {
  const s = new Scrubber();
  assert.equal(s.empty, true);
  const v = { a: ["123456"], n: 1 };
  assert.equal(s.deep(v), v);
  assert.equal(s.scrub("123456"), "123456");
});

test("codes_and_secret_are_masked_everywhere_in_a_string", () => {
  const s = new Scrubber();
  s.addCode("493817");
  s.addSecret(SECRET);
  assert.equal(s.scrub("fill('493817') 493817"), `fill('${CODE_MASK}') ${CODE_MASK}`);
  assert.equal(s.scrub(`key=${SECRET}`), `key=${SECRET_MASK}`);
});

test("secret_is_also_masked_in_its_compact_and_uri_forms", () => {
  const s = new Scrubber();
  s.addSecret("otpauth://totp/Acme:linh?secret=GEZDGNBVGY3TQOJQ&issuer=Acme");
  assert.equal(s.scrub("GEZDGNBVGY3TQOJQ"), SECRET_MASK);
  const t = new Scrubber();
  t.addSecret("gezd-gnbv gy3tqojq");
  assert.equal(t.scrub("GEZD-GNBV-GY3TQOJQ is not it, GEZDGNBVGY3TQOJQ is"), `GEZD-GNBV-GY3TQOJQ is not it, ${SECRET_MASK} is`);
});

test("short_codes_are_not_scrubbed_from_free_text", () => {
  const s = new Scrubber();
  s.addCode("123");
  assert.equal(s.empty, true);
  assert.equal(s.scrub("step 123 of 456"), "step 123 of 456");
});

test("longer_value_wins_over_a_shorter_one_it_contains", () => {
  const s = new Scrubber();
  s.addCode("1234");
  s.addCode("123456");
  assert.equal(s.scrub("x123456y1234"), `x${CODE_MASK}y${CODE_MASK}`);
});

test("deep_scrubs_strings_in_nested_values_and_leaves_numbers_and_keys", () => {
  const s = new Scrubber();
  s.addCode("493817");
  const out = s.deep({ 493817: "k", list: ["a 493817", { code: "493817" }], n: 493817, ok: true, none: null });
  assert.deepEqual(out, { 493817: "k", list: [`a ${CODE_MASK}`, { code: CODE_MASK }], n: 493817, ok: true, none: null });
});

test("scrub_tree_rewrites_text_files_and_skips_binary", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "request.json"), '{"url":"http://h/?c=493817"}');
  fs.writeFileSync(path.join(dir, "a", "b", "response-body.txt"), "code 493817");
  const bin = Buffer.concat([Buffer.from("493817"), Buffer.from([0, 1, 2])]);
  fs.writeFileSync(path.join(dir, "a", "body.bin"), bin);
  fs.writeFileSync(path.join(dir, "a", "clean.txt"), "nothing here");
  const s = new Scrubber();
  s.addCode("493817");
  scrubTree(dir, s);
  assert.equal(fs.readFileSync(path.join(dir, "a", "request.json"), "utf8"), `{"url":"http://h/?c=${CODE_MASK}"}`);
  assert.equal(fs.readFileSync(path.join(dir, "a", "b", "response-body.txt"), "utf8"), `code ${CODE_MASK}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, "a", "body.bin")), bin);
  assert.equal(fs.readFileSync(path.join(dir, "a", "clean.txt"), "utf8"), "nothing here");
});

test("scrub_tree_ignores_a_missing_folder", () => {
  const s = new Scrubber();
  s.addCode("493817");
  assert.doesNotThrow(() => scrubTree(path.join(tmpDir(), "nope"), s));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/scrub.test.ts`
Expected: FAIL with `Cannot find module '../src/scrub.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/scrub.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and the full suite**

Run: `node --test test/scrub.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scrub.ts test/scrub.test.ts
git commit -m "feat: scrubber for the TOTP secret and 2FA codes"
```

---

### Task 3: Events and the `TwoFactor` provider

**Files:**
- Modify: `src/events.ts`, `src/runs/past.ts`
- Create: `src/twofa.ts`
- Test: `test/twofa.test.ts`, `test/runs/past.test.ts`

**Interfaces:**
- Consumes: `parseSecret`, `totpAt`, `TotpSecretError` (Task 1); `Scrubber` (Task 2); `AbortedError` from `src/proc.ts`; `RunEventInput` from `src/events.ts`.
- Produces (from `src/events.ts`):
  - `type TwofaWait = "secret" | "sms" | "email" | "passkey"`
  - new `RunEvent` members `{ type: "twofa:wait"; at: number; kind: TwofaWait; deadline: number }` and `{ type: "twofa:done"; at: number; outcome: "answered" | "cancelled" | "timeout" }`
- Produces (from `src/twofa.ts`):
  - `SECRET_ENV`, `TWOFA_KINDS`, `MAX_TWOFA_ATTEMPTS`, `NO_HUMAN`
  - `class TwoFactorError extends Error`, `class CancelledError extends Error`
  - `interface Human { secret(signal: AbortSignal): Promise<string>; code(kind: "sms" | "email", signal: AbortSignal): Promise<string>; approve(signal: AbortSignal): Promise<void> }`
  - `interface TwoFactor { readonly scrubber: Scrubber; totp(): Promise<string>; code(kind: "sms" | "email"): Promise<string>; approve(): Promise<void> }`
  - `createTwoFactor(o: { secret: string | null; human: Human | null; timeoutSec: number; signal: AbortSignal; events?: RunEvents; scrubber?: Scrubber; now?: () => number }): TwoFactor`
  - `checkTwofaArgs(args: string[]): string | null`
  - `secretProblem(env: Record<string, string | undefined>): string | null`

- [ ] **Step 1: Write the failing tests**

Create `test/twofa.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { RunEvents } from "../src/events.ts";
import type { RunEvent } from "../src/events.ts";
import { AbortedError } from "../src/proc.ts";
import {
  CancelledError, MAX_TWOFA_ATTEMPTS, NO_HUMAN, SECRET_ENV, TwoFactorError, checkTwofaArgs, createTwoFactor, secretProblem,
} from "../src/twofa.ts";
import type { Human } from "../src/twofa.ts";
import { CODE_MASK } from "../src/scrub.ts";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const AT_59 = "287082"; // the RFC 6238 code for t=59 s

function human(over: Partial<Human> = {}): Human & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    secret: async () => { asked.push("secret"); return SECRET; },
    code: async (kind) => { asked.push(kind); return "493817"; },
    approve: async () => { asked.push("passkey"); },
    ...over,
  };
}

const hangs = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new AbortedError()), { once: true }));

const make = (o: Partial<Parameters<typeof createTwoFactor>[0]> = {}) =>
  createTwoFactor({ secret: null, human: null, timeoutSec: 5, signal: new AbortController().signal, now: () => 59_000, ...o });

test("totp_uses_the_env_secret_without_asking_and_scrubs_the_code", async () => {
  const h = human();
  const tf = make({ secret: SECRET, human: h });
  assert.equal(await tf.totp(), AT_59);
  assert.deepEqual(h.asked, []);
  assert.equal(tf.scrubber.scrub(`fill('${AT_59}') ${SECRET}`), `fill('${CODE_MASK}') [REDACTED]`);
});

test("totp_works_with_no_human_when_the_env_secret_is_set", async () => {
  assert.equal(await make({ secret: SECRET }).totp(), AT_59);
});

test("totp_asks_for_the_secret_once_and_keeps_it_in_memory", async () => {
  const h = human();
  const tf = make({ human: h });
  assert.equal(await tf.totp(), AT_59);
  assert.equal(await tf.totp(), AT_59);
  assert.deepEqual(h.asked, ["secret"]);
  assert.equal(tf.scrubber.scrub(SECRET), "[REDACTED]");
});

test("a_bad_typed_secret_is_refused_without_quoting_it", async () => {
  const tf = make({ human: human({ secret: async () => "hunter2!" }) });
  await assert.rejects(tf.totp(), (e: unknown) =>
    e instanceof TwoFactorError && e.message === "not a valid TOTP secret" && !e.message.includes("hunter2"));
});

test("an_invalid_env_secret_throws_when_the_provider_is_built", () => {
  assert.throws(() => make({ secret: "!!" }), /not a valid TOTP secret/);
});

test("sms_and_email_codes_come_from_the_human_and_are_scrubbed", async () => {
  const h = human();
  const tf = make({ human: h });
  assert.equal(await tf.code("sms"), "493817");
  assert.equal(await tf.code("email"), "493817");
  assert.deepEqual(h.asked, ["sms", "email"]);
  assert.equal(tf.scrubber.scrub("got 493817"), `got ${CODE_MASK}`);
});

test("empty_code_is_refused", async () => {
  const tf = make({ human: human({ code: async () => "   " }) });
  await assert.rejects(tf.code("sms"), (e: unknown) => e instanceof TwoFactorError && /empty/.test(e.message));
});

test("passkey_waits_for_the_human", async () => {
  const h = human();
  await make({ human: h }).approve();
  assert.deepEqual(h.asked, ["passkey"]);
});

test("no_human_means_a_clear_error_for_every_human_call", async () => {
  const tf = make();
  for (const call of [() => tf.totp(), () => tf.code("sms"), () => tf.approve()]) {
    await assert.rejects(call(), (e: unknown) => e instanceof TwoFactorError && e.message === NO_HUMAN);
  }
});

test("a_human_wait_times_out_and_emits_wait_then_done", async () => {
  const events = new RunEvents();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const tf = make({ human: human({ code: (_k, signal) => hangs(signal) }), timeoutSec: 0.05, events });
  await assert.rejects(tf.code("sms"), (e: unknown) =>
    e instanceof TwoFactorError && e.message === "timed out waiting for the 2FA code");
  assert.deepEqual(seen.map((e) => e.type), ["twofa:wait", "twofa:done"]);
  assert.equal(seen[0].type === "twofa:wait" && seen[0].kind, "sms");
  assert.equal(seen[1].type === "twofa:done" && seen[1].outcome, "timeout");
});

test("aborting_the_run_rejects_with_aborted_error", async () => {
  const run = new AbortController();
  const tf = make({ human: human({ code: (_k, signal) => hangs(signal) }), signal: run.signal });
  const p = tf.code("sms");
  run.abort();
  await assert.rejects(p, AbortedError);
});

test("cancel_becomes_an_error_result", async () => {
  const tf = make({ human: human({ approve: async () => { throw new CancelledError(); } }) });
  await assert.rejects(tf.approve(), (e: unknown) => e instanceof TwoFactorError && e.message === "cancelled");
});

test("the_sixth_attempt_is_refused", async () => {
  const tf = make({ human: human() });
  for (let i = 0; i < MAX_TWOFA_ATTEMPTS; i++) await tf.code("sms");
  await assert.rejects(tf.code("sms"), (e: unknown) =>
    e instanceof TwoFactorError && e.message === "too many 2FA attempts in this run");
});

test("check_twofa_args", () => {
  assert.equal(checkTwofaArgs(["totp", "e12"]), null);
  assert.equal(checkTwofaArgs(["sms", "f1e3"]), null);
  assert.equal(checkTwofaArgs(["email", "e1"]), null);
  assert.equal(checkTwofaArgs(["passkey"]), null);
  assert.equal(checkTwofaArgs([]), "error: twofa needs a kind: totp, sms, email, passkey");
  assert.equal(checkTwofaArgs(["fax", "e1"]), "error: twofa needs a kind: totp, sms, email, passkey");
  assert.equal(checkTwofaArgs(["totp"]), "error: twofa totp needs the element ref of the code field");
  assert.equal(checkTwofaArgs(["sms", "e1", "x"]), "error: twofa sms needs the element ref of the code field");
  assert.equal(checkTwofaArgs(["totp", "e1; rm -rf"]), "error: twofa totp needs the element ref of the code field");
  assert.equal(checkTwofaArgs(["passkey", "e1"]), "error: twofa passkey takes no other argument");
});

test("secret_problem", () => {
  assert.equal(secretProblem({}), null);
  assert.equal(secretProblem({ [SECRET_ENV]: "" }), null);
  assert.equal(secretProblem({ [SECRET_ENV]: SECRET }), null);
  assert.equal(secretProblem({ [SECRET_ENV]: "!!" }), "DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret");
});
```

Append to `test/runs/past.test.ts` (match its existing imports; it already imports `readEventsJsonl` or the module's helpers — if not, add `import { readEventsJsonl } from "../../src/runs/past.ts";`):

```ts
test("events_jsonl_accepts_twofa_events", () => {
  const end = { type: "run:end", at: 3, outcome: { status: "pass", exitCode: 0, success: true, answer: "a", steps: 0, costUsd: 0, historyPath: null, export: { kind: "off" }, warnings: [], error: null } };
  const text = [
    { type: "twofa:wait", at: 1, kind: "sms", deadline: 301000 },
    { type: "twofa:done", at: 2, outcome: "answered" },
    end,
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  assert.equal(readEventsJsonl(text)?.length, 3);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/twofa.test.ts test/runs/past.test.ts`
Expected: FAIL (`Cannot find module '../src/twofa.ts'`; the past test returns null).

- [ ] **Step 3: Add the events**

In `src/events.ts`, after the `ExportOutcome` type add:

```ts
/** What a 2FA wait is for: the TOTP secret itself, a code the human types, or a passkey approval. */
export type TwofaWait = "secret" | "sms" | "email" | "passkey";
```

and add two members to the `RunEvent` union, before `control`:

```ts
  | { type: "twofa:wait"; at: number; kind: TwofaWait; deadline: number }
  | { type: "twofa:done"; at: number; outcome: "answered" | "cancelled" | "timeout" }
```

In `src/runs/past.ts`, extend `EVENT_TYPES` with `"twofa:wait", "twofa:done"`, and exempt them from the `step` check:

```ts
const EVENT_TYPES = new Set([
  "run:start", "step:start", "phase", "decision", "action:start", "action:result",
  "brain:error", "step:end", "control", "twofa:wait", "twofa:done", "run:end",
]);
```
```ts
    if (v.type !== "run:start" && v.type !== "run:end" && v.type !== "control" && v.type !== "step:end"
      && v.type !== "twofa:wait" && v.type !== "twofa:done" && typeof v.step !== "number") return null;
```

In `src/tui/state.ts`, inside `reduceRunEvent`, add before `case "control"`:

```ts
    case "twofa:wait":
    case "twofa:done":
      return r;
```

- [ ] **Step 4: Write the provider**

Create `src/twofa.ts`:

```ts
// 2FA for a run: where the code comes from (the env secret, or a human), how long to wait for a
// human, and how many tries. Front ends only supply a Human; nothing here knows about terminals or Ink.
import type { RunEvents, RunEventInput, TwofaWait } from "./events.ts";
import { AbortedError } from "./proc.ts";
import { Scrubber } from "./scrub.ts";
import { parseSecret, totpAt } from "./totp.ts";

export const SECRET_ENV = "DUCKWRIGHT_TOTP_SECRET";
export const TWOFA_KINDS = ["totp", "sms", "email", "passkey"] as const;
export const MAX_TWOFA_ATTEMPTS = 5;
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
    const ms = Math.round(o.timeoutSec * 1000);
    const timeout = AbortSignal.timeout(ms);
    const signal = AbortSignal.any([o.signal, timeout]);
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
      if (timeout.aborted) {
        outcome = "timeout";
        throw new TwoFactorError("timed out waiting for the 2FA code");
      }
      throw e;
    } finally {
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
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `node --test test/twofa.test.ts test/runs/past.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/runs/past.ts src/tui/state.ts src/twofa.ts test/twofa.test.ts test/runs/past.test.ts
git commit -m "feat: TwoFactor provider and twofa run events"
```

---

### Task 4: The `twofa` action, schema and system prompt

**Files:**
- Modify: `src/brain.ts`, `src/actions.ts`, `prompts/system.md`
- Test: `test/actions.test.ts`, `test/prompt.test.ts` (and `test/brain.test.ts` passes unchanged: it already checks the schema's commands equal `ALLOWED_COMMANDS`)

**Interfaces:**
- Consumes: `TwoFactor`, `TwoFactorError`, `checkTwofaArgs` (Task 3); `Scrubber` via `TwoFactor.scrubber` (Task 2).
- Produces: `execute(pw, actions, codes?, hooks?, requests?, call?, twofa?: TwoFactor | null)`: a `twofa` action fills the code field and submits (`playwright-cli fill <ref> <code> --submit`); `passkey` only waits for approval. The result is `ok` or an `error:` string with no code in it; the recorded code is scrubbed.

- [ ] **Step 1: Write the failing tests**

Append to `test/actions.test.ts` (it already has `A`, `makePw`, `execute`; add the imports at the top):

```ts
import { createTwoFactor } from "../src/twofa.ts";
import type { Human } from "../src/twofa.ts";
```

```ts
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const FILL_OUT = "### Ran Playwright code\n```js\nawait page.getByLabel('Code').fill('287082');\n```\n";
const tf = (human: Human | null = null, secret: string | null = SECRET) =>
  createTwoFactor({ secret, human, timeoutSec: 5, signal: new AbortController().signal, now: () => 59_000 });
const sayHuman = (code: string): Human => ({ secret: async () => SECRET, code: async () => code, approve: async () => {} });

test("twofa_totp_fills_and_submits_and_never_exposes_the_code", async () => {
  const [pw, calls] = makePw(0, "", FILL_OUT);
  const codes: (string | null)[] = [];
  const { results } = await execute(pw, [A("twofa", "totp", "e5")], codes, undefined, null, null, tf());
  assert.deepEqual(calls, [["fill", ["e5", "287082", "--submit"]]]);
  assert.deepEqual(results, ["ok"]);
  assert.deepEqual(codes, ["await page.getByLabel('Code').fill('[2FA CODE]');"]);
});

test("twofa_sms_uses_the_human_code", async () => {
  const [pw, calls] = makePw(0, "", FILL_OUT.replace("287082", "493817"));
  const codes: (string | null)[] = [];
  const { results } = await execute(pw, [A("twofa", "sms", "e5")], codes, undefined, null, null, tf(sayHuman("493817")));
  assert.deepEqual(calls, [["fill", ["e5", "493817", "--submit"]]]);
  assert.deepEqual(results, ["ok"]);
  assert.deepEqual(codes, ["await page.getByLabel('Code').fill('[2FA CODE]');"]);
});

test("twofa_passkey_waits_for_approval_and_runs_no_browser_command", async () => {
  const [pw, calls] = makePw();
  const { results } = await execute(pw, [A("twofa", "passkey")], undefined, undefined, null, null, tf(sayHuman("x")));
  assert.deepEqual(results, ["ok"]);
  assert.deepEqual(calls, []);
});

test("twofa_is_page_changing_so_later_actions_are_skipped", async () => {
  const [pw, calls] = makePw(0, "", FILL_OUT);
  const { results } = await execute(pw, [A("twofa", "totp", "e5"), A("click", "e9")], undefined, undefined, null, null, tf());
  assert.deepEqual(results, ["ok", "skipped: page may have changed"]);
  assert.equal(calls.length, 1);
});

test("twofa_fill_failure_is_an_error_without_the_code", async () => {
  const [pw] = makePw(1, "no element 287082", "");
  const codes: (string | null)[] = [];
  const { results } = await execute(pw, [A("twofa", "totp", "e5")], codes, undefined, null, null, tf());
  assert.deepEqual(results, ["error: no element [2FA CODE]"]);
  assert.deepEqual(codes, [null]);
});

test("twofa_without_a_human_reports_it", async () => {
  const [pw, calls] = makePw();
  const { results } = await execute(pw, [A("twofa", "sms", "e5")], undefined, undefined, null, null, tf(null, null));
  assert.deepEqual(results, ["error: no way to ask for a code (stdin is not a terminal)"]);
  assert.deepEqual(calls, []);
});

test("twofa_without_a_provider_is_an_error", async () => {
  const [pw] = makePw();
  const { results } = await execute(pw, [A("twofa", "totp", "e5")]);
  assert.deepEqual(results, ["error: 2FA is not available in this run"]);
});

test("twofa_bad_args_are_rejected_before_anything_runs", async () => {
  const [pw, calls] = makePw();
  const { results } = await execute(pw, [A("twofa"), A("twofa", "totp"), A("twofa", "passkey", "e1")], undefined, undefined, null, null, tf());
  assert.deepEqual(results, [
    "error: twofa needs a kind: totp, sms, email, passkey",
    "error: twofa totp needs the element ref of the code field",
    "error: twofa passkey takes no other argument",
  ]);
  assert.deepEqual(calls, []);
});

test("twofa_bad_args_after_a_page_change_still_report_the_rejection", async () => {
  const [pw] = makePw();
  const { results } = await execute(pw, [A("goto", "x"), A("twofa", "fax", "e1")], undefined, undefined, null, null, tf());
  assert.deepEqual(results, ["ok", "error: twofa needs a kind: totp, sms, email, passkey"]);
});

test("twofa_total_is_capped_at_five", async () => {
  const [pw] = makePw(0, "", FILL_OUT);
  const t = tf();
  for (let i = 0; i < 5; i++) await execute(pw, [A("twofa", "totp", "e5")], undefined, undefined, null, null, t);
  const { results } = await execute(pw, [A("twofa", "totp", "e5")], undefined, undefined, null, null, t);
  assert.deepEqual(results, ["error: too many 2FA attempts in this run"]);
});
```

Append to `test/prompt.test.ts`:

```ts
test("system_md_documents_twofa", () => {
  const md = fs.readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");
  assert.match(md, /goto, click, .*request, twofa, done\./);
  assert.ok(md.includes("## Two-factor verification"));
  assert.ok(md.includes('"args": ["totp", "e15"]'));
  assert.ok(md.includes('"args": ["passkey"]'));
  assert.ok(md.includes("never type or guess a code"));
  assert.ok(md.includes("A page-changing action (goto, click, press, tab-new, tab-select, tab-close, go-back, twofa)"));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/actions.test.ts test/prompt.test.ts`
Expected: FAIL (`twofa` is not an allowed command; the prompt lacks the section).

- [ ] **Step 3: Schema and command list**

In `src/brain.ts`, add `"twofa"` before `"done"` in `ALLOWED_COMMANDS`:

```ts
  "screenshot", "expect", "expect-request", "request", "twofa", "done",
```

Extend the generic branch's filter:

```ts
                enum: ALLOWED_COMMANDS.filter((c) => c !== "done" && c !== "expect" && c !== "expect-request" && c !== "request" && c !== "twofa"),
```

and add this branch at the end of the `anyOf` array (after the `request` branch):

```ts
          // twofa: a kind, then the code field's ref (none for passkey); twofa.ts checks the shape.
          {
            type: "object",
            required: ["cmd", "args"],
            properties: {
              cmd: { const: "twofa" },
              args: {
                type: "array",
                items: { type: "string" },
                contains: { enum: ["totp", "sms", "email", "passkey"] },
                minItems: 1,
                maxItems: 2,
              },
            },
          },
```

- [ ] **Step 4: The action**

In `src/actions.ts`:

1. Add imports:

```ts
import { TwoFactorError, checkTwofaArgs } from "./twofa.ts";
import type { TwoFactor } from "./twofa.ts";
```

2. Add `"twofa"` to `PAGE_CHANGING`:

```ts
export const PAGE_CHANGING: ReadonlySet<string> = new Set([
  "goto", "click", "press", "tab-new", "tab-select", "tab-close", "go-back", "twofa",
]);
```

3. In `rejection()`, after the `request` line:

```ts
  if (a.cmd === "twofa") return checkTwofaArgs(a.args);
```

4. Add this function above `execute`:

```ts
/** Run one `twofa` action: [result, recorded code]. Neither ever contains the code itself. */
async function runTwofa(pw: PlaywrightCLI, tf: TwoFactor | null, args: string[]): Promise<[string, string | null]> {
  if (tf === null) return ["error: 2FA is not available in this run", null];
  const kind = args[0];
  try {
    if (kind === "passkey") {
      await tf.approve();
      return ["ok", null];
    }
    const code = kind === "totp" ? await tf.totp() : await tf.code(kind as "sms" | "email");
    const res = await pw.run("fill", [args[1], code, "--submit"]);
    if (res.code !== 0) return [tf.scrubber.scrub(`error: ${res.stderr.trim() || res.stdout.trim()}`), null];
    const ran = extractCode(res.stdout);
    return ["ok", ran === null ? null : tf.scrubber.scrub(ran)];
  } catch (e) {
    // AbortedError and anything unexpected propagate: the run stops.
    if (e instanceof TwoFactorError) return [`error: ${e.message}`, null];
    throw e;
  }
}
```

5. Extend the `execute` signature and add the branch (before the `const res = await pw.run(a.cmd, a.args);` line):

```ts
export async function execute(
  pw: PlaywrightCLI, actions: Action[], codes?: (string | null)[], hooks?: ExecuteHooks,
  requests?: RequestContext | null, call?: RequestCallContext | null, twofa?: TwoFactor | null,
): Promise<Executed> {
```
```ts
    if (a.cmd === "twofa") {
      const [result, code] = await runTwofa(pw, twofa ?? null, a.args);
      results.push(clip(result));
      if (code !== null) ran.set(i, code);
      // The form was submitted, so the page may have changed.
      if (result === "ok" && a.args[0] !== "passkey") skip = "skipped: page may have changed";
      return;
    }
```

Also update the doc comment above `execute`: add "`twofa` supplies 2FA codes for `twofa` actions." after the `call` line.

- [ ] **Step 5: The system prompt**

In `prompts/system.md`:

1. In the `## Commands` paragraph, change `expect, expect-request, request, done.` to `expect, expect-request, request, twofa, done.`
2. In `## Actions per step`, change `(goto, click, press, tab-new, tab-select, tab-close, go-back)` to `(goto, click, press, tab-new, tab-select, tab-close, go-back, twofa)`.
3. Insert this section immediately before `## Finishing`:

```markdown
## Two-factor verification

When the page asks for a verification code (an authenticator app code, or a code sent by SMS or email) or for a passkey, use `twofa`. The harness gets the code and enters it for you: never type or guess a code with `fill`. Args are the kind, then the ref of the code field:
- `{"cmd": "twofa", "args": ["totp", "e15"]}`: an authenticator app code
- `{"cmd": "twofa", "args": ["sms", "e15"]}` or `{"cmd": "twofa", "args": ["email", "e15"]}`: a code the user is asked to type in
- `{"cmd": "twofa", "args": ["passkey"]}`: the user approves the passkey prompt on their device

For a code kind the harness fills the field and submits the form, so `twofa` is page-changing: put it last in the step and read the page again afterwards. If it returns an error such as no way to ask for a code, a timeout or a cancel, do not retry: finish with `done failure` and say why. If the page rejects a code, you may try once more.
```

- [ ] **Step 6: Run the tests and the full suite**

Run: `node --test test/actions.test.ts test/prompt.test.ts test/brain.test.ts && npm test`
Expected: PASS. `npm test` also type-checks `actions.ts`'s new `execute` parameter against `loop.ts` (still compiles: the new parameter is optional).

- [ ] **Step 7: Commit**

```bash
git add src/brain.ts src/actions.ts prompts/system.md test/actions.test.ts test/prompt.test.ts
git commit -m "feat: twofa action (TOTP, SMS, email, passkey)"
```

---

### Task 5: Scrub records, events, prompts and network files in the agent loop

**Files:**
- Modify: `src/loop.ts`
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: `TwoFactor` (Task 3), `Scrubber.scrub/deep/empty`, `scrubTree` (Task 2), `networkDir` from `src/network.ts`, `execute(..., twofa)` (Task 4).
- Produces: `AgentOptions.twofa?: TwoFactor`. With it, the prompt sent to the brain, the `action:result` events, the `StepRecord` (results, codes, network entries, network errors), this step's `network/<id>/` files and the final answer are scrubbed.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `test/loop.test.ts`:

```ts
import { createTwoFactor } from "../src/twofa.ts";
```

Append (the file already defines `FakePW`, `NetPW`, `FakeBrain`, `dec`, `agent`, `tmpDir`):

```ts
const TF_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TF_CODE = "287082"; // the RFC 6238 code at t=59 s
const ECHO = `### Ran Playwright code\n\`\`\`js\nawait page.getByLabel('Code').fill('${TF_CODE}');\n\`\`\`\n`;
const twofa = () => createTwoFactor({
  secret: TF_SECRET, human: null, timeoutSec: 5, signal: new AbortController().signal, now: () => 59_000,
});

test("twofa_codes_are_scrubbed_from_records_events_and_prompts", async () => {
  // Every playwright-cli reply echoes the code, as a page that shows what you typed would.
  const pw = new FakePW({ runStdout: ECHO });
  const brain = new FakeBrain([dec([["twofa", ["totp", "e1"]]]), dec([["done", ["success", "ok"]]])]);
  const events = new RunEvents();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const r = await agent(pw, brain, { twofa: twofa(), events }).run();
  assert.equal(r.success, true);
  assert.deepEqual(r.history[0].results, ["ok"]);
  assert.deepEqual(r.history[0].codes, ["await page.getByLabel('Code').fill('[2FA CODE]');"]);
  assert.ok(!brain.prompts[1].includes(TF_CODE), "the next prompt is clean");
  assert.ok(brain.prompts[1].includes("[2FA CODE]"));
  const blob = JSON.stringify([r, seen]);
  assert.ok(!blob.includes(TF_CODE), "records and events are clean");
  assert.ok(!blob.includes(TF_SECRET));
});

test("twofa_codes_are_scrubbed_from_the_final_answer", async () => {
  const pw = new FakePW({ runStdout: ECHO });
  const brain = new FakeBrain([dec([["twofa", ["totp", "e1"]]]), dec([["done", ["success", `code was ${TF_CODE}`]]])]);
  const r = await agent(pw, brain, { twofa: twofa() }).run();
  assert.equal(r.answer, "code was [2FA CODE]");
});

test("twofa_codes_are_scrubbed_from_network_entries_and_files", async () => {
  class EchoNet extends NetPW {
    override async run(cmd: string, args: string[]): Promise<ProcResult> {
      if (cmd === "requests" && args[0] !== "--clear") {
        return { code: 0, stdout: `### Result\n1. [GET] http://h/a?c=${TF_CODE} => [200] OK\n`, stderr: "" };
      }
      return super.run(cmd, args);
    }
  }
  const workdir = tmpDir();
  const r = await agent(new EchoNet({ runStdout: ECHO }), new FakeBrain([dec([["twofa", ["totp", "e1"]]]), dec([["done", ["success", "ok"]]])]),
    { network: true, workdir, twofa: twofa() }).run();
  assert.equal(r.history[0].network?.[0].url, "http://h/a?c=[2FA CODE]");
  const file = fs.readFileSync(path.join(workdir, "network", "0001", "request.json"), "utf8");
  assert.ok(!file.includes(TF_CODE));
  assert.ok(file.includes("[2FA CODE]"));
});

test("without_twofa_nothing_is_scrubbed", async () => {
  const brain = new FakeBrain([dec([["done", ["success", TF_CODE]]])]);
  const r = await agent(new FakePW(), brain).run();
  assert.equal(r.answer, TF_CODE);
});
```

(`RunEvents`, `RunEvent`, `ProcResult`, `fs` and `path` are already imported at the top of `test/loop.test.ts`; if `ProcResult` is only a type import, keep it as `import type`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/loop.test.ts`
Expected: FAIL (`twofa` is not an `AgentOptions` field, and the code leaks).

- [ ] **Step 3: Wire it in**

In `src/loop.ts`:

1. Imports:

```ts
import path from "node:path";
```
```ts
import { captureStep, clearRequests, currentOrigin, networkDir } from "./network.ts";
```
```ts
import { scrubTree } from "./scrub.ts";
import type { TwoFactor } from "./twofa.ts";
```

2. `AgentOptions` gets `twofa?: TwoFactor;`. The `Agent` class gets `readonly twofa: TwoFactor | undefined;` and in the constructor `this.twofa = opts.twofa;`.

3. Add a method to `Agent` (above `private record`):

```ts
  /** Removes the TOTP secret and every code handed out so far; identity when there is no 2FA. */
  private scrub = (text: string): string => (this.twofa ? this.twofa.scrubber.scrub(text) : text);
```

4. In `loop()`, scrub the prompt right before `decide`:

```ts
      const prompt = this.scrub(buildPrompt(this.task, step, this.maxSteps, history, memory, obs, { nudge, paste }));
```

5. Pass the provider to `execute` and scrub the live events:

```ts
      const { results, done, origins } = await execute(this.pw, decision.actions, codes, {
        start: (index) => this.events.emit({ type: "action:start", step, index }),
        result: (index, result, code) => this.events.emit({
          type: "action:result", step, index, result: this.scrub(result), code: code === null ? null : this.scrub(code),
        }),
      }, requestCtx, callCtx, this.twofa ?? null);
      const rec: StepRecord = {
        step, decision, results: results.map(this.scrub), codes: codes.map((c) => (c === null ? null : this.scrub(c))),
      };
```
(replace the existing `const rec: StepRecord = { step, decision, results, codes };`)

6. After `const cap = await captureStep(...)` and `this.nextNetworkId = cap.nextId;`, replace the lines that set `rec.network` and the errors with scrubbed versions and scrub this step's files:

```ts
        const scrubber = this.twofa?.scrubber;
        const entries = scrubber ? scrubber.deep(cap.entries) : cap.entries;
        if (scrubber && !scrubber.empty) {
          for (const e of cap.entries) scrubTree(path.join(networkDir(this.workdir), e.id), scrubber);
        }
        const errs = [...this.pendingNetworkErrors, ...cap.errors].map(this.scrub);
        this.pendingNetworkErrors = [];
        rec.network = entries;
        if (errs.length) rec.networkErrors = errs;
```

7. The final answer:

```ts
      if (done !== null) return { success: done.success, answer: this.scrub(done.answer), steps, costUsd: this.costUsd, history };
```

`scrub` is an arrow-function class field, so `results.map(this.scrub)` keeps `this`.

- [ ] **Step 4: Run the tests and the full suite**

Run: `node --test test/loop.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop.ts test/loop.test.ts
git commit -m "feat: scrub 2FA codes from prompts, records, events and network files"
```

---

### Task 6: `--twofa-timeout`, task-file key and run wiring

**Files:**
- Modify: `src/args.ts`, `src/taskfile.ts`, `src/runs/run.ts`
- Test: `test/args.test.ts`, `test/taskfile.test.ts`, `test/runs/run.test.ts`

**Interfaces:**
- Consumes: `createTwoFactor`, `SECRET_ENV`, `Human` (Task 3); `AgentOptions.twofa` (Task 5).
- Produces:
  - `RunArgs.twofaTimeout: number` (default `300`), `--twofa-timeout <sec>` (integer >= 1), task-file key `twofa-timeout`
  - `RunDeps.humanFor?(ctx: { signal: AbortSignal; events: RunEvents }): Human | null` and `RunDeps.env?: Record<string, string | undefined>`
  - `startRun` builds one `TwoFactor` per run and passes it as `AgentOptions.twofa`

- [ ] **Step 1: Write the failing tests**

Append to `test/args.test.ts` (it has `parse` and `args()` helpers):

```ts
test("twofa_timeout_default_and_flag", () => {
  assert.equal(parse("t").twofaTimeout, 300);
  assert.equal(parse("t", "--twofa-timeout", "60").twofaTimeout, 60);
  assert.equal(parse("t", "--twofa-timeout=90").twofaTimeout, 90);
});

test("twofa_timeout_must_be_a_positive_int", () => {
  assert.throws(() => parse("t", "--twofa-timeout", "0"), /argument --twofa-timeout: must be at least 1/);
  assert.throws(() => parse("t", "--twofa-timeout", "soon"), /argument --twofa-timeout: invalid int value: 'soon'/);
  assert.throws(() => parse("t", "--twofa-timeout"), /argument --twofa-timeout: expected one argument/);
});
```

Append to `test/taskfile.test.ts` (reuse its existing helper for loading a task file from text; if it writes a file with `loadTaskFile`, follow that pattern):

```ts
test("front_matter_twofa_timeout", () => {
  const dir = tmpDir();
  const file = path.join(dir, "t.md");
  fs.writeFileSync(file, "---\ntwofa-timeout: 45\n---\nlog in\n");
  assert.equal(loadTaskFile(file).settings.twofaTimeout, 45);
  fs.writeFileSync(file, "---\ntwofa-timeout: 0\n---\nlog in\n");
  assert.throws(() => loadTaskFile(file), /twofa-timeout must be a whole number of at least 1/);
});
```

Append to `test/runs/run.test.ts`:

```ts
import { RunEvents } from "../../src/events.ts";
import type { Human } from "../../src/twofa.ts";
```
(add `RunEvents` only if not already imported)

```ts
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("run_gives_the_agent_a_twofa_provider_built_from_the_env_secret", async () => {
  let code = "";
  const { spec, deps } = setup(agentWith(async (opts) => {
    code = await opts.twofa!.totp();
    return result(true);
  }));
  deps.env = { DUCKWRIGHT_TOTP_SECRET: RFC_SECRET };
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "pass");
  assert.match(code, /^\d{6}$/);
});

test("run_without_an_env_secret_has_no_secret_and_no_human_by_default", async () => {
  let message = "";
  const { spec, deps } = setup(agentWith(async (opts) => {
    try { await opts.twofa!.totp(); } catch (e) { message = (e as Error).message; }
    return result(true);
  }));
  deps.env = {};
  await startRun(spec, deps).done;
  assert.equal(message, "no way to ask for a code (stdin is not a terminal)");
});

test("run_humanfor_gets_the_run_signal_and_events_and_the_timeout_comes_from_args", async () => {
  const seen: unknown[] = [];
  const human: Human = {
    secret: async () => RFC_SECRET,
    code: (_k, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new AbortedError()), { once: true })),
    approve: async () => {},
  };
  let message = "";
  const { spec, deps } = setup(agentWith(async (opts) => {
    try { await opts.twofa!.code("sms"); } catch (e) { message = (e as Error).message; }
    return result(true);
  }), { twofaTimeout: 0.05 });
  deps.env = {};
  deps.humanFor = (ctx) => { seen.push(ctx.signal instanceof AbortSignal, ctx.events instanceof RunEvents); return human; };
  const h = startRun(spec, deps);
  await h.done;
  assert.deepEqual(seen, [true, true]);
  assert.equal(message, "timed out waiting for the 2FA code");
  const types = fs.readFileSync(path.join(h.workdir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
  assert.ok(types.includes("twofa:wait") && types.includes("twofa:done"));
});

test("run_with_an_invalid_env_secret_fails_the_run", async () => {
  const { spec, deps } = setup(agentWith(async () => result(true)));
  deps.env = { DUCKWRIGHT_TOTP_SECRET: "!!" };
  const o = await startRun(spec, deps).done;
  assert.equal(o.status, "fail");
  assert.match(o.error ?? "", /not a valid TOTP secret/);
});
```

Also update the `args()` helper at the top of `test/runs/run.test.ts` to include `twofaTimeout: 300,`, and the two literal expected `RunArgs` objects in `test/args.test.ts` (around lines 19 and 34) to include `twofaTimeout: 300`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/args.test.ts test/taskfile.test.ts test/runs/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Options**

In `src/args.ts`:

1. `RunArgs` gets `twofaTimeout: number;` (after `network: boolean;`).
2. In `RUN_USAGE`, add a line after the `--export/--network` line:

```ts
  + "                  [--twofa-timeout SEC]\n"
```
3. In `RUN_HELP`, after the `--network, --no-network` entry add:

```
  --twofa-timeout SEC   seconds to wait for a person to enter a 2FA code or
                        approve a passkey before the step fails (default 300)
```
4. `RUN_SPEC.names` gets `"--twofa-timeout": "--twofa-timeout",`; `VALUE_OPTIONS` gets `"--twofa-timeout"`.
5. The defaults object in `parseRunArgs` gets `twofaTimeout: 300,` (before `...settings`).
6. In the value-option chain, before `} else if (name === "--model") args.model = v!;` add:

```ts
      } else if (name === "--twofa-timeout") {
        if (!PY_INT.test(v!)) fail(`argument --twofa-timeout: invalid int value: '${v}'`);
        const n = Number.parseInt(v!.trim().replaceAll("_", ""), 10);
        if (n < 1) fail("argument --twofa-timeout: must be at least 1");
        args.twofaTimeout = n;
```

In `src/taskfile.ts`: add `twofaTimeout: number;` to `TaskSettings`, and `"twofa-timeout": ["twofaTimeout", "int"],` to `KEYS`.

- [ ] **Step 4: Run wiring**

In `src/runs/run.ts`:

1. Imports:

```ts
import { SECRET_ENV, createTwoFactor } from "../twofa.ts";
import type { Human } from "../twofa.ts";
```
2. `RunDeps` gets:

```ts
  /** Who can be asked for a 2FA code in this run; null (the default) when nobody is attached. */
  humanFor?: (ctx: { signal: AbortSignal; events: RunEvents }) => Human | null;
  /** Where the TOTP secret is read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
```
3. In `execute()`, right before `agent = deps.createAgent({`, build the provider, and pass it:

```ts
    const twofa = createTwoFactor({
      secret: (deps.env ?? process.env)[SECRET_ENV] ?? null,
      human: deps.humanFor?.({ signal, events }) ?? null,
      timeoutSec: args.twofaTimeout,
      signal, events,
    });
    agent = deps.createAgent({
      task, pw, brain, workdir,
      maxSteps: args.maxSteps, headed: args.headed, state: args.state ? resolvePath(args.state) : null,
      snapshotMode: args.snapshot, network: args.network,
      signal, events, control, twofa,
    });
```

- [ ] **Step 5: Fix other `RunArgs` literals**

Run: `npm run typecheck`
Expected: errors only where a `RunArgs` object literal lacks `twofaTimeout` (for example in `test/runs/manager.test.ts` or `test/cli.test.ts`). Add `twofaTimeout: 300` to each and re-run until clean.

- [ ] **Step 6: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src test
git commit -m "feat: --twofa-timeout and per-run TwoFactor provider"
```

---

### Task 7: Print mode: terminal prompts, preflight and CLI wiring

**Files:**
- Create: `src/report/ttyHuman.ts`
- Modify: `src/cli.ts`
- Test: `test/ttyHuman.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `Human`, `secretProblem` (Task 3); `RunDeps.humanFor`, `RunDeps.env` (Task 6); `AbortedError`.
- Produces:
  - `createTtyHuman(o: { label: string; stdin?: TtyInput; write?: (text: string) => void; onInterrupt?: () => void }): Human` (prompts on stderr, secret read with echo off, codes echoed, Ctrl-C raises SIGINT)
  - `CliDeps.env` and `CliDeps.human(label: string): Human | null`
  - exit `2` with `DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret` before any task starts (print and TUI)

- [ ] **Step 1: Write the failing tests**

Create `test/ttyHuman.test.ts`:

```ts
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createTtyHuman } from "../src/report/ttyHuman.ts";
import { AbortedError } from "../src/proc.ts";

const live = () => new AbortController().signal;

function setup(over: { onInterrupt?: () => void } = {}) {
  const stdin = new PassThrough();
  const out: string[] = [];
  const human = createTtyHuman({ label: "[2/3] b.md", stdin, write: (s) => out.push(s), ...over });
  return { stdin, out, human, text: () => out.join("") };
}

test("code_prompts_with_the_label_reads_a_line_and_echoes", async () => {
  const t = setup();
  const p = t.human.code("sms", live());
  t.stdin.write("12");
  t.stdin.write("3456\n");
  assert.equal(await p, "123456");
  assert.ok(t.text().includes("[2/3] b.md: SMS verification code"));
  assert.ok(t.text().includes("123456"), "a code is echoed");
});

test("email_prompt_names_email", async () => {
  const t = setup();
  const p = t.human.code("email", live());
  t.stdin.write("1\n");
  await p;
  assert.ok(t.text().includes("email verification code"));
});

test("secret_is_not_echoed", async () => {
  const t = setup();
  const p = t.human.secret(live());
  t.stdin.write("GEZDGNBV\n");
  assert.equal(await p, "GEZDGNBV");
  assert.ok(t.text().includes("TOTP secret"));
  assert.ok(!t.text().includes("GEZDGNBV"));
});

test("backspace_edits_the_input", async () => {
  const t = setup();
  const p = t.human.code("sms", live());
  t.stdin.write("12\x7f3\n");
  assert.equal(await p, "13");
});

test("approve_waits_for_enter", async () => {
  const t = setup();
  let done = false;
  const p = t.human.approve(live()).then(() => { done = true; });
  t.stdin.write("   ");
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  t.stdin.write("\n");
  await p;
  assert.ok(t.text().includes("approve the passkey prompt"));
});

test("two_prompts_in_a_row", async () => {
  const t = setup();
  const a = t.human.code("sms", live());
  t.stdin.write("1111\n");
  assert.equal(await a, "1111");
  const b = t.human.code("sms", live());
  t.stdin.write("2222\n");
  assert.equal(await b, "2222");
  assert.equal(t.stdin.listenerCount("data"), 0);
});

test("abort_removes_listeners_and_rejects", async () => {
  const t = setup();
  const ac = new AbortController();
  const p = t.human.code("sms", ac.signal);
  ac.abort();
  await assert.rejects(p, AbortedError);
  assert.equal(t.stdin.listenerCount("data"), 0);
});

test("an_already_aborted_signal_rejects_at_once", async () => {
  const t = setup();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(t.human.code("sms", ac.signal), AbortedError);
  assert.equal(t.text(), "");
});

test("ctrl_c_in_raw_mode_raises_the_interrupt", async () => {
  let interrupts = 0;
  const t = setup({ onInterrupt: () => { interrupts++; } });
  const ac = new AbortController();
  const p = t.human.code("sms", ac.signal);
  t.stdin.write("\x03");
  await new Promise((r) => setImmediate(r));
  assert.equal(interrupts, 1);
  ac.abort();
  await assert.rejects(p, AbortedError);
});
```

Append to `test/cli.test.ts` (it already imports `main`, `env`, `never`; add `import type { Human } from "../src/twofa.ts";` and `import { TwoFactorError } from "../src/twofa.ts";`):

```ts
const OKRESULT: RunResult = { success: true, answer: "a", steps: 0, costUsd: 0, history: [] };

test("invalid_totp_secret_exits_2_before_anything_runs", async () => {
  const e = env();
  const code = await main(e.argv, e.deps({ env: { DUCKWRIGHT_TOTP_SECRET: "!!" } }));
  assert.equal(code, 2);
  assert.ok(e.err.join("\n").includes("DUCKWRIGHT_TOTP_SECRET is not a valid TOTP secret"));
  assert.equal(runDirs(e.tmp).length, 0);
});

test("print_mode_asks_the_tty_human_with_the_label", async () => {
  const e = env();
  const labels: string[] = [];
  const human: Human = { secret: async () => "", code: async () => "493817", approve: async () => {} };
  let got = "";
  const code = await main(e.argv, e.deps({
    isTTY: () => true,
    env: {},
    human: (label) => { labels.push(label); return human; },
    createAgent: (opts) => ({ costUsd: 0, run: async () => { got = await opts.twofa!.code("sms"); return OKRESULT; } }),
  }));
  assert.equal(code, 0);
  assert.equal(got, "493817");
  assert.deepEqual(labels, ["duckwright"]);
});

test("print_mode_without_a_tty_fails_fast", async () => {
  const e = env();
  let humanCalled = false;
  let message = "";
  await main(e.argv, e.deps({
    isTTY: () => false,
    env: {},
    human: () => { humanCalled = true; return null; },
    createAgent: (opts) => ({ costUsd: 0, run: async () => {
      try { await opts.twofa!.code("sms"); } catch (err) { message = (err as TwoFactorError).message; }
      return OKRESULT;
    } }),
  }));
  assert.equal(humanCalled, false);
  assert.equal(message, "no way to ask for a code (stdin is not a terminal)");
});

test("print_mode_totp_works_without_a_tty_when_the_env_secret_is_set", async () => {
  const e = env();
  let code = "";
  await main(e.argv, e.deps({
    isTTY: () => false,
    env: { DUCKWRIGHT_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
    createAgent: (opts) => ({ costUsd: 0, run: async () => { code = await opts.twofa!.totp(); return OKRESULT; } }),
  }));
  assert.match(code, /^\d{6}$/);
});

test("batch_prompts_are_labelled_with_position_and_file", async () => {
  const e = env();
  fs.mkdirSync("tasks");
  fs.writeFileSync("tasks/a.md", "task a");
  fs.writeFileSync("tasks/b.md", "task b");
  const labels: string[] = [];
  await main(["-f", "tasks/a.md", "tasks/b.md", "--skill", path.join(e.tmp, "SKILL.md")], e.deps({
    isTTY: () => true,
    env: {},
    human: (label) => { labels.push(label); return null; },
    createAgent: (opts) => ({ costUsd: 0, run: async () => { await opts.twofa!.approve().catch(() => {}); return OKRESULT; } }),
  }));
  assert.deepEqual(labels, ["[1/2] tasks/a.md", "[2/2] tasks/b.md"]);
});
```

(A `human` that returns `null` makes `createTwoFactor` fail the `approve()` with the no-human error, which the agent stub swallows; the point of the test is only the label.)

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/ttyHuman.test.ts test/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: The terminal reader**

Create `src/report/ttyHuman.ts`:

```ts
// Asks the person at the terminal for a 2FA secret, code or approval. Prompts go to stderr so stdout
// keeps only the run's own output. Reading is by hand (raw mode when there is one) so a secret is never echoed.
import { AbortedError } from "../proc.ts";
import type { Human } from "../twofa.ts";

/** What this needs from stdin: process.stdin has all of it, a PassThrough has all but setRawMode. */
export interface TtyInput {
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  off(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  setRawMode?(mode: boolean): unknown;
}

export interface TtyOptions {
  /** Names the task in every prompt, e.g. `duckwright` or `[2/3] tasks/b.md`. */
  label: string;
  stdin?: TtyInput;
  write?: (text: string) => void;
  /** Called on Ctrl-C, which raw mode delivers as a character. Default: send this process SIGINT. */
  onInterrupt?: () => void;
}

export function createTtyHuman(o: TtyOptions): Human {
  const stdin: TtyInput = o.stdin ?? process.stdin;
  const write = o.write ?? ((s: string) => { process.stderr.write(s); });
  const interrupt = o.onInterrupt ?? ((): void => { process.kill(process.pid, "SIGINT"); });

  function readLine(prompt: string, echo: boolean, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortedError());
        return;
      }
      let text = "";
      const finish = (): void => {
        stdin.off("data", onData);
        signal.removeEventListener("abort", onAbort);
        stdin.setRawMode?.(false);
        stdin.pause();
      };
      const onAbort = (): void => {
        finish();
        write("\n");
        reject(new AbortedError());
      };
      const onData = (chunk: Buffer | string): void => {
        for (const ch of String(chunk)) {
          if (ch === "\x03") {
            interrupt();
          } else if (ch === "\r" || ch === "\n") {
            finish();
            write("\n");
            resolve(text);
            return;
          } else if (ch === "\x7f" || ch === "\b") {
            if (text !== "") {
              text = [...text].slice(0, -1).join("");
              if (echo) write("\b \b");
            }
          } else if (ch >= " ") {
            text += ch;
            if (echo) write(ch);
          }
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
      write(prompt);
    });
  }

  return {
    secret: (signal) => readLine(`${o.label}: TOTP secret (input hidden): `, false, signal),
    code: (kind, signal) =>
      readLine(`${o.label}: ${kind === "sms" ? "SMS" : "email"} verification code: `, true, signal),
    approve: async (signal) => {
      await readLine(`${o.label}: approve the passkey prompt on your device, then press Enter: `, true, signal);
    },
  };
}
```

- [ ] **Step 4: CLI wiring**

In `src/cli.ts`:

1. Imports:

```ts
import { createTtyHuman } from "./report/ttyHuman.ts";
import { secretProblem } from "./twofa.ts";
import type { Human } from "./twofa.ts";
```
2. `CliDeps` gets:

```ts
  /** Where the TOTP secret is read from. */
  env: Record<string, string | undefined>;
  /** The person to ask for a 2FA code in print mode, named by `label`. Only used when `isTTY()` is true. */
  human(label: string): Human | null;
```
and `DEFAULT_DEPS` gets:

```ts
  env: process.env,
  human: (label) => createTtyHuman({ label }),
```
3. Change `runOne` to take a label and pass the human and env:

```ts
async function runOne(
  deps: CliDeps, args: RunArgs, taskFile: string | null, label: string,
): Promise<[code: number, history: string, cost: number]> {
  const handle = startRun(
    { task: args.task!, taskFile, args },
    {
      ...deps,
      humanFor: () => (deps.isTTY() ? deps.human(label) : null),
      env: deps.env,
      onWarning: (m) => deps.stderr(`warning: ${m}`),
    },
  );
```
4. Update the three callers: single CLI task `runOne(deps, args, null, "duckwright")`; in `runBatch`: `runOne(deps, args, p, \`[${i + 1}/${runs.length}] ${p}\`)`; single file `runOne(deps, fileArgs, p, p)`.
5. In `tuiMain`, change the manager's `startRun` to take the bridge's human (Task 9 supplies the second argument; for now keep the one-argument form and add `env`):

```ts
    startRun: (s) => startRun(s, {
      prompts: deps.prompts, signal: deps.signal, createAgent: deps.createAgent, env: deps.env,
      onWarning: (m) => manager.notify("error", m),
    }),
```
6. In `dispatch`, after the `version` branch and before `const { args } = parsed;` add:

```ts
  const badSecret = secretProblem(deps.env);
  if (badSecret !== null) {
    deps.stderr(badSecret);
    return 2;
  }
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `node --test test/ttyHuman.test.ts test/cli.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/report/ttyHuman.ts src/cli.ts test/ttyHuman.test.ts test/cli.test.ts
git commit -m "feat: print-mode 2FA prompts and secret preflight"
```

---

### Task 8: Export `twofa` steps

**Files:**
- Modify: `src/export.ts`
- Test: `test/export.test.ts`

**Interfaces:**
- Consumes: `CODE_MASK` (Task 2); a history action `{ cmd: "twofa", args, code }` as recorded by Tasks 4 and 5.
- Produces:
  - `TOTP_IMPORT`, `TOTP_HELPER` (exported strings: plain JavaScript that is also valid TypeScript, with a `totp(): string` function reading `process.env.DUCKWRIGHT_TOTP_SECRET`)
  - `renderSpec`: `twofa totp` becomes `<recorded fill with the mask replaced by totp()> // 2FA`; `sms`, `email` and `passkey` become `// MANUAL: …` plus `await page.pause();`; a header note and warnings say the test cannot run unattended; a `twofa` counts as a UI action for the `request` ordering rule.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `test/export.test.ts`:

```ts
import { TOTP_HELPER, TOTP_IMPORT } from "../src/export.ts";
```
(merge into the existing `../src/export.ts` import line)

Append (`step`, `run`, `GOTO`, `EXPECT`, `exportError` already exist in the file):

```ts
const MASKED_FILL = "await page.getByLabel('Code').fill('[2FA CODE]');";

test("twofa_totp_exports_a_helper_call_not_a_code", () => {
  const { spec, warnings } = renderSpec(run([
    step([["goto", ["https://example.com/login"], GOTO]]),
    step([["twofa", ["totp", "e5"], MASKED_FILL]]),
    step([["expect", ["url", "https://example.com/home"], EXPECT]]),
  ]));
  assert.ok(spec.includes(TOTP_IMPORT));
  assert.ok(spec.includes(TOTP_HELPER));
  assert.ok(spec.includes("  await page.getByLabel('Code').fill(totp()); // 2FA\n"));
  assert.ok(!spec.includes("[2FA CODE]"));
  assert.ok(!spec.includes("cannot run unattended"));
  assert.deepEqual(warnings, []);
});

test("twofa_totp_keeps_the_submit_lines_after_the_fill", () => {
  const { spec } = renderSpec(run([
    step([["goto", ["https://example.com/login"], GOTO]]),
    step([["twofa", ["totp", "e5"], `${MASKED_FILL}\nawait page.getByLabel('Code').press('Enter');`]]),
  ]));
  assert.ok(spec.includes("  await page.getByLabel('Code').fill(totp()); // 2FA\n  await page.getByLabel('Code').press('Enter');\n"));
});

test("twofa_human_kinds_export_as_manual_steps_with_a_header_note_and_warnings", () => {
  const { spec, warnings } = renderSpec(run([
    step([["goto", ["https://example.com/login"], GOTO]]),
    step([["twofa", ["sms", "e5"], MASKED_FILL]]),
    step([["twofa", ["email", "e6"], MASKED_FILL]]),
    step([["twofa", ["passkey"], null]]),
    step([["expect", ["url", "https://example.com/home"], EXPECT]]),
  ]));
  assert.ok(spec.includes("  // MANUAL: enter the sms code here\n  await page.pause();\n"));
  assert.ok(spec.includes("  // MANUAL: enter the email code here\n  await page.pause();\n"));
  assert.ok(spec.includes("  // MANUAL: approve the passkey prompt\n  await page.pause();\n"));
  assert.ok(spec.includes("cannot run unattended"));
  assert.ok(!spec.includes("[2FA CODE]"));
  assert.ok(!spec.includes("totp()"));
  assert.deepEqual(warnings, [
    "twofa sms in step 2 is a manual step; the test cannot run unattended",
    "twofa email in step 3 is a manual step; the test cannot run unattended",
    "twofa passkey in step 4 is a manual step; the test cannot run unattended",
  ]);
});

test("twofa_without_a_recorded_code_fails_the_export_except_passkey", () => {
  assert.throws(() => renderSpec(run([step([["twofa", ["totp", "e5"], null]])])),
    exportError(1, /twofa in step 1 has no recorded code/));
  assert.throws(() => renderSpec(run([step([["twofa", ["sms", "e5"], null]])])),
    exportError(1, /twofa in step 1 has no recorded code/));
});

test("a_totp_step_whose_code_has_no_mask_fails_the_export", () => {
  assert.throws(() => renderSpec(run([step([["twofa", ["totp", "e5"], "await page.getByLabel('Code').fill('123456');"]])])),
    exportError(1, /twofa in step 1 has no recorded code/));
});

test("a_failed_twofa_is_skipped_with_a_warning", () => {
  const { warnings } = renderSpec(run([
    step([["goto", ["https://example.com/login"], GOTO]]),
    step([["twofa", ["sms", "e5"], null]], ["error: timed out waiting for the 2FA code"]),
    step([["expect", ["url", "https://example.com/home"], EXPECT]]),
  ]));
  assert.deepEqual(warnings, ["twofa in step 2 failed and was skipped"]);
});

test("a_request_after_twofa_is_refused_like_one_after_any_ui_action", () => {
  assert.throws(() => renderSpec(run([
    step([["goto", ["https://example.com/login"], GOTO]]),
    step([["twofa", ["totp", "e5"], MASKED_FILL]]),
    { ...step([["request", ["POST", "/api/x"], "marker"]], ["ok 201"]), request_origins: ["https://example.com"] },
  ])), exportError(1, /request in step 3 comes after a UI action in step 2/));
});

test("the_totp_helper_matches_rfc_6238", () => {
  const body = `${TOTP_HELPER}\nreturn totp();`;
  const at = (seconds: number): string =>
    new Function("createHmac", "process", "Date", body)(
      createHmac, { env: { DUCKWRIGHT_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" } }, { now: () => seconds * 1000 });
  assert.equal(at(59), "287082");
  assert.equal(at(1111111109), "081804");
  assert.equal(at(20000000000), "353130");
  const uri = new Function("createHmac", "process", "Date", body)(
    createHmac, { env: { DUCKWRIGHT_TOTP_SECRET: "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=x" } }, { now: () => 59_000 });
  assert.equal(uri, "287082");
});

test("the_totp_helper_demands_the_env_secret", () => {
  assert.throws(() => new Function("createHmac", "process", "Date", `${TOTP_HELPER}\nreturn totp();`)(
    createHmac, { env: {} }, Date), /set DUCKWRIGHT_TOTP_SECRET to run this test/);
});
```

Add at the top of the file: `import { createHmac } from "node:crypto";`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/export.test.ts`
Expected: FAIL (`TOTP_HELPER` is not exported).

- [ ] **Step 3: Implement**

In `src/export.ts`:

1. Import the mask:

```ts
import { CODE_MASK } from "./scrub.ts";
```

2. After `NO_ASSERTIONS` add:

```ts
export const TOTP_IMPORT = "import { createHmac } from 'node:crypto';\n";
// Plain JavaScript that is also valid TypeScript (no annotations), so the tests can run it as is.
export const TOTP_HELPER = `function totp() {
  let secret = process.env.DUCKWRIGHT_TOTP_SECRET;
  if (!secret) throw new Error('set DUCKWRIGHT_TOTP_SECRET to run this test');
  if (/^otpauth:/i.test(secret)) secret = new URL(secret).searchParams.get('secret') || '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = [];
  let bits = 0;
  let acc = 0;
  for (const ch of secret.replace(/[\\s=-]/g, '').toUpperCase()) {
    acc = (acc << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const value = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(value % 1000000).padStart(6, '0');
}
`;
const MANUAL_NOTE = "// NOTE: this test has manual 2FA steps (marked MANUAL) and cannot run unattended.\n";
const MASKED_CODE = new RegExp(`(['"\`])${CODE_MASK.replace(/[[\]]/g, "\\$&")}\\1`, "g");
```

3. In `renderSpec`, declare next to `let asserted = false;`:

```ts
  let usesTotp = false;
  const manual: string[] = [];
```

4. Add this block inside the action loop, right after the `if (cmd === "request") { ... }` block and before `if (firstUi === null && UI_COMMANDS.has(cmd) && result === "ok") firstUi = index + 1;`:

```ts
      if (cmd === "twofa") {
        const args = Array.isArray(a.args) ? a.args : [];
        const kind = args[0];
        if (result !== "ok") {
          if (typeof result === "string" && result.startsWith("error:")) {
            warnings.push(`twofa in step ${index + 1} failed and was skipped`);
          }
          continue;
        }
        if (firstUi === null) firstUi = index + 1;
        const recorded = typeof code === "string" ? code : "";
        if (kind !== "passkey" && recorded.trim() === "") {
          throw new ExportError(`twofa in step ${index + 1} has no recorded code to replay`, 1);
        }
        if (kind === "totp") {
          const filled = recorded.replace(MASKED_CODE, "totp()");
          if (!filled.includes("totp()")) {
            throw new ExportError(`twofa in step ${index + 1} has no recorded code to replay`, 1);
          }
          lines[index].push(...splitLines(filled).map((line) => `  ${line.includes("totp()") ? `${line} // 2FA` : line}`));
          usesTotp = true;
        } else if (kind === "sms" || kind === "email" || kind === "passkey") {
          lines[index].push(
            kind === "passkey" ? "  // MANUAL: approve the passkey prompt" : `  // MANUAL: enter the ${kind} code here`,
            "  await page.pause();",
          );
          manual.push(`twofa ${kind} in step ${index + 1} is a manual step; the test cannot run unattended`);
        } else {
          continue;
        }
        hasCode = true;
        continue;
      }
```

The error message must start `twofa in step N has no recorded code`: it does (`...has no recorded code to replay`).

5. At the end, before `const spec = ...`, add the manual warnings and assemble the new header:

```ts
  warnings.push(...manual);
  const head = HEADER + (manual.length > 0 ? MANUAL_NOTE : "") + (usesTotp ? `${TOTP_IMPORT}\n${TOTP_HELPER}` : "");
  const spec = head + "\n"
    + `test(${JSON.stringify(data.task)}, async ({ page }) => {\n`
    + body.map((line) => line + "\n").join("")
    + "});\n";
  return { spec, warnings };
```
(replace the existing `const spec = HEADER + "\n" + ...` and `return` lines; keep the `if (!asserted) warnings.push(NO_ASSERTIONS)` line before `warnings.push(...manual)` so the existing warning order is unchanged for runs without `twofa`.)

6. Confirm `src/exportApi.ts` needs no change: run `grep -n "twofa\|cmd ===" src/exportApi.ts`. It builds specs from captured network entries, not actions, so it ignores `twofa` steps.

- [ ] **Step 4: Run the tests and the full suite**

Run: `node --test test/export.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/export.ts test/export.test.ts
git commit -m "feat(export): replay twofa totp steps, mark human 2FA steps as manual"
```

---

### Task 9: TUI: `HumanBridge`, manager and snapshot

**Files:**
- Create: `src/runs/humanBridge.ts`
- Modify: `src/runs/manager.ts`, `src/cli.ts`, `test/tui/fake-manager.ts`
- Test: `test/runs/humanBridge.test.ts`, `test/runs/manager.test.ts`

**Interfaces:**
- Consumes: `Human`, `CancelledError` (Task 3); `TwofaWait` (Task 3); `AbortedError`.
- Produces:
  - `class HumanBridge implements Human { constructor(onChange: () => void); get pending(): { kind: TwofaWait } | null; answer(value: string | null): boolean }` (`null` cancels; `""` approves a passkey)
  - `TaskSnapshot.twofa: { kind: TwofaWait } | null` (set while the task's active run waits)
  - `ManagerOptions.startRun(spec: RunSpec, human: Human): RunHandle`
  - `ManagerLike.answerTwoFactor(id: TaskId, value: string | null): void`
  - `FakeManager.answerTwoFactor` recording `{ id, value }` in `twofaAnswers` and `"answerTwoFactor:<id>"` in `log`

- [ ] **Step 1: Write the failing tests**

Create `test/runs/humanBridge.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { HumanBridge } from "../../src/runs/humanBridge.ts";
import { AbortedError } from "../../src/proc.ts";
import { CancelledError } from "../../src/twofa.ts";

const live = () => new AbortController().signal;

test("a_request_is_pending_until_answered", async () => {
  let changes = 0;
  const b = new HumanBridge(() => { changes++; });
  assert.equal(b.pending, null);
  const p = b.code("sms", live());
  assert.deepEqual(b.pending, { kind: "sms" });
  assert.equal(b.answer("123456"), true);
  assert.equal(await p, "123456");
  assert.equal(b.pending, null);
  assert.equal(changes, 2);
});

test("secret_and_passkey_kinds", async () => {
  const b = new HumanBridge(() => {});
  const s = b.secret(live());
  assert.deepEqual(b.pending, { kind: "secret" });
  b.answer("GEZD");
  assert.equal(await s, "GEZD");
  const a = b.approve(live());
  assert.deepEqual(b.pending, { kind: "passkey" });
  b.answer("");
  await a;
});

test("null_cancels", async () => {
  const b = new HumanBridge(() => {});
  const p = b.code("email", live());
  b.answer(null);
  await assert.rejects(p, CancelledError);
  assert.equal(b.pending, null);
});

test("abort_clears_pending", async () => {
  const b = new HumanBridge(() => {});
  const ac = new AbortController();
  const p = b.code("sms", ac.signal);
  ac.abort();
  await assert.rejects(p, AbortedError);
  assert.equal(b.pending, null);
});

test("an_already_aborted_signal_never_becomes_pending", async () => {
  const b = new HumanBridge(() => {});
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(b.code("sms", ac.signal), AbortedError);
  assert.equal(b.pending, null);
});

test("answer_with_nothing_pending_is_a_no_op", () => {
  assert.equal(new HumanBridge(() => {}).answer("x"), false);
});
```

Append to `test/runs/manager.test.ts` (add imports: `RunEvents` from `../../src/events.ts`, `RunControl` from `../../src/control.ts`, `RunManager` and `ManagerEvent` from `../../src/runs/manager.ts` if not already imported, `CancelledError` from `../../src/twofa.ts`, `AbortedError` from `../../src/proc.ts`, and `import type { Human } from "../../src/twofa.ts"`):

```ts
function twofaSetup() {
  const humans: Human[] = [];
  const aborts: AbortController[] = [];
  const mgr = new RunManager({
    argv: ["--tui"], defaultSkill: "/s.md", maxParallel: 3, preflight: () => null,
    startRun: (_spec, human) => {
      humans.push(human);
      const events = new RunEvents();
      const ac = new AbortController();
      aborts.push(ac);
      return { id: `r${humans.length}`, workdir: "/w", events, control: new RunControl(ac, events), done: new Promise(() => {}) };
    },
  });
  const id = mgr.addTyped("log in");
  assert.deepEqual(mgr.start(id), { ok: true, runId: "r1" });
  return { mgr, id, humans, aborts };
}

test("twofa_request_shows_on_the_task_snapshot_and_is_answered_through_the_manager", async () => {
  const { mgr, id, humans } = twofaSetup();
  const updates: (string | null)[] = [];
  mgr.subscribe((e: ManagerEvent) => { if (e.type === "task:updated") updates.push(e.task.twofa?.kind ?? null); });
  assert.equal(mgr.list()[0].twofa, null);
  const p = humans[0].code("sms", new AbortController().signal);
  assert.deepEqual(mgr.list()[0].twofa, { kind: "sms" });
  mgr.answerTwoFactor(id, "493817");
  assert.equal(await p, "493817");
  assert.equal(mgr.list()[0].twofa, null);
  assert.deepEqual(updates.slice(-2), ["sms", null]);
});

test("twofa_cancel_rejects_the_request", async () => {
  const { mgr, id, humans } = twofaSetup();
  const p = humans[0].approve(new AbortController().signal);
  mgr.answerTwoFactor(id, null);
  await assert.rejects(p, CancelledError);
});

test("twofa_answer_for_a_task_that_is_not_waiting_is_ignored", () => {
  const { mgr, id } = twofaSetup();
  assert.doesNotThrow(() => mgr.answerTwoFactor(id, "x"));
  assert.doesNotThrow(() => mgr.answerTwoFactor(999, "x"));
});

test("twofa_stopping_the_run_clears_the_request", async () => {
  const { mgr, humans } = twofaSetup();
  const ac = new AbortController();
  const p = humans[0].code("sms", ac.signal);
  ac.abort();
  await assert.rejects(p, AbortedError);
  assert.equal(mgr.list()[0].twofa, null);
});
```

Update `test/tui/fake-manager.ts`:

1. In `snapshot()`, add `twofa: null,` to the returned object (after `createdAt: 0`).
2. Add to `FakeManager`:

```ts
  /** Every answerTwoFactor call, in order (null = cancel). */
  twofaAnswers: Array<{ id: TaskId; value: string | null }> = [];

  answerTwoFactor(id: TaskId, value: string | null): void {
    this.log.push(`answerTwoFactor:${id}`);
    this.twofaAnswers.push({ id, value });
  }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/runs/humanBridge.test.ts test/runs/manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: The bridge**

Create `src/runs/humanBridge.ts`:

```ts
// The TUI's Human for one run: a request waits here, shown on the task, until the dialog answers
// it, the user cancels, or the run stops or times out.
import type { TwofaWait } from "../events.ts";
import { AbortedError } from "../proc.ts";
import { CancelledError } from "../twofa.ts";
import type { Human } from "../twofa.ts";

interface Waiting {
  kind: TwofaWait;
  settle(value: string | null): void;
}

export class HumanBridge implements Human {
  #waiting: Waiting | null = null;
  #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get pending(): { kind: TwofaWait } | null {
    return this.#waiting === null ? null : { kind: this.#waiting.kind };
  }

  secret(signal: AbortSignal): Promise<string> {
    return this.#ask("secret", signal);
  }

  code(kind: "sms" | "email", signal: AbortSignal): Promise<string> {
    return this.#ask(kind, signal);
  }

  async approve(signal: AbortSignal): Promise<void> {
    await this.#ask("passkey", signal);
  }

  /** Answer the waiting request; `null` cancels it. False when nothing is waiting. */
  answer(value: string | null): boolean {
    const waiting = this.#waiting;
    if (waiting === null) return false;
    waiting.settle(value);
    return true;
  }

  #ask(kind: TwofaWait, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortedError());
        return;
      }
      const onAbort = (): void => {
        this.#clear();
        reject(new AbortedError());
      };
      this.#waiting = {
        kind,
        settle: (value) => {
          signal.removeEventListener("abort", onAbort);
          this.#clear();
          if (value === null) reject(new CancelledError());
          else resolve(value);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#onChange();
    });
  }

  #clear(): void {
    this.#waiting = null;
    this.#onChange();
  }
}
```

- [ ] **Step 4: Manager**

In `src/runs/manager.ts`:

1. Imports:

```ts
import type { ControlState, RunEvent, RunOutcome, TwofaWait } from "../events.ts";
import type { Human } from "../twofa.ts";
import { HumanBridge } from "./humanBridge.ts";
```
(extend the existing `../events.ts` import rather than duplicating it)

2. `TaskSnapshot` gets `twofa: { kind: TwofaWait } | null;` (after `runCount: number;`), with the comment `/** Set while the task's active run waits for a 2FA answer. */`.

3. `ManagerLike` gets `answerTwoFactor(id: TaskId, value: string | null): void;` (after `stop`).

4. `ManagerOptions.startRun` becomes `startRun(spec: RunSpec, human: Human): RunHandle;`.

5. `RunRecord` gets `bridge: HumanBridge;`.

6. In `start()`, create the bridge before calling `startRun`, and store it:

```ts
    const slot = this.#freeSlot();
    const session = `${args.session}-${slot}`;
    const bridge = new HumanBridge(() => this.#updated(task));
    let handle: RunHandle;
    try {
      const taskFile = task.source.kind === "file" ? task.source.path : null;
      handle = this.#o.startRun({ task: task.text, taskFile, args: { ...args, session } }, bridge);
    } catch (err) {
```
and `const run: RunRecord = { handle, slot, session, bridge, active: true, quitStopped: false, outcome: null };`

7. Add the method (next to `stop`):

```ts
  answerTwoFactor(id: TaskId, value: string | null): void {
    this.#activeRunOf(id)?.bridge.answer(value);
  }
```

8. In `#snapshot`, add to the `snap` object literal: `twofa: this.#activeRun(task)?.bridge.pending ?? null,`.

In `src/cli.ts` `tuiMain`, give the manager's runs their human:

```ts
    startRun: (s, human) => startRun(s, {
      prompts: deps.prompts, signal: deps.signal, createAgent: deps.createAgent, env: deps.env,
      humanFor: () => human,
      onWarning: (m) => manager.notify("error", m),
    }),
```

- [ ] **Step 5: Fix other `TaskSnapshot` literals**

Run: `npm run typecheck`
Expected: errors only where a `TaskSnapshot` literal lacks `twofa` (for example the `task()` helper in `test/tui/keys.test.ts`). Add `twofa: null` to each and re-run until clean.

- [ ] **Step 6: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runs/humanBridge.ts src/runs/manager.ts src/cli.ts test
git commit -m "feat(tui): HumanBridge and twofa state on the task snapshot"
```

---

### Task 10: TUI: masked dialog, keys and sidebar marker

**Files:**
- Create: `src/tui/twofaInput.ts`, `src/tui/twofaDialog.ts`
- Modify: `src/tui/state.ts`, `src/tui/keys.ts`, `src/tui/app.ts`, `src/tui/sidebar.ts`
- Test: `test/tui/twofaInput.test.ts`, `test/tui/keys.test.ts`, `test/tui/app.test.ts`

**Interfaces:**
- Consumes: `TaskSnapshot.twofa`, `ManagerLike.answerTwoFactor`, `FakeManager.twofaAnswers` (Task 9); `TwofaWait` (Task 3).
- Produces:
  - `twofaKey(kind: TwofaWait, buffer: string, k: KeyPress): { buffer: string } | { answer: string | null }`
  - `pendingTwofa(s: ViewState): TaskSnapshot | null` and `twofaWaitKey(t: TaskSnapshot): string` (from `state.ts`)
  - `Command` variant `{ kind: "twofaKey"; id: TaskId; wait: TwofaWait; waitKey: string; key: KeyPress }`
  - The typed text lives only in a ref inside `Workspace`: never in `ViewState`, manager events or the run log.

- [ ] **Step 1: Write the failing tests**

Create `test/tui/twofaInput.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { key } from "../../src/tui/keypress.ts";
import { twofaKey } from "../../src/tui/twofaInput.ts";

test("typing_appends_and_backspace_removes", () => {
  assert.deepEqual(twofaKey("sms", "12", key("3")), { buffer: "123" });
  assert.deepEqual(twofaKey("sms", "123", key("backspace")), { buffer: "12" });
  assert.deepEqual(twofaKey("sms", "", key("backspace")), { buffer: "" });
});

test("a_paste_keeps_printable_characters_only", () => {
  assert.deepEqual(twofaKey("secret", "", { ...key("x"), input: "GEZD\n GNBV\x1b" }), { buffer: "GEZD GNBV" });
});

test("return_submits_a_trimmed_non_empty_code_and_ignores_an_empty_one", () => {
  assert.deepEqual(twofaKey("sms", " 123456 ", key("return")), { answer: "123456" });
  assert.deepEqual(twofaKey("sms", "  ", key("return")), { buffer: "  " });
});

test("escape_cancels", () => {
  assert.deepEqual(twofaKey("email", "12", key("escape")), { answer: null });
  assert.deepEqual(twofaKey("passkey", "", key("escape")), { answer: null });
});

test("passkey_takes_y_or_return_to_approve_and_n_to_cancel", () => {
  assert.deepEqual(twofaKey("passkey", "", key("y")), { answer: "" });
  assert.deepEqual(twofaKey("passkey", "", key("return")), { answer: "" });
  assert.deepEqual(twofaKey("passkey", "", key("n")), { answer: null });
  assert.deepEqual(twofaKey("passkey", "", key("x")), { buffer: "" });
});

test("control_keys_are_ignored", () => {
  assert.deepEqual(twofaKey("sms", "1", key("ctrl+a")), { buffer: "1" });
  assert.deepEqual(twofaKey("sms", "1", key("up")), { buffer: "1" });
});
```

Append to `test/tui/keys.test.ts` (it has `task`, `mk`, `press`, `hints` imports; the `task()` helper now returns `twofa: null`):

```ts
import { pendingTwofa, twofaWaitKey } from "../../src/tui/state.ts";

const waiting = (kind: "secret" | "sms" | "email" | "passkey" = "sms"): ViewState =>
  initialState(0, [{ ...task(1, "running"), twofa: { kind } }]);

test("pending_twofa_takes_every_key_as_a_twofa_command", () => {
  const s = waiting();
  const t = s.tasks[0];
  const cmds = press(s, "a");
  assert.equal(cmds.length, 1);
  assert.deepEqual(cmds[0], { kind: "twofaKey", id: 1, wait: "sms", waitKey: twofaWaitKey(t), key: key("a") });
  for (const spec of ["j", "q", "tab", "?", "/", "escape", "return", "1"]) {
    assert.equal(press(s, spec)[0].kind, "twofaKey", spec);
  }
});

test("a_twofa_command_carries_the_key_but_no_ui_action_that_could_hold_it", () => {
  const cmds = press(waiting(), "7");
  assert.ok(cmds.every((c) => c.kind === "twofaKey"), "no ui action carries the typed key");
});

test("ctrl_c_still_asks_to_quit_while_a_twofa_dialog_is_open", () => {
  const cmds = press(waiting(), "ctrl+c", 1);
  assert.ok(cmds.some((c) => c.kind === "ui" && c.action.type === "confirm"));
  assert.ok(!cmds.some((c) => c.kind === "twofaKey"));
});

test("the_quit_question_takes_y_n_over_the_twofa_dialog", () => {
  let s = waiting();
  s = play(s, press(s, "ctrl+c", 1));
  assert.equal(s.mode, "confirm");
  assert.deepEqual(press(s, "y", 1), [{ kind: "stopAllAndQuit" }]);
});

test("no_twofa_means_normal_keys", () => {
  const s = mk("running");
  assert.equal(pendingTwofa(s), null);
  assert.notEqual(press(s, "a")[0].kind, "twofaKey");
});

test("pending_twofa_picks_the_first_waiting_task", () => {
  const s = initialState(0, [
    { ...task(1, "running"), twofa: null },
    { ...task(2, "running"), twofa: { kind: "email" } },
    { ...task(3, "running"), twofa: { kind: "sms" } },
  ]);
  assert.equal(pendingTwofa(s)?.id, 2);
});

test("twofa_footer_hints", () => {
  assert.deepEqual(hints(waiting("sms")), [{ key: "⏎", label: "submit" }, { key: "esc", label: "cancel" }]);
  assert.deepEqual(hints(waiting("passkey")), [{ key: "y/⏎", label: "approved" }, { key: "n/esc", label: "cancel" }]);
});
```

Append to `test/tui/app.test.ts`:

```ts
test("twofa_dialog_masks_input_and_answers_the_manager", async () => {
  const m = new FakeManager([snapshot(1, "log in", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  m.update(1, { twofa: { kind: "sms" } });
  await settle();
  assert.match(t.frame(), /SMS code/);
  await t.type("1", "2", "3", "4", "5", "6");
  assert.ok(t.frame().includes("••••••"));
  assert.ok(!t.frame().includes("123456"), "the code is never drawn");
  await t.type("\r");
  assert.deepEqual(m.twofaAnswers, [{ id: 1, value: "123456" }]);
  assert.deepEqual(m.log.filter((l) => l.startsWith("answerTwoFactor")), ["answerTwoFactor:1"]);
  assert.ok(!m.log.join("\n").includes("123456"), "the code is not in the manager call log");
});

test("twofa_dialog_does_not_leak_keys_to_the_workspace", async () => {
  const m = new FakeManager([snapshot(1, "log in", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  m.update(1, { twofa: { kind: "email" } });
  await settle();
  await t.type("a", "q");
  assert.equal(m.log.filter((l) => l.startsWith("start") || l.startsWith("stop")).length, 0);
  assert.ok(!t.frame().includes("Add a task"), "the add box did not open");
  assert.deepEqual(t.quits, []);
});

test("twofa_passkey_dialog_approves_with_y", async () => {
  const m = new FakeManager([snapshot(1, "log in", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  m.update(1, { twofa: { kind: "passkey" } });
  await settle();
  assert.match(t.frame(), /Approve the passkey prompt/);
  await t.type("y");
  assert.deepEqual(m.twofaAnswers, [{ id: 1, value: "" }]);
});

test("second_request_queues_behind_the_first", async () => {
  const m = new FakeManager([
    snapshot(1, "first", { state: "running", runId: "r1", runCount: 1 }),
    snapshot(2, "second", { state: "running", runId: "r2", runCount: 1 }),
  ]);
  const t = mount(m);
  await settle();
  m.update(1, { twofa: { kind: "sms" } });
  m.update(2, { twofa: { kind: "email" } });
  await settle();
  assert.match(t.frame(), /SMS code/);
  await t.type("9", "9", "9", "9", "\r");
  assert.deepEqual(m.twofaAnswers, [{ id: 1, value: "9999" }]);
  m.update(1, { twofa: null });
  await settle();
  assert.match(t.frame(), /email code/i);
  assert.ok(!t.frame().includes("9999"));
  await t.type("5", "5", "5", "5", "\r");
  assert.deepEqual(m.twofaAnswers[1], { id: 2, value: "5555" });
});

test("a_waiting_task_is_marked_in_the_sidebar", async () => {
  const m = new FakeManager([snapshot(1, "log in", { state: "running", runId: "r1", runCount: 1, twofa: { kind: "sms" } })]);
  const t = mount(m, { columns: 100, rows: 24 });
  await settle();
  const row = t.frame().split("\n").find((l) => l.includes("log in"))!;
  assert.match(row, /\?/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/tui/twofaInput.test.ts test/tui/keys.test.ts test/tui/app.test.ts`
Expected: FAIL.

- [ ] **Step 3: Input handling (pure)**

Create `src/tui/twofaInput.ts`:

```ts
// What a key does inside the 2FA dialog: edit the typed text, answer, or cancel. Pure, so the typed
// text can live in the view layer only (see Workspace) and never reaches the view state or the manager
// until it is answered.
import type { TwofaWait } from "../events.ts";
import type { KeyPress } from "./keypress.ts";

export type TwofaStep = { buffer: string } | { answer: string | null };

const CONTROL = /[\x00-\x1f\x7f]/g;

export function twofaKey(kind: TwofaWait, buffer: string, k: KeyPress): TwofaStep {
  const typed = k.name === null && !k.ctrl && !k.meta ? k.input : "";
  if (kind === "passkey") {
    if (k.name === "return" || typed === "y") return { answer: "" };
    if (k.name === "escape" || typed === "n") return { answer: null };
    return { buffer };
  }
  if (k.name === "escape") return { answer: null };
  if (k.name === "return") return buffer.trim() === "" ? { buffer } : { answer: buffer.trim() };
  if (k.name === "backspace") return { buffer: [...buffer].slice(0, -1).join("") };
  const printable = typed.replace(CONTROL, "");
  return printable === "" ? { buffer } : { buffer: buffer + printable };
}
```

- [ ] **Step 4: State, keys, dialog, app, sidebar**

In `src/tui/state.ts`, add after `selectedRun`:

```ts
/** The first task (in the order they were added) whose run waits for a 2FA answer. */
export function pendingTwofa(s: ViewState): TaskSnapshot | null {
  return s.tasks.find((t) => t.twofa !== null) ?? null;
}

/** Identifies one wait, so text typed for one request is never shown for another. */
export function twofaWaitKey(t: TaskSnapshot): string {
  return t.twofa === null ? "" : `${t.id}:${t.twofa.kind}:${t.runCount}`;
}
```

In `src/tui/keys.ts`:

1. Imports: `import type { TwofaWait } from "../events.ts";` and add `pendingTwofa, twofaWaitKey` to the `./state.ts` import.
2. Add to `Command`:

```ts
  | { kind: "twofaKey"; id: TaskId; wait: TwofaWait; waitKey: string; key: KeyPress }
```
3. Add above `keymap`:

```ts
/** While a run waits for 2FA, every key belongs to the dialog (Ctrl-C and the quit question aside). */
function twofaCommands(k: KeyPress, t: TaskSnapshot): Command[] {
  if (t.twofa === null) return [];
  return [{ kind: "twofaKey", id: t.id, wait: t.twofa.kind, waitKey: twofaWaitKey(t), key: k }];
}
```
4. In `keymap`, directly after the `isCtrlC` line:

```ts
  const waiting = pendingTwofa(s);
  if (waiting !== null && s.mode !== "quitting" && s.mode !== "confirm") return twofaCommands(k, waiting);
```
5. At the top of `hints`:

```ts
  const waiting = pendingTwofa(s);
  if (waiting?.twofa && s.mode !== "quitting" && s.mode !== "confirm") {
    return waiting.twofa.kind === "passkey"
      ? [{ key: "y/⏎", label: "approved" }, { key: "n/esc", label: "cancel" }]
      : [{ key: "⏎", label: "submit" }, { key: "esc", label: "cancel" }];
  }
```

Create `src/tui/twofaDialog.ts`:

```ts
// The 2FA dialog: a masked input for a code or the TOTP secret, or an approve/cancel question for a passkey.
import { Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { TaskSnapshot } from "../runs/manager.ts";
import { Centered, Dialog } from "./dialog.ts";
import { sanitize } from "./sanitize.ts";
import { useTheme } from "./themeContext.ts";

export interface TwofaDialogProps { task: TaskSnapshot; typed: string; width: number; height: number }

export function TwofaDialog({ task, typed, width, height }: TwofaDialogProps): ReactElement | null {
  const { role } = useTheme();
  if (task.twofa === null) return null;
  const kind = task.twofa.kind;
  const name = sanitize(task.name);
  const title = kind === "secret" ? "TOTP secret" : kind === "passkey" ? "Passkey" : kind === "sms" ? "SMS code" : "Email code";
  const ask = kind === "secret" ? `Enter the TOTP secret for ${name}`
    : kind === "passkey" ? `Approve the passkey prompt on your device for ${name}`
    : `Enter the ${kind === "sms" ? "SMS" : "email"} code for ${name}`;
  const rows: ReactElement[] = [h(Text, { bold: true, wrap: "truncate-end" }, ask)];
  if (kind !== "passkey") rows.push(h(Text, { wrap: "truncate-end" }, `${"•".repeat([...typed].length)}▌`));
  rows.push(h(Text, { color: role.muted, wrap: "truncate-end" },
    kind === "passkey" ? "y/⏎ approved · n/esc cancel" : "⏎ submit · esc cancel · input is hidden"));
  const dialogWidth = Math.min(width, Math.max(30, Math.min(64, width - 4)));
  return h(Centered, { width, height, child: h(Dialog, { width: dialogWidth, borderColor: role.accent, rows, title }) });
}
```

In `src/tui/app.ts`:

1. Imports:

```ts
import { editingGlobals, initialState, pendingTwofa, reduce, twofaWaitKey } from "./state.ts";
import { twofaKey } from "./twofaInput.ts";
import { TwofaDialog } from "./twofaDialog.ts";
```
(extend the existing `./state.ts` import line)

2. In `Workspace`, next to `const toastsSeen = useRef(0);` add:

```ts
  // What the user has typed into the 2FA dialog. Kept here, not in the view state or the manager,
  // so a code or secret is never held anywhere but on its way to the run.
  const twofaText = useRef({ key: "", text: "" });
```
3. In `run()`, add a case before `case "quit":`:

```ts
      case "twofaKey": {
        const typed = twofaText.current.key === c.waitKey ? twofaText.current.text : "";
        const step = twofaKey(c.wait, typed, c.key);
        if ("answer" in step) {
          twofaText.current = { key: "", text: "" };
          manager.answerTwoFactor(c.id, step.answer);
        } else {
          twofaText.current = { key: c.waitKey, text: step.buffer };
        }
        rerender();
        return;
      }
```
4. Replace the `overlay` expression with this (the confirm clause moves to the front, and the dialog goes second):

```ts
  const area = { width: columns, height: paneHeight };
  const waiting = pendingTwofa(s);
  const typed = waiting !== null && twofaText.current.key === twofaWaitKey(waiting) ? twofaText.current.text : "";
  const overlay = s.mode === "confirm" && s.confirm !== null ? h(Confirm, { key: "confirm", s, ...area })
    : waiting !== null && s.mode !== "quitting" ? h(TwofaDialog, { key: "twofa", task: waiting, typed, ...area })
    : s.mode === "help" ? h(Help, { key: "help", s, ...area })
    : s.mode === "form" && s.form !== null && s.form.taskId !== null ? h(FormView, { key: "form", form: s.form, title: "Settings", ...area })
    : s.mode === "form" && s.form !== null && oh === 0 ? h(FormView, { key: "form", form: s.form, title: "Global options", ...area })
    : s.mode === "options" && s.globals !== null && oh === 0 ? h(FormView, {
      key: "form", form: openForm(null, s.globals.base, s.globals.overrides, s.optionsSelected), title: "Global options", note: "⏎ edit", ...area,
    })
    : null;
```
(this replaces the existing `const area = ...` and `const overlay = ...` statements; keep the rest of the return unchanged)

In `src/tui/sidebar.ts`, add the marker inside `marks`, before the cost entry:

```ts
    t.twofa !== null ? h(Text, { color: theme.role.accent, bold: true }, " ?") : null,
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `node --test test/tui/twofaInput.test.ts test/tui/keys.test.ts test/tui/app.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui test/tui
git commit -m "feat(tui): masked 2FA dialog, keys and sidebar marker"
```

---

### Task 11: README and the end-to-end leak test

**Files:**
- Modify: `README.md`
- Create: `test/twofa.leak.test.ts`

**Interfaces:**
- Consumes: everything above (`startRun`, `Agent`, `createTwoFactor`, `exportRun` through `args.export`).
- Produces: documentation, and a regression test that fails if the secret or a code reaches any file, prompt or output of a run.

- [ ] **Step 1: Write the leak test**

Create `test/twofa.leak.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { RunArgs } from "../src/args.ts";
import type { Decision } from "../src/brain.ts";
import { Agent } from "../src/loop.ts";
import type { ProcResult } from "../src/proc.ts";
import { stepLine } from "../src/prompt.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import { PROMPTS, startRun } from "../src/runs/run.ts";
import type { Human } from "../src/twofa.ts";
import { tmpDir } from "./helpers.ts";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SMS = "493817";

/** Echoes whatever was last filled into the code field in the tab list, like a page that shows what you typed. */
class EchoPW extends PlaywrightCLI {
  filled: string[] = [];
  last = "";

  override async run(cmd: string, args: string[]): Promise<ProcResult> {
    if (cmd === "fill") {
      this.last = args[1];
      this.filled.push(args[1]);
      return { code: 0, stdout: `### Ran Playwright code\n\`\`\`js\nawait page.getByLabel('Code').fill('${args[1]}');\n\`\`\`\n`, stderr: "" };
    }
    return { code: 0, stdout: `- tab 0 (current): Verify ${this.last}`, stderr: "" };
  }
  override async open(): Promise<ProcResult> { return { code: 0, stdout: "", stderr: "" }; }
  override async stateLoad(): Promise<void> {}
  override async close(): Promise<void> {}
  override async snapshot(): Promise<string> { return `- textbox "Code" [ref=e5]\n- text: ${this.last}`; }
}

class ScriptBrain {
  prompts: string[] = [];
  calls = 0;
  async decide(prompt: string): Promise<[Decision, number]> {
    this.prompts.push(prompt);
    const script: [string, string[]][] = [["twofa", ["totp", "e5"]], ["twofa", ["sms", "e5"]], ["done", ["success", "logged in"]]];
    const [cmd, args] = script[Math.min(this.calls++, script.length - 1)];
    return [{ evaluationPreviousGoal: "ok", memory: "m", nextGoal: "g", actions: [{ cmd, args }] }, 0];
  }
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

test("no_secret_or_code_reaches_any_file_prompt_or_output", async () => {
  const tmp = tmpDir();
  const pw = new EchoPW();
  const brain = new ScriptBrain();
  const human: Human = { secret: async () => SECRET, code: async () => SMS, approve: async () => {} };
  const args: RunArgs = {
    task: "log in", file: null, maxSteps: 5, model: "m", headed: false, skill: PROMPTS.defaultSkill, session: "s-1",
    state: null, allowFileAccess: false, export: true, snapshot: "full", tui: false, maxParallel: null, network: false,
    twofaTimeout: 300,
  };
  const printed: string[] = [];
  const handle = startRun({ task: "log in", taskFile: null, args }, {
    prompts: PROMPTS, signal: new AbortController().signal, runsDir: path.join(tmp, "runs"),
    env: { DUCKWRIGHT_TOTP_SECRET: SECRET },
    humanFor: () => human,
    createAgent: (opts) => new Agent({ ...opts, pw, brain }),
  });
  handle.events.subscribe((e) => { if (e.type === "step:end") printed.push(stepLine(e.record)); });
  const outcome = await handle.done;
  assert.equal(outcome.status, "pass", outcome.error ?? "");
  assert.equal(pw.filled.length, 2);
  const [totp, sms] = pw.filled;
  assert.match(totp, /^\d{6}$/);
  assert.equal(sms, SMS);

  const secrets = [SECRET, totp, SMS];
  const haystacks: [string, string][] = [
    ...filesUnder(handle.workdir).map((f): [string, string] => [f, fs.readFileSync(f, "utf8")]),
    ...brain.prompts.map((p, i): [string, string] => [`prompt ${i + 1}`, p]),
    ["printed steps", printed.join("\n")],
    ["outcome", JSON.stringify(outcome)],
  ];
  for (const [name, text] of haystacks) {
    for (const s of secrets) assert.ok(!text.includes(s), `${name} contains ${s === SECRET ? "the secret" : "a code"}`);
  }

  const spec = fs.readFileSync(path.join(handle.workdir, "duckwright.spec.ts"), "utf8");
  assert.ok(spec.includes("fill(totp()); // 2FA"));
  assert.ok(spec.includes("// MANUAL: enter the sms code here"));
  assert.ok(spec.includes("DUCKWRIGHT_TOTP_SECRET"));
  const history = JSON.parse(fs.readFileSync(path.join(handle.workdir, "history.json"), "utf8"));
  assert.deepEqual(history.history.map((s: { actions: { cmd: string }[] }) => s.actions[0].cmd), ["twofa", "twofa", "done"]);
  assert.ok(history.history[0].actions[0].code.includes("[2FA CODE]"));
  const events = fs.readFileSync(path.join(handle.workdir, "events.jsonl"), "utf8");
  assert.ok(events.includes('"twofa:wait"'));
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/twofa.leak.test.ts`
Expected: PASS (all earlier tasks are in). If it fails, the failure message names the file or prompt that leaked: fix the cause in the owning task's code, not the test.

- [ ] **Step 3: README**

In `README.md`:

1. In the options table, after the `--network` row add:

```markdown
| `--twofa-timeout` | `300` | Seconds to wait for a person to type a 2FA code or approve a passkey before that `twofa` step fails (see [Two-factor verification](#two-factor-verification)) |
```
2. In the `## Features` list, after the "Direct API calls for setup" bullet add:

```markdown
- **Two-factor verification**: the agent can get past a 2FA prompt with a `twofa` action. TOTP codes are generated from a secret you supply, SMS and email codes and passkey approvals pause the run and ask you, in print mode and in the TUI. Codes and the secret never reach `history.json`, the prompts or an exported test.
```
3. Insert this section immediately before `### Task files`:

````markdown
### Two-factor verification

When a login asks for a second factor, the agent uses a `twofa` action: the harness gets the code and types it, so the model never sees one.

| Kind | Where the code comes from |
|---|---|
| `totp` | Generated from your authenticator secret. Set it as `DUCKWRIGHT_TOTP_SECRET` (a base32 secret, or an `otpauth://` URI). If it is unset, Duckwright asks for it the first time it is needed (hidden input) and keeps it in memory for that run only. |
| `sms`, `email` | The run pauses and asks you for the code. |
| `passkey` | The run pauses until you approve the prompt on your device and confirm. |

```bash
export DUCKWRIGHT_TOTP_SECRET=JBSWY3DPEHPK3PXP
duckwright "Log in to the demo app as linh and open the dashboard"
```

- **Print mode** asks on the terminal (prompts go to stderr; a secret is not echoed). With no terminal (CI, a pipe) a step that needs a person fails at once with `no way to ask for a code`, and the agent can finish with `done failure`. `totp` still works unattended when `DUCKWRIGHT_TOTP_SECRET` is set. In a batch the prompt names the task, for example `[2/3] tasks/b.md`.
- **`--tui`** shows a masked dialog and marks the waiting task with `?` in the list; the other runs keep going, and a second request waits its turn. `esc` cancels that step.
- **Waiting** is bounded by `--twofa-timeout` (default 300 seconds; also a task-file key). Ctrl-C always stops the wait. A run may use at most 5 `twofa` actions.
- **Nothing is recorded**: the secret and every code are scrubbed from `history.json`, `events.jsonl`, `network/`, the prompts and the terminal output. The recorded Playwright code shows `[2FA CODE]`.
- **An invalid `DUCKWRIGHT_TOTP_SECRET`** stops Duckwright before anything runs (exit `2`).
- **Exported tests**: a `totp` step becomes a `fill(totp())` that reads `DUCKWRIGHT_TOTP_SECRET` when the test runs, so the test works in CI. `sms`, `email` and `passkey` steps become `// MANUAL` steps with `await page.pause()`, and the export warns that the test cannot run unattended.
````
4. Next to the existing note that `code` contains whatever the agent typed (search for ``> `code` contains whatever the agent typed, passwords included.``) append a sentence: ` 2FA codes are the exception: they are replaced by `[2FA CODE]`.`
5. In the source-files table (search for the `taskfile.ts` row), add three rows after it:

```markdown
| [`totp.ts`](https://github.com/locle97/duckwright/blob/main/src/totp.ts) | RFC 6238 one-time passwords from a user-supplied secret |
| [`twofa.ts`](https://github.com/locle97/duckwright/blob/main/src/twofa.ts) | The per-run 2FA provider: env secret, human prompts, timeout and attempt cap |
| [`scrub.ts`](https://github.com/locle97/duckwright/blob/main/src/scrub.ts) | Removes the secret and 2FA codes from everything a run keeps or sends |
```

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Manual smoke check in each mode (needs a terminal, no browser)**

Run print mode against a fake agent is covered by tests; check the real prompts once:

```bash
node -e '
import("./src/report/ttyHuman.ts").then(async ({ createTtyHuman }) => {
  const h = createTtyHuman({ label: "smoke" });
  const ac = new AbortController();
  console.log("code:", JSON.stringify(await h.code("sms", ac.signal)));
  console.log("secret length:", (await h.secret(ac.signal)).length);
});'
```
Expected: the first prompt echoes what you type; the second shows no characters while typing; Ctrl-C at either prompt exits 130-style (the process receives SIGINT).

For the TUI, run `duckwright --tui`, add a task, and confirm the app starts and a normal run is unaffected (the dialog only appears when a run asks, which the `app.test.ts` tests cover with a fake manager). Report that the live browser path was not exercised.

- [ ] **Step 6: Commit**

```bash
git add README.md test/twofa.leak.test.ts
git commit -m "docs: two-factor verification; test: no secret or code leaks from a run"
```

---

## Self-review

**Spec coverage** (decision, task):
- D1/D2 action shape and static checks: Task 3 (`checkTwofaArgs`), Task 4 (rejection, schema).
- D3/D4 execution, D5 page-changing: Task 4.
- D6 cap, D7 provider (with the signal refinement noted above), D9 secret source, D15 wait and timeout: Task 3; `--twofa-timeout` Task 6.
- D8 TOTP: Task 1. D10 preflight: Task 7. D11 scrubber: Tasks 2 and 5.
- D12 recorded action: Tasks 4 (scrubbed code) and 5 (records). D13/D14 print mode: Task 7.
- D16/D17 TUI: Tasks 9 and 10. D18 events: Task 3 (also `past.ts` so past runs with these events still load).
- D19-D21 export: Task 8. D22/D23 prompt and schema: Task 4. D24 docs: Task 11.
- Errors table and leak test: Tasks 3, 4, 7, 11.

**Placeholder scan:** no TBD or "similar to Task N"; every code step has code.

**Type consistency:** `TwoFactor` (`scrubber`, `totp`, `code(kind)`, `approve`) is defined in Task 3 and used with those names in Tasks 4, 5, 6, 7 and 11. `Human` (`secret`, `code`, `approve`, each taking a signal) is used the same way in Tasks 3, 7, 9 and 11. `TaskSnapshot.twofa` and `answerTwoFactor` (Task 9) match Task 10. `HumanBridge.pending` returns `{ kind } | null`, as `TaskSnapshot.twofa` expects. `TwofaWait` has `"secret" | "sms" | "email" | "passkey"` in Tasks 3, 9 and 10. `runOne`'s new `label` parameter appears at all three call sites in Task 7.

**Known limits, stated so they are not a surprise:** `page/snapshot.yml` (the saved page snapshot) is not scrubbed, since the spec's scope is history, events, network, prompts and output; a page that echoes a code is scrubbed from the pasted copy in the prompt only. The live browser path (a real login with 2FA) is not exercised by any automated test.
