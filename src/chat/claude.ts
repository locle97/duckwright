// The claude process behind a chat turn: its argv, its stream-json output, and the spawner.
import { spawn } from "node:child_process";
import { constants } from "node:os";

import { escapeCommandForCmd, isBatchFile, quoteForCmd, which } from "../which.ts";

export interface ClaudeTurn {
  prompt: string;
  model: string;
  resume: string | null;
  cwd: string;          // the Duckwright root
  skillsDir: string;    // <package>/skills
  systemPrompt: string;
  mcpUrl: string;
  mcpToken: string;
}

/** Edit(...) rules also cover the Write tool; there is no bare Bash. */
export const ALLOWED_TOOLS = (skillsDir: string): string[] => [
  "Read", "Grep", "Glob",
  "Edit(tasks/**)", "Edit(.duckwright/**)", "Edit(environments/**)", "Edit(CLAUDE.md)",
  `Bash(node ${skillsDir}/*:*)`,
  "Bash(duckwright check:*)", "Bash(duckwright explore:*)",
  "Bash(npx playwright test:*)", "Bash(npx tsc:*)",
  "Bash(npm run lint:*)", "Bash(npm run typecheck:*)",
  "Bash(npx eslint:*)", "Bash(npx prettier:*)",
  // The Playwright phase.
  "Edit(**/*.spec.ts)", "Edit(**/*.spec.js)",
  "mcp__duckwright__*",
];

export function claudeArgv(t: ClaudeTurn): string[] {
  const mcp = {
    mcpServers: {
      duckwright: { type: "http", url: t.mcpUrl, headers: { Authorization: `Bearer ${t.mcpToken}` } },
    },
  };
  return [
    "claude", "-p", t.prompt, "--output-format", "stream-json", "--verbose", "--model", t.model,
    ...(t.resume !== null ? ["--resume", t.resume] : []),
    "--tools", "Read,Grep,Glob,Write,Edit,Bash",
    // --allowedTools takes several values, so a -- flag must follow it.
    "--allowedTools", ...ALLOWED_TOOLS(t.skillsDir),
    "--add-dir", t.skillsDir,
    "--append-system-prompt", t.systemPrompt,
    "--mcp-config", JSON.stringify(mcp),
    "--strict-mcp-config",
  ];
}

export type StreamItem =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "result"; sessionId: string; costUsd: number; isError: boolean; text: string };

const SUMMARY_MAX = 120;
const MCP_PREFIX = "mcp__duckwright__";

function summarize(name: string, input: Record<string, unknown>): string {
  let s = "";
  if (name.startsWith(MCP_PREFIX)) s = name.slice(MCP_PREFIX.length);
  else if (name === "Bash") s = String(input.command ?? "");
  else if (name === "Read" || name === "Edit" || name === "Write") s = String(input.file_path ?? "");
  return s.slice(0, SUMMARY_MAX);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** One stream-json line to zero or more items; blank, non-JSON and uninteresting lines give []. */
export function parseStreamLine(line: string): StreamItem[] {
  if (line.trim() === "") return [];
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(j)) return [];
  if (j.type === "system" && j.subtype === "init" && typeof j.session_id === "string") {
    return [{ kind: "init", sessionId: j.session_id }];
  }
  if (j.type === "assistant" && isObj(j.message) && Array.isArray(j.message.content)) {
    const out: StreamItem[] = [];
    for (const b of j.message.content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string") out.push({ kind: "text", text: b.text });
      else if (b.type === "tool_use" && typeof b.name === "string") {
        out.push({ kind: "tool", name: b.name, summary: summarize(b.name, isObj(b.input) ? b.input : {}) });
      }
    }
    return out;
  }
  if (j.type === "result") {
    return [{
      kind: "result",
      sessionId: typeof j.session_id === "string" ? j.session_id : "",
      costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0,
      isError: j.is_error === true,
      text: typeof j.result === "string" ? j.result : "",
    }];
  }
  return [];
}

export interface ClaudeProcess {
  done: Promise<{ code: number; stderr: string }>;
  kill(): void;
}

export type ClaudeSpawner = (argv: string[], cwd: string, onLine: (line: string) => void) => ClaudeProcess;

/** Real spawner: argv list only, never a shell; stdin ignored. */
export const spawnClaude: ClaudeSpawner = (argv, cwd, onLine) => {
  // Windows starts only .exe by name; resolve npm's .cmd shims through PATHEXT.
  const exe = process.platform === "win32" ? which(argv[0]) ?? argv[0] : argv[0];
  const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
  const child = process.platform === "win32" && isBatchFile(exe)
    ? spawn(process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `"${[escapeCommandForCmd(exe), ...argv.slice(1).map(quoteForCmd)].join(" ")}"`],
      { cwd, stdio, windowsVerbatimArguments: true })
    : spawn(exe, argv.slice(1), { cwd, stdio });
  let tail = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    tail += chunk;
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const l of lines) onLine(l);
  });
  const err: Buffer[] = [];
  child.stderr.on("data", (b: Buffer) => err.push(b));
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    const stderr = () => Buffer.concat(err).toString("utf8");
    child.on("error", (e) => resolve({ code: -1, stderr: e.message }));
    child.on("close", (code, sig) => {
      if (tail !== "") onLine(tail);
      tail = "";
      resolve({ code: code ?? -(sig ? constants.signals[sig] : 1), stderr: stderr() });
    });
  });
  return { done, kill: () => { child.kill("SIGTERM"); } };
};
