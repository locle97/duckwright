// test/explore/merge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeSitemap } from "../../src/explore/merge.ts";
import type { RunEvidence } from "../../src/explore/merge.ts";
import { CAPS, emptySitemap } from "../../src/explore/site.ts";

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
  assert.equal(second.summary.added_pages, 1); // /b is new
  assert.equal(second.summary.updated_pages, 1); // only / existed before
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

test("query strings never reach the stored map (page url, link, note url, flow start)", () => {
  const flows = [{ title: "Cart", start_url: u("/cart?token=SECRET"), steps: [], expected: "", status: "ok" as const, notes: "" }];
  const notes = [{ step: 1, kind: "page" as const, text: "the cart", url: u("/cart?token=SECRET") }];
  const { sitemap } = mergeSitemap(null, ev({
    pages: [{ url: u("/?x=1"), title: "Home", links: [u("/cart?token=SECRET"), "https://other.test/o?k=SECRET"] }, page("/cart")],
    notes, flows,
  }));
  assert.ok(!JSON.stringify(sitemap).includes("?"));
  assert.equal(sitemap.flows[0].start_url, u("/cart"));
  assert.equal(sitemap.pages.find((p) => p.url === u("/cart"))?.purpose, "the cart");
});

test("flows starting off-host are dropped", () => {
  const flows = [{ title: "Out", start_url: "https://other.test/x", steps: [], expected: "", status: "ok" as const, notes: "" }];
  assert.deepEqual(mergeSitemap(null, ev({ pages: [page("/")], flows })).sitemap.flows, []);
});

test("off-host links of visited pages are recorded in external_links", () => {
  const { sitemap } = mergeSitemap(null, ev({
    pages: [{ url: u("/"), title: "H", links: [u("/a"), "https://other.test/x", "https://other.test/x"] }],
  }));
  assert.deepEqual(sitemap.external_links, ["https://other.test/x"]);
  assert.deepEqual(sitemap.frontier, [u("/a")]);
});

test("pattern pages are stable across runs and absorb later visits", () => {
  const ids = [1, 2, 3, 4];
  const r1 = mergeSitemap(null, ev({ pages: [page("/", ids.map((i) => `/product/${i}`)), page("/product/1"), page("/product/2"), page("/product/3")] })).sitemap;
  const pat = r1.pages.find((p) => p.url === u("/product/:id"));
  assert.equal(pat?.pattern, "/product/:id");
  const r2 = mergeSitemap(r1, ev({ runName: "r2", pages: [page("/product/7", ["/"])] })).sitemap;
  const r3 = mergeSitemap(r2, ev({ runName: "r3", pages: [page("/product/8")], failedPages: [u("/product/2")] })).sitemap;
  for (const sm of [r2, r3]) {
    assert.deepEqual(sm.pages.filter((p) => /product/.test(p.url)).map((p) => p.url), [u("/product/:id")]);
    assert.equal(sm.pages.find((p) => p.url === u("/product/:id"))?.pattern, "/product/:id");
  }
  assert.equal(r2.pages.find((p) => p.url === u("/product/:id"))?.last_seen_run, 2);
  assert.equal(r3.pages.find((p) => p.url === u("/product/:id"))?.last_seen_run, 3);
  assert.equal(r3.pages.find((p) => p.url === u("/product/:id"))?.status, "broken");
});

test("the frontier never holds a :id url; one sample per unvisited pattern", () => {
  const { sitemap } = mergeSitemap(null, ev({ pages: [page("/", ["/item/1", "/item/2", "/item/3", "/x"])] }));
  assert.ok(!sitemap.frontier.some((f) => f.includes(":id")));
  assert.deepEqual(sitemap.frontier, [u("/item/1"), u("/x")]);
  const next = mergeSitemap(sitemap, ev({ runName: "r2", pages: [page("/item/1"), page("/item/2"), page("/item/3"), page("/")] })).sitemap;
  assert.ok(!next.frontier.some((f) => f.includes(":id") || /\/item\/\d/.test(f)));
});

test("a broken page unseen for over 10 runs is pruned first when over the page cap", () => {
  const sm = emptySitemap(H);
  sm.runs = 20;
  const mk = (path: string, last: number, status: "ok" | "broken") => ({
    url: u(path), title: path, purpose: "", status, http_status: null, depth: 1, first_seen_run: 1, last_seen_run: last, links: [], pattern: null,
  });
  sm.pages = [mk("/dead", 5, "broken"), ...Array.from({ length: CAPS.pages }, (_, i) => mk(`/page-${i}`, 4, "ok"))];
  const out = mergeSitemap(sm, ev({ pages: [page("/")] })).sitemap;
  assert.ok(out.pages.length <= CAPS.pages);
  assert.ok(!out.pages.some((p) => p.url === u("/dead")));
});

test("a broken page does not turn stale", () => {
  const sm = emptySitemap(H);
  sm.runs = 5;
  sm.pages = [{ url: u("/dead"), title: "d", purpose: "", status: "broken", http_status: null, depth: 1, first_seen_run: 1, last_seen_run: 1, links: [], pattern: null }];
  const out = mergeSitemap(sm, ev({ pages: [page("/")] }));
  assert.equal(out.sitemap.pages.find((p) => p.url === u("/dead"))?.status, "broken");
  assert.equal(out.summary.stale_pages, 0);
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

test("off-limits notes are never dropped for room: the incoming one is dropped and counted", () => {
  const old = emptySitemap(H);
  old.notes["off-limits"] = Array.from({ length: CAPS.notesPerKind }, (_, i) => `off ${i}`);
  const notes = [{ step: 1, kind: "off-limits" as const, text: "off new", url: null }];
  const { sitemap, summary } = mergeSitemap(old, ev({ pages: [page("/")], notes }));
  assert.equal(sitemap.notes["off-limits"].length, CAPS.notesPerKind);
  assert.ok(sitemap.notes["off-limits"].includes("off 0"));
  assert.ok(!sitemap.notes["off-limits"].includes("off new"));
  assert.equal(summary.notes_dropped, 1);
  assert.equal(summary.notes_added, 0);
});

test("other kinds still drop the oldest note beyond the cap", () => {
  const old = emptySitemap(H);
  old.notes.quirk = Array.from({ length: CAPS.notesPerKind }, (_, i) => `q ${i}`);
  const { sitemap } = mergeSitemap(old, ev({ pages: [page("/")], notes: [{ step: 1, kind: "quirk", text: "q new", url: null }] }));
  assert.ok(!sitemap.notes.quirk.includes("q 0") && sitemap.notes.quirk.includes("q new"));
});
