import { flat, neutralise } from "../text.ts";
import { STALE_AFTER_RUNS } from "./merge.ts";
import type { Sitemap } from "./site.ts";

export const BRIEF_MAX_BYTES = 4096;

/** Sitemap text came from pages: one line, and no harness tags that could close a prompt block. */
const safe = (s: string): string => neutralise(flat(s));

/** What a returning explore run should spend its budget on, as prompt text; "" when nothing is known yet. */
export function frontierBrief(sm: Sitemap, maxBytes: number = BRIEF_MAX_BYTES, opts: { writes?: boolean } = {}): string {
  const pages = sm.pages ?? [];
  const frontier = sm.frontier ?? [];
  const flows = sm.flows ?? [];
  const functions = sm.functions ?? [];
  const created = sm.created ?? [];
  if (pages.length === 0) return "";
  const known = new Set(pages.map((p) => p.url));
  const broken = pages.filter((p) => p.status === "broken").length;
  // Off-limits comes first: trimming drops from the end, and that list must be the last thing lost.
  const groups: [string, string[]][] = [
    ["Off-limits (never open these)", (sm.notes?.["off-limits"] ?? []).map((t) => `- ${safe(t)}`)],
    ...(opts.writes
      ? ([
          [
            "Functions still to exercise (untested first, then broken to re-check; blocked ones only if something changed)",
            (["untested", "broken", "blocked"] as const).flatMap((s) =>
              functions.filter((f) => f.status === s).map((f) => `- ${safe(f.name)} (${s})${f.area ? ` at ${safe(f.area)}` : ""}`)),
          ],
          [
            "Leftovers from earlier runs (do not touch; they do not carry this run's marker)",
            created.filter((c) => !c.removed).map((c) => `- ${safe(c.name)}${c.url ? ` at ${safe(c.url)}` : ""}`),
          ],
        ] as [string, string[]][])
      : ([
          [
            "Known functions (information only; do not write)",
            functions.map((f) => `- ${safe(f.name)} (${safe(f.status)})`),
          ],
        ] as [string, string[]][])),
    ["Unvisited links (explore these first)", frontier.map((u) => `- ${safe(u)}`)],
    [
      "Flows to re-check (dead-end or broken last time)",
      flows.filter((f) => f.status !== "ok").map((f) => `- ${safe(f.title)} at ${safe(f.start_url)} (${safe(f.status)}${f.notes ? `: ${safe(f.notes)}` : ""})`),
    ],
    [
      `Pages not seen for ${STALE_AFTER_RUNS} or more runs`,
      pages.filter((p) => !p.pattern && p.status !== "external" && sm.runs - p.last_seen_run >= STALE_AFTER_RUNS).map((p) => `- ${safe(p.url)}`),
    ],
    [
      "Shallow areas (visited, but links from them were not followed)",
      pages.filter((p) => !p.pattern && p.depth <= 1 && (p.links ?? []).some((l) => !known.has(l))).map((p) => `- ${safe(p.url)}`),
    ],
  ];
  const head = `Earlier runs mapped ${pages.length} pages on this site${broken ? ` (${broken} broken)` : ""}. Do not re-walk what is already mapped; use the budget to extend the map.`;
  const lines = [head];
  for (const [title, items] of groups) if (items.length) lines.push("", `${title}:`, ...items);
  let out = lines.join("\n");
  // Drop lines from the end (keeping the head) until it fits; never leave a title or blank line dangling.
  while (Buffer.byteLength(out) > maxBytes && lines.length > 1) {
    lines.pop();
    while (lines.length > 1 && !lines[lines.length - 1].startsWith("- ")) lines.pop();
    out = lines.join("\n");
  }
  return out;
}
