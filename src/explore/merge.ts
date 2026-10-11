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

  const evFlows = ev.flows.map((f) => ({ ...f, steps: [...f.steps] }));

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
      const target = evFlows.length && n.url ? evFlows.find((f) => normalizeUrl(f.start_url) === n.url) : undefined;
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
  for (const f of evFlows) {
    flows.set(flowKey(f.title, f.start_url), { ...f, steps: [...f.steps], last_run: run });
    summary.flows_updated++;
  }
  base.flows = [...flows.values()].sort((a, b) => b.last_run - a.last_run).slice(0, CAPS.flows);

  // 6. Collapse parameterized urls (/product/1, /product/2, ...) into one page and one link target.
  const patterns = collapsePatterns([...pages.keys(), ...[...pages.values()].flatMap((p) => p.links), ...base.frontier]);
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
