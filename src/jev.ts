import { AbortedError } from "./proc.ts";

export type { JevRecord } from "./brain.ts";

// ---- Target extraction ----

export interface Target {
  ref: string;
  role: string;
  name: string;
}

export const TARGET_ROLES = ["link", "button", "checkbox", "radio", "tab", "menuitem", "option"] as const;
export const MAX_TARGETS = 255;

const LINE_RE = /^\s*- (\w+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*):?\s*$/;

/** Clickable elements of a snapshot, in order, with their refs. */
export function extractTargets(snapshot: string): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const line of snapshot.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const role = m[1];
    if (!(TARGET_ROLES as readonly string[]).includes(role)) continue;
    const attrs = m[3] ?? "";
    const ref = /\[ref=([^\]]+)\]/.exec(attrs)?.[1];
    if (!ref || seen.has(ref)) continue;
    const name = (m[2] ?? "").replace(/\\(["\\])/g, "$1");
    if (name === "" && !attrs.includes("[cursor=pointer]")) continue;
    seen.add(ref);
    out.push({ ref, role, name });
  }
  return out;
}

// ---- HTTP client ----

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 10_000;
export const JEV_RETRY_DELAYS_MS = [1000, 3000];
export const JEV_INPUT_USD_PER_TOKEN = 42e-9;
// Conservative placeholder: no output price is published, so assume the input price.
export const JEV_OUTPUT_USD_PER_TOKEN = 42e-9;

export class JevAuthError extends Error {
  constructor() {
    super("invalid TYPESAFE_API_KEY");
    this.name = "JevAuthError";
  }
}

export class JevError extends Error {
  cost: number;
  constructor(msg: string, cost = 0) {
    super(msg);
    this.name = "JevError";
    this.cost = cost;
  }
}

export interface JevQuestion {
  type: "choice";
  question: string;
  criteria: Record<string, string>;
}

export interface JevAnswer {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export type JevTransport = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type JevSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultTransport: JevTransport = async (url, init) => {
  const r = await globalThis.fetch(url, init);
  return { status: r.status, text: () => r.text() };
};

const defaultSleep: JevSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class JevClient {
  readonly apiKey: string;
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly transport: JevTransport;
  private readonly sleep: JevSleep;
  private readonly signal?: AbortSignal;

  constructor(o: {
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    transport?: JevTransport;
    sleep?: JevSleep;
    signal?: AbortSignal;
  }) {
    this.apiKey = o.apiKey;
    this.model = o.model ?? JEV_MODEL;
    this.timeoutMs = o.timeoutMs ?? JEV_TIMEOUT_MS;
    this.transport = o.transport ?? defaultTransport;
    this.sleep = o.sleep ?? defaultSleep;
    this.signal = o.signal;
  }

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<[Record<string, JevAnswer>, number]> {
    const body = JSON.stringify({ model: this.model, state, questions });
    const headers = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
    const attempts = JEV_RETRY_DELAYS_MS.length + 1;
    for (let i = 0; i < attempts; i++) {
      if (this.signal?.aborted) throw new AbortedError();
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = AbortSignal.any(this.signal ? [timeout, this.signal] : [timeout]);
      let res: { status: number; text(): Promise<string> };
      let text: string;
      try {
        res = await this.transport(JEV_URL, { method: "POST", headers, body, signal });
        text = await res.text();
      } catch (e) {
        if (this.signal?.aborted) throw new AbortedError();
        const err = e as Error;
        if (timeout.aborted || err?.name === "TimeoutError") {
          throw new JevError(`jev timeout after ${this.timeoutMs / 1000}s`);
        }
        throw new JevError(`jev network error: ${err?.message ?? String(e)}`);
      }
      const status = res.status;
      if (status === 401) throw new JevAuthError();
      if (status === 429 || status === 529) {
        if (i < attempts - 1) {
          await this.sleep(JEV_RETRY_DELAYS_MS[i], this.signal);
          if (this.signal?.aborted) throw new AbortedError();
          continue;
        }
        throw new JevError(`jev http ${status} after ${attempts} attempts`);
      }
      if (status === 422) {
        throw new JevError(`jev http 422: ${text.replace(/\s+/g, " ").trim().slice(0, 200)}`);
      }
      if (status < 200 || status >= 300) throw new JevError(`jev http ${status}`);
      return this.parse(text, questions);
    }
    throw new JevError("jev http: no attempts"); // unreachable
  }

  private parse(text: string, questions: Record<string, JevQuestion>): [Record<string, JevAnswer>, number] {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new JevError("jev malformed response: not JSON");
    }
    if (!isObj(data)) throw new JevError("jev malformed response: not JSON");
    const u = data.usage;
    if (
      !isObj(u) ||
      typeof u.input_tokens !== "number" ||
      typeof u.output_tokens !== "number" ||
      !Number.isFinite(u.input_tokens) ||
      !Number.isFinite(u.output_tokens)
    ) {
      throw new JevError("jev malformed response: bad usage");
    }
    const cost = u.input_tokens * JEV_INPUT_USD_PER_TOKEN + u.output_tokens * JEV_OUTPUT_USD_PER_TOKEN;
    const answers = isObj(data.answers) ? data.answers : {};
    const out: Record<string, JevAnswer> = {};
    for (const id of Object.keys(questions)) {
      const a = answers[id];
      if (!isObj(a)) throw new JevError(`jev malformed response: missing answer "${id}"`, cost);
      if (typeof a.choice !== "string" || !Object.keys(questions[id].criteria).includes(a.choice)) {
        throw new JevError(`jev malformed response: bad choice for "${id}"`, cost);
      }
      if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
        throw new JevError(`jev malformed response: bad confidence for "${id}"`, cost);
      }
      out[id] = a as unknown as JevAnswer;
    }
    return [out, cost];
  }
}
