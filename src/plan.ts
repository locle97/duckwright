// Plan mode, with no UI: a planner call (claude -p) breaks a person's test plan into scenarios,
// which are written as task files in a folder with a shared setup file and a plan.json manifest.
import fs from "node:fs";
import path from "node:path";

import { isEnvName, resolveEnv } from "./environment.ts";
import { resolvePath } from "./paths.ts";
import { runProcess } from "./proc.ts";
import type { Runner } from "./proc.ts";
import { slugify } from "./rundir.ts";
import { flat } from "./text.ts";

export const PLANNER_TIMEOUT = 600;
export const MANIFEST = "plan.json";
export const SETUP_FILE = "shared/setup.md";

export const PLAN_SCHEMA = {
  type: "object",
  required: ["setup", "notes", "tasks", "skipped"],
  properties: {
    setup: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "preconditions", "steps", "expected"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" }, minItems: 1 },
          expected: { type: "array", items: { type: "string" } },
        },
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "reason"],
        properties: { id: { type: "string" }, title: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

export interface Scenario { id: string; title: string; preconditions: string[]; steps: string[]; expected: string[] }
export interface Skipped { id: string; title: string; reason: string }
/** What the planner returns. */
export interface PlanDoc { setup: string; notes: string[]; tasks: Scenario[]; skipped: Skipped[] }

/** One planned task as the manifest lists it; `file` is relative to the plan folder. */
export interface PlanEntry { file: string; id: string; title: string }
export interface Manifest {
  version: 1;
  /** Shown as the plan's name: the plan file's name. */
  name: string;
  /** The plan file, as given when planning. */
  source: string;
  /** Relative to the plan folder, or null. */
  setup: string | null;
  notes: string[];
  skipped: Skipped[];
  tasks: PlanEntry[];
}

/** A plan folder as loaded: paths are joined onto the folder. */
export interface LoadedPlan {
  folder: string;
  manifest: Manifest;
  setupPath: string | null;
  tasks: Array<PlanEntry & { path: string }>;
}

export class PlanError extends Error {
  cost: number;

  constructor(message: string, cost = 0) {
    super(message);
    this.name = "PlanError";
    this.cost = cost;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter((x) => x !== "");

/** Check the planner's structured output; a malformed one is a PlanError. */
export function parsePlanDoc(so: unknown): PlanDoc {
  const bad = (why: string): never => {
    throw new PlanError(`planner returned a malformed plan: ${why}`);
  };
  if (!isObject(so)) return bad("not an object");
  if (typeof so.setup !== "string") bad("setup is not a string");
  if (!isStrings(so.notes)) bad("notes is not a list of strings");
  if (!Array.isArray(so.tasks)) bad("tasks is not a list");
  if (!Array.isArray(so.skipped)) bad("skipped is not a list");
  const tasks = (so.tasks as unknown[]).map((t, i): Scenario => {
    if (!isObject(t) || typeof t.id !== "string" || typeof t.title !== "string"
      || !isStrings(t.preconditions) || !isStrings(t.steps) || !isStrings(t.expected)) {
      return bad(`task ${i + 1} is malformed`);
    }
    const steps = clean(t.steps);
    if (steps.length === 0) bad(`task ${i + 1} has no steps`);
    return {
      id: flat(t.id).trim() || String(i + 1), title: flat(t.title).trim() || `Scenario ${i + 1}`,
      preconditions: clean(t.preconditions), steps, expected: clean(t.expected),
    };
  });
  const skipped = (so.skipped as unknown[]).map((s, i): Skipped => {
    if (!isObject(s) || typeof s.id !== "string" || typeof s.title !== "string" || typeof s.reason !== "string") {
      return bad(`skipped ${i + 1} is malformed`);
    }
    return { id: flat(s.id).trim(), title: flat(s.title).trim(), reason: flat(s.reason).trim() };
  });
  if (tasks.length === 0) {
    bad(skipped.length > 0 ? "no scenario can run in a browser" : "no scenarios found");
  }
  return { setup: (so.setup as string).trim(), notes: clean(so.notes as string[]), tasks, skipped };
}

export interface PlannerOptions {
  planFile: string;
  promptFile: string;
  model: string;
  runner?: Runner;
  signal?: AbortSignal;
  timeoutSec?: number;
}

export function plannerArgv(promptFile: string, model: string): string[] {
  return [
    "claude", "-p", "--output-format", "json", "--tools", "",
    "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--model", model,
    "--json-schema", JSON.stringify(PLAN_SCHEMA),
    "--append-system-prompt-file", promptFile,
  ];
}

/** Read the plan file and ask Claude to split it; resolves with the plan and what the call cost. */
export async function runPlanner(o: PlannerOptions): Promise<{ doc: PlanDoc; cost: number }> {
  let text: string;
  try {
    text = fs.readFileSync(o.planFile, "utf8").replaceAll("\r\n", "\n").trim();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new PlanError(code === "ENOENT" ? `${o.planFile}: file not found` : `${o.planFile}: cannot read: ${(e as Error).message}`);
  }
  if (text === "") throw new PlanError(`${o.planFile}: the plan is empty`);
  // The plan is the person's own, but keep it from closing its block all the same.
  const prompt = `<plan file="${flat(path.basename(o.planFile)).replaceAll('"', "'")}">\n${text.replace(/<(?=\/?plan\b)/gi, "&lt;")}\n</plan>`;
  const res = await (o.runner ?? runProcess)(plannerArgv(o.promptFile, o.model), prompt, o.timeoutSec ?? PLANNER_TIMEOUT, { signal: o.signal });
  if (res.code === -1) throw new PlanError("planner timed out");
  if (res.code !== 0) throw new PlanError(res.stderr.trim() || `claude exited ${res.code}`);
  let env: unknown;
  try {
    env = JSON.parse(res.stdout);
  } catch (e) {
    throw new PlanError(`planner gave non-JSON output: ${(e as Error).message}`);
  }
  if (!isObject(env)) throw new PlanError("planner output is not an object");
  const cost = typeof env.total_cost_usd === "number" && Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : 0;
  try {
    if (env.is_error) throw new PlanError(`claude error: ${String(env.result || "unknown")}`);
    if (env.structured_output === undefined || env.structured_output === null) throw new PlanError("planner output has no plan");
    return { doc: parsePlanDoc(env.structured_output), cost };
  } catch (e) {
    if (e instanceof PlanError) e.cost = cost;
    throw e;
  }
}

/** One task file: a comment naming the plan and scenario, the shared setup, then the scenario. */
export function taskFileText(s: Scenario, source: string, setup: string | null, env: string | null = null): string {
  const front = [
    "---", `# From ${flat(source)}, scenario ${s.id}`,
    ...(setup !== null ? [`setup: ${setup}`] : []),
    ...(env !== null ? [`env: ${env}`] : []),
    "---",
  ];
  const list = (xs: string[]): string[] => xs.map((x) => `- ${x}`);
  const body = [`# ${s.id}: ${s.title}`, ""];
  if (s.preconditions.length > 0) body.push("Preconditions:", ...list(s.preconditions), "");
  body.push("Steps:", ...s.steps.map((x, i) => `${i + 1}. ${x}`), "");
  if (s.expected.length > 0) body.push("Expected results:", ...list(s.expected), "");
  return [...front, ...body].join("\n");
}

function freshFolder(root: string, slug: string): string {
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const p = path.join(root, n === 1 ? slug : `${slug}-${n}`);
    try {
      fs.mkdirSync(p);
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/**
 * Write a planned folder under `root`: `<root>/<plan name>/` (with -2, -3, ... rather than touch
 * an existing one) holding NN-<title>.md per scenario, shared/setup.md, and plan.json.
 */
export function writePlan(doc: PlanDoc, planFile: string, root = "tasks", env: string | null = null): LoadedPlan {
  const name = path.basename(planFile);
  const folder = freshFolder(root, slugify(path.parse(planFile).name) || "plan");
  const setup = doc.setup !== "" ? SETUP_FILE : null;
  let envValue: string | null = null;
  if (env !== null) {
    if (isEnvName(env)) envValue = env;
    else {
      // Task-file paths are read relative to the file, so write one relative to the folder,
      // and never in a form that would be re-read as a name.
      const rel = path.relative(resolvePath(folder), resolveEnv(env).path);
      envValue = !rel.includes("/") && !rel.includes(path.sep) && !/\.md$/i.test(rel) ? `./${rel}` : rel;
    }
  }
  if (setup !== null) {
    fs.mkdirSync(path.join(folder, path.dirname(setup)), { recursive: true });
    fs.writeFileSync(path.join(folder, setup), doc.setup + "\n");
  }
  const width = Math.max(2, String(doc.tasks.length).length);
  const tasks: PlanEntry[] = doc.tasks.map((s, i) => {
    // The number keeps names unique and the folder's order the plan's order.
    const file = `${String(i + 1).padStart(width, "0")}-${slugify(s.title) || "scenario"}.md`;
    fs.writeFileSync(path.join(folder, file), taskFileText(s, planFile, setup, envValue));
    return { file, id: s.id, title: s.title };
  });
  const manifest: Manifest = { version: 1, name, source: planFile, setup, notes: doc.notes, skipped: doc.skipped, tasks };
  writeManifest(folder, manifest);
  return withPaths(folder, manifest);
}

export function writeManifest(folder: string, m: Manifest): void {
  fs.writeFileSync(path.join(folder, MANIFEST), JSON.stringify(m, null, 2) + "\n");
}

function withPaths(folder: string, m: Manifest): LoadedPlan {
  return {
    folder, manifest: m,
    setupPath: m.setup !== null ? path.join(folder, m.setup) : null,
    tasks: m.tasks.map((t) => ({ ...t, path: path.join(folder, t.file) })),
  };
}

export function isPlanFolder(p: string): boolean {
  try {
    return fs.statSync(path.join(p, MANIFEST)).isFile();
  } catch {
    return false;
  }
}

/** Read a planned folder's plan.json; a task whose file is gone is left out. */
export function loadPlan(folder: string): LoadedPlan {
  const where = path.join(folder, MANIFEST);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(where, "utf8"));
  } catch (e) {
    throw new PlanError(`${where}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : `cannot read: ${(e as Error).message}`}`);
  }
  const bad = (): never => {
    throw new PlanError(`${where}: not a Duckwright plan manifest`);
  };
  if (!isObject(data) || data.version !== 1 || typeof data.name !== "string" || typeof data.source !== "string"
    || !(data.setup === null || typeof data.setup === "string") || !isStrings(data.notes)
    || !Array.isArray(data.skipped) || !Array.isArray(data.tasks)) return bad();
  const tasks = (data.tasks as unknown[]).map((t): PlanEntry => {
    if (!isObject(t) || typeof t.file !== "string" || typeof t.id !== "string" || typeof t.title !== "string") return bad();
    // Only plain names inside the folder: a manifest must not point elsewhere.
    if (t.file !== path.basename(t.file) || t.file.startsWith(".")) return bad();
    return { file: t.file, id: t.id, title: t.title };
  });
  const skipped = (data.skipped as unknown[]).map((s): Skipped => {
    if (!isObject(s) || typeof s.id !== "string" || typeof s.title !== "string" || typeof s.reason !== "string") return bad();
    return { id: s.id, title: s.title, reason: s.reason };
  });
  const setup = data.setup as string | null;
  if (setup !== null && (path.isAbsolute(setup) || setup.split(/[\\/]/).includes(".."))) return bad();
  const m: Manifest = { version: 1, name: data.name, source: data.source, setup, notes: data.notes as string[], skipped, tasks };
  const loaded = withPaths(folder, m);
  return { ...loaded, tasks: loaded.tasks.filter((t) => fs.existsSync(t.path)) };
}
