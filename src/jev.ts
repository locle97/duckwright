import { BrainError } from "./brain.ts";
import type { Action, DecideFn, Decision, JevRecord, StepInput } from "./brain.ts";
import { AbortedError } from "./proc.ts";

export type { JevRecord } from "./brain.ts";

// ---- Target extraction ----

export interface Target {
  ref: string;
  role: string;
  name: string;
  /** Visible text of the item the element sits in (price, stock, ...), when the snapshot has any. */
  context?: string;
}

export const TARGET_ROLES = ["link", "button", "checkbox", "radio", "tab", "menuitem", "option"] as const;
export const MAX_TARGETS = 255;

const LINE_RE = /^\s*- (\w+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*):?\s*$/;

const CONTAINER_ROLES = new Set(["listitem", "article", "row", "treeitem", "group", "figure"]);
const INLINE_TEXT_RE = /^\s*- (?:text|\w+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*): (.+)$/;
export const MAX_CONTEXT_CHARS = 100;
const MAX_CLIMB = 4;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const roleOf = (line: string): string => /^\s*- (\w+)/.exec(line)?.[1] ?? "";

/** Inline text of the lines nested under `lines[i]`, skipping nested containers and the lines in `skip`. */
function textUnder(lines: string[], i: number, skip?: { from: number; to: number }): string {
  const base = indentOf(lines[i]);
  const parts: string[] = [];
  let nested = -1; // indent of the nested container being skipped
  for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > base); j++) {
    if (skip && j >= skip.from && j < skip.to) continue;
    const ind = indentOf(lines[j]);
    if (nested >= 0 && ind > nested) continue;
    nested = CONTAINER_ROLES.has(roleOf(lines[j])) ? ind : -1;
    if (nested >= 0) continue;
    const text = INLINE_TEXT_RE.exec(lines[j])?.[1]?.replace(/[^\p{L}\p{N}\p{Sc}\p{P} ]/gu, "").trim();
    if (text && !text.startsWith("/") && !parts.includes(text)) parts.push(text);
  }
  return parts.join(" · ");
}

function subtreeEnd(lines: string[], i: number): number {
  const base = indentOf(lines[i]);
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > base)) j++;
  return j;
}

/** Text shown in the item that holds the element on line `i`, so options with alike names can be told apart. */
function contextOf(lines: string[], i: number): string {
  let indent = indentOf(lines[i]);
  for (let j = i - 1, climbed = 0; j >= 0 && climbed < MAX_CLIMB; j--) {
    if (lines[j].trim() === "" || indentOf(lines[j]) >= indent) continue;
    indent = indentOf(lines[j]);
    climbed++;
    if (!CONTAINER_ROLES.has(roleOf(lines[j]))) continue;
    const text = textUnder(lines, j, { from: i, to: subtreeEnd(lines, i) });
    return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS - 1) + "…" : text;
  }
  return "";
}

/** URL of the current tab in `playwright-cli tab-list` output, or null. */
export function currentTabUrl(tabs: string): string | null {
  const line = tabs.split("\n").find((l) => l.includes("(current)"));
  return line ? (/\]\((\S+)\)\s*$/.exec(line)?.[1] ?? null) : null;
}

/** Whether the link on line `i` points at the page the browser is already on. */
function linksToCurrentPage(lines: string[], i: number, pageUrl: string): boolean {
  const href = /^\s*- \/url: (.+)$/.exec(lines[i + 1] ?? "")?.[1]?.trim();
  if (!href) return false;
  try {
    return new URL(href, pageUrl).href === new URL(pageUrl).href;
  } catch {
    return false;
  }
}

/** Clickable elements of a snapshot, in order, with their refs. Links back to `pageUrl` are left out. */
export function extractTargets(snapshot: string, pageUrl?: string | null): Target[] {
  return scanTargets(snapshot, pageUrl).map((x) => x.target);
}

/** extractTargets, plus each target's link url as the snapshot writes it ("" when it has none). */
function scanTargets(snapshot: string, pageUrl?: string | null): { target: Target; href: string }[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  const lines = snapshot.split("\n");
  const hrefs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const role = m[1];
    if (!(TARGET_ROLES as readonly string[]).includes(role)) continue;
    const attrs = m[3] ?? "";
    const ref = /\[ref=([^\]]+)\]/.exec(attrs)?.[1];
    if (!ref || seen.has(ref)) continue;
    let name = (m[2] ?? "").replace(/\\(["\\])/g, "$1");
    if (name === "" && !attrs.includes("[cursor=pointer]")) continue;
    if (pageUrl && role === "link" && linksToCurrentPage(lines, i, pageUrl)) continue;
    if (name === "") name = textUnder(lines, i); // e.g. a link whose label is a nested <strong>
    seen.add(ref);
    const context = contextOf(lines, i);
    out.push(context ? { ref, role, name, context } : { ref, role, name });
    hrefs.push(/^\s*- \/url: (.+)$/.exec(lines[i + 1] ?? "")?.[1]?.trim() ?? "");
  }
  // An unnamed link (a cover image) to the same place as a named one only splits Jev's vote.
  const named = new Set(out.flatMap((t, k) => (t.name !== "" && hrefs[k] ? [hrefs[k]] : [])));
  return out.flatMap((t, k) =>
    t.name === "" && t.role === "link" && hrefs[k] && named.has(hrefs[k]) ? [] : [{ target: t, href: hrefs[k] }]
  );
}

export const MAX_HREF_CHARS = 80;

export interface Candidate {
  target: Target;
  /** What Jev reads for this target. */
  description: string;
}

/**
 * The target list offered to Jev. Links with the same role, name and url lead to the same place
 * (a tag in a sidebar and under every item), so they become one candidate instead of splitting Jev's
 * vote; each link also shows where it leads, which tells look-alike labels apart.
 */
export function targetCandidates(snapshot: string, pageUrl?: string | null): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const { target, href } of scanTargets(snapshot, pageUrl)) {
    let description = targetDescription(target);
    if (target.role === "link" && href) {
      const key = JSON.stringify([target.role, target.name, href]);
      if (seen.has(key)) continue;
      seen.add(key);
      description += ` -> ${href.length > MAX_HREF_CHARS ? href.slice(0, MAX_HREF_CHARS - 1) + "…" : href}`;
    }
    out.push({ target, description });
  }
  return out;
}

/**
 * What Jev should work on now: Claude's latest goal and its progress notes. Null when there is no
 * goal (the previous step was Jev's own, so goal and notes may be stale), then the whole task is used.
 * A whole multi-part task leaves Jev unsure which part it is on, spreading its vote over every
 * element the task names; the current goal plus progress pins down the part at hand.
 */
export function currentFocus(ctx: { memory: string; goal?: string }): string | null {
  const goal = ctx.goal?.trim() ?? "";
  return goal === "" ? null : [goal, ctx.memory.trim()].filter((s) => s !== "").join("\n");
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
      !Number.isFinite(u.output_tokens) ||
      u.input_tokens < 0 ||
      u.output_tokens < 0
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

// ---- Hybrid routing ----

export const ACTION_QUESTION = "Which single next move best advances the task on this page?";
export const TARGET_QUESTION = "Which element should that move act on?";

export const ACTION_OPTIONS: Readonly<
  Record<string, { description: string; cmd: string | null; args: readonly string[]; target: boolean }>
> = {
  click: {
    description: "Click one element on the page: a link, button, tab, menu item or option.",
    cmd: "click", args: [], target: true,
  },
  check: {
    description: "Tick a checkbox or select a radio button that is not checked yet.",
    cmd: "check", args: [], target: true,
  },
  uncheck: { description: "Untick a checkbox that is checked.", cmd: "uncheck", args: [], target: true },
  hover: { description: "Hover over one element to reveal a menu or tooltip.", cmd: "hover", args: [], target: true },
  press_enter: {
    description: "Press the Enter key, for example to submit the focused form.",
    cmd: "press", args: ["Enter"], target: false,
  },
  press_tab: {
    description: "Press the Tab key to move the focus to the next field.",
    cmd: "press", args: ["Tab"], target: false,
  },
  press_escape: {
    description: "Press the Escape key to close a dialog or menu.",
    cmd: "press", args: ["Escape"], target: false,
  },
  go_back: {
    description: "Go back to the previous page in the browser history.",
    cmd: "go-back", args: [], target: false,
  },
  needs_text: {
    description:
      "The next move needs typed text: open a URL, fill or type into a field, pick a select value, or anything not listed here.",
    cmd: null, args: [], target: false,
  },
  done: {
    description:
      "Every part of the task has already been carried out on pages already visited, including opening any page the task says to open, and nothing is left to click. Or the task cannot be completed.",
    cmd: null, args: [], target: false,
  },
};

export function targetDescription(t: Target): string {
  const base = t.name === "" ? `${t.role} (no name)` : `${t.role} "${t.name}"`;
  return t.context ? `${base} (${t.context})` : base;
}

export class HybridBrain implements DecideFn {
  readonly jev: Pick<JevClient, "ask">;
  readonly claude: DecideFn;
  readonly minConfidence: number;

  constructor(o: { jev: Pick<JevClient, "ask">; claude: DecideFn; minConfidence?: number }) {
    this.jev = o.jev;
    this.claude = o.claude;
    this.minConfidence = o.minConfidence ?? 0.8;
  }

  async decide(prompt: string, grep = true, step?: StepInput): Promise<[Decision, number]> {
    const viaClaude = async (record: JevRecord | null, jevCost: number): Promise<[Decision, number]> => {
      try {
        const [d, c] = await this.claude.decide(prompt, grep);
        return [{ ...d, source: "claude", jev: record }, jevCost + c];
      } catch (e) {
        if (e instanceof BrainError) {
          e.cost += jevCost;
          if (record) e.jev = record;
        }
        throw e;
      }
    };

    if (!step || step.ctx.step === 1 || step.ctx.nudged || step.ctx.previousFailed) return viaClaude(null, 0);
    const pageUrl = currentTabUrl(step.obs.tabs);
    const candidates = targetCandidates(step.obs.snapshot, pageUrl);
    if (candidates.length === 0 || candidates.length > MAX_TARGETS) return viaClaude(null, 0);

    const { ctx, obs } = step;
    const criteria: Record<string, string> = {};
    for (const [id, o] of Object.entries(ACTION_OPTIONS)) criteria[id] = o.description;
    const targetCriteria: Record<string, string> = {};
    for (const c of candidates) targetCriteria[c.target.ref] = c.description;

    // Jev reads `state.task` as what to do now; the whole task still frames the action question.
    const task = currentFocus(ctx) ?? ctx.task;
    let answers: Record<string, JevAnswer>;
    let jevCost: number;
    try {
      [answers, jevCost] = await this.jev.ask(
        { task, memory: ctx.memory, history: ctx.historyLines, tabs: obs.tabs, snapshot: obs.snapshot },
        {
          action: { type: "choice", question: `${ACTION_QUESTION}\n\nTask: ${ctx.task}`, criteria },
          target: { type: "choice", question: TARGET_QUESTION, criteria: targetCriteria },
        },
      );
    } catch (e) {
      if (e instanceof JevError) {
        return viaClaude(
          { action: null, action_confidence: null, target: null, target_confidence: null, routed: `error: ${e.message}` },
          e.cost,
        );
      }
      throw e;
    }

    const a = answers.action;
    const t = answers.target;
    const opt = ACTION_OPTIONS[a.choice];
    const record: JevRecord = {
      action: a.choice,
      action_confidence: a.confidence,
      target: t.choice,
      target_confidence: t.confidence,
      routed: "accepted",
    };
    const target = candidates.find((c) => c.target.ref === t.choice)?.target;
    if (a.choice === "needs_text" || a.choice === "done") {
      record.routed = a.choice;
    } else if (a.confidence < this.minConfidence || (opt.target && (!target || t.confidence < this.minConfidence))) {
      record.routed = "low_confidence";
    }
    if (record.routed !== "accepted") return viaClaude(record, jevCost);

    let action: Action;
    let conf = a.confidence;
    let goal: string;
    if (opt.target) {
      action = { cmd: opt.cmd!, args: [target!.ref] };
      conf = Math.min(conf, t.confidence);
      goal = `jev: ${a.choice} ${targetDescription(target!)} (${conf.toFixed(2)})`;
    } else {
      action = { cmd: opt.cmd!, args: [...opt.args] };
      goal = `jev: ${a.choice} (${conf.toFixed(2)})`;
    }
    return [
      { evaluationPreviousGoal: "", memory: ctx.memory, nextGoal: goal, actions: [action], source: "jev", jev: record },
      jevCost,
    ];
  }
}
