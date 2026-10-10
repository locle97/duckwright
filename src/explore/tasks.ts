import fs from "node:fs";
import path from "node:path";

import { freshFolder } from "../plan.ts";
import { slugify } from "../rundir.ts";
import { flat } from "../text.ts";
import type { Flow } from "./report.ts";

const TASK_MAX_STEPS = 25;

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
  lines.push(`Check that: ${expected || "the flow finishes without an error page."}`, "");
  return lines.join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Write one task file per working flow into a new `<root>/explore-<host>[-N]/`; null when there are none. */
export function writeExploreTasks(
  flows: Flow[], url: string, runDir: string, root = "tasks",
): { folder: string; files: string[] } | null {
  const ok = flows.filter((f) => f.status === "ok");
  if (!ok.length) return null;
  const folder = freshFolder(root, `explore-${slugify(hostOf(url)) || "site"}`);
  const width = Math.max(2, String(ok.length).length);
  const files = ok.map((f, i) => {
    const name = `${String(i + 1).padStart(width, "0")}-${slugify(f.title) || "flow"}.md`;
    const file = path.join(folder, name);
    fs.writeFileSync(file, exploreTaskText(f, url, runDir));
    return file;
  });
  return { folder, files };
}
