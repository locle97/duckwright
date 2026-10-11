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
  const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
  const edited = "# Mine\r\nhand-written head\r\n\r\n" + crlf(first.trimEnd() + "\nMy own note\n- keep me");
  assert.ok(!edited.endsWith("\n"));
  assert.ok(edited.startsWith("# Mine\r\n") && edited.includes("\r\n- keep me"));
  const after = updateEnvText(edited, sm({ notes: { business: ["Changed"], quirk: [], "off-limits": [], account: [] } })).text;
  assert.ok(after.includes("Changed"));
  assert.ok(!after.includes("A mug shop"));
  const tail = (s: string) => s.slice(s.indexOf(GEN_END) + GEN_END.length);
  assert.equal(tail(after), tail(edited));
  assert.ok(tail(after).endsWith("- keep me"));
  const head = (s: string) => s.slice(0, s.indexOf("<!-- duckwright:generated:start"));
  assert.equal(head(after), head(edited));
  assert.equal(head(after), "# Mine\r\nhand-written head\r\n\r\n");
});

test("a hand-written file without markers gets a block appended and is otherwise untouched", () => {
  const mine = "# Staging\nBase URL: https://staging.test\n";
  const { text, warnings } = updateEnvText(mine, sm());
  assert.ok(text.startsWith(mine));
  assert.deepEqual(warnings, []);
  assert.ok(text.includes(GEN_END));
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
  assert.ok(text.includes(hand.trimEnd()));
  assert.ok(text.endsWith(existing.slice(existing.indexOf(GEN_END) + GEN_END.length)));
});

test("writeEnvFile writes atomically and the result loads through loadEnvironment", () => {
  const dir = tmpDir();
  const file = path.join(dir, "environments", "shop.example.md");
  assert.deepEqual(writeEnvFile(file, sm()), []);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["shop.example.md"]);
  const loaded = loadEnvironment(file, dir);
  assert.match(loaded.text, /Search needs 3 letters/);
});
