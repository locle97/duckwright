// Completion candidates for @ mentions: a capped, breadth-first walk of the current folder for
// task files and folders holding them, and fzf-style ranking. Pure apart from nodeReadDir.
import fs from "node:fs";
import path from "node:path";

import { TASK_SUFFIXES } from "../taskfile.ts";
import { compareCodePoints } from "../text.ts";

export interface DirEntry { name: string; dir: boolean }
/** Entries of `relDir` ("" is the current folder, "tasks/smoke" a subfolder). Never throws. */
export type ReadDir = (relDir: string) => DirEntry[];
/** Folder paths end with "/"; `count` is the folder's root-level task files (0 for files). */
export interface Candidate { path: string; folder: boolean; count: number }
export interface CandidateIndex { items: Candidate[]; truncated: boolean }

export const WALK_LIMIT = 5000;
const SKIP = new Set(["node_modules", "runs"]);

const isTaskFile = (name: string): boolean => TASK_SUFFIXES.includes(path.extname(name).toLowerCase());
const skipped = (name: string): boolean => name.startsWith(".") || SKIP.has(name) || name.includes('"');

/** Task files and folders under the current folder, shallow first, reading at most `limit` entries. */
export function walk(readdir: ReadDir, limit = WALK_LIMIT): CandidateIndex {
  const found: Candidate[] = [];
  const folders = new Map<string, Candidate>();
  const queue = [""];
  let seen = 0;
  let truncated = false;
  outer: for (let q = 0; q < queue.length; q++) {
    const rel = queue[q];
    const entries = [...readdir(rel)].sort((a, b) => compareCodePoints(a.name, b.name));
    for (const e of entries) {
      if (seen >= limit) {
        truncated = true;
        break outer;
      }
      seen++;
      if (skipped(e.name)) continue;
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.dir) {
        const c: Candidate = { path: `${p}/`, folder: true, count: 0 };
        folders.set(p, c);
        found.push(c);
        queue.push(p);
      } else if (isTaskFile(e.name)) {
        found.push({ path: p, folder: false, count: 0 });
        const parent = folders.get(rel);
        if (parent) parent.count++;
      }
    }
  }
  return { items: found.filter((c) => !c.folder || c.count > 0), truncated };
}

const BOUNDARY = "/-_. ";
const depth = (p: string): number => (p.endsWith("/") ? p.slice(0, -1) : p).split("/").length - 1;

/** fzf-style score of `query` against `p` (both lower-cased), or null when it does not match. */
function score(p: string, query: string): number | null {
  let best: number | null = null;
  for (let i = p.indexOf(query[0]); i !== -1; i = p.indexOf(query[0], i + 1)) {
    let total = 0;
    let prev = -2;
    let at = i;
    let ok = true;
    for (const ch of query) {
      const j = p.indexOf(ch, at);
      if (j === -1) {
        ok = false;
        break;
      }
      total += 16 + (j === prev + 1 ? 8 : 0) + (j === 0 || BOUNDARY.includes(p[j - 1]) ? 10 : 0);
      prev = j;
      at = j + 1;
    }
    if (!ok) break; // a later start cannot match either
    if (best === null || total > best) best = total;
  }
  return best === null ? null : best - p.length;
}

/** Candidates matching `query`, best first: consecutive and segment-start matches, then short paths. */
export function rank(index: CandidateIndex, query: string): Candidate[] {
  if (query === "") {
    return [...index.items].sort((a, b) => depth(a.path) - depth(b.path) || compareCodePoints(a.path, b.path));
  }
  const q = query.toLowerCase();
  const scored: { c: Candidate; s: number }[] = [];
  for (const c of index.items) {
    const s = score(c.path.toLowerCase(), q);
    if (s !== null) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.path.length - b.c.path.length || compareCodePoints(a.c.path, b.c.path));
  return scored.map((x) => x.c);
}

/** A ReadDir over the real folder `root`. Symlinked folders are not followed, so loops cannot hang the walk. */
export function nodeReadDir(root: string): ReadDir {
  return (relDir) => {
    try {
      const dir = path.join(root, relDir);
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d): DirEntry[] => {
        if (d.isDirectory()) return [{ name: d.name, dir: true }];
        if (d.isFile()) return [{ name: d.name, dir: false }];
        if (d.isSymbolicLink()) {
          try {
            return fs.statSync(path.join(dir, d.name)).isFile() ? [{ name: d.name, dir: false }] : [];
          } catch {
            return [];
          }
        }
        return [];
      });
    } catch {
      return [];
    }
  };
}
