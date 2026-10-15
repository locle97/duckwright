// src/explore/memory.ts
import fs from "node:fs";
import path from "node:path";

import { envRoot } from "../environment.ts";
import type { HistoryData } from "../export.ts";
import { frontierBrief } from "./brief.ts";
import { writeEnvFile } from "./envfile.ts";
import { mergeSitemap } from "./merge.ts";
import type { RunEvidence } from "./merge.ts";
import { readNotes, readRejected } from "./notes.ts";
import type { NoteLine } from "./notes.ts";
import type { ExploreReport, FlowStatus } from "./report.ts";
import { readLedger } from "./writes.ts";
import type { CreatedEntry, LedgerItem } from "./writes.ts";
import { MEMORY_KINDS, SITEMAP_VERSION, normalizeUrl, slugForHost } from "./site.ts";
import type { PageStatus, SiteFlow, SiteFunction, SitePage, Sitemap, StoredFunctionStatus } from "./site.ts";

const PAGE_STATUSES: readonly PageStatus[] = ["ok", "broken", "stale", "gated", "external"];
const FLOW_STATUSES: readonly FlowStatus[] = ["ok", "dead-end", "broken"];

export function memoryPaths(host: string, root: string = envRoot()) {
  const slug = slugForHost(host);
  return {
    slug,
    md: path.join(root, `${slug}.md`),
    sitemap: path.join(root, `${slug}.sitemap.json`),
    lock: path.join(root, `${slug}.lock`),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the shape and fills what older or hand-edited files may lack (note kinds, external_links). */
function asSitemap(v: unknown): Sitemap | null {
  if (!isObject(v) || v.version !== SITEMAP_VERSION) return null;
  if (!Array.isArray(v.pages) || !Array.isArray(v.flows) || !Array.isArray(v.frontier) || !isObject(v.notes)) return null;
  const notes = {} as Sitemap["notes"];
  for (const k of MEMORY_KINDS) {
    const list = v.notes[k];
    notes[k] = Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  }
  const urls = (xs: unknown): string[] => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string" && normalizeUrl(x) !== null) : []);
  const pages = v.pages.flatMap((p) => asPage(p) ?? []);
  const flows = v.flows.flatMap((f) => asFlow(f) ?? []);
  const functions = Array.isArray(v.functions) ? v.functions.flatMap((f) => asFunction(f) ?? []) : [];
  const created = Array.isArray(v.created) ? v.created.flatMap((c) => asCreated(c) ?? []) : [];
  return {
    ...(v as unknown as Sitemap), pages, flows, functions, created, notes, frontier: urls(v.frontier), external_links: urls(v.external_links),
  };
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A hand-edited page entry: malformed ones are dropped, missing optional fields get safe defaults. */
function asPage(p: unknown): SitePage | null {
  if (!isObject(p) || typeof p.url !== "string") return null;
  const url = normalizeUrl(p.url);
  if (url === null) return null;
  return {
    url, title: str(p.title), purpose: str(p.purpose),
    status: PAGE_STATUSES.includes(p.status as PageStatus) ? (p.status as PageStatus) : "ok",
    http_status: typeof p.http_status === "number" ? p.http_status : null,
    depth: num(p.depth, 1), first_seen_run: num(p.first_seen_run, 0), last_seen_run: num(p.last_seen_run, 0),
    links: Array.isArray(p.links) ? p.links.filter((l): l is string => typeof l === "string" && normalizeUrl(l) !== null) : [],
    pattern: typeof p.pattern === "string" ? p.pattern : null,
  };
}

function asFlow(f: unknown): SiteFlow | null {
  if (!isObject(f) || typeof f.title !== "string" || typeof f.start_url !== "string") return null;
  const start = normalizeUrl(f.start_url);
  if (start === null) return null;
  return {
    title: f.title, start_url: start,
    steps: Array.isArray(f.steps) ? f.steps.filter((s): s is string => typeof s === "string") : [],
    expected: str(f.expected),
    status: FLOW_STATUSES.includes(f.status as FlowStatus) ? (f.status as FlowStatus) : "ok",
    notes: str(f.notes), last_run: num(f.last_run, 0),
  };
}

const FUNCTION_STATUSES: readonly StoredFunctionStatus[] = ["untested", "ok", "broken", "blocked"];

function asFunction(f: unknown): SiteFunction | null {
  if (!isObject(f) || typeof f.name !== "string" || f.name.trim() === "") return null;
  const area = typeof f.area === "string" ? normalizeUrl(f.area) : null;
  return {
    name: f.name, area,
    status: FUNCTION_STATUSES.includes(f.status as StoredFunctionStatus) ? (f.status as StoredFunctionStatus) : "untested",
    steps: Array.isArray(f.steps) ? f.steps.filter((s): s is string => typeof s === "string") : [],
    expected: str(f.expected), notes: str(f.notes),
    first_seen_run: num(f.first_seen_run, 0), last_run: num(f.last_run, 0),
  };
}

function asCreated(c: unknown): CreatedEntry | null {
  if (!isObject(c) || typeof c.name !== "string" || c.name.trim() === "") return null;
  return { name: c.name, url: typeof c.url === "string" ? normalizeUrl(c.url) : null, removed: c.removed === true, run: num(c.run, 0) };
}

type SitemapRead = { sitemap: Sitemap | null; unreadable: string | null };

/** Only ENOENT means "no sitemap yet"; any other read error leaves the file alone and reports why. */
function readSitemap(file: string, warnings: string[]): SitemapRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { sitemap: null, unreadable: null };
    const reason = `${code ?? "error"}: ${(e as Error).message}`;
    warnings.push(`sitemap ${file} exists but could not be read (${reason}); leaving it untouched`);
    return { sitemap: null, unreadable: reason };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const sm = asSitemap(parsed);
    if (sm) return { sitemap: sm, unreadable: null };
  } catch {
    // fall through to the backup
  }
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    fs.renameSync(file, backup);
    warnings.push(`sitemap ${file} could not be read; moved it to ${backup} (backup) and starting fresh`);
  } catch (e) {
    const reason = `${(e as NodeJS.ErrnoException).code ?? "error"}: ${(e as Error).message}`;
    warnings.push(`sitemap ${file} could not be read and could not be backed up (${reason}); leaving it untouched`);
    return { sitemap: null, unreadable: reason };
  }
  return { sitemap: null, unreadable: null };
}

export function loadMemory(host: string, root: string = envRoot(), opts: { writes?: boolean } = {}) {
  const p = memoryPaths(host, root);
  const warnings: string[] = [];
  const { sitemap } = readSitemap(p.sitemap, warnings);
  return {
    sitemap,
    brief: sitemap ? frontierBrief(sitemap, undefined, opts) : "",
    envName: fs.existsSync(p.md) ? p.slug : null,
    warnings,
  };
}

/** What the run saw, or null when it never recorded a page (it never opened the site). */
export function buildEvidence(
  data: HistoryData, report: ExploreReport, notes: NoteLine[],
  o: { host: string; runName: string; startUrl: string; ledger?: LedgerItem[] },
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
  const visited = new Set(pages.flatMap((p) => normalizeUrl(p.url) ?? []));
  return {
    host: o.host, runName: o.runName, start: normalizeUrl(o.startUrl) ?? o.startUrl,
    pages, notes, flows: [...report.working_flows, ...report.broken_flows],
    failedPages: [...failed].filter((u) => visited.has(u)),
    completed: data.success,
    functions: report.functions ?? [], created: o.ledger ?? [],
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
    host: o.host, runName: path.basename(o.runDir), startUrl: o.startUrl, ledger: readLedger(o.runDir),
  });
  if (ev === null) return { md: null, sitemap: null, warnings: [] };
  const warnings: string[] = [];
  const { tries, delayMs } = o.lock ?? { tries: 50, delayMs: 100 };
  const res = await withLock(p.lock, tries, delayMs, () => {
    const { sitemap: old, unreadable } = readSitemap(p.sitemap, warnings);
    if (unreadable !== null) return null;
    const { sitemap, summary } = mergeSitemap(old, ev);
    summary.notes_rejected = readRejected(o.runDir);
    const tmp = `${p.sitemap}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(sitemap, null, 2) + "\n");
      fs.renameSync(tmp, p.sitemap);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    const md = o.envFile ?? p.md;
    warnings.push(...writeEnvFile(md, sitemap));
    fs.writeFileSync(path.join(o.runDir, "explore-memory.json"), JSON.stringify(summary, null, 2) + "\n");
    return md;
  });
  if (res.ok && res.value === null) {
    const pending = path.join(o.runDir, "pending-merge.json");
    fs.writeFileSync(pending, JSON.stringify(ev, null, 2) + "\n");
    warnings.push(`left ${p.sitemap} untouched; saved this run's evidence to ${pending}`);
    return { md: null, sitemap: null, warnings };
  }
  if (!res.ok) {
    fs.writeFileSync(path.join(o.runDir, "pending-merge.json"), JSON.stringify(ev, null, 2) + "\n");
    warnings.push(`could not take the lock ${p.lock}; saved this run's evidence to ${path.join(o.runDir, "pending-merge.json")}`);
    return { md: null, sitemap: null, warnings };
  }
  return { md: res.value as string, sitemap: p.sitemap, warnings };
}
