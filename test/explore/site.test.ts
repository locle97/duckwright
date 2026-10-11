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
