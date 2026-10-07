// The HTTP API as a route table: each route validates its input and makes one ManagerLike call.
// No HTTP in here, so it runs against a fake manager.
import type { RunEvent } from "../events.ts";
import type { SnapshotMode } from "../observe.ts";
import type { EditTarget, Globals, ManagerLike, Overrides, PlanSnapshot, TaskId, TaskSnapshot } from "../runs/manager.ts";
import { rank } from "../tui/candidates.ts";
import type { CandidateIndex } from "../tui/candidates.ts";
import type { ThemeName } from "../tui/theme.ts";

/** Every event of one run since the server started: how a browser opened mid-run rebuilds its timeline. */
export interface LoggedRun { taskId: TaskId; runId: string; events: RunEvent[] }

export interface ApiContext {
  manager: ManagerLike;
  maxParallel: number;
  /** One-time messages for the screen (e.g. skipped run folders). */
  notices: string[];
  theme: ThemeName;
  /** Stop every run and shut the server down. */
  quit(): void;
  /** The task files and folders `@` completion ranks. */
  candidates(): CandidateIndex;
  /** The runs seen so far with their events, oldest first. */
  runs(): LoggedRun[];
}

export interface ApiRequest { method: string; path: string; query: URLSearchParams; body: unknown }
export interface ApiResponse { status: number; body: unknown }

/** What the browser needs to draw the screen; the first message of every event stream. */
export interface WebSnapshot {
  tasks: TaskSnapshot[];
  plans: PlanSnapshot[];
  globals: Globals;
  activeCount: number;
  maxParallel: number;
  notices: string[];
  theme: ThemeName;
  runs: LoggedRun[];
}

export function snapshotOf(ctx: ApiContext): WebSnapshot {
  const m = ctx.manager;
  return {
    tasks: m.list(), plans: m.plans(), globals: m.globals(), activeCount: m.activeCount(),
    maxParallel: ctx.maxParallel, notices: ctx.notices, theme: ctx.theme, runs: ctx.runs(),
  };
}

const ok = (extra: Record<string, unknown> = {}): ApiResponse => ({ status: 200, body: { ok: true, ...extra } });
const bad = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResponse =>
  ({ status, body: { ok: false, error, ...extra } });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SNAPSHOTS: readonly string[] = ["hybrid", "full", "grep"];

/** The overrides in `raw`, or the reason they are invalid. Unknown fields are dropped. */
export function parseOverrides(raw: unknown): Overrides | string {
  if (!isObject(raw)) return "the options must be an object";
  const o: Overrides = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim() === "") return "model must be a non-empty string";
    o.model = raw.model.trim();
  }
  if (raw.maxSteps !== undefined) {
    if (!Number.isInteger(raw.maxSteps) || (raw.maxSteps as number) < 1) return "maxSteps must be a whole number of at least 1";
    o.maxSteps = raw.maxSteps as number;
  }
  if (raw.headed !== undefined) {
    if (typeof raw.headed !== "boolean") return "headed must be true or false";
    o.headed = raw.headed;
  }
  if (raw.export !== undefined) {
    if (typeof raw.export !== "boolean") return "export must be true or false";
    o.export = raw.export;
  }
  if (raw.snapshot !== undefined) {
    if (typeof raw.snapshot !== "string" || !SNAPSHOTS.includes(raw.snapshot)) return "snapshot must be hybrid, full or grep";
    o.snapshot = raw.snapshot as SnapshotMode;
  }
  return o;
}

function targetOf(raw: unknown): EditTarget | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "task" && Number.isInteger(raw.id)) return { kind: "task", id: raw.id as number };
  if (raw.kind === "setup" && Number.isInteger(raw.planId)) return { kind: "setup", planId: raw.planId as number };
  return null;
}

interface Route {
  method: string;
  re: RegExp;
  run(ctx: ApiContext, m: RegExpExecArray, req: ApiRequest): ApiResponse | Promise<ApiResponse>;
}

const taskExists = (ctx: ApiContext, m: RegExpExecArray): number | null => {
  const id = Number(m[1]);
  return ctx.manager.list().some((t) => t.id === id) ? id : null;
};
const planExists = (ctx: ApiContext, m: RegExpExecArray): number | null => {
  const id = Number(m[1]);
  return ctx.manager.plans().some((p) => p.id === id) ? id : null;
};
const fromResult = (r: { ok: true } | { ok: false; error: string }): ApiResponse => (r.ok ? ok() : bad(409, r.error));

const ROUTES: Route[] = [
  { method: "GET", re: /^\/api\/state$/, run: (ctx) => ({ status: 200, body: snapshotOf(ctx) }) },
  {
    method: "POST", re: /^\/api\/tasks$/,
    run: (ctx, _m, req) => {
      const b = req.body;
      if (!isObject(b) || !Array.isArray(b.mentions) || !b.mentions.every((x) => typeof x === "string")
        || (b.typed !== undefined && b.typed !== null && typeof b.typed !== "string")) {
        return bad(400, "send { mentions: string[], typed: string | null }");
      }
      const typed = typeof b.typed === "string" && b.typed.trim() !== "" ? b.typed.trim() : null;
      if (b.mentions.length === 0 && typed === null) return bad(400, "give a task or mention a task file");
      const r = ctx.manager.add({ mentions: b.mentions as string[], typed });
      if (r.ok) return ok({ added: r.added, duplicates: r.duplicates });
      return bad(400, r.errors.map((e) => e.message).join("\n"), { errors: r.errors });
    },
  },
  {
    method: "POST", re: /^\/api\/tasks\/(\d+)\/start$/,
    run: (ctx, m) => {
      const id = taskExists(ctx, m);
      if (id === null) return bad(404, "no such task");
      const r = ctx.manager.start(id);
      return r.ok ? ok({ runId: r.runId }) : bad(409, r.reason);
    },
  },
  {
    method: "DELETE", re: /^\/api\/tasks\/(\d+)$/,
    run: (ctx, m) => {
      const id = taskExists(ctx, m);
      if (id === null) return bad(404, "no such task");
      return ctx.manager.remove(id) ? ok() : bad(409, "the task is running");
    },
  },
  {
    method: "PUT", re: /^\/api\/tasks\/(\d+)\/overrides$/,
    run: (ctx, m, req) => {
      const id = taskExists(ctx, m);
      if (id === null) return bad(404, "no such task");
      const o = parseOverrides(req.body);
      if (typeof o === "string") return bad(400, o);
      ctx.manager.setOverrides(id, o);
      return ok();
    },
  },
  {
    method: "PUT", re: /^\/api\/globals$/,
    run: (ctx, _m, req) => {
      const o = parseOverrides(req.body);
      if (typeof o === "string") return bad(400, o);
      ctx.manager.setGlobals(o);
      return ok();
    },
  },
  {
    method: "POST", re: /^\/api\/tasks\/(\d+)\/twofa$/,
    run: (ctx, m, req) => {
      const id = taskExists(ctx, m);
      if (id === null) return bad(404, "no such task");
      const v = isObject(req.body) ? req.body.value : undefined;
      if (v !== null && typeof v !== "string") return bad(400, "send { value: string | null }");
      ctx.manager.answerTwoFactor(id, v as string | null);
      return ok();
    },
  },
  {
    method: "POST", re: /^\/api\/tasks\/(\d+)\/move$/,
    run: (ctx, m, req) => {
      const id = taskExists(ctx, m);
      if (id === null) return bad(404, "no such task");
      const d = isObject(req.body) ? req.body.delta : undefined;
      if (!Number.isInteger(d)) return bad(400, "send { delta: whole number }");
      ctx.manager.movePlanTask(id, d as number);
      return ok();
    },
  },
  {
    method: "POST", re: /^\/api\/plans$/,
    run: (ctx, _m, req) => {
      const s = isObject(req.body) ? req.body.source : undefined;
      if (typeof s !== "string") return bad(400, "send { source: string }");
      const r = ctx.manager.plan(s);
      return r.ok ? ok({ id: r.id }) : bad(400, r.error);
    },
  },
  {
    method: "POST", re: /^\/api\/plans\/(\d+)\/run$/,
    run: (ctx, m, req) => {
      const id = planExists(ctx, m);
      if (id === null) return bad(404, "no such plan");
      const which = isObject(req.body) && req.body.which !== undefined ? req.body.which : "all";
      if (which !== "all" && which !== "failed") return bad(400, "which must be all or failed");
      return fromResult(ctx.manager.runPlan(id, which));
    },
  },
  {
    method: "POST", re: /^\/api\/plans\/(\d+)\/retry$/,
    run: (ctx, m) => {
      const id = planExists(ctx, m);
      return id === null ? bad(404, "no such plan") : fromResult(ctx.manager.retryPlan(id));
    },
  },
  {
    method: "DELETE", re: /^\/api\/plans\/(\d+)$/,
    run: (ctx, m) => {
      const id = planExists(ctx, m);
      if (id === null) return bad(404, "no such plan");
      return ctx.manager.removePlan(id) ? ok() : bad(409, "the plan is planning or running");
    },
  },
  {
    method: "GET", re: /^\/api\/source$/,
    run: (ctx, _m, req) => {
      const q = req.query;
      const target = targetOf({ kind: q.get("kind"), id: Number(q.get("id")), planId: Number(q.get("planId")) });
      if (target === null) return bad(400, "give kind=task&id=N or kind=setup&planId=N");
      const r = ctx.manager.readSource(target);
      return r.ok ? ok({ text: r.text }) : bad(409, r.error);
    },
  },
  {
    method: "PUT", re: /^\/api\/source$/,
    run: (ctx, _m, req) => {
      const b = isObject(req.body) ? req.body : {};
      const target = targetOf(b.target);
      if (target === null || typeof b.text !== "string") return bad(400, "send { target, text: string }");
      const r = ctx.manager.saveSource(target, b.text);
      return r.ok ? ok() : bad(400, r.error);
    },
  },
  {
    method: "GET", re: /^\/api\/candidates$/,
    run: (ctx, _m, req) => {
      const index = ctx.candidates();
      return ok({ items: rank(index, req.query.get("q") ?? "").slice(0, 50), truncated: index.truncated });
    },
  },
  {
    method: "POST", re: /^\/api\/quit$/,
    run: (ctx) => {
      ctx.quit();
      return ok();
    },
  },
];

// Per-task and per-plan controls that take no body and always succeed.
for (const verb of ["pause", "resume", "step", "stop"] as const) {
  ROUTES.push({
    method: "POST", re: new RegExp(`^/api/tasks/(\\d+)/${verb}$`),
    run: (ctx, m) => {
      const id = taskExists(ctx, m);
      if (id === null) return bad(404, "no such task");
      ctx.manager[verb](id);
      return ok();
    },
  });
}
for (const verb of ["cancelPlan", "stopPlan"] as const) {
  ROUTES.push({
    method: "POST", re: new RegExp(`^/api/plans/(\\d+)/${verb === "cancelPlan" ? "cancel" : "stop"}$`),
    run: (ctx, m) => {
      const id = planExists(ctx, m);
      if (id === null) return bad(404, "no such plan");
      ctx.manager[verb](id);
      return ok();
    },
  });
}

export async function handleApi(ctx: ApiContext, req: ApiRequest): Promise<ApiResponse> {
  let known = false;
  for (const route of ROUTES) {
    const m = route.re.exec(req.path);
    if (!m) continue;
    known = true;
    if (route.method !== req.method) continue;
    try {
      return await route.run(ctx, m, req);
    } catch {
      // Never show a manager's error text to the browser.
      return bad(500, "internal error");
    }
  }
  return known ? bad(405, "method not allowed") : bad(404, "not found");
}
