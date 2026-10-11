// src/explore/merge.ts
import { flat } from "../text.ts";
import type { PageInfo } from "./pages.ts";
import type { NoteLine } from "./notes.ts";
import type { Flow } from "./report.ts";
import {
  CAPS, MEMORY_KINDS, collapsePatterns, emptySitemap, isIdSegment, normalizeUrl,
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
  /** Notes the note action refused (credential-looking, bad kind or url); set by saveMemory. */
  notes_rejected: number;
  flows_updated: number;
}

const hostOf = (url: string) => new URL(url).host;
const noteKey = (text: string) => flat(text).toLowerCase().replace(/\s+/g, " ").trim();
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function mergeSitemap(old: Sitemap | null, ev: RunEvidence): { sitemap: Sitemap; summary: MergeSummary } {
  const base: Sitemap = old ? structuredClone(old) : emptySitemap(ev.host);
  const run = base.runs + 1;
  const summary: MergeSummary = {
    added_pages: 0, updated_pages: 0, broken_pages: 0, stale_pages: 0, notes_added: 0, notes_dropped: 0, notes_rejected: 0, flows_updated: 0,
  };
  const pages = new Map<string, SitePage>(base.pages.map((p) => [p.url, p]));
  const visited = new Set<string>();

  // 0. Canonicalise incoming urls against pattern pages stored by earlier runs (/product/7 -> /product/:id).
  const storedPatterns = base.pages.filter((p) => p.pattern !== null).map((p) => new URL(p.url));
  const pre = (url: string): string => {
    const u = new URL(url);
    const segs = u.pathname.split("/");
    for (const pu of storedPatterns) {
      const psegs = pu.pathname.split("/");
      if (pu.origin !== u.origin || psegs.length !== segs.length) continue;
      if (psegs.every((ps, i) => ps === segs[i] || (ps === ":id" && i > 0 && isIdSegment(segs[i])))) return pu.href;
    }
    return url;
  };
  const norm = (url: string | null): string | null => {
    const n = url === null ? null : normalizeUrl(url);
    return n === null ? null : pre(n);
  };
  const extLinks: string[] = [];

  // 1. Pages seen this run.
  for (const raw of ev.pages) {
    const url = norm(raw.url);
    if (url === null) continue;
    const obs = { ...raw, url };
    const external = hostOf(obs.url) !== ev.host;
    const allLinks = external ? [] : raw.links.map((l) => norm(l)).filter((l): l is string => l !== null);
    const links = allLinks.filter((l) => hostOf(l) === ev.host);
    extLinks.push(...allLinks.filter((l) => hostOf(l) !== ev.host));
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
  const sameHostVisited = [...visited].some((u) => hostOf(u) === ev.host);

  // 2. Broken pages: a failed request, or a flow that starts there and was judged broken.
  const evFlows: Flow[] = [];
  for (const f of ev.flows) {
    const start = norm(f.start_url);
    if (start === null || hostOf(start) !== ev.host) continue;
    evFlows.push({ ...f, start_url: start, steps: [...f.steps] });
  }
  const brokenUrls = new Set(ev.failedPages.map((f) => norm(f)).filter((f): f is string => f !== null));
  for (const f of evFlows) {
    if (f.status === "broken") brokenUrls.add(f.start_url);
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
      if (!visited.has(p.url) && p.status === "ok" && run - p.last_seen_run >= STALE_AFTER_RUNS) {
        p.status = "stale";
        summary.stale_pages++;
      }
    }
  }

  // 4. Notes.
  for (const kind of MEMORY_KINDS) base.notes[kind] = base.notes[kind] ?? [];
  for (const n of ev.notes) {
    const nurl = norm(n.url);
    if (n.kind === "page") {
      const p = nurl ? pages.get(nurl) : undefined;
      if (!p) { summary.notes_dropped++; continue; }
      if (/^\s*gated\b/i.test(n.text)) p.status = "gated";
      else p.purpose = n.text;
      summary.notes_added++;
    } else if (n.kind === "flow") {
      const target = evFlows.length && nurl ? evFlows.find((f) => f.start_url === nurl) : undefined;
      if (!target) { summary.notes_dropped++; continue; }
      target.notes = target.notes ? `${target.notes}; ${n.text}` : n.text;
      summary.notes_added++;
    } else {
      const list = base.notes[n.kind as MemoryKind];
      if (list.some((t) => noteKey(t) === noteKey(n.text))) { summary.notes_dropped++; continue; }
      // Off-limits entries are safety rules: never push one out for room, drop the incoming one instead.
      if (n.kind === "off-limits" && list.length >= CAPS.notesPerKind) { summary.notes_dropped++; continue; }
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
      merged.set(key, { ...p, url: key, links, pattern: patterns.get(p.url) ?? p.pattern });
      continue;
    }
    prev.first_seen_run = Math.min(prev.first_seen_run, p.first_seen_run);
    prev.last_seen_run = Math.max(prev.last_seen_run, p.last_seen_run);
    prev.links = uniq([...prev.links, ...links]).slice(0, CAPS.linksPerPage);
    if (p.status === "broken") prev.status = "broken";
    prev.purpose = prev.purpose || p.purpose;
    prev.pattern = prev.pattern ?? patterns.get(p.url) ?? p.pattern;
  }

  // 7. Depth: breadth-first from the start URL; unreachable pages keep their old depth.
  const start = canon(norm(ev.start) ?? ev.start);
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
  const isPatternUrl = (url: string) => /\/:id(\/|$)/.test(new URL(url).pathname);
  const rawTargets = [
    ...[...pages.values()].filter((p) => p.status !== "external").flatMap((p) => p.links),
    ...base.frontier,
  ];
  const sampled = new Set<string>();
  const candidates: string[] = [];
  for (const raw of uniq(rawTargets)) {
    if (hostOf(raw) !== ev.host) continue;
    const target = canon(raw);
    if (known.has(target)) continue;
    if (isPatternUrl(raw)) continue;
    if (target !== raw) {
      if (sampled.has(target)) continue;
      sampled.add(target);
    }
    candidates.push(raw);
  }
  base.frontier = candidates.slice(0, CAPS.frontier);
  base.external_links = uniq([...base.external_links, ...extLinks]).slice(0, CAPS.frontier);

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
