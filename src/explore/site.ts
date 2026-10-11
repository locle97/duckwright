import type { FlowStatus } from "./report.ts";

export const SITEMAP_VERSION = 1;
export const CAPS = { pages: 500, flows: 100, frontier: 100, notesPerKind: 20, linksPerPage: 100 } as const;

export type PageStatus = "ok" | "broken" | "stale" | "gated" | "external";
export type NoteKind = "business" | "page" | "quirk" | "off-limits" | "account" | "flow" | "created" | "removed" | "function";
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

export const isIdSegment = (seg: string): boolean => ID_SEGMENT.test(seg);

/** Maps each URL that has three or more id-like siblings to its path pattern, e.g. `/product/:id`. */
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
