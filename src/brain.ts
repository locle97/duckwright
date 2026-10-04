import path from "node:path";

import { CHECKS } from "./expect.ts";
import { runProcess } from "./proc.ts";
import type { Runner } from "./proc.ts";

// Grep mode: the only tools Claude gets, confined (--restricted) to the snapshot folder.
export const SNAPSHOT_TOOLS = "Read,Grep";
export const TOOL_TIMEOUT = 120;

export const ALLOWED_COMMANDS = [
  "goto", "click", "fill", "type", "press", "select", "check", "uncheck",
  "hover", "drag", "tab-new", "tab-select", "tab-close", "go-back",
  "screenshot", "expect", "done",
] as const;

export const DECISION_SCHEMA = {
  type: "object",
  required: ["evaluation_previous_goal", "memory", "next_goal", "actions"],
  properties: {
    evaluation_previous_goal: { type: "string" },
    memory: { type: "string" },
    next_goal: { type: "string" },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        anyOf: [
          // done must carry a status and an answer. Positional typing
          // (prefixItems / tuple items) is rejected by the CLI or the API,
          // so `contains` stands in; actions.ts still checks args[0].
          {
            type: "object",
            required: ["cmd", "args"],
            properties: {
              cmd: { const: "done" },
              args: {
                type: "array",
                items: { type: "string" },
                contains: { enum: ["success", "failure"] },
                minItems: 2,
                maxItems: 2,
              },
            },
          },
          // expect must name one of its checks; expect.ts checks the order.
          {
            type: "object",
            required: ["cmd", "args"],
            properties: {
              cmd: { const: "expect" },
              args: {
                type: "array",
                items: { type: "string" },
                contains: { enum: Object.keys(CHECKS) },
                minItems: 1,
                maxItems: 3,
              },
            },
          },
          {
            type: "object",
            required: ["cmd", "args"],
            properties: {
              cmd: {
                type: "string",
                enum: ALLOWED_COMMANDS.filter((c) => c !== "done" && c !== "expect"),
              },
              args: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
    },
  },
};

export interface Action {
  cmd: string;
  args: string[];
}

export interface Decision {
  evaluationPreviousGoal: string;
  memory: string;
  nextGoal: string;
  actions: Action[];
}

export class BrainError extends Error {
  cost: number;

  constructor(msg = "", cost = 0) {
    super(msg);
    this.name = "BrainError";
    this.cost = cost;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseDecision(so: unknown): Decision {
  if (!isObject(so)) throw new BrainError("structured_output is not an object");
  for (const key of ["evaluation_previous_goal", "memory", "next_goal"]) {
    if (typeof so[key] !== "string") throw new BrainError(`structured_output missing string field: ${key}`);
  }
  const raw = so.actions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BrainError("structured_output.actions must be a non-empty list");
  }
  const actions = raw.map((a: unknown): Action => {
    if (
      !isObject(a) || typeof a.cmd !== "string" || !Array.isArray(a.args)
      || !a.args.every((x) => typeof x === "string")
    ) {
      throw new BrainError(`malformed action: ${JSON.stringify(a)}`);
    }
    return { cmd: a.cmd, args: [...(a.args as string[])] };
  });
  return {
    evaluationPreviousGoal: so.evaluation_previous_goal as string,
    memory: so.memory as string,
    nextGoal: so.next_goal as string,
    actions,
  };
}

export interface BrainOptions {
  systemFiles: string[];
  model?: string;
  runner?: Runner;
  timeout?: number;
  snapshotDir?: string | null;
  signal?: AbortSignal;
}

export class Brain {
  readonly systemFiles: string[];
  readonly model: string;
  readonly runner: Runner;
  readonly timeout: number;
  readonly snapshotDir: string | null;
  readonly signal: AbortSignal | undefined;

  constructor(opts: BrainOptions) {
    this.systemFiles = opts.systemFiles;
    this.model = opts.model ?? "sonnet";
    this.runner = opts.runner ?? runProcess;
    this.snapshotDir = opts.snapshotDir ?? null;
    this.timeout = opts.timeout ?? (this.snapshotDir !== null ? TOOL_TIMEOUT : 60);
    this.signal = opts.signal;
  }

  argv(grep = true): string[] {
    const tools = this.snapshotDir === null || !grep
      ? ["--tools", ""]
      // --allowedTools takes several values, so a -- flag must follow it.
      : ["--tools", SNAPSHOT_TOOLS, "--allowedTools", SNAPSHOT_TOOLS, "--restricted"];
    const argv = [
      "claude", "-p", "--output-format", "json", ...tools,
      "--strict-mcp-config", "--disable-slash-commands",
      "--no-session-persistence",
      "--model", this.model,
      "--json-schema", JSON.stringify(DECISION_SCHEMA),
    ];
    for (const f of this.systemFiles) {
      // In grep mode claude runs inside snapshotDir, so a relative path would miss.
      argv.push("--append-system-prompt-file", this.snapshotDir === null || !grep ? f : path.resolve(f));
    }
    return argv;
  }

  /** grep=false runs this one call without tools, for a step whose snapshot is pasted. */
  async decide(prompt: string, grep = true): Promise<[Decision, number]> {
    const res = this.snapshotDir === null || !grep
      ? await this.runner(this.argv(false), prompt, this.timeout, { signal: this.signal })
      : await this.runner(this.argv(), prompt, this.timeout, {
        cwd: path.resolve(this.snapshotDir), signal: this.signal,
      });
    if (res.code === -1) throw new BrainError("timeout");
    if (res.code !== 0) throw new BrainError(res.stderr.trim() || `claude exited ${res.code}`);
    let env: unknown;
    try {
      env = JSON.parse(res.stdout);
    } catch (e) {
      throw new BrainError(`non-JSON output: ${(e as Error).message}`);
    }
    if (!isObject(env)) throw new BrainError("envelope is not an object");
    const rawCost = env.total_cost_usd;
    const cost = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;
    try {
      if (env.is_error) throw new BrainError(`claude error: ${env.result || "unknown"}`);
      const so = env.structured_output;
      if (so === undefined || so === null) throw new BrainError("missing structured_output");
      return [parseDecision(so), cost];
    } catch (e) {
      if (e instanceof BrainError) e.cost = cost;
      throw e;
    }
  }
}

/** What the agent loop needs from a brain. */
export type DecideFn = Pick<Brain, "decide">;
