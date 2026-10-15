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

test("created, removed and function notes never reach the memory notes", () => {
  const notes = [
    { step: 1, kind: "created" as const, text: "DW-1-Pasta", url: u("/r/1") },
    { step: 2, kind: "removed" as const, text: "DW-1-Pasta", url: null },
    { step: 3, kind: "function" as const, text: "Create recipe", url: null },
  ];
  const { sitemap, summary } = mergeSitemap(null, ev({ pages: [page("/")], notes }));
  assert.deepEqual(sitemap.notes, { business: [], quirk: [], "off-limits": [], account: [] });
  assert.equal(summary.notes_dropped, 0);
});

const fn = (name: string, status: "ok" | "broken" | "blocked" = "ok", over: object = {}) => ({
  name, area_url: u("/r/create"), status, steps: ["Open", "Save"], expected: "It opens", notes: "", ...over,
});
const decl = (text: string, url: string | null = null) => ({ step: 1, kind: "function" as const, text, url });

test("a declared function is untested; a reported one carries its verdict and steps", () => {
  const a = mergeSitemap(null, ev({ pages: [page("/")], notes: [decl("Create recipe", u("/r/create")), decl("Delete recipe")] }));
  assert.deepEqual(a.sitemap.functions.map((f) => [f.name, f.status, f.area]).sort(), [["Create recipe", "untested", u("/r/create")], ["Delete recipe", "untested", null]]);
  assert.equal(a.summary.functions_added, 2);
  const b = mergeSitemap(a.sitemap, ev({ runName: "r2", pages: [page("/")], functions: [fn("create recipe", "ok", { steps: ["a", "b"] })] }));
  const created = b.sitemap.functions.find((f) => f.name === "Create recipe")!;
  assert.equal(created.status, "ok");
  assert.deepEqual(created.steps, ["a", "b"]);
  assert.equal(created.first_seen_run, 1);
  assert.equal(created.last_run, 2);
  assert.equal(b.summary.functions_updated, 1);
  assert.equal(b.sitemap.functions.find((f) => f.name === "Delete recipe")!.status, "untested");
});

test("names match case-insensitively and an untested function is never produced by a report", () => {
  const a = mergeSitemap(null, ev({ pages: [page("/")], functions: [fn("Create Recipe")] })).sitemap;
  const b = mergeSitemap(a, ev({ pages: [page("/")], notes: [decl("  create   recipe ")] })).sitemap;
  assert.equal(b.functions.length, 1);
  assert.equal(b.functions[0].status, "ok"); // a re-declaration never downgrades a verdict
});

test("a run that reports nothing keeps stored function verdicts (absence proves nothing)", () => {
  const a = mergeSitemap(null, ev({ pages: [page("/")], functions: [fn("Create recipe", "broken")] })).sitemap;
  const b = mergeSitemap(a, ev({ pages: [page("/")], completed: false })).sitemap;
  assert.equal(b.functions[0].status, "broken");
});

test("the function inventory is capped and area urls are normalized and kept on-host", () => {
  const many = Array.from({ length: 250 }, (_, i) => fn(`Function ${i}`));
  assert.equal(mergeSitemap(null, ev({ pages: [page("/")], functions: many })).sitemap.functions.length, CAPS.functions);
  const q = mergeSitemap(null, ev({ pages: [page("/")], functions: [fn("A", "ok", { area_url: `${u("/r/create")}?token=SECRET#x` })] })).sitemap;
  assert.equal(q.functions[0].area, u("/r/create"));
  const off = mergeSitemap(null, ev({ pages: [page("/")], notes: [decl("B", "https://other.test/x")] })).sitemap;
  assert.equal(off.functions[0].area, null);
});

test("the ledger appends, dedupes, marks removed and caps; old sitemaps without it merge fine", () => {
  const items = [{ name: "DW-1-Pasta", url: u("/r/1?x=1"), removed: false }, { name: "DW-1-Soup", url: null, removed: true }];
  const a = mergeSitemap(null, ev({ pages: [page("/")], created: items }));
  assert.deepEqual(a.sitemap.created, [
    { name: "DW-1-Pasta", url: u("/r/1"), removed: false, run: 1 },
    { name: "DW-1-Soup", url: null, removed: true, run: 1 },
  ]);
  assert.equal(a.summary.created_logged, 2);
  const again = mergeSitemap(a.sitemap, ev({ runName: "r2", pages: [page("/")], created: [{ name: "DW-1-Pasta", url: u("/r/1"), removed: true }] }));
  assert.equal(again.sitemap.created.length, 2);
  assert.equal(again.sitemap.created.find((c) => c.name === "DW-1-Pasta")!.removed, true);
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `DW-1-${i}`, url: null, removed: false }));
  assert.equal(mergeSitemap(null, ev({ pages: [page("/")], created: many })).sitemap.created.length, CAPS.created);
  const legacy = { ...emptySitemap(H) } as Record<string, unknown>;
  delete legacy.functions;
  delete legacy.created;
  const m = mergeSitemap(legacy as never, ev({ pages: [page("/")], functions: [fn("X")], created: items }));
  assert.equal(m.sitemap.functions.length, 1);
  assert.equal(m.sitemap.created.length, 2);
});

test("a function name over 120 chars keeps one stable entry across runs", () => {
  const long = "L".repeat(130);
  const a = mergeSitemap(null, ev({ pages: [page("/")], notes: [decl(long)] })).sitemap;
  const b = mergeSitemap(a, ev({ runName: "r2", pages: [page("/")], notes: [decl(long)], functions: [fn(long)] })).sitemap;
  assert.deepEqual(b.functions.map((f) => [f.name.length, f.status]), [[120, "ok"]]);
  const c = mergeSitemap(b, ev({ runName: "r3", pages: [page("/")], notes: [decl(long)], functions: [fn(long)] })).sitemap;
  assert.equal(c.functions.length, 1);
  assert.deepEqual(c.functions.map((f) => [f.name, f.status, f.steps, f.first_seen_run]), b.functions.map((f) => [f.name, f.status, f.steps, f.first_seen_run]));
});

test("ledger urls keep the real id even when a pattern page is stored", () => {
  const base = { ...emptySitemap(H), runs: 1, pages: [{ url: u("/r/:id"), title: "R", purpose: "", status: "ok" as const, http_status: null, depth: 1, first_seen_run: 1, last_seen_run: 1, links: [], pattern: "/r/:id" }] };
  const m = mergeSitemap(base, ev({ pages: [page("/")], created: [{ name: "DW-x-Pasta", url: u("/r/12?x=1"), removed: false }] }));
  assert.equal(m.sitemap.created[0].url, u("/r/12"));
});

test("function counters: declare+report is one add; report twice is one update", () => {
  const both = mergeSitemap(null, ev({ pages: [page("/")], notes: [decl("New one")], functions: [fn("New one")] })).summary;
  assert.deepEqual([both.functions_added, both.functions_updated], [1, 0]);
  const twice = mergeSitemap(null, ev({ pages: [page("/")], functions: [fn("Twice"), fn("twice")] })).summary;
  assert.deepEqual([twice.functions_added, twice.functions_updated], [1, 0]);
  const a = mergeSitemap(null, ev({ pages: [page("/")], functions: [fn("Old")] })).sitemap;
  const r = mergeSitemap(a, ev({ pages: [page("/")], functions: [fn("Old"), fn("old")] })).summary;
  assert.deepEqual([r.functions_added, r.functions_updated], [0, 1]);
});

test("ledger names are flattened and capped at 120 chars", () => {
  const name = "DW-1-" + "line\nbreak ".repeat(20);
  const m = mergeSitemap(null, ev({ pages: [page("/")], created: [{ name, url: null, removed: false }] })).sitemap;
  assert.ok(name.length > 120);
  assert.ok(!m.created[0].name.includes("\n"));
  assert.ok([...m.created[0].name].length <= 120);
});

test("ledger over the cap evicts removed entries first, then the oldest", () => {
  const full = Array.from({ length: CAPS.created - 1 }, (_, i) => ({ name: `DW-1-${i}`, url: null, removed: false }));
  full.push({ name: "DW-1-old-removed", url: null, removed: true });
  const a = mergeSitemap(null, ev({ pages: [page("/")], created: full })).sitemap;
  const b = mergeSitemap(a, ev({ runName: "r2", pages: [page("/")], created: [{ name: "DW-2-new", url: null, removed: false }] })).sitemap;
  assert.equal(b.created.length, CAPS.created);
  assert.ok(!b.created.some((c) => c.name === "DW-1-old-removed")); // removed goes first
  assert.ok(b.created.some((c) => c.name === "DW-1-0")); // unremoved leftovers kept
  const c = mergeSitemap(b, ev({ runName: "r3", pages: [page("/")], created: [{ name: "DW-3-new", url: null, removed: false }] })).sitemap;
  assert.equal(c.created.length, CAPS.created);
  assert.ok(!c.created.some((x) => x.name === "DW-1-0")); // then the oldest unremoved
  assert.ok(c.created.some((x) => x.name === "DW-3-new"));
});
