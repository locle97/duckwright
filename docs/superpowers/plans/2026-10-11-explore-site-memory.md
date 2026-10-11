# Explore Site Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `duckwright explore <url>` business-aware and deeper, record what it learns through a `note` action, and persist it as `environments/<slug>.sitemap.json` plus a generated block in `environments/<slug>.md` that the next explore run loads automatically.

**Architecture:** The agent emits validated `note` actions (appended to `<run>/notes.jsonl`) and the loop records per-step page evidence (URL, title, links) in `history.json`. After the run, a pure merge function folds history, notes and the flow answer into the sitemap, a writer regenerates only the generated block of the environment file, and `exploreMain` loads both before the next run and injects a capped "frontier brief" into the prompt. No model call is involved in the merge.

**Tech Stack:** TypeScript (Node ≥ 22.18, `.ts` imports, no build step for tests), `node:test`, existing modules `environment.ts`, `redact.ts`, `text.ts`, `explore/report.ts`.

**Spec:** `docs/superpowers/specs/2026-10-11-explore-site-memory-design.md` (builds on `docs/superpowers/specs/2026-10-10-exploration-mode-explore-design.md`).

## Global Constraints

- Node `>=22.18`; imports use the `.ts` extension; no new runtime dependencies (core uses only Node's standard library).
- Tests: `node --test test/explore/<file>.test.ts`; full gate is `npm test` (typecheck, then all tests).
- The environment file must stay within `ENV_MAX_BYTES` (16384) and load through `loadEnvironment`. Names must satisfy `isEnvName`.
- Sitemap caps: 500 pages, 100 flows, 100 frontier entries, 20 notes per kind. `version` is `1`.
- Note rules: kinds `business`, `page`, `quirk`, `off-limits`, `account`, `flow`; text at most 400 code points; `note` is available in explore runs only.
- Never persist secrets: notes are redacted or rejected, and no URL query strings are stored.
- Hand-written content below the generated block (`## Notes (yours)`) is preserved byte-for-byte.
- Explore default step budget is 60 (was 40); only `--max-steps` changes it.
- Memory is best-effort: a memory failure warns and only affects the exit code if the run itself passed (exit `1`).
- Commit after each task. Commit messages end with the `Co-Authored-By` and `Claude-Session` trailer lines used elsewhere on this branch.

## Review Focus

Failure modes the spec implies that no single task's happy path covers (each has a test in the owning task):

1. A hand-edited environment file (CRLF line endings, no trailing newline, duplicated or half-deleted generated markers) must keep every byte outside the generated block, and a malformed marker pair must warn and append rather than corrupt. (Task 5)
2. A note whose text begins with `-` (looks like a flag), contains a credential-looking value, or contains instructions aimed at the agent must be accepted or rejected by the note rules only, never treated as a flag or given authority; secrets never reach `notes.jsonl`. (Task 2)
3. Two consecutive runs on one host must not duplicate pages, notes or frontier entries, and the second run's frontier must shrink as pages get visited. (Tasks 4 and 9)
4. A step-limited, failed or no-history run must not mark pages stale, wipe data, or create files. (Tasks 4, 8 and 9)
5. `localhost:3000`, upper-case and bracketed hosts must produce a valid env name, parameterized URLs (`/product/1` … `/product/900`) must not blow the page cap, and URLs with `?token=…` must not be persisted. (Tasks 1 and 4)

---

### Task 1: Sitemap types, slug and URL normalization

**Files:**
- Create: `src/explore/site.ts`
- Test: `test/explore/site.test.ts`

**Interfaces:**
- Consumes: `FlowStatus` type from `src/explore/report.ts`.
- Produces (used by every later task):
  - `SITEMAP_VERSION = 1`, `CAPS`
  - types `PageStatus`, `SitePage`, `SiteFlow`, `NoteKind`, `MemoryKind`, `Sitemap`
  - `emptySitemap(host: string): Sitemap`
  - `slugForHost(host: string): string`
  - `normalizeUrl(raw: string, base?: string): string | null`
  - `collapsePatterns(urls: string[]): Map<string, string>` (url → path pattern such as `/product/:id`)

- [ ] **Step 1: Write the failing test**

```ts
// test/explore/site.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { collapsePatterns, emptySitemap, normalizeUrl, slugForHost } from "../../src/explore/site.ts";
import { isEnvName } from "../../src/environment.ts";

test("slugForHost makes valid env names", () => {
  for (const [host, slug] of [
    ["shop.example.com", "shop.example.com"],
    ["localhost:3000", "localhost-3000"],
    ["Shop.Example.COM", "shop.example.com"],
    ["[::1]:3000", "1-3000"],
    ["", "site"],
  ]) {
    assert.equal(slugForHost(host), slug);
    assert.ok(isEnvName(slug), slug);
  }
});

test("normalizeUrl strips query, fragment, credentials and trailing slash", () => {
  assert.equal(normalizeUrl("https://Shop.Example/a/?token=abc#f"), "https://shop.example/a");
  assert.equal(normalizeUrl("https://shop.example"), "https://shop.example/");
  assert.equal(normalizeUrl("https://u:p@shop.example/x"), "https://shop.example/x");
  assert.equal(normalizeUrl("/b", "https://shop.example/a/c"), "https://shop.example/b");
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  assert.equal(normalizeUrl("javascript:void(0)"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("collapsePatterns needs three id-like siblings", () => {
  const two = collapsePatterns(["https://s.test/p/1", "https://s.test/p/2"]);
  assert.equal(two.size, 0);
  const three = collapsePatterns(["https://s.test/p/1", "https://s.test/p/2", "https://s.test/p/30", "https://s.test/about"]);
  assert.equal(three.get("https://s.test/p/1"), "/p/:id");
  assert.equal(three.get("https://s.test/p/30"), "/p/:id");
  assert.equal(three.has("https://s.test/about"), false);
  const uuid = ["a", "b", "c"].map((c) => `https://s.test/o/${c.repeat(8)}-aaaa-bbbb-cccc-${c.repeat(12)}`);
  assert.equal(collapsePatterns(uuid).get(uuid[0]), "/o/:id");
});

test("emptySitemap has version 1 and empty collections", () => {
  const s = emptySitemap("shop.example");
  assert.equal(s.version, 1);
  assert.equal(s.runs, 0);
  assert.deepEqual(s.pages, []);
  assert.deepEqual(s.notes, { business: [], quirk: [], "off-limits": [], account: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/explore/site.test.ts`
Expected: FAIL (`Cannot find module '../../src/explore/site.ts'`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/explore/site.ts
import type { FlowStatus } from "./report.ts";

export const SITEMAP_VERSION = 1;
export const CAPS = { pages: 500, flows: 100, frontier: 100, notesPerKind: 20, linksPerPage: 100 } as const;

export type PageStatus = "ok" | "broken" | "stale" | "gated" | "external";
export type NoteKind = "business" | "page" | "quirk" | "off-limits" | "account" | "flow";
export type MemoryKind = "business" | "quirk" | "off-limits" | "account";
export const MEMORY_KINDS: readonly MemoryKind[] = ["business", "quirk", "off-limits", "account"];

export interface SitePage {
  url: string;
  title: string;
  purpose: string;
  status: PageStatus;
  http_status: number | null;
  depth: number;
  first_seen_run: number;
  last_seen_run: number;
  links: string[];
  pattern: string | null;
}

export interface SiteFlow {
  title: string;
  start_url: string;
  steps: string[];
  expected: string;
  status: FlowStatus;
  notes: string;
  last_run: number;
}

export interface Sitemap {
  version: 1;
  host: string;
  updated_run: string;
  runs: number;
  pages: SitePage[];
  flows: SiteFlow[];
  frontier: string[];
  external_links: string[];
  notes: Record<MemoryKind, string[]>;
}

export function emptySitemap(host: string): Sitemap {
  return {
    version: SITEMAP_VERSION, host, updated_run: "", runs: 0, pages: [], flows: [], frontier: [],
    external_links: [], notes: { business: [], quirk: [], "off-limits": [], account: [] },
  };
}

/** A valid environment name for a host: `localhost:3000` becomes `localhost-3000`. */
export function slugForHost(host: string): string {
  const s = host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/-+$/, "");
  return s === "" ? "site" : s;
}

/** http(s) only; drops query, fragment, credentials and any trailing slash (except the root). */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.search = "";
  u.username = "";
  u.password = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.href;
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})$/i;

/** Maps each URL that has two or more id-like siblings to its path pattern, e.g. `/product/:id`. */
export function collapsePatterns(urls: string[]): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const url of urls) {
    const u = new URL(url);
    const segs = u.pathname.split("/");
    segs.forEach((seg, i) => {
      if (i === 0 || !ID_SEGMENT.test(seg)) return;
      const key = u.origin + segs.map((s, j) => (j === i ? ":id" : s)).join("/");
      let set = groups.get(key);
      if (!set) groups.set(key, (set = new Set()));
      set.add(url);
    });
  }
  const out = new Map<string, string>();
  for (const [key, set] of groups) {
    if (set.size < 3) continue;
    for (const url of set) if (!out.has(url)) out.set(url, key.slice(new URL(url).origin.length));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/explore/site.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/explore/site.ts test/explore/site.test.ts
git commit -m "explore: sitemap types, slug and URL normalization"
```

---

### Task 2: The `note` action

**Files:**
- Create: `src/explore/notes.ts`
- Modify: `src/brain.ts` (command list and decision schema), `src/actions.ts` (`execute` and `rejection`), `src/loop.ts` (`AgentOptions`, `Agent`, the `execute` call), `prompts/system.md`
- Test: `test/explore/notes.test.ts`, plus additions to `test/actions.test.ts`

**Interfaces:**
- Consumes: `normalizeUrl`, `NoteKind` from `src/explore/site.ts`; `redactText` from `src/redact.ts`; `flat`, `codePointLength` from `src/text.ts`.
- Produces:
  - `NOTE_KINDS`, `NOTE_TEXT_MAX = 400`, `NOTES_FILE = "notes.jsonl"`
  - `interface NoteLine { step: number; kind: NoteKind; text: string; url: string | null }`
  - `looksLikeSecret(text: string): boolean`
  - `checkNoteArgs(args: string[], host: string): string | null` (error text or null)
  - `class NoteSink { step: number; constructor(workdir: string, host: string); add(args: string[]): string }` (returns `"ok"` or `"error: ..."`)
  - `readNotes(workdir: string): NoteLine[]`
  - `execute(pw, actions, codes?, hooks?, requests?, call?, twofa?, notes?: NoteSink | null)`; without a sink a `note` action returns `error: command 'note' not allowed outside explore runs`
  - `AgentOptions.notes?: NoteSink`

- [ ] **Step 1: Write the failing tests**

```ts
// test/explore/notes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { NoteSink, checkNoteArgs, looksLikeSecret, readNotes } from "../../src/explore/notes.ts";
import { tmpDir } from "../helpers.ts";

const HOST = "shop.example";

test("checkNoteArgs accepts each kind and an on-host url", () => {
  for (const kind of ["business", "page", "quirk", "off-limits", "account", "flow"]) {
    assert.equal(checkNoteArgs([kind, "text"], HOST), null, kind);
  }
  assert.equal(checkNoteArgs(["page", "Cart", "https://shop.example/cart?x=1"], HOST), null);
});

test("checkNoteArgs rejects bad shapes", () => {
  assert.match(checkNoteArgs(["nope", "x"], HOST) ?? "", /^error: .*kind/);
  assert.match(checkNoteArgs(["quirk"], HOST) ?? "", /^error:/);
  assert.match(checkNoteArgs(["quirk", "  "], HOST) ?? "", /^error:/);
  assert.match(checkNoteArgs(["quirk", "x".repeat(401)], HOST) ?? "", /400/);
  assert.match(checkNoteArgs(["page", "x", "https://other.example/"], HOST) ?? "", /host/);
  assert.match(checkNoteArgs(["page", "x", "ftp://shop.example/"], HOST) ?? "", /url/);
});

test("looksLikeSecret flags credentials, not credential sources", () => {
  assert.equal(looksLikeSecret("password: hunter2"), true);
  assert.equal(looksLikeSecret("api_key=abcd1234"), true);
  assert.equal(looksLikeSecret("Authorization: Bearer abc.def.ghi"), true);
  assert.equal(looksLikeSecret("token abcDEF1234567890abcDEF1234567890xyz"), true);
  assert.equal(looksLikeSecret("test user qa@shop.example; password comes from DUCKWRIGHT_QA_PASSWORD"), false);
  assert.equal(looksLikeSecret("Search is slow on the /products page"), false);
});

test("text starting with a dash is a valid note, not a flag", () => {
  assert.equal(checkNoteArgs(["quirk", "--submit is just text here"], HOST), null);
});

test("NoteSink appends only valid notes and readNotes is tolerant", () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, HOST);
  sink.step = 3;
  assert.equal(sink.add(["business", "A mug shop"]), "ok");
  assert.match(sink.add(["account", "password: hunter2"]), /^error:.*secret/);
  assert.equal(sink.add(["page", "Cart page", "https://shop.example/cart#x"]), "ok");
  const raw = fs.readFileSync(path.join(dir, "notes.jsonl"), "utf8");
  assert.ok(!raw.includes("hunter2"));
  fs.appendFileSync(path.join(dir, "notes.jsonl"), "not json\n");
  assert.deepEqual(readNotes(dir), [
    { step: 3, kind: "business", text: "A mug shop", url: null },
    { step: 3, kind: "page", text: "Cart page", url: "https://shop.example/cart" },
  ]);
  assert.deepEqual(readNotes(tmpDir()), []);
});
```

Add to `test/actions.test.ts` (match the file's existing fake-`PlaywrightCLI` helpers; read the file's first 60 lines for the pattern before writing):

```ts
test("note runs only with a sink and never touches the browser", async () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, "shop.example");
  const calls: string[] = [];
  const pw = fakePw((cmd) => { calls.push(cmd); return ok(""); }); // use this file's existing fake
  const withSink = await execute(pw, [{ cmd: "note", args: ["business", "A mug shop"] }], undefined, undefined, null, null, null, sink);
  assert.deepEqual(withSink.results, ["ok"]);
  assert.deepEqual(calls, []);
  const without = await execute(pw, [{ cmd: "note", args: ["business", "x"] }]);
  assert.match(without.results[0], /^error: command 'note' not allowed outside explore runs/);
});

test("note after a page-changing action is skipped, and a note beginning with a dash is not a bad flag", async () => {
  const dir = tmpDir();
  const sink = new NoteSink(dir, "shop.example");
  const pw = fakePw(() => ok(""));
  const r = await execute(pw, [
    { cmd: "note", args: ["quirk", "--weird text"] },
    { cmd: "click", args: ["e1"] },
    { cmd: "note", args: ["quirk", "after"] },
  ], undefined, undefined, null, null, null, sink);
  assert.equal(r.results[0], "ok");
  assert.match(r.results[2], /^skipped:/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/explore/notes.test.ts test/actions.test.ts`
Expected: FAIL (module missing; `note` not allowed).

- [ ] **Step 3: Write the implementation**

`src/explore/notes.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

import { redactText } from "../redact.ts";
import { codePointLength, flat } from "../text.ts";
import { normalizeUrl } from "./site.ts";
import type { NoteKind } from "./site.ts";

export const NOTE_KINDS: readonly NoteKind[] = ["business", "page", "quirk", "off-limits", "account", "flow"];
export const NOTE_TEXT_MAX = 400;
export const NOTES_FILE = "notes.jsonl";

export interface NoteLine {
  step: number;
  kind: NoteKind;
  text: string;
  url: string | null;
}

const SECRET_ASSIGN = /\b(pass(word|wd)?|secret|token|api[-_ ]?key|otp|pin)\b\s*[:=]\s*\S+/i;
const LONG_TOKEN = /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{32,}\b/;

export function looksLikeSecret(text: string): boolean {
  return redactText(text) !== text || SECRET_ASSIGN.test(text) || LONG_TOKEN.test(text);
}

/** The error text for an invalid note action, or null when it is fine. */
export function checkNoteArgs(args: string[], host: string): string | null {
  if (args.length < 2 || args.length > 3) return "error: note needs [kind, text] or [kind, text, url]";
  if (!NOTE_KINDS.includes(args[0] as NoteKind)) return `error: note kind must be one of ${NOTE_KINDS.join(", ")}`;
  const text = flat(args[1]).trim();
  if (text === "") return "error: note text is empty";
  if (codePointLength(text) > NOTE_TEXT_MAX) return `error: note text is longer than ${NOTE_TEXT_MAX} characters`;
  if (looksLikeSecret(text)) {
    return "error: note looks like it contains a secret; name where the credential comes from instead of its value";
  }
  if (args.length === 3) {
    const url = normalizeUrl(args[2]);
    if (url === null) return "error: note url must be an http(s) url";
    if (new URL(url).host !== host) return `error: note url must be on the host ${host}`;
  }
  return null;
}

/** Appends validated notes to `<workdir>/notes.jsonl`; the loop sets `step` before each execute. */
export class NoteSink {
  step = 0;

  constructor(readonly workdir: string, readonly host: string) {}

  add(args: string[]): string {
    const err = checkNoteArgs(args, this.host);
    if (err !== null) return err;
    const line: NoteLine = {
      step: this.step, kind: args[0] as NoteKind, text: flat(args[1]).trim(),
      url: args.length === 3 ? normalizeUrl(args[2]) : null,
    };
    fs.appendFileSync(path.join(this.workdir, NOTES_FILE), JSON.stringify(line) + "\n");
    return "ok";
  }
}

/** Never throws: a missing file is no notes, an unreadable line is skipped. */
export function readNotes(workdir: string): NoteLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workdir, NOTES_FILE), "utf8");
  } catch {
    return [];
  }
  const out: NoteLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as NoteLine;
      if (NOTE_KINDS.includes(o.kind) && typeof o.text === "string" && typeof o.step === "number") {
        out.push({ step: o.step, kind: o.kind, text: o.text, url: typeof o.url === "string" ? o.url : null });
      }
    } catch {
      // skip a damaged line
    }
  }
  return out;
}
```

`src/brain.ts`: add `"note"` to `ALLOWED_COMMANDS` (before `"done"`), exclude it in the generic enum filter (`c !== "note"` next to `c !== "twofa"`), and add a schema alternative beside `expect-request`:

```ts
          // note: kind, text, then an optional url on the explored host (explore runs only).
          {
            type: "object",
            required: ["cmd", "args"],
            properties: {
              cmd: { const: "note" },
              args: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 },
            },
          },
```

`src/actions.ts`:
- import `type { NoteSink } from "./explore/notes.ts"`.
- in `rejection`, add before the `badFlag` check: `if (a.cmd === "note") return null; // validated by the sink; its text may look like a flag`.
- add a trailing parameter to `execute`: `notes?: NoteSink | null`, document it in the doc comment, and add this branch before the generic `pw.run` call:

```ts
    if (a.cmd === "note") {
      results.push(notes ? clip(notes.add(a.args)) : "error: command 'note' not allowed outside explore runs");
      return;
    }
```

`src/loop.ts`: add `notes?: NoteSink;` to `AgentOptions`, `readonly notes: NoteSink | undefined;` to `Agent`, `this.notes = opts.notes;` in the constructor, `if (this.notes) this.notes.step = step;` just before the `execute(...)` call, and pass `this.notes ?? null` as the new last argument.

`prompts/system.md`: add `note` to the "You may ONLY use these commands" list and, after "Checking the outcome", add a short section:

```
## Notes (explore runs only)

In an exploration run you may also use `note`: `{"cmd": "note", "args": ["<kind>", "<text>"]}` or with a page URL on the explored host as a third argument. Kinds: business (what the site is for, who uses it), page (what one page is for; third arg is its URL), quirk, off-limits (areas not to touch), account (which test account exists and where its credential comes from, never the value), flow. Keep each note under 400 characters. Notes are saved even if the run is cut off. `note` does not change the page.
```

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/notes.test.ts test/actions.test.ts test/brain.test.ts test/prompt.test.ts && npm run typecheck`
Expected: PASS. If a test compares `system.md` or the schema with `ALLOWED_COMMANDS` and fails, update that test's expectation to include `note`.

- [ ] **Step 5: Commit**

```bash
git add src/explore/notes.ts src/brain.ts src/actions.ts src/loop.ts prompts/system.md test/explore/notes.test.ts test/actions.test.ts test/brain.test.ts
git commit -m "explore: add the note action and notes.jsonl sink"
```

---

### Task 3: Page evidence in history

**Files:**
- Create: `src/explore/pages.ts`
- Modify: `src/prompt.ts` (`StepRecord.page`), `src/loop.ts` (`AgentOptions.pageInfo`, record the page), `src/runs/run.ts` (`historyJson`), `src/export.ts` (`HistoryStep.page`)
- Test: `test/explore/pages.test.ts`; add a case to `test/loop.test.ts`

**Interfaces:**
- Consumes: `normalizeUrl` (Task 1); `pageDir`, `SNAPSHOT_FILE` from `src/observe.ts`.
- Produces:
  - `interface PageInfo { url: string; title: string; links: string[] }` (URLs normalized: no query or fragment)
  - `parsePage(tabs: string, snapshot: string | null): PageInfo | null`
  - `readPage(tabs: string, workdir: string): PageInfo | null`
  - `StepRecord.page?: PageInfo`, `HistoryStep.page?: PageInfo` (written as `page` in `history.json`)
  - `AgentOptions.pageInfo?: boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/explore/pages.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../src/explore/pages.ts";

const TABS = "### Result\n- 0: [Other](https://a.test/)\n- 1: (current) [Mugs | Shop](https://shop.example/mugs?utm=1#top)\n";
const SNAP = [
  "- link \"Home\" [ref=e1]:",
  "  - /url: /",
  "- link \"Cart\" [ref=e2]:",
  "  - /url: /cart?item=7",
  "- link \"Docs\" [ref=e3]:",
  "  - /url: https://docs.shop.example/x",
  "- link \"Mail\" [ref=e4]:",
  "  - /url: mailto:hi@shop.example",
  "- link \"Cart again\" [ref=e5]:",
  "  - /url: /cart",
].join("\n");

test("parsePage reads the current tab and normalized, resolved, de-duplicated links", () => {
  assert.deepEqual(parsePage(TABS, SNAP), {
    url: "https://shop.example/mugs",
    title: "Mugs | Shop",
    links: ["https://shop.example/", "https://shop.example/cart", "https://docs.shop.example/x"],
  });
});

test("parsePage without a snapshot has no links; non-http pages are null", () => {
  assert.deepEqual(parsePage(TABS, null)?.links, []);
  assert.equal(parsePage("- 0: (current) [New tab](about:blank)", SNAP), null);
  assert.equal(parsePage("", SNAP), null);
});
```

Add to `test/loop.test.ts` a case that runs an `Agent` with `pageInfo: true` against the file's existing fake `pw` whose `tab-list` returns the `TABS` text above, and asserts `result.history[0].page?.url === "https://shop.example/mugs"`; a second case with `pageInfo` unset asserts `page` is `undefined`. (Copy the setup from the existing `consoleErrors` loop test.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/explore/pages.test.ts test/loop.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/explore/pages.ts
import fs from "node:fs";
import path from "node:path";

import { SNAPSHOT_FILE, pageDir } from "../observe.ts";
import { normalizeUrl } from "./site.ts";

export const MAX_PAGE_LINKS = 200;

export interface PageInfo {
  url: string;
  title: string;
  links: string[];
}

const CURRENT_TAB = /^- \d+: \(current\) \[(.*)\]\((\S+)\)\s*$/;
const LINK_URL = /^\s*- \/url:\s*(.+?)\s*$/;

/** The current http(s) tab and the links in its snapshot; null when the tab is not a web page. */
export function parsePage(tabs: string, snapshot: string | null): PageInfo | null {
  let title = "";
  let url: string | null = null;
  for (const line of tabs.split(/\r?\n/)) {
    const m = CURRENT_TAB.exec(line);
    if (m) {
      title = m[1];
      url = normalizeUrl(m[2]);
      break;
    }
  }
  if (url === null) return null;
  const links: string[] = [];
  const seen = new Set<string>();
  for (const line of (snapshot ?? "").split(/\r?\n/)) {
    const m = LINK_URL.exec(line);
    if (!m) continue;
    const raw = m[1].replace(/^["']|["']$/g, "");
    const abs = normalizeUrl(raw, url);
    if (abs === null || seen.has(abs)) continue;
    seen.add(abs);
    links.push(abs);
    if (links.length >= MAX_PAGE_LINKS) break;
  }
  return { url, title, links };
}

/** Like parsePage, reading the snapshot file the observer just wrote; never throws. */
export function readPage(tabs: string, workdir: string): PageInfo | null {
  let snapshot: string | null = null;
  try {
    snapshot = fs.readFileSync(path.join(pageDir(workdir), SNAPSHOT_FILE), "utf8");
  } catch {
    // no snapshot file: still record the page
  }
  return parsePage(tabs, snapshot);
}
```

Wiring:
- `src/prompt.ts`: import `type { PageInfo } from "./explore/pages.ts"` and add `page?: PageInfo;` to `StepRecord`.
- `src/export.ts`: add `page?: { url: string; title: string; links: string[] };` to `HistoryStep`.
- `src/loop.ts`: add `pageInfo?: boolean` to `AgentOptions`, `readonly pageInfo: boolean` to `Agent` (`this.pageInfo = opts.pageInfo ?? false;`), and right after `rec` is created (before the network capture block):

```ts
      if (this.pageInfo) {
        const page = readPage(obs.tabs, this.workdir);
        if (page !== null) rec.page = page;
      }
```
- `src/runs/run.ts` `historyJson`: add `...(r.page ? { page: r.page } : {}),` after the `console_errors` line.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/pages.test.ts test/loop.test.ts test/runs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/explore/pages.ts src/prompt.ts src/export.ts src/loop.ts src/runs/run.ts test/explore/pages.test.ts test/loop.test.ts
git commit -m "explore: record the current page and its links per step"
```

---

### Task 4: Sitemap merge

**Files:**
- Create: `src/explore/merge.ts`
- Test: `test/explore/merge.test.ts`

**Interfaces:**
- Consumes: everything from `site.ts`; `PageInfo` (Task 3); `NoteLine` (Task 2); `Flow` from `report.ts`.
- Produces:
  - `interface RunEvidence { host: string; runName: string; start: string; pages: PageInfo[]; notes: NoteLine[]; flows: Flow[]; failedPages: string[]; completed: boolean }` where `start` is the normalized start URL, `pages` are in visit order and may repeat, `failedPages` are normalized URLs that returned status ≥ 400, and `completed` is true only when the run finished with `done success`
  - `interface MergeSummary { added_pages: number; updated_pages: number; broken_pages: number; stale_pages: number; notes_added: number; notes_dropped: number; flows_updated: number }`
  - `mergeSitemap(old: Sitemap | null, ev: RunEvidence): { sitemap: Sitemap; summary: MergeSummary }` (pure; does not mutate `old`)

- [ ] **Step 1: Write the failing tests**

```ts
// test/explore/merge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeSitemap } from "../../src/explore/merge.ts";
import type { RunEvidence } from "../../src/explore/merge.ts";
import { CAPS } from "../../src/explore/site.ts";

const H = "shop.example";
const u = (p: string) => `https://${H}${p}`;
const page = (p: string, links: string[] = [], title = p) => ({ url: u(p), title, links: links.map(u) });
const ev = (over: Partial<RunEvidence> = {}): RunEvidence => ({
  host: H, runName: "run-1", start: u("/"), pages: [], notes: [], flows: [], failedPages: [], completed: true, ...over,
});

test("first run builds pages, depth, frontier and external links", () => {
  const { sitemap, summary } = mergeSitemap(null, ev({
    pages: [page("/", ["/a", "/b"]), page("/a", ["/c"])],
  }));
  assert.equal(sitemap.runs, 1);
  assert.deepEqual(sitemap.pages.map((p) => [p.url, p.depth]).sort(), [[u("/"), 0], [u("/a"), 1]]);
  assert.deepEqual([...sitemap.frontier].sort(), [u("/b"), u("/c")]);
  assert.equal(summary.added_pages, 2);
});

test("a second run extends the map without duplicates and shrinks the frontier", () => {
  const first = mergeSitemap(null, ev({ pages: [page("/", ["/a", "/b"])] })).sitemap;
  const second = mergeSitemap(first, ev({ runName: "run-2", pages: [page("/b", ["/"]), page("/", ["/a", "/b"])] }));
  assert.equal(second.sitemap.runs, 2);
  assert.equal(new Set(second.sitemap.pages.map((p) => p.url)).size, second.sitemap.pages.length);
  assert.deepEqual(second.sitemap.frontier, [u("/a")]);
  assert.equal(second.sitemap.pages.find((p) => p.url === u("/"))?.last_seen_run, 2);
  assert.equal(second.sitemap.pages.find((p) => p.url === u("/"))?.first_seen_run, 1);
  assert.equal(second.summary.updated_pages, 2);
});

test("old is not mutated", () => {
  const first = mergeSitemap(null, ev({ pages: [page("/", [])] })).sitemap;
  const snapshot = JSON.stringify(first);
  mergeSitemap(first, ev({ pages: [page("/x", [])] }));
  assert.equal(JSON.stringify(first), snapshot);
});

test("failed pages become broken and recover when they work again", () => {
  const a = mergeSitemap(null, ev({ pages: [page("/", ["/a"]), page("/a")], failedPages: [u("/a")] })).sitemap;
  assert.equal(a.pages.find((p) => p.url === u("/a"))?.status, "broken");
  const b = mergeSitemap(a, ev({ pages: [page("/a")] })).sitemap;
  assert.equal(b.pages.find((p) => p.url === u("/a"))?.status, "ok");
});

test("staleness: only after 3 runs unseen, only from a completed run", () => {
  let sm = mergeSitemap(null, ev({ pages: [page("/", ["/a"]), page("/a")] })).sitemap;
  for (const n of [2, 3]) sm = mergeSitemap(sm, ev({ runName: `r${n}`, pages: [page("/")] })).sitemap;
  assert.equal(sm.pages.find((p) => p.url === u("/a"))?.status, "ok"); // seen at run 1, now run 3: gap 2
  const stepLimited = mergeSitemap(sm, ev({ pages: [page("/")], completed: false })).sitemap;
  assert.equal(stepLimited.pages.find((p) => p.url === u("/a"))?.status, "ok");
  const done = mergeSitemap(sm, ev({ pages: [page("/")], completed: true }));
  assert.equal(done.sitemap.pages.find((p) => p.url === u("/a"))?.status, "stale");
  assert.equal(done.summary.stale_pages, 1);
});

test("a run with no same-host pages changes nothing but is still a valid sitemap", () => {
  const first = mergeSitemap(null, ev({ pages: [page("/")] })).sitemap;
  const again = mergeSitemap(first, ev({ pages: [], completed: false })).sitemap;
  assert.deepEqual(again.pages, first.pages);
});

test("off-host landing is an external page; its links are not followed", () => {
  const { sitemap } = mergeSitemap(null, ev({
    pages: [page("/", []), { url: "https://other.test/x", title: "Other", links: ["https://other.test/y"] }],
  }));
  const ext = sitemap.pages.find((p) => p.url === "https://other.test/x");
  assert.equal(ext?.status, "external");
  assert.deepEqual(ext?.links, []);
  assert.deepEqual(sitemap.frontier, []);
});

test("parameterized urls collapse to one page and respect the page cap", () => {
  const many = Array.from({ length: 900 }, (_, i) => page(`/product/${i + 1}`));
  const { sitemap } = mergeSitemap(null, ev({ pages: [page("/", many.map((m) => m.url.slice(`https://${H}`.length))), ...many] }));
  const products = sitemap.pages.filter((p) => p.pattern === "/product/:id");
  assert.equal(products.length, 1);
  assert.equal(products[0].url, u("/product/:id"));
  assert.ok(sitemap.pages.length <= CAPS.pages);
  assert.ok(sitemap.frontier.length <= CAPS.frontier);
});

test("notes dedupe, cap per kind, fill page purpose, and never store secrets or queries", () => {
  const notes = [
    { step: 1, kind: "business" as const, text: "A mug shop", url: null },
    { step: 2, kind: "business" as const, text: "a  mug shop", url: null },
    { step: 2, kind: "page" as const, text: "Where mugs are listed", url: u("/") },
    { step: 3, kind: "off-limits" as const, text: "Do not open /admin", url: null },
    { step: 4, kind: "page" as const, text: "orphan", url: null },
  ];
  const { sitemap, summary } = mergeSitemap(null, ev({ pages: [page("/")], notes }));
  assert.deepEqual(sitemap.notes.business, ["A mug shop"]);
  assert.deepEqual(sitemap.notes["off-limits"], ["Do not open /admin"]);
  assert.equal(sitemap.pages[0].purpose, "Where mugs are listed");
  assert.equal(summary.notes_added, 3);
  assert.equal(summary.notes_dropped, 2);
  const many = Array.from({ length: 30 }, (_, i) => ({ step: 1, kind: "quirk" as const, text: `quirk ${i}`, url: null }));
  assert.equal(mergeSitemap(null, ev({ pages: [page("/")], notes: many })).sitemap.notes.quirk.length, CAPS.notesPerKind);
  assert.ok(!JSON.stringify(sitemap).includes("?"));
});

test("a gated note marks the page; a flow note attaches to the matching flow", () => {
  const flows = [{ title: "Checkout", start_url: u("/cart"), steps: [], expected: "", status: "ok" as const, notes: "" }];
  const notes = [
    { step: 1, kind: "page" as const, text: "gated: needs a login", url: u("/account") },
    { step: 2, kind: "flow" as const, text: "stops before payment", url: u("/cart") },
  ];
  const { sitemap } = mergeSitemap(null, ev({ pages: [page("/"), page("/account")], notes, flows }));
  assert.equal(sitemap.pages.find((p) => p.url === u("/account"))?.status, "gated");
  assert.equal(sitemap.flows[0].notes, "stops before payment");
});

test("flows: the latest verdict replaces the old one and unrelated flows stay", () => {
  const f = (status: "ok" | "broken") => ({ title: "Search", start_url: u("/"), steps: ["s"], expected: "e", status, notes: "" });
  const a = mergeSitemap(null, ev({ pages: [page("/")], flows: [f("ok"), { ...f("ok"), title: "Other" }] })).sitemap;
  const b = mergeSitemap(a, ev({ pages: [page("/")], flows: [f("broken")] }));
  assert.equal(b.sitemap.flows.length, 2);
  assert.equal(b.sitemap.flows.find((x) => x.title === "Search")?.status, "broken");
  assert.equal(b.sitemap.flows.find((x) => x.title === "Search")?.last_run, 2);
  assert.equal(b.summary.flows_updated, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/explore/merge.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/explore/merge.ts
import { flat } from "../text.ts";
import type { PageInfo } from "./pages.ts";
import type { NoteLine } from "./notes.ts";
import type { Flow } from "./report.ts";
import {
  CAPS, MEMORY_KINDS, collapsePatterns, emptySitemap, normalizeUrl,
} from "./site.ts";
import type { MemoryKind, SiteFlow, SitePage, Sitemap } from "./site.ts";

export const STALE_AFTER_RUNS = 3;
const BROKEN_PRUNE_AFTER_RUNS = 10;

export interface RunEvidence {
  host: string;
  runName: string;
  start: string;
  pages: PageInfo[];
  notes: NoteLine[];
  flows: Flow[];
  failedPages: string[];
  completed: boolean;
}

export interface MergeSummary {
  added_pages: number;
  updated_pages: number;
  broken_pages: number;
  stale_pages: number;
  notes_added: number;
  notes_dropped: number;
  flows_updated: number;
}

const hostOf = (url: string) => new URL(url).host;
const noteKey = (text: string) => flat(text).toLowerCase().replace(/\s+/g, " ").trim();
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function mergeSitemap(old: Sitemap | null, ev: RunEvidence): { sitemap: Sitemap; summary: MergeSummary } {
  const base: Sitemap = old ? structuredClone(old) : emptySitemap(ev.host);
  const run = base.runs + 1;
  const summary: MergeSummary = {
    added_pages: 0, updated_pages: 0, broken_pages: 0, stale_pages: 0, notes_added: 0, notes_dropped: 0, flows_updated: 0,
  };
  const pages = new Map<string, SitePage>(base.pages.map((p) => [p.url, p]));
  const visited = new Set<string>();

  // 1. Pages seen this run.
  for (const obs of ev.pages) {
    const external = hostOf(obs.url) !== ev.host;
    const links = external ? [] : obs.links.filter((l) => hostOf(l) === ev.host);
    let p = pages.get(obs.url);
    if (!p) {
      p = {
        url: obs.url, title: obs.title, purpose: "", status: external ? "external" : "ok", http_status: null,
        depth: 1, first_seen_run: run, last_seen_run: run, links: [], pattern: null,
      };
      pages.set(obs.url, p);
      summary.added_pages++;
    } else if (!visited.has(obs.url)) {
      summary.updated_pages++;
    }
    visited.add(obs.url);
    p.title = obs.title || p.title;
    p.last_seen_run = run;
    p.links = uniq([...p.links, ...links]).slice(0, CAPS.linksPerPage);
    if (!external && (p.status === "stale" || p.status === "broken")) p.status = "ok";
  }
  const sameHostVisited = ev.pages.some((o) => hostOf(o.url) === ev.host);

  // 2. Broken pages: a failed request, or a flow that starts there and was judged broken.
  const brokenUrls = new Set(ev.failedPages);
  for (const f of ev.flows) {
    const s = normalizeUrl(f.start_url);
    if (f.status === "broken" && s !== null) brokenUrls.add(s);
  }
  for (const url of brokenUrls) {
    const p = pages.get(url);
    if (p && visited.has(url)) {
      p.status = "broken";
      summary.broken_pages++;
    }
  }

  // 3. Stale pages: only a run that finished normally can say a page is gone.
  if (ev.completed && sameHostVisited) {
    for (const p of pages.values()) {
      if (!visited.has(p.url) && p.status !== "external" && run - p.last_seen_run >= STALE_AFTER_RUNS && p.status !== "stale") {
        p.status = "stale";
        summary.stale_pages++;
      }
    }
  }

  // 4. Notes.
  for (const kind of MEMORY_KINDS) base.notes[kind] = base.notes[kind] ?? [];
  for (const n of ev.notes) {
    if (n.kind === "page") {
      const p = n.url ? pages.get(n.url) : undefined;
      if (!p) { summary.notes_dropped++; continue; }
      if (/^\s*gated\b/i.test(n.text)) p.status = "gated";
      else p.purpose = n.text;
      summary.notes_added++;
    } else if (n.kind === "flow") {
      const target = ev.flows.length && n.url ? ev.flows.find((f) => normalizeUrl(f.start_url) === n.url) : undefined;
      if (!target) { summary.notes_dropped++; continue; }
      target.notes = target.notes ? `${target.notes}; ${n.text}` : n.text;
      summary.notes_added++;
    } else {
      const list = base.notes[n.kind as MemoryKind];
      if (list.some((t) => noteKey(t) === noteKey(n.text))) { summary.notes_dropped++; continue; }
      list.push(n.text);
      if (list.length > CAPS.notesPerKind) list.shift();
      summary.notes_added++;
    }
  }

  // 5. Flows: newest verdict wins, keyed by title and start URL.
  const flowKey = (title: string, url: string) => `${title.toLowerCase()}|${normalizeUrl(url) ?? url}`;
  const flows = new Map<string, SiteFlow>(base.flows.map((f) => [flowKey(f.title, f.start_url), f]));
  for (const f of ev.flows) {
    flows.set(flowKey(f.title, f.start_url), { ...f, steps: [...f.steps], last_run: run });
    summary.flows_updated++;
  }
  base.flows = [...flows.values()].sort((a, b) => b.last_run - a.last_run).slice(0, CAPS.flows);

  // 6. Collapse parameterized urls (/product/1, /product/2, ...) into one page and one link target.
  const patterns = collapsePatterns([...pages.keys(), ...pages.values().flatMap((p) => p.links), ...base.frontier]);
  const canon = (url: string): string => {
    const pat = patterns.get(url);
    return pat === undefined ? url : new URL(url).origin + pat;
  };
  const merged = new Map<string, SitePage>();
  for (const p of pages.values()) {
    const key = canon(p.url);
    const links = uniq(p.links.map(canon));
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...p, url: key, links, pattern: patterns.get(p.url) ?? null });
      continue;
    }
    prev.first_seen_run = Math.min(prev.first_seen_run, p.first_seen_run);
    prev.last_seen_run = Math.max(prev.last_seen_run, p.last_seen_run);
    prev.links = uniq([...prev.links, ...links]).slice(0, CAPS.linksPerPage);
    if (p.status === "broken") prev.status = "broken";
    prev.purpose = prev.purpose || p.purpose;
  }

  // 7. Depth: breadth-first from the start URL; unreachable pages keep their old depth.
  const start = canon(ev.start);
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const l of merged.get(queue[i])?.links ?? []) {
      if (!depth.has(l)) { depth.set(l, depth.get(queue[i])! + 1); queue.push(l); }
    }
  }
  for (const p of merged.values()) p.depth = depth.get(p.url) ?? p.depth;

  // 8. Frontier: same-host link targets never visited, plus the old frontier, nearest first.
  const known = new Set(merged.keys());
  const candidates = uniq([
    ...[...merged.values()].filter((p) => p.status !== "external").flatMap((p) => p.links),
    ...base.frontier.map(canon),
  ]).filter((l) => !known.has(l) && hostOf(l) === ev.host);
  base.frontier = candidates.slice(0, CAPS.frontier);
  base.external_links = uniq([
    ...base.external_links,
    ...[...merged.values()].flatMap((p) => p.links.filter((l) => hostOf(l) !== ev.host)),
  ]).slice(0, CAPS.frontier);

  // 9. Page cap: drop long-broken pages first, then the least recently seen and deepest.
  let list = [...merged.values()];
  if (list.length > CAPS.pages) {
    const rank = (p: SitePage) => (p.status === "broken" && run - p.last_seen_run > BROKEN_PRUNE_AFTER_RUNS ? 0 : 1);
    list.sort((a, b) => rank(b) - rank(a) || b.last_seen_run - a.last_seen_run || a.depth - b.depth);
    list = list.slice(0, CAPS.pages);
  }
  base.pages = list.sort((a, b) => a.depth - b.depth || (a.url < b.url ? -1 : 1));
  base.runs = run;
  base.updated_run = ev.runName;
  return { sitemap: base, summary };
}
```

Implementation notes for the engineer: `Iterator.prototype.flatMap` on `pages.values()` needs Node ≥ 22 (already required); if typecheck complains, use `[...pages.values()].flatMap`. The `flows` objects from `ev.flows` are mutated by the `flow` note branch (`target.notes`); that is acceptable because they are built per run, but if a test shows `ev.flows` reused across calls, clone them first.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/merge.test.ts && npm run typecheck`
Expected: PASS. Fix any failing expectation by adjusting the code, not the spec semantics (staleness needs a gap of at least 3 runs, a step-limited run never stales, no query strings are stored).

- [ ] **Step 5: Commit**

```bash
git add src/explore/merge.ts test/explore/merge.test.ts
git commit -m "explore: deterministic sitemap merge"
```

---

### Task 5: Environment file writer

**Files:**
- Create: `src/explore/envfile.ts`
- Test: `test/explore/envfile.test.ts`

**Interfaces:**
- Consumes: `Sitemap` (Task 1); `ENV_MAX_BYTES`, `loadEnvironment` from `src/environment.ts`.
- Produces:
  - `GEN_START_PREFIX = "<!-- duckwright:generated:start"`, `GEN_END = "<!-- duckwright:generated:end -->"`, `HAND_HEADING = "## Notes (yours)"`
  - `renderGenerated(sm: Sitemap, opts?: { treeDepth: number; maxPages: number; maxPerSection: number }): string` (the block including both marker lines)
  - `updateEnvText(existing: string | null, sm: Sitemap): { text: string; warnings: string[] }`
  - `writeEnvFile(file: string, sm: Sitemap): string[]` (warnings); writes atomically (temp file then rename), creating the folder if needed

- [ ] **Step 1: Write the failing tests**

```ts
// test/explore/envfile.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ENV_MAX_BYTES, loadEnvironment } from "../../src/environment.ts";
import { GEN_END, HAND_HEADING, updateEnvText, writeEnvFile } from "../../src/explore/envfile.ts";
import { emptySitemap } from "../../src/explore/site.ts";
import type { Sitemap } from "../../src/explore/site.ts";
import { tmpDir } from "../helpers.ts";

const sm = (over: Partial<Sitemap> = {}): Sitemap => ({
  ...emptySitemap("shop.example"), runs: 2,
  notes: { business: ["A mug shop for home cooks"], quirk: ["Search needs 3 letters"], "off-limits": ["/admin"], account: ["qa user; password from DUCKWRIGHT_QA_PASSWORD"] },
  pages: [
    { url: "https://shop.example/", title: "Home", purpose: "Landing", status: "ok", http_status: 200, depth: 0, first_seen_run: 1, last_seen_run: 2, links: [], pattern: null },
    { url: "https://shop.example/cart", title: "Cart", purpose: "", status: "broken", http_status: 500, depth: 1, first_seen_run: 1, last_seen_run: 2, links: [], pattern: null },
  ],
  flows: [{ title: "Search", start_url: "https://shop.example/", steps: [], expected: "", status: "ok", notes: "", last_run: 2 }],
  ...over,
});

test("a new file has the generated block, then an empty hand-written section", () => {
  const { text, warnings } = updateEnvText(null, sm());
  assert.deepEqual(warnings, []);
  assert.match(text, /A mug shop for home cooks/);
  assert.match(text, /\/cart.*broken/);
  assert.ok(text.indexOf(GEN_END) < text.indexOf(HAND_HEADING));
  assert.ok(text.trimEnd().endsWith(HAND_HEADING));
});

test("regeneration keeps everything outside the block byte-for-byte (CRLF, no trailing newline)", () => {
  const first = updateEnvText(null, sm()).text;
  const edited = first.replace(HAND_HEADING, `${HAND_HEADING}\r\nMy own note\r\n- keep me`) .replace(/\n/g, "\r\n").replace(/\r\r\n/g, "\r\n");
  const after = updateEnvText(edited, sm({ notes: { business: ["Changed"], quirk: [], "off-limits": [], account: [] } })).text;
  assert.ok(after.includes("Changed"));
  const tail = (s: string) => s.slice(s.indexOf(GEN_END) + GEN_END.length);
  assert.equal(tail(after), tail(edited));
  const head = (s: string) => s.slice(0, s.indexOf("<!-- duckwright:generated:start"));
  assert.equal(head(after), head(edited));
});

test("a hand-written file without markers gets a block appended and is otherwise untouched", () => {
  const mine = "# Staging\nBase URL: https://staging.test\n";
  const { text, warnings } = updateEnvText(mine, sm());
  assert.ok(text.startsWith(mine));
  assert.deepEqual(warnings, []);
});

test("duplicated or half-deleted markers warn and append instead of corrupting", () => {
  const block = updateEnvText(null, sm()).text;
  const dup = block + "\n" + block;
  const a = updateEnvText(dup, sm());
  assert.ok(a.text.startsWith(dup));
  assert.match(a.warnings.join(), /marker/);
  const half = block.replace(GEN_END, "");
  const b = updateEnvText(half, sm());
  assert.ok(b.text.startsWith(half));
  assert.match(b.warnings.join(), /marker/);
});

test("the file never exceeds the environment limit and never trims the hand-written part", () => {
  const pages = Array.from({ length: 500 }, (_, i) => ({
    url: `https://shop.example/section-${i}/very/long/path/segment/number/${i}`, title: "T".repeat(60), purpose: "P".repeat(120),
    status: "ok" as const, http_status: 200, depth: 1 + (i % 4), first_seen_run: 1, last_seen_run: 2, links: [], pattern: null,
  }));
  const big = sm({ pages, notes: { business: ["B".repeat(380)], quirk: Array(20).fill("Q".repeat(380)), "off-limits": Array(20).fill("O".repeat(380)), account: Array(20).fill("A".repeat(380)) } });
  const hand = `${HAND_HEADING}\n` + "mine\n".repeat(400);
  const existing = updateEnvText(null, sm()).text.replace(HAND_HEADING, hand.trimEnd());
  const { text } = updateEnvText(existing, big);
  assert.ok(Buffer.byteLength(text) <= ENV_MAX_BYTES, String(Buffer.byteLength(text)));
  assert.ok(text.endsWith("mine\n".repeat(400).trimEnd()) || text.includes("mine\n".repeat(400).trimEnd()));
});

test("writeEnvFile writes atomically and the result loads through loadEnvironment", () => {
  const dir = tmpDir();
  const file = path.join(dir, "environments", "shop.example.md");
  assert.deepEqual(writeEnvFile(file, sm()), []);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["shop.example.md"]);
  const loaded = loadEnvironment(file, dir);
  assert.match(loaded.text, /Search needs 3 letters/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/explore/envfile.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/explore/envfile.ts
import fs from "node:fs";
import path from "node:path";

import { ENV_MAX_BYTES } from "../environment.ts";
import { flat } from "../text.ts";
import type { Sitemap } from "./site.ts";

export const GEN_START_PREFIX = "<!-- duckwright:generated:start";
export const GEN_END = "<!-- duckwright:generated:end -->";
export const HAND_HEADING = "## Notes (yours)";

export interface RenderOptions {
  treeDepth: number;
  maxPages: number;
  maxPerSection: number;
}
const FULL: RenderOptions = { treeDepth: 4, maxPages: 120, maxPerSection: 20 };
const SHRINK: RenderOptions[] = [
  FULL,
  { treeDepth: 3, maxPages: 60, maxPerSection: 12 },
  { treeDepth: 2, maxPages: 30, maxPerSection: 8 },
  { treeDepth: 1, maxPages: 10, maxPerSection: 4 },
  { treeDepth: 0, maxPages: 0, maxPerSection: 2 },
];

const bullets = (xs: string[], max: number) => xs.slice(0, max).map((x) => `- ${flat(x)}`);
const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines, ""] : []);

export function renderGenerated(sm: Sitemap, opts: RenderOptions = FULL): string {
  const root = sm.pages.find((p) => p.depth === 0)?.url ?? null;
  const rel = (url: string) => {
    const u = new URL(url);
    return url === root || u.pathname === "/" ? "/" : u.pathname;
  };
  const tree = sm.pages
    .filter((p) => p.depth <= opts.treeDepth)
    .slice(0, opts.maxPages)
    .map((p) => {
      const tags = [p.status !== "ok" ? p.status : "", p.purpose ? flat(p.purpose) : ""].filter(Boolean);
      return `${"  ".repeat(Math.min(p.depth, opts.treeDepth))}- ${rel(p.url)}${tags.length ? ` (${tags.join("; ")})` : ""}`;
    });
  const flows = sm.flows.slice(0, opts.maxPerSection).map((f) => `- ${flat(f.title)}: ${f.status}${f.notes ? ` (${flat(f.notes)})` : ""}`);
  const lines = [
    `${GEN_START_PREFIX} run=${sm.runs} -->`,
    `# ${sm.host} (generated by duckwright explore, run ${sm.runs}; may be out of date)`,
    "",
    ...(root ? [`Base URL: ${new URL(root).origin}/`, ""] : []),
    ...section("Business", bullets(sm.notes.business, opts.maxPerSection)),
    ...section("Roles and accounts", bullets(sm.notes.account, opts.maxPerSection)),
    ...section("Key flows", flows),
    ...section("Quirks", bullets(sm.notes.quirk, opts.maxPerSection)),
    ...section("Off-limits", bullets(sm.notes["off-limits"], opts.maxPerSection)),
    ...section("Sitemap", tree),
    GEN_END,
  ];
  return lines.join("\n");
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function findBlock(text: string): { start: number; end: number } | "none" | "bad" {
  const starts = [...text.matchAll(/<!-- duckwright:generated:start[^>]*-->/g)];
  const ends = [...text.matchAll(/<!-- duckwright:generated:end -->/g)];
  if (starts.length === 0 && ends.length === 0) return "none";
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index! < starts[0].index!) return "bad";
  return { start: starts[0].index!, end: ends[0].index! + GEN_END.length };
}

function fit(sm: Sitemap, room: number): { block: string; trimmed: boolean } {
  for (const [i, o] of SHRINK.entries()) {
    const block = renderGenerated(sm, o);
    if (bytes(block) <= room) return { block, trimmed: i > 0 };
  }
  const minimal = `${GEN_START_PREFIX} run=${sm.runs} -->\n${GEN_END}`;
  return { block: bytes(minimal) <= room ? minimal : "", trimmed: true };
}

/** The new file text: only the generated block changes; everything else is kept byte-for-byte. */
export function updateEnvText(existing: string | null, sm: Sitemap): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  if (existing === null) {
    const { block } = fit(sm, ENV_MAX_BYTES - bytes(`\n\n${HAND_HEADING}\n`));
    return { text: `${block}\n\n${HAND_HEADING}\n`, warnings };
  }
  const found = findBlock(existing);
  let before: string;
  let after: string;
  if (found === "none" || found === "bad") {
    if (found === "bad") warnings.push("generated block markers are duplicated or incomplete; appended a fresh block and left the rest alone");
    before = existing.endsWith("\n") || existing === "" ? existing : existing + "\n";
    before += existing === "" ? "" : "\n";
    after = "\n";
  } else {
    before = existing.slice(0, found.start);
    after = existing.slice(found.end);
  }
  const { block, trimmed } = fit(sm, ENV_MAX_BYTES - bytes(before) - bytes(after));
  if (trimmed) warnings.push("the environment file is near its size limit; the generated block was shortened");
  if (block === "") warnings.push("no room for a generated block under the size limit; shorten the hand-written part");
  return { text: before + block + after, warnings };
}

/** Atomic write (temp file, then rename); returns warnings. */
export function writeEnvFile(file: string, sm: Sitemap): string[] {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    // new file
  }
  const { text, warnings } = updateEnvText(existing, sm);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return warnings;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/envfile.test.ts && npm run typecheck`
Expected: PASS. In the "no markers" branch, the appended block follows the existing text after one blank line.

- [ ] **Step 5: Commit**

```bash
git add src/explore/envfile.ts test/explore/envfile.test.ts
git commit -m "explore: generate the environment file block without touching hand-written text"
```

---

### Task 6: Frontier brief

**Files:**
- Create: `src/explore/brief.ts`
- Test: `test/explore/brief.test.ts`

**Interfaces:**
- Consumes: `Sitemap`, `STALE_AFTER_RUNS` (from `merge.ts`).
- Produces: `frontierBrief(sm: Sitemap, maxBytes?: number): string` (default cap 4096 bytes; empty string for a sitemap with no pages)

- [ ] **Step 1: Write the failing tests**

```ts
// test/explore/brief.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { frontierBrief } from "../../src/explore/brief.ts";
import { emptySitemap } from "../../src/explore/site.ts";
import type { SitePage, Sitemap } from "../../src/explore/site.ts";

const pg = (p: string, over: Partial<SitePage> = {}): SitePage => ({
  url: `https://s.test${p}`, title: p, purpose: "", status: "ok", http_status: null, depth: 1,
  first_seen_run: 1, last_seen_run: 5, links: [], pattern: null, ...over,
});
const sm = (over: Partial<Sitemap> = {}): Sitemap => ({ ...emptySitemap("s.test"), runs: 5, pages: [pg("/")], ...over });

test("empty map gives an empty brief", () => {
  assert.equal(frontierBrief(emptySitemap("s.test")), "");
});

test("the brief lists unvisited links, re-check flows, long-unseen pages, shallow pages and off-limits", () => {
  const brief = frontierBrief(sm({
    pages: [pg("/", { depth: 0 }), pg("/old", { last_seen_run: 1 }), pg("/hub", { depth: 1, links: ["https://s.test/new"] })],
    frontier: ["https://s.test/new", "https://s.test/other"],
    flows: [
      { title: "Checkout", start_url: "https://s.test/cart", steps: [], expected: "", status: "broken", notes: "500", last_run: 4 },
      { title: "Search", start_url: "https://s.test/", steps: [], expected: "", status: "ok", notes: "", last_run: 4 },
    ],
    notes: { business: [], quirk: [], "off-limits": ["/admin"], account: [] },
  }));
  for (const s of ["https://s.test/new", "https://s.test/other", "Checkout", "https://s.test/old", "https://s.test/hub", "/admin"]) {
    assert.ok(brief.includes(s), s);
  }
  assert.ok(!brief.includes("Search"));
});

test("the brief respects the byte cap", () => {
  const frontier = Array.from({ length: 100 }, (_, i) => `https://s.test/section/${"x".repeat(60)}/${i}`);
  const brief = frontierBrief(sm({ frontier }), 1024);
  assert.ok(Buffer.byteLength(brief) <= 1024);
  assert.ok(brief.length > 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/explore/brief.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/explore/brief.ts
import { flat } from "../text.ts";
import { STALE_AFTER_RUNS } from "./merge.ts";
import type { Sitemap } from "./site.ts";

export const BRIEF_MAX_BYTES = 4096;

/** What a returning explore run should spend its budget on, as prompt text; "" when nothing is known yet. */
export function frontierBrief(sm: Sitemap, maxBytes: number = BRIEF_MAX_BYTES): string {
  if (sm.pages.length === 0) return "";
  const known = new Set(sm.pages.map((p) => p.url));
  const broken = sm.pages.filter((p) => p.status === "broken").length;
  const groups: [string, string[]][] = [
    ["Unvisited links (explore these first)", sm.frontier.map((u) => `- ${flat(u)}`)],
    [
      "Flows to re-check (dead-end or broken last time)",
      sm.flows.filter((f) => f.status !== "ok").map((f) => `- ${flat(f.title)} at ${flat(f.start_url)} (${f.status}${f.notes ? `: ${flat(f.notes)}` : ""})`),
    ],
    [
      `Pages not seen for ${STALE_AFTER_RUNS} or more runs`,
      sm.pages.filter((p) => p.status !== "external" && sm.runs - p.last_seen_run >= STALE_AFTER_RUNS).map((p) => `- ${flat(p.url)}`),
    ],
    [
      "Shallow areas (visited, but links from them were not followed)",
      sm.pages.filter((p) => p.depth <= 1 && p.links.some((l) => !known.has(l))).map((p) => `- ${flat(p.url)}`),
    ],
    ["Off-limits (never open these)", sm.notes["off-limits"].map((t) => `- ${flat(t)}`)],
  ];
  const head = `Earlier runs mapped ${sm.pages.length} pages on this site${broken ? ` (${broken} broken)` : ""}. Do not re-walk what is already mapped; use the budget to extend the map.`;
  const lines = [head];
  for (const [title, items] of groups) if (items.length) lines.push("", `${title}:`, ...items);
  let out = lines.join("\n");
  // Drop whole lines from the end (keeping the head) until it fits.
  while (Buffer.byteLength(out) > maxBytes && lines.length > 1) {
    lines.pop();
    out = lines.join("\n");
  }
  return out;
}
```

Because the off-limits group is last, trimming from the end would drop it first. Reorder `groups` so off-limits comes right after the head (move that tuple to the first position of the array) and update the test expectation order only if it relies on position (it does not).

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/brief.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/explore/brief.ts test/explore/brief.test.ts
git commit -m "explore: frontier brief for returning runs"
```

---

### Task 7: Business-aware explore prompt and budget

**Files:**
- Modify: `src/explore/task.ts`, `test/explore/task.test.ts`, `prompts/system.md` (one sentence)
- Test: `test/explore/task.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `EXPLORE_MAX_STEPS = 60`
  - `exploreTask(url: string, opts?: { brief?: string }): string` (without a brief the text has no frontier section)

- [ ] **Step 1: Update the tests first**

Replace the exact-text test and the budget test in `test/explore/task.test.ts`:

```ts
test("EXPLORE_MAX_STEPS is 60", () => {
  assert.equal(EXPLORE_MAX_STEPS, 60);
});

test("exploreTask has the four phases, the safety rules and the answer format", () => {
  const t = exploreTask("https://shop.example/a?x=1");
  assert.ok(t.includes("Explore the website at https://shop.example/a?x=1"));
  assert.ok(t.includes("Start with goto https://shop.example/a?x=1."));
  assert.ok(t.includes("Stay on the host shop.example."));
  for (const phase of ["1. Orient", "2. Plan", "3. Go deep", "4. Write down what you learn"]) assert.ok(t.includes(phase), phase);
  assert.ok(t.includes('"cmd": "note"') || t.includes("note business"));
  assert.ok(t.includes("Never do anything destructive or irreversible"));
  assert.ok(t.includes("Never write a password, token or other secret value into a note"));
  assert.ok(t.includes('{"flows":[{"title":"Search products"'));
  assert.ok(!t.includes("Earlier exploration"));
});

test("exploreTask adds the frontier brief only when given", () => {
  const t = exploreTask("https://shop.example/", { brief: "Unvisited links:\n- https://shop.example/new" });
  assert.ok(t.includes("Earlier exploration of this site"));
  assert.ok(t.includes("- https://shop.example/new"));
});

test("exploreTask uses host with port and normalised href", () => {
  const t = exploreTask("http://localhost:3000");
  assert.ok(t.includes("Explore the website at http://localhost:3000/ like"));
  assert.ok(t.includes("Stay on the host localhost:3000."));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/explore/task.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Rewrite `src/explore/task.ts`:

```ts
export const EXPLORE_MAX_STEPS = 60;

export function exploreTask(url: string, opts: { brief?: string } = {}): string {
  const u = new URL(url);
  const URL_ = u.href;
  const HOST = u.host;
  const brief = opts.brief
    ? `\n\nEarlier exploration of this site (automatic notes; they may be out of date, so trust the live page over them):\n${opts.brief}\n`
    : "";
  return `Explore the website at ${URL_} like a careful first-time visitor who wants to understand the business behind it, then check that its main flows work. There is no fixed goal beyond that.${brief}

Work in four phases:
1. Orient. In your first few steps work out what this site is for and who uses it (a shop, a SaaS app, a docs site...). Record it: {"cmd": "note", "args": ["business", "<one or two sentences>"]}.
2. Plan. Pick the 3 to 5 business-critical flows for that kind of site (for a shop: browse, search, product page, cart, checkout up to the payment step) and do them first.
3. Go deep. Follow each flow several steps in (a list, then a detail page, then the action you can safely take) instead of one click per flow. Then use what is left on the less important pages.
4. Write down what you learn as you go with note actions: what a page is for ({"cmd": "note", "args": ["page", "<what it is for>", "<its URL>"]}), quirks ("quirk"), areas not to touch ("off-limits"), which test accounts exist and where their credentials come from ("account"). A login wall you cannot pass: {"cmd": "note", "args": ["page", "gated: <why>", "<its URL>"]}. Never write a password, token or other secret value into a note: name where it comes from instead. Notes are short (under 400 characters) and do not change the page.

Rules:
- Start with goto ${URL_}.
- Stay on the host ${HOST}. Do not open links to other hosts; mention them in a flow's notes instead.
- Do not revisit pages you have already checked, and do not re-check what the earlier exploration above already covered unless it is marked broken or dead-end.
- Never do anything destructive or irreversible: do not delete, pay, buy, order, send messages, invite people, change passwords or settings, sign out, or submit a form that creates or changes real data. Search and filter forms are fine to submit.
- Never open anything the environment context or the earlier exploration marks as off-limits.
- Do not log in or sign up unless the environment context gives you a test account for it.
- You do not need expect checks in this task.
- Judge each flow: "ok" when it reaches the page or result it promises; "dead-end" when it leads nowhere useful (no way forward, an empty page, a link back to the same page, a form that does nothing); "broken" when it shows an error (a 404 or 500 page, an error message, a control that fails).
- Watch the step budget shown as Step N/M. When you are within 3 steps of the limit, or have explored enough, finish.

Finish with done success, and set args[1] to one JSON object and nothing else, like:
{"flows":[{"title":"Search products","start_url":"https://shop.example/","steps":["Type 'mug' into the search box","Press Enter"],"expected":"A results list with at least one product","status":"ok","notes":""}]}
Each flow has: title (a short name), start_url (the full URL where the flow starts), steps (what a person does, in order, in plain words), expected (what shows the flow worked, or should have), status ("ok", "dead-end" or "broken"), and notes (what went wrong, or ""). List every flow you tried. Use done failure only if the site cannot be opened at all.`;
}
```

In `prompts/system.md` "Environment context" paragraph, append one sentence: "If part of it is marked as generated by `duckwright explore`, that part comes from earlier automated exploration and may be out of date or wrong; trust the live page over it."

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/task.test.ts test/prompt.test.ts && npm run typecheck`
Expected: PASS. If `cli.test.ts` asserts the old budget `40` or the old prompt text, update those assertions in Task 9 (leave them red until then; do not weaken the assertion).

- [ ] **Step 5: Commit**

```bash
git add src/explore/task.ts test/explore/task.test.ts prompts/system.md
git commit -m "explore: business-aware four-phase prompt and 60-step budget"
```

---

### Task 8: Memory orchestrator (load, save, lock, corrupt files)

**Files:**
- Create: `src/explore/memory.ts`
- Test: `test/explore/memory.test.ts`

**Interfaces:**
- Consumes: `mergeSitemap`, `RunEvidence`, `MergeSummary` (Task 4); `writeEnvFile` (Task 5); `frontierBrief` (Task 6); `readNotes` (Task 2); `normalizeUrl`, `slugForHost`, `Sitemap`, `SITEMAP_VERSION` (Task 1); `HistoryData` from `src/export.ts`; `ExploreReport` from `report.ts`.
- Produces:
  - `memoryPaths(host: string, root?: string): { slug: string; md: string; sitemap: string; lock: string }` (root defaults to `"environments"`)
  - `loadMemory(host: string, root?: string): { sitemap: Sitemap | null; brief: string; envName: string | null; warnings: string[] }` (`envName` is the slug when `<slug>.md` exists; a corrupt sitemap is renamed to `<slug>.sitemap.json.bak-<timestamp>` with a warning)
  - `buildEvidence(data: HistoryData, report: ExploreReport, notes: NoteLine[], o: { host: string; runName: string; startUrl: string }): RunEvidence | null` (null when no step recorded a page)
  - `saveMemory(o: { host: string; runDir: string; data: HistoryData; report: ExploreReport; startUrl: string; root?: string; envFile?: string | null; lock?: { tries: number; delayMs: number } }): Promise<{ md: string | null; sitemap: string | null; warnings: string[] }>`
  - saveMemory also writes `<runDir>/explore-memory.json` (the `MergeSummary`) and, when the lock cannot be taken, `<runDir>/pending-merge.json` (the evidence)

- [ ] **Step 1: Write the failing tests**

```ts
// test/explore/memory.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildEvidence, loadMemory, memoryPaths, saveMemory } from "../../src/explore/memory.ts";
import { buildExploreReport } from "../../src/explore/report.ts";
import type { HistoryData } from "../../src/export.ts";
import { tmpDir } from "../helpers.ts";

const HOST = "shop.example";
const step = (n: number, url: string | null, links: string[] = [], extra: object = {}) => ({
  step: n, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [], ...extra,
  ...(url ? { page: { url, title: url, links } } : {}),
});
const data = (over: Partial<HistoryData> = {}): HistoryData => ({
  task: "t", task_file: null, success: true,
  answer: JSON.stringify({ flows: [{ title: "Browse", start_url: "https://shop.example/", steps: [], expected: "", status: "ok", notes: "" }] }),
  steps: 2, cost_usd: 0,
  history: [step(1, "https://shop.example/", ["https://shop.example/a", "https://shop.example/b"]), step(2, "https://shop.example/a")],
  ...over,
});
const run = (d: HistoryData, root: string, extra: object = {}) => {
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  const report = buildExploreReport(d, { url: "https://shop.example/", runDir, network: true });
  return saveMemory({ host: HOST, runDir, data: d, report, startUrl: "https://shop.example/", root, ...extra }).then((r) => ({ ...r, runDir }));
};

test("buildEvidence is null when no page was recorded", () => {
  const d = data({ history: [step(1, null)] });
  assert.equal(buildEvidence(d, buildExploreReport(d, { url: "https://shop.example/", runDir: "r", network: true }), [], { host: HOST, runName: "r", startUrl: "https://shop.example/" }), null);
});

test("a no-history run creates no files", async () => {
  const root = tmpDir();
  const r = await run(data({ history: [step(1, null)] }), root);
  assert.equal(r.md, null);
  assert.equal(fs.existsSync(memoryPaths(HOST, root).sitemap), false);
});

test("save then load: files exist, brief is built, env name is the slug", async () => {
  const root = tmpDir();
  const r = await run(data(), root);
  const p = memoryPaths(HOST, root);
  assert.equal(r.sitemap, p.sitemap);
  assert.ok(fs.existsSync(p.md));
  assert.ok(fs.existsSync(path.join(r.runDir, "explore-memory.json")));
  const mem = loadMemory(HOST, root);
  assert.equal(mem.envName, HOST);
  assert.equal(mem.sitemap?.runs, 1);
  assert.match(mem.brief, /https:\/\/shop\.example\/b/);
});

test("two runs extend the map; an unreadable sitemap is backed up, not overwritten", async () => {
  const root = tmpDir();
  await run(data(), root);
  await run(data({ history: [step(1, "https://shop.example/b", ["https://shop.example/"])] }), root);
  assert.equal(loadMemory(HOST, root).sitemap?.runs, 2);
  const p = memoryPaths(HOST, root);
  fs.writeFileSync(p.sitemap, "{ not json");
  const mem = loadMemory(HOST, root);
  assert.equal(mem.sitemap, null);
  assert.match(mem.warnings.join(), /backup|bak/);
  assert.ok(fs.readdirSync(root).some((f) => f.includes(".bak-")) || fs.readdirSync(path.dirname(p.sitemap)).some((f) => f.includes(".bak-")));
});

test("an unknown sitemap version is treated as corrupt", () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  fs.mkdirSync(path.dirname(p.sitemap), { recursive: true });
  fs.writeFileSync(p.sitemap, JSON.stringify({ version: 99 }));
  assert.equal(loadMemory(HOST, root).sitemap, null);
});

test("a held lock saves pending-merge.json instead of losing the run", async () => {
  const root = tmpDir();
  const p = memoryPaths(HOST, root);
  fs.mkdirSync(path.dirname(p.lock), { recursive: true });
  fs.writeFileSync(p.lock, "");
  const r = await run(data(), root, { lock: { tries: 2, delayMs: 5 } });
  assert.equal(r.sitemap, null);
  assert.match(r.warnings.join(), /lock/);
  assert.ok(fs.existsSync(path.join(r.runDir, "pending-merge.json")));
  assert.equal(fs.existsSync(p.sitemap), false);
});

test("a step-limited run adds pages but stales nothing, and a custom env file is updated in place", async () => {
  const root = tmpDir();
  const envFile = path.join(root, "custom", "mine.md");
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, "# Mine\nhand-written\n");
  await run(data({ success: false, answer: "max steps reached" }), root, { envFile });
  const text = fs.readFileSync(envFile, "utf8");
  assert.ok(text.startsWith("# Mine\nhand-written\n"));
  assert.ok(text.includes("duckwright:generated:start"));
  assert.equal(fs.existsSync(memoryPaths(HOST, root).md), false);
  assert.ok(fs.existsSync(memoryPaths(HOST, root).sitemap));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/explore/memory.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/explore/memory.ts
import fs from "node:fs";
import path from "node:path";

import { ENV_DIR } from "../environment.ts";
import type { HistoryData } from "../export.ts";
import { frontierBrief } from "./brief.ts";
import { writeEnvFile } from "./envfile.ts";
import { mergeSitemap } from "./merge.ts";
import type { RunEvidence } from "./merge.ts";
import { readNotes } from "./notes.ts";
import type { NoteLine } from "./notes.ts";
import type { ExploreReport } from "./report.ts";
import { SITEMAP_VERSION, normalizeUrl, slugForHost } from "./site.ts";
import type { Sitemap } from "./site.ts";

export function memoryPaths(host: string, root: string = ENV_DIR) {
  const slug = slugForHost(host);
  return {
    slug,
    md: path.join(root, `${slug}.md`),
    sitemap: path.join(root, `${slug}.sitemap.json`),
    lock: path.join(root, `${slug}.lock`),
  };
}

const isSitemap = (v: unknown): v is Sitemap =>
  typeof v === "object" && v !== null && (v as Sitemap).version === SITEMAP_VERSION
  && Array.isArray((v as Sitemap).pages) && Array.isArray((v as Sitemap).flows)
  && Array.isArray((v as Sitemap).frontier) && typeof (v as Sitemap).notes === "object";

function readSitemap(file: string, warnings: string[]): Sitemap | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSitemap(parsed)) return parsed;
  } catch {
    // fall through to the backup
  }
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(file, backup);
    warnings.push(`sitemap ${file} could not be read; moved it to ${backup} (backup) and starting fresh`);
  } catch {
    warnings.push(`sitemap ${file} could not be read and could not be backed up; starting fresh`);
  }
  return null;
}

export function loadMemory(host: string, root: string = ENV_DIR) {
  const p = memoryPaths(host, root);
  const warnings: string[] = [];
  const sitemap = readSitemap(p.sitemap, warnings);
  return {
    sitemap,
    brief: sitemap ? frontierBrief(sitemap) : "",
    envName: fs.existsSync(p.md) ? p.slug : null,
    warnings,
  };
}

/** What the run saw, or null when it never recorded a page (it never opened the site). */
export function buildEvidence(
  data: HistoryData, report: ExploreReport, notes: NoteLine[],
  o: { host: string; runName: string; startUrl: string },
): RunEvidence | null {
  const pages = data.history.flatMap((s) => (s.page ? [s.page] : []));
  if (pages.length === 0) return null;
  const failed = new Set<string>();
  for (const s of data.history) {
    for (const e of s.network ?? []) {
      const url = normalizeUrl(e.url);
      if (url !== null && e.status !== null && e.status >= 400) failed.add(url);
    }
  }
  const visited = new Set(pages.map((p) => p.url));
  return {
    host: o.host, runName: o.runName, start: normalizeUrl(o.startUrl) ?? o.startUrl,
    pages, notes, flows: [...report.working_flows, ...report.broken_flows],
    failedPages: [...failed].filter((u) => visited.has(u)),
    completed: data.success,
  };
}

async function withLock<T>(
  lock: string, tries: number, delayMs: number, fn: () => T,
): Promise<{ ok: true; value: T } | { ok: false }> {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; i < tries; i++) {
    let held = false;
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
      } catch {
        // the holder just released it
      }
    }
    if (held) {
      try {
        return { ok: true, value: fn() };
      } finally {
        fs.rmSync(lock, { force: true });
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false };
}

export async function saveMemory(o: {
  host: string; runDir: string; data: HistoryData; report: ExploreReport; startUrl: string;
  root?: string; envFile?: string | null; lock?: { tries: number; delayMs: number };
}): Promise<{ md: string | null; sitemap: string | null; warnings: string[] }> {
  const p = memoryPaths(o.host, o.root);
  const ev = buildEvidence(o.data, o.report, readNotes(o.runDir), {
    host: o.host, runName: path.basename(o.runDir), startUrl: o.startUrl,
  });
  if (ev === null) return { md: null, sitemap: null, warnings: [] };
  const warnings: string[] = [];
  const { tries, delayMs } = o.lock ?? { tries: 50, delayMs: 100 };
  const res = await withLock(p.lock, tries, delayMs, () => {
    const old = readSitemap(p.sitemap, warnings);
    const { sitemap, summary } = mergeSitemap(old, ev);
    const tmp = `${p.sitemap}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(sitemap, null, 2) + "\n");
    fs.renameSync(tmp, p.sitemap);
    const md = o.envFile ?? p.md;
    warnings.push(...writeEnvFile(md, sitemap));
    fs.writeFileSync(path.join(o.runDir, "explore-memory.json"), JSON.stringify(summary, null, 2) + "\n");
    return md;
  });
  if (!res.ok) {
    fs.writeFileSync(path.join(o.runDir, "pending-merge.json"), JSON.stringify(ev, null, 2) + "\n");
    warnings.push(`could not take the lock ${p.lock}; saved this run's evidence to ${path.join(o.runDir, "pending-merge.json")}`);
    return { md: null, sitemap: null, warnings };
  }
  return { md: res.value, sitemap: p.sitemap, warnings };
}
```

Note `ev.completed = data.success`: only a run that ended with `done success` may mark pages stale; a step-limited run (`answer: "max steps reached"`, `success: false`) and an errored run never do.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/explore/memory.test.ts && npm run typecheck`
Expected: PASS. In the "backed up" test the backup sits next to the sitemap (the check accepts either folder because `root` is the environments folder).

- [ ] **Step 5: Commit**

```bash
git add src/explore/memory.ts test/explore/memory.test.ts
git commit -m "explore: load and save site memory with a lock and corrupt-file backup"
```

---

### Task 9: Wire it into `explore`

**Files:**
- Modify: `src/runs/run.ts` (`RunSpec.explore`, pass `notes` and `pageInfo` to the agent), `src/cli.ts` (`exploreMain`), `test/cli.test.ts` (new and updated explore cases)
- Test: `test/cli.test.ts`, `test/runs/*` as needed

**Interfaces:**
- Consumes: `NoteSink` (Task 2), `loadMemory` and `saveMemory` (Task 8), `exploreTask` and `EXPLORE_MAX_STEPS` (Task 7), `slugForHost` (Task 1).
- Produces: `RunSpec.explore?: { host: string }` (when set the agent gets a `NoteSink(workdir, host)` and `pageInfo: true`); `exploreMain` prints `Environment: <path>` and `Sitemap: <path>` after the `Data:` line.

- [ ] **Step 1: Read the existing explore integration tests and write the failing ones**

Read the explore cases in `test/cli.test.ts` (search for `explore`) and reuse their fake `createAgent`/deps helpers. Add these cases using the same helpers (adjust names to the file's helpers; assertions are the contract):

1. **Memory files are written and printed.** Run `exploreMain` with a fake agent whose history has `page` entries for `https://shop.example/` and `/a`, in a temp cwd. Assert stdout contains `Environment: environments/shop.example.md` and `Sitemap: environments/shop.example.sitemap.json`, both files exist, and the run folder has `explore-memory.json`.
2. **Second run auto-loads and extends.** Run twice with the same host; the second run's `task` passed to `createAgent` includes `Earlier exploration of this site` and the unvisited link from run 1, and the agent's `environment` is the text of `environments/shop.example.md`. After the second run `sitemap.runs === 2` and no duplicate pages.
3. **`--env` wins.** With `environments/shop.example.md` present and `--env other` (a file `environments/other.md`), the agent's `environment` is `other.md`'s text, while the sitemap and `shop.example.md` are still the ones updated.
4. **Task runs stay explicit.** A normal (non-explore) run on the same cwd does not read the generated environment (`environment` is null without `--env`).
5. **A failed memory write warns.** Make `environments` a regular file; the run still prints the report, stderr has `explore: cannot save site memory`, and the exit code is `1` for a run that otherwise succeeded.
6. **A no-history run creates no environment files.**
7. Update the existing assertions that mention `40` steps or the old prompt text to `60` and the new text.

The agent options captured by the fake `createAgent` must show `notes` is a `NoteSink` and `pageInfo === true` for explore, and `notes === undefined` for a normal task run.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/cli.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

`src/runs/run.ts`:
- add `explore?: { host: string };` to `RunSpec`;
- import `NoteSink` from `../explore/notes.ts`;
- in the `deps.createAgent({ ... })` call add:

```ts
      ...(spec.explore ? { notes: new NoteSink(workdir, spec.explore.host), pageInfo: true } : {}),
```

`src/cli.ts` (`exploreMain`), after `const { url, writeTasks, run } = parsed.args;` and the secret check:

```ts
  const host = new URL(url).host;
  const mem = loadMemory(host);
  for (const w of mem.warnings) deps.stderr(`warning: ${w}`);
  // An explicit --env wins; otherwise an earlier run's environment file for this host is used.
  const runArgs = run.env === null && mem.envName !== null ? { ...run, env: mem.envName } : run;
```

Then use `runArgs` in place of `run` for `preflightArgs` and in the `startRun` spec; build the task with `exploreTask(url, { brief: mem.brief })` and add `explore: { host }` to the spec (keep `consoleErrors: true`). If `run.env` is a path (`isEnvPath`), pass `envFile: path.resolve(run.env)` to `saveMemory`; otherwise leave it undefined. Keep the existing `run.network` use in `buildExploreReport`.

After the report/`writeExploreReport` block and before `--write-tasks`:

```ts
  try {
    const m = await saveMemory({
      host, runDir: handle.workdir, data, report, startUrl: url,
      envFile: run.env !== null && isEnvPath(run.env) ? path.resolve(run.env) : null,
    });
    for (const w of m.warnings) deps.stderr(`warning: ${w}`);
    if (m.md !== null) deps.stdout(`Environment: ${m.md}`);
    if (m.sitemap !== null) deps.stdout(`Sitemap: ${m.sitemap}`);
  } catch (e) {
    writeFailed = true;
    deps.stderr(`explore: cannot save site memory: ${errMsg(e)}`);
  }
```

(`writeFailed` is declared before the report block today; move its declaration above if needed.) Add the imports (`loadMemory`, `saveMemory`, `isEnvPath`, `path`). `--write-tasks` also gains `env: <slug>` only if `mem.envName` is set or a memory file was just written: pass `env` through `writeExploreTasks`'s front matter if that is a one-line change; otherwise leave task files as they are (documented in the README).

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all green (typecheck plus every test). Investigate any failure in the loop, run or TUI tests caused by the new optional fields rather than changing assertions.

- [ ] **Step 5: Commit**

```bash
git add src/runs/run.ts src/cli.ts test/cli.test.ts
git commit -m "explore: load site memory before the run, merge and save it after"
```

---

### Task 10: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In the Exploration mode section: change the budget text to 60 steps; add an "Explore memory" subsection covering:
- the two generated files, `environments/<slug>.md` and `environments/<slug>.sitemap.json`, and the slug rule (`localhost:3000` becomes `localhost-3000`);
- the hand-written `## Notes (yours)` section that explore never changes, and that edits outside the generated block are kept;
- that `explore` loads both automatically, spends its budget on unvisited links, broken or dead-end flows, long-unseen pages and shallow areas, and that an explicit `--env` still wins;
- that task runs stay explicit: use `--env <slug>`;
- the run-folder files `notes.jsonl`, `explore-memory.json` and (when another run held the lock) `pending-merge.json`;
- the `note` action and its kinds, the 400-character limit, and that secret-looking notes are rejected;
- limits: 500 pages, 100 flows, a 16 KB environment file, pages collapsing to patterns like `/product/:id`;
- known limitations: single-page apps that do not change the URL give a coarse map; the map reflects what one budget could visit;
- how to reset: delete `environments/<slug>.sitemap.json`.

Add `note` to the action reference if the README has one, add a Roadmap line ("Explore site memory"), and update the `explore` usage text in `src/args.ts` only if it lists the files written (check `test/args.test.ts` before changing it).

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: PASS (usage-text tests catch accidental wording changes).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: explore site memory"
```

---

## Self-review against the spec

- **Summary, files, data model:** Tasks 1, 4, 5. **Decisions table:** slug (1), `note` action (2), structure from history (3, 4), frontier-first (6, 7), auto-load/`--env` wins (9), 60-step budget (7), deterministic merge (4, 8). `--refresh` is out of scope, as the spec says.
- **Note action rules:** kinds, 400 characters, host check, secret rejection, explore-only, non-page-changing, appended immediately: Task 2.
- **Run flow before/after:** Tasks 6, 7, 8, 9. Printing of `Environment:` and `Sitemap:` lines and `explore-memory.json`: Tasks 8 and 9.
- **Errors and safety:** best-effort and exit-code rule (9), no-history skip (8, 9), corrupt or unknown version backup (8), lock and `pending-merge.json` (8), marker problems (5), `--env` path updates that file's block (8, 9), secret handling (2), same-host restriction and external pages (4), off-limits fed back (6, 7).
- **Caps and normalization:** Tasks 1 and 4 (query always stripped, which covers the spec's allow-listed keys collapsing into one page).
- **Known simplifications to confirm with the spec owner:** a page note whose text begins with `gated` marks the page gated; `flow` notes attach to the flow with the same start URL and are otherwise dropped; `completed` for staleness means the run ended with `done success`.
- **Type consistency:** `PageInfo`, `NoteLine`, `RunEvidence`, `Sitemap`, `MergeSummary`, `NoteSink`, `memoryPaths`, `loadMemory`, `saveMemory`, `exploreTask(url, { brief })` and `frontierBrief(sm, maxBytes)` keep the same names and signatures wherever they are used.
