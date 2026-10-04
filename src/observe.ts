import fs from "node:fs";
import path from "node:path";

import { PlaywrightCLI, PlaywrightError } from "./pw.ts";
import { codePointLength, sliceCodePoints, splitLines } from "./text.ts";

export const MAX_SNAPSHOT_CHARS = 40_000;
export const TRUNCATION_MARKER = "\n…[snapshot truncated]";
// The snapshot gets a folder of its own: in grep mode it is the only thing Claude can read.
export const PAGE_DIR = "page";
export const SNAPSHOT_FILE = "snapshot.yml";
// How the agent reads the page: always pasted, always grepped, or by size (hybrid).
export const SNAPSHOT_MODES = ["hybrid", "full", "grep"] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];
export const HYBRID_MAX_CHARS = 5_000;

export interface Observation {
  tabs: string;
  snapshot: string;
  truncated: boolean;
  // Size of the whole snapshot, before any truncation.
  lines: number;
  chars: number;
}

export function pageDir(workdir: string): string {
  return path.join(workdir, PAGE_DIR);
}

/** Whether this step pastes the snapshot into the prompt rather than letting Claude grep it. */
export function pasteSnapshot(mode: SnapshotMode, obs: Observation): boolean {
  if (mode === "hybrid") return obs.chars <= HYBRID_MAX_CHARS;
  return mode === "full";
}

export async function observe(
  pw: PlaywrightCLI, workdir: string, maxChars: number = MAX_SNAPSHOT_CHARS,
): Promise<Observation> {
  const tabRes = await pw.run("tab-list", []);
  if (tabRes.code !== 0) throw new PlaywrightError(tabRes.stderr || tabRes.stdout);
  const folder = pageDir(workdir);
  fs.mkdirSync(folder, { recursive: true });
  const full = await pw.snapshot(path.join(folder, SNAPSHOT_FILE));
  const chars = codePointLength(full);
  const truncated = chars > maxChars;
  return {
    tabs: tabRes.stdout,
    snapshot: truncated ? sliceCodePoints(full, maxChars) + TRUNCATION_MARKER : full,
    truncated,
    lines: splitLines(full).length,
    chars,
  };
}
