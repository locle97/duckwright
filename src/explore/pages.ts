import fs from "node:fs";
import path from "node:path";

import { SNAPSHOT_FILE, pageDir } from "../observe.ts";
import { normalizeUrl } from "./site.ts";

export const MAX_PAGE_LINKS = 200;

export interface PageInfo {
  url: string;
  title: string;
  links: string[];
}

const CURRENT_TAB = /^- \d+: \(current\) \[(.*)\]\((\S+)\)\s*$/;
const LINK_URL = /^\s*- \/url:\s*(.+?)\s*$/;

/** The current http(s) tab and the links in its snapshot; null when the tab is not a web page. */
export function parsePage(tabs: string, snapshot: string | null): PageInfo | null {
  let title = "";
  let url: string | null = null;
  for (const line of tabs.split(/\r?\n/)) {
    const m = CURRENT_TAB.exec(line);
    if (m) {
      title = m[1];
      url = normalizeUrl(m[2]);
      break;
    }
  }
  if (url === null) return null;
  const links: string[] = [];
  const seen = new Set<string>();
  for (const line of (snapshot ?? "").split(/\r?\n/)) {
    const m = LINK_URL.exec(line);
    if (!m) continue;
    const raw = m[1].replace(/^["']|["']$/g, "");
    const abs = normalizeUrl(raw, url);
    if (abs === null || seen.has(abs)) continue;
    seen.add(abs);
    links.push(abs);
    if (links.length >= MAX_PAGE_LINKS) break;
  }
  return { url, title, links };
}

/** Like parsePage, reading the snapshot file the observer just wrote; never throws. */
export function readPage(tabs: string, workdir: string): PageInfo | null {
  let snapshot: string | null = null;
  try {
    snapshot = fs.readFileSync(path.join(pageDir(workdir), SNAPSHOT_FILE), "utf8");
  } catch {
    // no snapshot file: still record the page
  }
  return parsePage(tabs, snapshot);
}
