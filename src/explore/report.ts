import fs from "node:fs";
import path from "node:path";

import type { HistoryData } from "../export.ts";
import { fixed4, flat } from "../text.ts";
import { readAudit, readRefusals } from "./guard.ts";
import type { AuditEntry, Refusal } from "./guard.ts";
import { normalizeUrl } from "./site.ts";
import { readLedger } from "./writes.ts";
import type { CreatedEntry, LedgerItem } from "./writes.ts";

export type FlowStatus = "ok" | "dead-end" | "broken";

export interface Flow {
  title: string;
  start_url: string;
  steps: string[];
  expected: string;
  status: FlowStatus;
  notes: string;
}

export interface FailedRequest {
  method: string;
  url: string;
  status: number | null;
  status_text: string;
  steps: number[];
}

export interface ConsoleError {
  message: string;
  steps: number[];
}

export type FunctionStatus = "ok" | "broken" | "blocked";

export interface ReportedFunction {
  name: string;
  area_url: string | null;
  status: FunctionStatus;
  steps: string[];
  expected: string;
  notes: string;
}

export interface WritesReport {
  marker: string;
  created: LedgerItem[];
  refused: Refusal[];
  audit: AuditEntry[];
  functions: ReportedFunction[];
  leftovers: CreatedEntry[];
}

export interface ExploreReport {
  version: 1;
  url: string;
  run_dir: string;
  success: boolean;
  steps: number;
  cost_usd: number;
  network_checked: boolean;
  failed_requests: FailedRequest[];
  console_errors: ConsoleError[];
  answer_error: string | null;
  dropped_flows: number;
  broken_flows: Flow[];
  working_flows: Flow[];
  functions?: ReportedFunction[];
  dropped_functions?: number;
  writes?: WritesReport;
}

const STATUSES: readonly string[] = ["ok", "dead-end", "broken"];

function toFlow(item: unknown, base: string): Flow | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.title !== "string" || o.title.trim() === "") return null;
  if (typeof o.status !== "string" || !STATUSES.includes(o.status)) return null;
  if (typeof o.start_url !== "string") return null;
  let u: URL;
  try {
    u = new URL(o.start_url, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return {
    title: o.title,
    start_url: u.href,
    steps: Array.isArray(o.steps) ? o.steps.filter((s): s is string => typeof s === "string") : [],
    expected: typeof o.expected === "string" ? o.expected : "",
    status: o.status as FlowStatus,
    notes: typeof o.notes === "string" ? o.notes : "",
  };
}

/** Read the agent's final answer as a flow list. Never throws. */
export function parseFlows(answer: string, base: string): { flows: Flow[]; dropped: number; error: string | null } {
  const fail = (error: string) => ({ flows: [], dropped: 0, error });
  const first = answer.indexOf("{");
  const last = answer.lastIndexOf("}");
  if (first < 0 || last < first) return fail("no JSON object in the answer");
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(first, last + 1));
  } catch (e) {
    return fail(`invalid JSON: ${(e as Error).message}`);
  }
  const list = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).flows : undefined;
  if (!Array.isArray(list)) return fail('no "flows" list in the answer');
  const flows: Flow[] = [];
  let dropped = 0;
  for (const item of list) {
    const f = toFlow(item, base);
    if (f) flows.push(f);
    else dropped++;
  }
  return { flows, dropped, error: null };
}

const FN_STATUSES: readonly string[] = ["ok", "broken", "blocked"];
const FN_NAME_MAX = 120;

function toFunction(item: unknown, base: string): ReportedFunction | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.name !== "string" || flat(o.name).trim() === "") return null;
  if (typeof o.status !== "string" || !FN_STATUSES.includes(o.status)) return null;
  const area = typeof o.area_url === "string" ? normalizeUrl(o.area_url, base) : null;
  return {
    name: [...flat(o.name).trim()].slice(0, FN_NAME_MAX).join(""),
    area_url: area,
    status: o.status as FunctionStatus,
    steps: Array.isArray(o.steps) ? o.steps.filter((s): s is string => typeof s === "string").map((s) => flat(s)) : [],
    expected: typeof o.expected === "string" ? flat(o.expected) : "",
    notes: typeof o.notes === "string" ? flat(o.notes) : "",
  };
}

/** The optional `functions` list of the agent's answer. Never throws; `present` is false for old-style answers. */
export function parseFunctions(answer: string, base: string): { functions: ReportedFunction[]; dropped: number; present: boolean } {
  const none = { functions: [], dropped: 0, present: false };
  const first = answer.indexOf("{");
  const last = answer.lastIndexOf("}");
  if (first < 0 || last < first) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(first, last + 1));
  } catch {
    return none;
  }
  const list = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).functions : undefined;
  if (!Array.isArray(list)) return none;
  const functions: ReportedFunction[] = [];
  let dropped = 0;
  for (const item of list) {
    const f = toFunction(item, base);
    if (f) functions.push(f);
    else dropped++;
  }
  return { functions, dropped, present: true };
}

export function failedRequests(data: HistoryData): FailedRequest[] {
  const groups = new Map<string, FailedRequest>();
  for (const s of data.history) {
    for (const e of s.network ?? []) {
      const failed = e.status === null || e.status >= 400;
      if (!failed || /abort|cancel/i.test(e.statusText)) continue;
      const key = JSON.stringify([e.method, e.url, e.status]);
      let g = groups.get(key);
      if (!g) {
        g = { method: e.method, url: e.url, status: e.status, status_text: e.statusText, steps: [] };
        groups.set(key, g);
      }
      if (!g.steps.includes(s.step)) g.steps.push(s.step);
    }
  }
  for (const g of groups.values()) g.steps.sort((a, b) => a - b);
  return [...groups.values()];
}

export function consoleErrors(data: HistoryData): ConsoleError[] {
  const groups = new Map<string, ConsoleError>();
  for (const s of data.history) {
    for (const m of s.console_errors ?? []) {
      let g = groups.get(m);
      if (!g) {
        g = { message: m, steps: [] };
        groups.set(m, g);
      }
      if (!g.steps.includes(s.step)) g.steps.push(s.step);
    }
  }
  for (const g of groups.values()) g.steps.sort((a, b) => a - b);
  return [...groups.values()];
}

export function buildExploreReport(
  data: HistoryData,
  o: { url: string; runDir: string; network: boolean; writes?: { marker: string; previous: CreatedEntry[] } },
): ExploreReport {
  const parsed = parseFlows(data.answer ?? "", o.url);
  const fns = parseFunctions(data.answer ?? "", o.url);
  const writes: WritesReport | undefined = o.writes
    ? {
        marker: o.writes.marker,
        created: readLedger(o.runDir),
        refused: readRefusals(o.runDir),
        audit: readAudit(o.runDir),
        functions: fns.functions,
        leftovers: o.writes.previous.filter((c) => !c.removed),
      }
    : undefined;
  return {
    version: 1,
    url: o.url,
    run_dir: o.runDir,
    success: data.success,
    steps: data.steps,
    cost_usd: data.cost_usd,
    network_checked: o.network,
    failed_requests: o.network ? failedRequests(data) : [],
    console_errors: consoleErrors(data),
    answer_error: parsed.error,
    dropped_flows: parsed.dropped,
    broken_flows: parsed.flows.filter((f) => f.status !== "ok"),
    working_flows: parsed.flows.filter((f) => f.status === "ok"),
    ...(fns.present || o.writes ? { functions: fns.functions, dropped_functions: fns.dropped } : {}),
    ...(writes ? { writes } : {}),
  };
}

const stepsLabel = (steps: number[]) => `(${steps.length === 1 ? "step" : "steps"} ${steps.join(", ")})`;

function flowBlock(f: Flow, heading: string, withNotes: boolean): string[] {
  const out = [`### ${heading}`, "", `- Start: ${flat(f.start_url)}`];
  if (f.steps.length) out.push(`- Steps: ${f.steps.map((s, i) => `${i + 1}. ${flat(s)}`).join("; ")}`);
  if (f.expected) out.push(`- Expected: ${flat(f.expected)}`);
  if (withNotes && f.notes) out.push(`- Notes: ${flat(f.notes)}`);
  return out;
}

export function renderExploreMarkdown(r: ExploreReport): string {
  const parts: string[][] = [];
  parts.push([`# Exploration report: ${flat(r.url)}`]);
  parts.push([`Run: ${flat(r.run_dir)}  Steps: ${r.steps}  Cost: $${fixed4(r.cost_usd)}  Result: ${r.success ? "success" : "failure"}`]);
  if (r.writes) parts.push([`Marker: ${flat(r.writes.marker)}`]);
  if (r.answer_error) parts.push([`The agent's answer could not be read as a flow list: ${flat(r.answer_error)}.`]);
  if (r.dropped_flows > 0) parts.push([`${r.dropped_flows} flow(s) in the answer were unreadable and left out.`]);
  if ((r.dropped_functions ?? 0) > 0) parts.push([`${r.dropped_functions} function(s) in the answer were unreadable and left out.`]);

  parts.push([`## Broken links and failed requests (${r.network_checked ? r.failed_requests.length : "-"})`]);
  if (!r.network_checked) parts.push(["Network capture was off (--no-network), so requests were not checked."]);
  else if (!r.failed_requests.length) parts.push(["None."]);
  else {
    parts.push(r.failed_requests.map((f) => {
      const result = f.status === null
        ? (f.status_text ? `no response: ${flat(f.status_text)}` : "no response")
        : `${f.status} ${flat(f.status_text)}`.trim();
      return `- ${flat(f.method)} ${flat(f.url)} → ${result}  ${stepsLabel(f.steps)}`;
    }));
  }

  parts.push([`## Console errors (${r.console_errors.length})`]);
  parts.push(r.console_errors.length
    ? r.console_errors.map((c) => `- ${flat(c.message)}  ${stepsLabel(c.steps)}`)
    : ["None."]);

  parts.push([`## Dead ends and broken flows (${r.broken_flows.length})`]);
  if (!r.broken_flows.length) parts.push(["None."]);
  for (const f of r.broken_flows) parts.push(flowBlock(f, `${flat(f.title)} (${f.status})`, true));

  parts.push([`## Flows that worked (${r.working_flows.length})`]);
  if (!r.working_flows.length) parts.push(["None."]);
  for (const f of r.working_flows) parts.push(flowBlock(f, flat(f.title), false));

  if (r.writes) {
    const w = r.writes;
    const fns = r.functions ?? [];
    const n = (s: FunctionStatus) => fns.filter((f) => f.status === s).length;
    parts.push([`## Functions exercised (${n("ok")} ok, ${n("broken")} broken, ${n("blocked")} blocked)`]);
    parts.push(fns.length
      ? fns.map((f) => `- ${flat(f.name)}: ${f.status}${f.steps.length ? ` (${f.steps.map(flat).join("; ")})` : ""}${f.notes ? ` – ${flat(f.notes)}` : ""}`)
      : ["None."]);
    parts.push([`## Items created (${w.created.length})`]);
    parts.push(w.created.length
      ? w.created.map((c) => `- ${flat(c.name)}${c.url ? ` (${flat(c.url)})` : ""} – ${c.removed ? "removed" : "still there"}`)
      : ["None."]);
    parts.push([`## Refused actions (${w.refused.length})`]);
    parts.push(w.refused.length ? w.refused.map((x) => `- step ${x.step}: '${flat(x.control)}'${x.url ? ` on ${flat(x.url)}` : ""}`) : ["None."]);
    parts.push([`## Possible writes to unmarked items (${w.audit.length})`]);
    parts.push(w.audit.length ? w.audit.map((x) => `- step ${x.step}: ${flat(x.cmd)} ${flat(x.control)}${x.url ? ` on ${flat(x.url)}` : ""}`) : ["None."]);
    parts.push([`## Leftovers from earlier runs (${w.leftovers.length})`]);
    parts.push(w.leftovers.length ? w.leftovers.map((l) => `- ${flat(l.name)}${l.url ? ` (${flat(l.url)})` : ""}`) : ["None."]);
  }

  return parts.map((p) => p.join("\n")).join("\n\n") + "\n";
}

export function writeExploreReport(runDir: string, r: ExploreReport): { md: string; json: string } {
  const md = path.join(runDir, "explore.md");
  const json = path.join(runDir, "explore.json");
  fs.writeFileSync(md, renderExploreMarkdown(r));
  fs.writeFileSync(json, JSON.stringify(r, null, 2) + "\n");
  return { md, json };
}
