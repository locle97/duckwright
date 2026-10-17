// The MCP endpoint the chat's Claude Code session talks to: JSON-RPC methods and the eight Duckwright
// tools, which start and await runs through the run manager so they show in the web UI.
import fs from "node:fs";

import { resolvePath } from "../paths.ts";
import type { ManagerLike, PlanId, TaskId } from "../runs/manager.ts";
import type { Phase } from "./types.ts";
import type { RunTracker } from "./tracker.ts";

export interface McpHost {
  manager: ManagerLike; tracker: RunTracker;
  spentUsd(): number; ceilingUsd(): number;
  takeMessages(): string[]; // drains queued person messages
  setPhase(p: Phase): void; ask(questions: string[]): void;
  activity(text: string): void; setPlanFolder(folder: string): void;
}
export type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };

const PHASES: Phase[] = ["read", "clarify", "plan", "probe", "write", "run", "report", "playwright"];

const obj = (properties: object, required: string[] = []) => ({ type: "object", properties, required });

export const MCP_TOOLS: { name: string; description: string; inputSchema: object }[] = [
  { name: "set_phase", description: "Tell the person which phase of the work you are in.", inputSchema: obj({ phase: { type: "string", enum: PHASES } }, ["phase"]) },
  { name: "ask", description: "Ask the person questions, then end your turn.", inputSchema: obj({ questions: { type: "array", items: { type: "string" } } }, ["questions"]) },
  { name: "check_messages", description: "Fetch messages the person sent while you were working.", inputSchema: obj({}) },
  { name: "budget", description: "Spend so far, the ceiling and what remains, in USD.", inputSchema: obj({}) },
  { name: "open_plan", description: "Open a planned folder (or plan a plan file) in Duckwright.", inputSchema: obj({ folder: { type: "string" } }, ["folder"]) },
  { name: "run_plan", description: "Run an open plan's tasks.", inputSchema: obj({ plan_id: { type: "number" }, which: { type: "string", enum: ["all", "failed"] } }, ["plan_id"]) },
  { name: "run_task", description: "Run one task file.", inputSchema: obj({ file: { type: "string" }, env: { type: "string" } }, ["file"]) },
  { name: "wait", description: "Wait for tasks or a plan to finish, up to a timeout.", inputSchema: obj({ task_ids: { type: "array", items: { type: "number" } }, plan_id: { type: "number" }, timeout_sec: { type: "number" } }) },
];

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

class ToolError extends Error {
  extra: object;
  constructor(message: string, extra: object = {}) {
    super(message);
    this.extra = extra;
  }
}

function overCeiling(host: McpHost): void {
  const spent = host.spentUsd();
  const ceiling = host.ceilingUsd();
  if (spent >= ceiling) throw new ToolError("spend ceiling reached", { spent_usd: spent, ceiling_usd: ceiling });
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "") throw new ToolError(`${name} must be a non-empty string`);
  return v;
}

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`${name} must be a number`);
  return v;
}

function planTaskIds(host: McpHost, planId: PlanId): TaskId[] {
  const plan = host.manager.plans().find((p) => p.id === planId);
  if (plan === undefined) throw new ToolError(`no plan ${planId}`);
  return plan.taskIds;
}

async function callTool(host: McpHost, name: string, a: Record<string, unknown>, waitCapSec: number): Promise<object> {
  const m = host.manager;
  switch (name) {
    case "set_phase": {
      const phase = a.phase;
      if (typeof phase !== "string" || !PHASES.includes(phase as Phase)) throw new ToolError(`unknown phase; use one of ${PHASES.join(", ")}`);
      host.setPhase(phase as Phase);
      return { ok: true };
    }
    case "ask": {
      const qs = a.questions;
      if (!Array.isArray(qs) || qs.length === 0 || !qs.every((q) => typeof q === "string")) throw new ToolError("questions must be a non-empty array of strings");
      host.ask(qs as string[]);
      return { ok: true, note: "end your turn now" };
    }
    case "check_messages":
      return {};
    case "budget": {
      const spent = host.spentUsd();
      const ceiling = host.ceilingUsd();
      return { spent_usd: spent, ceiling_usd: ceiling, remaining_usd: Math.max(0, ceiling - spent) };
    }
    case "open_plan": {
      const folder = str(a.folder, "folder");
      const r = m.plan(folder);
      let id: PlanId;
      if (r.ok) id = r.id;
      else {
        const key = resolvePath(folder);
        const found = r.error.includes("already open") ? m.plans().find((p) => p.folder !== null && resolvePath(p.folder) === key) : undefined;
        if (found === undefined) throw new ToolError(r.error);
        id = found.id;
      }
      host.tracker.ownPlan(id);
      const plan = m.plans().find((p) => p.id === id);
      host.setPlanFolder(plan?.folder ?? folder);
      return { plan_id: id, task_ids: plan?.taskIds ?? [] };
    }
    case "run_plan": {
      const id = num(a.plan_id, "plan_id");
      const which = a.which === undefined ? "all" : a.which;
      if (which !== "all" && which !== "failed") throw new ToolError('which must be "all" or "failed"');
      overCeiling(host);
      const plan = m.plans().find((p) => p.id === id);
      if (plan === undefined) throw new ToolError(`no plan ${id}`);
      const r = m.runPlan(id, which);
      if (!r.ok) throw new ToolError(r.error);
      host.tracker.ownPlan(id);
      host.activity(`Running plan ${plan.folder ?? plan.name}`);
      return { ok: true };
    }
    case "run_task": {
      const file = str(a.file, "file");
      const env = a.env === undefined ? undefined : str(a.env, "env");
      overCeiling(host);
      const added = m.add({ mentions: [file], typed: null });
      let id: TaskId;
      if (!added.ok) throw new ToolError(added.errors.map((e) => e.message).join("; "));
      if (added.added.length > 0) id = added.added[0];
      else {
        const key = resolvePath(file);
        const found = m.list().find((t) => t.source.kind === "file" && t.past === undefined && resolvePath(t.source.path) === key);
        if (found === undefined) throw new ToolError(`could not add ${file}`);
        id = found.id;
      }
      host.tracker.own([id]);
      if (env !== undefined) m.setOverrides(id, { env });
      const s = m.start(id);
      if (!s.ok) throw new ToolError(s.reason);
      host.activity(`Running ${file}`);
      return { task_id: id, run_id: s.runId };
    }
    case "wait": {
      let ids: TaskId[];
      if (Array.isArray(a.task_ids)) ids = a.task_ids.map((v) => num(v, "task_ids"));
      else if (a.plan_id !== undefined) ids = planTaskIds(host, num(a.plan_id, "plan_id"));
      else throw new ToolError("give task_ids or plan_id");
      const sec = Math.min(a.timeout_sec === undefined ? 600 : num(a.timeout_sec, "timeout_sec"), waitCapSec);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, sec) * 1000);
      });
      const done = await Promise.race([host.tracker.settled(ids).then(() => true as const), timeout]);
      clearTimeout(timer);
      return { done, results: host.tracker.results(ids) };
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}

export async function handleMcp(host: McpHost, msg: JsonRpc, waitCapSec = 600): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method.startsWith("notifications/")) return null;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  if (msg.method === "initialize") {
    return reply({
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "duckwright", version: version() },
    });
  }
  if (msg.method === "ping") return reply({});
  if (msg.method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (msg.method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    let isError = false;
    let result: object;
    try {
      result = await callTool(host, name, args, waitCapSec);
    } catch (e) {
      isError = true;
      result = e instanceof ToolError ? { error: e.message, ...e.extra } : { error: e instanceof Error ? e.message : String(e) };
    }
    const body = { ...result, pending_messages: host.takeMessages() };
    return reply({ content: [{ type: "text", text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) });
  }
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}
