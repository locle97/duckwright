import type { Decision } from "./brain.ts";
import { SNAPSHOT_FILE } from "./observe.ts";
import type { Observation } from "./observe.ts";
import { networkSummary } from "./network.ts";
import type { NetworkEntry } from "./network.ts";
import { flat, neutralise } from "./text.ts";

export const HISTORY_WINDOW = 15;

export interface StepRecord {
  step: number;
  decision: Decision;
  results: string[];
  // Playwright code playwright-cli ran per action (null where nothing ran), for replay.
  codes: (string | null)[];
  network?: NetworkEntry[];
  networkErrors?: string[];
  requestOrigins?: (string | null)[];
}

/** One history line: `step N | evaluation | next goal | cmd args → result; ...`. */
export function stepLine(rec: StepRecord): string {
  const d = rec.decision;
  // Results can carry page text (CLI errors, a failed expect's actual value).
  const results = rec.results.map((r) => neutralise(flat(r)));
  const acts = d.actions.length
    ? d.actions.map((a, i) => {
      const cmd = flat([a.cmd, ...a.args].join(" "));
      return `${cmd} → ${i < results.length ? results[i] : "(no result)"}`;
    }).join("; ")
    : results.join("; ");
  return `step ${rec.step} | ${flat(d.evaluationPreviousGoal)} | ${flat(d.nextGoal)} | ${acts}`;
}

function section(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

export interface PromptOptions {
  window?: number;
  nudge?: string | null;
  paste?: boolean;
}

export function buildPrompt(
  task: string,
  step: number,
  maxSteps: number,
  history: StepRecord[],
  memory: string,
  obs: Observation,
  { window = HISTORY_WINDOW, nudge = null, paste = true }: PromptOptions = {},
): string {
  const shown = window > 0 ? history.slice(-window) : [];
  const omitted = history.length - shown.length;
  const lines = shown.map(stepLine);
  if (omitted) lines.unshift(`(${omitted} earlier steps omitted)`);
  const parts = [
    `Step ${step}/${maxSteps}`,
    section("task", task),
    section("memory", memory || "(empty)"),
    section("tabs", neutralise(obs.tabs)),
    section("history", lines.length ? lines.join("\n") : "(none)"),
  ];
  const net = networkSummary(history.at(-1)?.network ?? [], obs.tabs);
  if (net !== null) parts.push(section("network", net));
  if (nudge) parts.push(nudge);
  if (paste) {
    parts.push(section("page_snapshot", neutralise(obs.snapshot)));
  } else {
    // Every value here comes from the harness, so there is nothing to escape.
    parts.push(section(
      "page_snapshot_file",
      `${SNAPSHOT_FILE}: ${obs.lines} lines, ${obs.chars} characters. `
        + "Not shown here: search it with Grep and Read.",
    ));
  }
  return parts.join("\n\n") + "\n";
}
