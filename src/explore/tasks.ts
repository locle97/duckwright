import fs from "node:fs";
import path from "node:path";

import { freshFolder } from "../plan.ts";
import { slugify } from "../rundir.ts";
import { flat, neutralise } from "../text.ts";
import type { Flow, ReportedFunction } from "./report.ts";

const TASK_MAX_STEPS = 25;
const FUNCTION_TASK_MAX_STEPS = 40;
const safe = (s: string): string => neutralise(flat(s));

export function exploreTaskText(flow: Flow, url: string, runDir: string): string {
  const lines = [
    "---",
    `# From duckwright explore ${flat(url)} (run ${flat(runDir)})`,
    `max-steps: ${TASK_MAX_STEPS}`,
    "---",
    `# ${flat(flow.title)}`,
    "",
    `Open ${flat(flow.start_url)}.`,
    "",
  ];
  if (flow.steps.length) {
    lines.push("Steps:", ...flow.steps.map((s, i) => `${i + 1}. ${flat(s)}`), "");
  }
  const expected = flat(flow.expected);
  lines.push(`Check that: ${sentence(expected || "the flow finishes without an error page")}`, "");
  return lines.join("\n");
}

/** Ends the text with "." unless it already ends in ".", "?" or "!". */
function sentence(text: string): string {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

export function exploreFunctionTaskText(fn: ReportedFunction, url: string, runDir: string, env: string | null): string {
  const lines = [
    "---",
    `# From duckwright explore ${flat(url)} (run ${flat(runDir)}), function inventory`,
    `max-steps: ${FUNCTION_TASK_MAX_STEPS}`,
    ...(env !== null ? [`env: ${flat(env)}`] : []),
    "---",
    `# ${safe(fn.name)}`,
    "",
    ...(fn.area_url ? [`Open ${safe(fn.area_url)}.`, ""] : []),
  ];
  if (fn.steps.length) lines.push("Steps:", ...fn.steps.map((s, i) => `${i + 1}. ${safe(s)}`), "");
  const expected = safe(fn.expected);
  lines.push(`Check that: ${sentence(expected || "the function finishes without an error page")}`, "");
  lines.push("Name everything you create with the prefix RT- and delete what you created at the end of the task.", "");
  return lines.join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Write one task file per working flow, then one per working function, into a new `<root>/explore-<host>[-N]/`; null when there are none. */
export function writeExploreTasks(
  flows: Flow[], url: string, runDir: string, root = "tasks",
  extra?: { functions: ReportedFunction[]; env: string | null },
): { folder: string; files: string[] } | null {
  const ok = flows.filter((f) => f.status === "ok");
  const fns = (extra?.functions ?? []).filter((f) => f.status === "ok");
  if (!ok.length && !fns.length) return null;
  const folder = freshFolder(root, `explore-${slugify(hostOf(url)) || "site"}`);
  const width = Math.max(2, String(ok.length + fns.length).length);
  const num = (i: number) => String(i + 1).padStart(width, "0");
  const files = ok.map((f, i) => {
    const file = path.join(folder, `${num(i)}-${slugify(f.title) || "flow"}.md`);
    fs.writeFileSync(file, exploreTaskText(f, url, runDir));
    return file;
  });
  fns.forEach((fn, j) => {
    const file = path.join(folder, `${num(ok.length + j)}-fn-${slugify(fn.name) || "function"}.md`);
    fs.writeFileSync(file, exploreFunctionTaskText(fn, url, runDir, extra?.env ?? null));
    files.push(file);
  });
  return { folder, files };
}
