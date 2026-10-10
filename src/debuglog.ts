// Debug mode: a human-readable log of every Claude call (and, with Jev, every request) of one run.
import fs from "node:fs";
import path from "node:path";

import type { RunEvents } from "./events.ts";
import { JEV_INPUT_USD_PER_TOKEN, JEV_OUTPUT_USD_PER_TOKEN } from "./jev.ts";
import type { JevTransport, RouteInfo } from "./jev.ts";
import type { ProcResult, Runner } from "./proc.ts";
import { REDACTED, redactHeaders, redactText } from "./redact.ts";
import type { Header } from "./redact.ts";
import { fixed4 } from "./text.ts";

export interface ClaudeCallInfo {
  argv: string[];
  cwd?: string;
  stdin: string | null;
  /** Set when the runner returned. */
  result?: ProcResult;
  /** Set when the runner threw. */
  error?: unknown;
  wallSec: number;
}

export interface JevRequestInfo {
  method: string;
  url: string;
  headers: Header[];
  body: string;
  status?: number;
  text?: string;
  error?: unknown;
  wallSec: number;
}

export interface DebugLogOptions {
  runId: string;
  file: string;
  console?: (text: string) => void;
  secrets?: string[];
  scrub?: (text: string) => string;
  readFile?: (p: string) => string;
  now?: () => number;
  onWarning?: (m: string) => void;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** The prompt's parts in order: the first line (`header`), each `<tag>` block, any other text (`other`), then `total`. */
export function promptSections(prompt: string): { name: string; chars: number }[] {
  const out: { name: string; chars: number }[] = [];
  const nl = prompt.indexOf("\n");
  const first = nl === -1 ? prompt : prompt.slice(0, nl);
  out.push({ name: "header", chars: first.length });
  let rest = nl === -1 ? "" : prompt.slice(nl + 1);
  const open = /^\s*<([a-z_]+)>\n/;
  while (rest.trim() !== "") {
    const m = open.exec(rest);
    const tag = m?.[1];
    const close = tag === undefined ? -1 : rest.indexOf(`\n</${tag}>`, m![0].length - 1);
    if (m && tag !== undefined && close !== -1) {
      const start = m[0].indexOf("<");
      const end = close + `\n</${tag}>`.length;
      out.push({ name: tag, chars: end - start });
      rest = rest.slice(end);
    } else {
      // Text up to the next tag block (or the end) that belongs to no section.
      const next = rest.slice(1).search(/\n<[a-z_]+>\n/);
      const stop = next === -1 ? rest.length : next + 1;
      const text = rest.slice(0, stop);
      if (text.trim() !== "") out.push({ name: "other", chars: text.trim().length });
      rest = rest.slice(stop);
    }
  }
  out.push({ name: "total", chars: prompt.length });
  return out;
}

const num = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? String(x) : "n/a");
const cost = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? fixed4(x) : "n/a");
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const errText = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : `${typeof e}: ${String(e)}`;

export class DebugLog {
  readonly #o: DebugLogOptions;
  readonly #file: string;
  #step = 0;
  #fileOk = true;
  #systemWritten = false;
  #files = new Map<string, { bytes: number; text: string }>();

  #claude = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, missing: 0 };
  #jev = { requests: 0, retries: 0, input: 0, output: 0, cost: 0 };
  #routes = { accepted: 0, low_confidence: 0, error: 0, needs_text: 0, done: 0, skipped: 0 };
  #routeCount = 0;
  #jevK = 0;

  constructor(o: DebugLogOptions) {
    this.#o = o;
    this.#file = path.resolve(o.file);
    this.write(`===== [debug ${o.runId}] run =====\nlog: ${this.#file}\n\n`);
  }

  now(): number {
    return (this.#o.now ?? Date.now)();
  }

  attach(events: RunEvents): void {
    try {
      events.subscribe((e) => {
        try {
          if (e.type === "step:start") {
            this.#step = e.step;
            this.#jevK = 0;
          }
          else if (e.type === "run:end") this.#summary();
        } catch {
          // logging must never affect the run
        }
      });
    } catch {
      // ignore
    }
  }

  #redact(text: string): string {
    let out = text;
    for (const s of this.#o.secrets ?? []) if (s !== "") out = out.split(s).join(REDACTED);
    if (this.#o.scrub) out = this.#o.scrub(out);
    return redactText(out);
  }

  write(block: string): void {
    let text: string;
    try {
      text = this.#redact(block);
    } catch {
      return; // never write what could not be redacted
    }
    if (this.#fileOk) {
      try {
        fs.appendFileSync(this.#file, text, "utf8");
      } catch (e) {
        this.#fileOk = false;
        try {
          this.#o.onWarning?.(`debug log: cannot write ${this.#file}: ${e instanceof Error ? e.message : String(e)}`);
        } catch {
          // ignore
        }
      }
    }
    try {
      this.#o.console?.(text);
    } catch {
      // ignore
    }
  }

  #block(title: string, body: string): string {
    return `===== [debug ${this.#o.runId}] ${title} =====\n${body.endsWith("\n") ? body : body + "\n"}\n`;
  }

  #fileInfo(p: string): { bytes: number; text: string } {
    let info = this.#files.get(p);
    if (!info) {
      try {
        const text = (this.#o.readFile ?? ((q: string) => fs.readFileSync(q, "utf8")))(p);
        info = { bytes: Buffer.byteLength(text), text };
      } catch (e) {
        info = { bytes: 0, text: `(cannot read: ${e instanceof Error ? e.message : String(e)})` };
      }
      this.#files.set(p, info);
    }
    return info;
  }

  claudeCall(info: ClaudeCallInfo): void {
    try {
      const files: string[] = [];
      info.argv.forEach((a, i) => {
        if (a === "--append-system-prompt-file" && i + 1 < info.argv.length) files.push(info.argv[i + 1]);
      });
      if (!this.#systemWritten) {
        this.#systemWritten = true;
        const body = files
          .map((p) => {
            const f = this.#fileInfo(p);
            return `----- ${p} (${f.bytes} bytes) -----\n${f.text}`;
          })
          .join("\n");
        this.write(this.#block("system prompts", body));
      }
      const prompt = info.stdin ?? "";
      const lines: string[] = [
        `argv: ${JSON.stringify(info.argv)}`,
        `cwd: ${info.cwd ?? "(inherited)"}`,
        `mode: ${info.argv.includes("--restricted") ? "grep" : "paste"}`,
        "system prompt files:",
        ...files.map((p) => `  ${p} (${this.#fileInfo(p).bytes} bytes)`),
        "prompt sections:",
        ...promptSections(prompt).map((s) =>
          `  ${s.name.padEnd(18)}  ${s.chars} chars  ~${estimateTokens(s.chars)} tokens (est.)`),
        "----- prompt (stdin) -----",
        prompt.endsWith("\n") ? prompt.slice(0, -1) : prompt,
        "----- response -----",
      ];
      this.#claude.calls++;
      if (info.result === undefined) {
        lines.push(`error: ${errText(info.error)}`);
        this.#claude.missing++;
        this.write(this.#block(`step ${this.#step} · claude`, lines.join("\n")));
        return;
      }
      const r = info.result;
      lines.push(`exit: ${r.code}${r.code === -1 ? " (timeout)" : ""}  wall: ${info.wallSec.toFixed(2)}s`);
      let env: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(r.stdout);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) env = parsed as Record<string, unknown>;
      } catch {
        // raw stdout is printed instead
      }
      lines.push(env ? JSON.stringify(env, null, 2) : r.stdout);
      if (r.stderr !== "") lines.push("----- stderr -----", r.stderr);
      const usage = (env?.usage ?? {}) as Record<string, unknown>;
      const fields = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
      if (!fields.every(isNum)) this.#claude.missing++;
      const t = this.#claude;
      if (isNum(fields[0])) t.input += fields[0];
      if (isNum(fields[1])) t.output += fields[1];
      if (isNum(fields[2])) t.cacheRead += fields[2];
      if (isNum(fields[3])) t.cacheWrite += fields[3];
      if (isNum(env?.total_cost_usd)) t.cost += env.total_cost_usd;
      lines.push(
        "----- usage -----",
        `input tokens: ${num(fields[0])}  output tokens: ${num(fields[1])}  cache read: ${num(fields[2])}  cache write: ${num(fields[3])}`,
        `cost: $${cost(env?.total_cost_usd)}  duration_ms: ${num(env?.duration_ms)}  duration_api_ms: ${num(env?.duration_api_ms)}`,
      );
      this.write(this.#block(`step ${this.#step} · claude`, lines.join("\n")));
    } catch {
      // logging must never affect the run
    }
  }

  jevRequest(info: JevRequestInfo): void {
    try {
      this.#jevK++;
      this.#jev.requests++;
      if (this.#jevK > 1) this.#jev.retries++;
      const pretty = (s: string): string => {
        try {
          return JSON.stringify(JSON.parse(s), null, 2);
        } catch {
          return s;
        }
      };
      const lines = [
        `POST ${info.url}`,
        `headers: ${redactHeaders(info.headers).map((h) => `${h.name}: ${h.value}`).join(", ")}`,
        "----- request body -----",
        pretty(info.body),
        "----- response -----",
      ];
      if (info.text === undefined) {
        lines.push(`error: ${errText(info.error)}`);
      } else {
        lines.push(`status: ${info.status}  wall: ${info.wallSec.toFixed(2)}s`, pretty(info.text));
        let data: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(info.text);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
        } catch {
          // raw text printed above
        }
        const u = (data?.usage ?? {}) as Record<string, unknown>;
        const inTok = u.input_tokens;
        const outTok = u.output_tokens;
        if (isNum(inTok)) this.#jev.input += inTok;
        if (isNum(outTok)) this.#jev.output += outTok;
        let c: number | undefined;
        if (isNum(inTok) && isNum(outTok)) {
          c = inTok * JEV_INPUT_USD_PER_TOKEN + outTok * JEV_OUTPUT_USD_PER_TOKEN;
          this.#jev.cost += c;
        }
        lines.push("----- usage -----", `input tokens: ${num(inTok)}  output tokens: ${num(outTok)}  cost: $${cost(c)}`);
        const answers = data?.answers;
        if (answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
          const rows: string[] = [];
          for (const [id, a] of Object.entries(answers as Record<string, unknown>)) {
            const o = a as Record<string, unknown> | null;
            if (o && typeof o === "object" && typeof o.choice === "string" && isNum(o.confidence)) {
              rows.push(`  ${id}: ${o.choice} (confidence ${o.confidence.toFixed(3)})`);
            }
          }
          if (rows.length > 0) lines.push("answers:", ...rows);
        }
      }
      this.write(this.#block(`step ${this.#step} · jev request ${this.#jevK}`, lines.join("\n")));
    } catch {
      // logging must never affect the run
    }
  }

  route(info: RouteInfo): void {
    try {
      this.#routes[info.outcome]++;
      this.#routeCount++;
      const body = `outcome: ${info.outcome}\nreason: ${info.reason}\nbrain: ${info.outcome === "accepted" ? "jev" : "claude"}`;
      this.write(this.#block(`step ${info.step} · route`, body));
    } catch {
      // logging must never affect the run
    }
  }

  #summary(): void {
    const c = this.#claude;
    const lines = [
      `claude: ${c.calls} calls  input ${c.input}  output ${c.output}  cache read ${c.cacheRead}  cache write ${c.cacheWrite} tokens  cost $${fixed4(c.cost)}`
        + (c.missing ? `  (usage missing on ${c.missing} calls)` : ""),
    ];
    const j = this.#jev;
    if (j.requests > 0) {
      lines.push(`jev: ${j.requests} requests (${j.retries} retries)  input ${j.input}  output ${j.output} tokens  cost $${fixed4(j.cost)}`);
    }
    const r = this.#routes;
    if (this.#routeCount > 0) {
      lines.push(`routes: accepted ${r.accepted}  low_confidence ${r.low_confidence}  error ${r.error}  needs_text ${r.needs_text}  done ${r.done}  skipped ${r.skipped}`);
    }
    lines.push(`total cost: $${fixed4(c.cost + j.cost)}`);
    this.write(this.#block("summary", lines.join("\n")));
  }
}

export function debugRunner(inner: Runner, log: DebugLog): Runner {
  return async (argv, stdin, timeoutSec, opts) => {
    const t0 = log.now();
    let result: ProcResult;
    try {
      result = await inner(argv, stdin, timeoutSec, opts);
    } catch (error) {
      try {
        log.claudeCall({ argv, cwd: opts?.cwd, stdin, error, wallSec: (log.now() - t0) / 1000 });
      } catch {
        // ignore
      }
      throw error;
    }
    try {
      log.claudeCall({ argv, cwd: opts?.cwd, stdin, result, wallSec: (log.now() - t0) / 1000 });
    } catch {
      // ignore
    }
    return result;
  };
}

export function debugTransport(inner: JevTransport, log: DebugLog): JevTransport {
  return async (url, init) => {
    const t0 = log.now();
    const headers = Object.entries(init.headers).map(([name, value]) => ({ name, value }));
    const record = (extra: { status?: number; text?: string; error?: unknown }): void => {
      try {
        log.jevRequest({ method: init.method, url, headers, body: init.body, wallSec: (log.now() - t0) / 1000, ...extra });
      } catch {
        // ignore
      }
    };
    let status: number;
    let text: string;
    try {
      const res = await inner(url, init);
      status = res.status;
      text = await res.text();
    } catch (error) {
      record({ error });
      throw error;
    }
    record({ status, text });
    return { status, text: async () => text };
  };
}
