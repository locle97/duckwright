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
import { MEMORY_KINDS, SITEMAP_VERSION, normalizeUrl, slugForHost } from "./site.ts";
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
  return { ...(v as unknown as Sitemap), notes, external_links: Array.isArray(v.external_links) ? (v.external_links as string[]) : [] };
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

export function loadMemory(host: string, root: string = ENV_DIR) {
  const p = memoryPaths(host, root);
  const warnings: string[] = [];
  const { sitemap } = readSitemap(p.sitemap, warnings);
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
  const visited = new Set(pages.flatMap((p) => normalizeUrl(p.url) ?? []));
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
    const { sitemap: old, unreadable } = readSitemap(p.sitemap, warnings);
    if (unreadable !== null) return null;
    const { sitemap, summary } = mergeSitemap(old, ev);
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
