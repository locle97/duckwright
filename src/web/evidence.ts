// Evidence files (screenshots, run video) served from the runs folder. Everything here is path
// confinement: the URL shape is matched strictly, then the real path must stay inside the run folder.
import fs from "node:fs";
import path from "node:path";

export const RUN_ID = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SHOT = /^screenshots\/step-\d{3,}\.png$/;
const PREFIX = "/api/runs/";

export interface EvidenceMatch { runId: string; rel: string; type: "image/png" | "video/webm" }

/** Matches the raw (still percent-encoded) request path; anything but the two known shapes is null. */
export function matchEvidence(pathname: string): EvidenceMatch | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const rest = pathname.slice(PREFIX.length);
  const i = rest.indexOf("/");
  if (i === -1) return null;
  const runId = rest.slice(0, i);
  const rel = rest.slice(i + 1);
  if (!RUN_ID.test(runId)) return null;
  if (rel === "video.webm") return { runId, rel, type: "video/webm" };
  if (SHOT.test(rel)) return { runId, rel, type: "image/png" };
  return null;
}

/** The real path of an existing evidence file inside the run's folder, or null. Symlinks leaving the folder are refused. */
export function resolveEvidence(runsDir: string, runId: string, rel: string): string | null {
  try {
    const realRoot = fs.realpathSync(runsDir);
    const real = fs.realpathSync(path.join(realRoot, runId, rel));
    if (!real.startsWith(path.join(realRoot, runId) + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** One byte range. null means ignore the header (serve the whole file); "unsatisfiable" means 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? Infinity : Number(m[2]);
  if (start > end) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}
