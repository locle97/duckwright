import fs from "node:fs";
import path from "node:path";

import { flat } from "../text.ts";

export const CREATED_FILE = "created.jsonl";

/** One item the agent created (and whether it says it removed it again). */
export interface LedgerItem {
  name: string;
  url: string | null;
  removed: boolean;
}

/** A ledger item kept in the sitemap across runs. */
export interface CreatedEntry extends LedgerItem {
  run: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `DW-<yymmdd>-<4 hex>-` from the UTC date, e.g. `DW-261011-a3f9-`. */
export function makeMarker(now: Date = new Date(), rng: () => number = Math.random): string {
  const yymmdd = pad(now.getUTCFullYear() % 100) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate());
  const hex = Math.floor(rng() * 0x10000).toString(16).padStart(4, "0");
  return `DW-${yymmdd}-${hex}-`;
}

/** Flattened, lower-cased, whitespace-collapsed: how item names are compared. */
export const itemKey = (s: string): string => flat(s).toLowerCase().replace(/\s+/g, " ").trim();

export const startsWithMarker = (text: string, marker: string): boolean =>
  itemKey(text).startsWith(marker.toLowerCase());

export const containsMarker = (text: string, marker: string): boolean =>
  text.toLowerCase().includes(marker.toLowerCase());

/** This run's ledger from created.jsonl. Never throws: a missing file is empty, a damaged line is skipped. */
export function readLedger(workdir: string): LedgerItem[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workdir, CREATED_FILE), "utf8");
  } catch {
    return [];
  }
  const items: LedgerItem[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let o: { created?: unknown; removed?: unknown; url?: unknown } | null;
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    if (typeof o !== "object" || o === null) continue;
    if (typeof o.created === "string") {
      items.push({ name: o.created, url: typeof o.url === "string" ? o.url : null, removed: false });
    } else if (typeof o.removed === "string") {
      const key = itemKey(o.removed);
      const hit = [...items].reverse().find((i) => !i.removed && itemKey(i.name) === key);
      if (hit) hit.removed = true;
    }
  }
  return items;
}
