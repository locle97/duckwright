// Live chats: one `claude -p` process per turn, its stream turned into chat messages, person messages
// queued mid-turn, spend tracked against the ceiling, turns stopped, and each chat's MCP endpoint.
import crypto from "node:crypto";

import { redactText } from "../redact.ts";
import type { ManagerEvent, ManagerLike, TaskId } from "../runs/manager.ts";
import { newToken as defaultNewToken } from "../web/auth.ts";
import { claudeArgv, parseStreamLine } from "./claude.ts";
import type { ClaudeProcess, ClaudeSpawner, StreamItem } from "./claude.ts";
import { handleMcp } from "./mcp.ts";
import type { JsonRpc, McpHost } from "./mcp.ts";
import { ChatStore, isChatId } from "./store.ts";
import type { ChatEvent, ChatId, ChatMessage, ChatMeta, TurnState } from "./types.ts";
import { RunTracker } from "./tracker.ts";

export interface ChatSessionsOptions {
  root: string; manager: ManagerLike; store: ChatStore;
  spawn: ClaudeSpawner; skillsDir: string; systemPrompt: string;
  mcpUrl(chatId: ChatId): string;               // filled by the server once it knows its port
  defaultModel?: string;                         // "sonnet"
  defaultCeilingUsd?: number;                    // 5
  newToken?: () => string;                       // per-chat MCP token; default auth.ts newToken
}

type Ok = { ok: true } | { ok: false; error: string };

const TITLE_MAX = 60;
const MCP_PREFIX = "mcp__duckwright__";
const KILL_WAIT_MS = 5000;

interface Turn { gen: number; proc: ClaudeProcess; gotResult: boolean }

interface Session {
  meta: ChatMeta;
  turn: TurnState;
  current: Turn | null;
  gen: number;
  queue: string[];
  token: string | null;
  turnCostUsd: number; // spend that is not a run this session's tracker follows: agent turns, plus what was saved before
  titled: boolean;
  tracker: RunTracker | null;
  unsubscribe: (() => void) | null;
  twofa: Set<TaskId>; // owned tasks already announced as waiting for 2FA
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export class ChatSessions {
  #o: ChatSessionsOptions;
  #sessions = new Map<ChatId, Session>();
  #listeners = new Set<(e: ChatEvent) => void>();
  #newToken: () => string;

  constructor(o: ChatSessionsOptions) {
    this.#o = o;
    this.#newToken = o.newToken ?? defaultNewToken;
  }

  list(): Array<{ chat: ChatMeta; turn: TurnState }> {
    return this.#o.store.list().map((m) => {
      const s = this.#sessions.get(m.id);
      return s === undefined ? { chat: m, turn: "idle" as TurnState } : { chat: { ...s.meta }, turn: s.turn };
    }).sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);
  }

  open(id: ChatId): { chat: ChatMeta; turn: TurnState; messages: ChatMessage[] } | null {
    if (!isChatId(id)) return null;
    const loaded = this.#o.store.load(id);
    if (loaded === null) return null;
    const s = this.#sessions.get(id);
    return { chat: { ...(s?.meta ?? loaded.meta) }, turn: s?.turn ?? "idle", messages: loaded.messages };
  }

  create(o: { model?: string; ceilingUsd?: number } = {}): ChatMeta {
    const model = typeof o.model === "string" && o.model.trim() !== "" ? o.model.trim() : this.#o.defaultModel ?? "sonnet";
    const ceilingUsd = validCeiling(o.ceilingUsd) ? o.ceilingUsd : this.#o.defaultCeilingUsd ?? 5;
    const meta = this.#o.store.create({ model, ceilingUsd });
    this.#sessions.set(meta.id, this.#newSession(meta, false));
    this.#emit({ type: "chat:updated", chat: { ...meta }, turn: "idle" });
    return { ...meta };
  }

  send(id: ChatId, text: string, attachments: string[]): Ok {
    const s = this.#session(id);
    if (s === null) return { ok: false, error: "no such chat" };
    if (s.turn === "stopping") return { ok: false, error: "the chat is stopping" };
    if (text.trim() === "" && attachments.length === 0) return { ok: false, error: "the message is empty" };
    this.#append(s, { kind: "person", at: Date.now(), text, attachments: [...attachments] });
    if (!s.titled) {
      s.titled = true;
      const title = redactText(text.trim().replace(/\s+/g, " ")).slice(0, TITLE_MAX);
      s.meta.title = title !== "" ? title : attachments[0].slice(0, TITLE_MAX);
      this.#saveMeta(s);
    }
    const prompt = [text, attachments.length > 0 ? `Attached files: ${attachments.join(", ")}` : ""].filter((p) => p !== "").join("\n\n");
    if (s.turn === "running") s.queue.push(prompt);
    else this.#startTurn(s, prompt);
    return { ok: true };
  }

  async stop(id: ChatId): Promise<void> {
    const s = this.#session(id);
    if (s === null || s.turn === "stopping") return;
    s.turn = "stopping";
    this.#emitMeta(s);
    const cur = s.current;
    s.current = null;
    s.gen++; // anything the killed process still says or asks is ignored
    s.token = null;
    s.queue = [];
    if (cur !== null) {
      cur.proc.kill();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([cur.proc.done, new Promise((r) => { timer = setTimeout(r, KILL_WAIT_MS); })]);
      clearTimeout(timer);
    }
    if (s.tracker !== null) {
      const { tasks, plans } = s.tracker.owned();
      const live = new Map(this.#o.manager.list().map((t) => [t.id, t.state]));
      for (const t of tasks) {
        const state = live.get(t);
        if (state === "running" || state === "paused") this.#o.manager.stop(t);
      }
      for (const p of plans) this.#o.manager.stopPlan(p);
    }
    s.turn = "idle";
    this.#append(s, { kind: "activity", at: Date.now(), text: "Stopped" });
    this.#emitMeta(s);
  }

  update(id: ChatId, o: { model?: string; ceilingUsd?: number; title?: string }): Ok {
    const s = this.#session(id);
    if (s === null) return { ok: false, error: "no such chat" };
    if (o.ceilingUsd !== undefined && !validCeiling(o.ceilingUsd)) return { ok: false, error: "ceilingUsd must be a number ≥ 0" };
    if (o.model !== undefined && (typeof o.model !== "string" || o.model.trim() === "")) return { ok: false, error: "model must be a non-empty string" };
    if (o.title !== undefined && (typeof o.title !== "string" || o.title.trim() === "")) return { ok: false, error: "title must be a non-empty string" };
    if (o.ceilingUsd !== undefined) s.meta.ceilingUsd = o.ceilingUsd;
    if (o.model !== undefined) s.meta.model = o.model.trim();
    if (o.title !== undefined) {
      s.meta.title = redactText(o.title.trim());
      s.titled = true;
    }
    this.#saveMeta(s);
    return { ok: true };
  }

  async mcp(id: ChatId, bearer: string | null, msg: JsonRpc): Promise<{ status: number; body: object | null }> {
    const s = this.#session(id);
    if (s === null || s.token === null || bearer === null || !crypto.timingSafeEqual(sha(bearer), sha(s.token))) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    const body = await handleMcp(this.#host(s, s.gen), msg);
    return { status: body === null ? 202 : 200, body };
  }

  subscribe(fn: (e: ChatEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  async stopAll(): Promise<void> {
    const all = [...this.#sessions.values()];
    await Promise.all(all.filter((s) => s.turn === "running").map((s) => this.stop(s.meta.id)));
    for (const s of all) {
      s.unsubscribe?.();
      s.unsubscribe = null;
      s.tracker?.close();
      s.tracker = null;
    }
  }

  #newSession(meta: ChatMeta, titled: boolean): Session {
    return {
      meta, turn: "idle", current: null, gen: 0, queue: [], token: null, turnCostUsd: meta.spentUsd,
      titled, tracker: null, unsubscribe: null, twofa: new Set(),
    };
  }

  /** The live session for a valid, existing chat, loaded from disk on first use. */
  #session(id: ChatId): Session | null {
    if (!isChatId(id)) return null;
    const known = this.#sessions.get(id);
    if (known !== undefined) return known;
    const loaded = this.#o.store.load(id);
    if (loaded === null) return null;
    const s = this.#newSession(loaded.meta, loaded.meta.title !== "New chat" || loaded.messages.some((m) => m.kind === "person"));
    this.#sessions.set(id, s);
    return s;
  }

  #tracker(s: Session): RunTracker {
    if (s.tracker !== null) return s.tracker;
    const tracker = new RunTracker(this.#o.manager);
    s.tracker = tracker;
    // Subscribed after the tracker, so its view is current when this runs.
    s.unsubscribe = this.#o.manager.subscribe((e) => this.#onManager(s, tracker, e));
    return tracker;
  }

  #onManager(s: Session, tracker: RunTracker, e: ManagerEvent): void {
    if (e.type === "run") this.#refreshSpent(s);
    else if (e.type === "task:updated" && tracker.owned().tasks.includes(e.task.id)) {
      if (e.task.twofa === null) s.twofa.delete(e.task.id);
      else if (!s.twofa.has(e.task.id)) {
        s.twofa.add(e.task.id);
        this.#append(s, { kind: "activity", at: Date.now(), text: `${e.task.name} is waiting for a 2FA code` });
      }
    }
  }

  #spent(s: Session): number {
    return s.turnCostUsd + (s.tracker?.runCostUsd() ?? 0);
  }

  #refreshSpent(s: Session): void {
    const spent = this.#spent(s);
    if (spent === s.meta.spentUsd) return;
    s.meta.spentUsd = spent;
    this.#saveMeta(s);
  }

  /** The host for one MCP call made during turn `gen`; once that turn is over its side effects are dropped. */
  #host(s: Session, gen: number): McpHost {
    const live = () => s.gen === gen && s.current !== null;
    return {
      manager: this.#o.manager,
      tracker: this.#tracker(s),
      spentUsd: () => this.#spent(s),
      ceilingUsd: () => s.meta.ceilingUsd,
      takeMessages: () => (live() ? s.queue.splice(0) : []),
      setPhase: (p) => { if (live()) { s.meta.phase = p; this.#saveMeta(s); } },
      ask: (questions) => { if (live()) this.#append(s, { kind: "questions", at: Date.now(), questions }); },
      activity: (text) => { if (live()) this.#append(s, { kind: "activity", at: Date.now(), text }); },
      setPlanFolder: (folder) => { if (live()) { s.meta.planFolder = folder; this.#saveMeta(s); } },
    };
  }

  #startTurn(s: Session, prompt: string): void {
    const gen = ++s.gen;
    s.token = this.#newToken();
    s.turn = "running";
    const argv = claudeArgv({
      prompt, model: s.meta.model, resume: s.meta.sessionId, cwd: this.#o.root, skillsDir: this.#o.skillsDir,
      systemPrompt: this.#o.systemPrompt, mcpUrl: this.#o.mcpUrl(s.meta.id), mcpToken: s.token,
    });
    const turn: Turn = { gen, proc: null as unknown as ClaudeProcess, gotResult: false };
    s.current = turn;
    this.#emitMeta(s);
    try {
      turn.proc = this.#o.spawn(argv, this.#o.root, (line) => {
        if (s.gen !== gen || turn.gotResult) return;
        for (const item of parseStreamLine(line)) {
          if (s.gen !== gen || turn.gotResult) return;
          this.#onItem(s, turn, item);
        }
      });
    } catch (e) {
      this.#append(s, { kind: "error", at: Date.now(), text: `could not start claude: ${e instanceof Error ? e.message : String(e)}` });
      s.queue = [];
      this.#endTurn(s, turn);
      return;
    }
    void turn.proc.done.then(({ code, stderr }) => {
      // The turn ends only once the process has exited, so two `claude --resume` never share a session.
      if (s.current !== turn) return; // stopped
      if (!turn.gotResult || code !== 0) {
        const first = stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
        this.#append(s, { kind: "error", at: Date.now(), text: `claude exited ${code}${first !== "" ? `: ${first}` : ""}` });
      }
      this.#endTurn(s, turn);
    });
  }

  #onItem(s: Session, turn: Turn, item: StreamItem): void {
    switch (item.kind) {
      case "init":
        if (s.meta.sessionId !== item.sessionId) {
          s.meta.sessionId = item.sessionId;
          this.#saveMeta(s);
        }
        return;
      case "text":
        this.#append(s, { kind: "agent", at: Date.now(), text: item.text });
        return;
      case "tool":
        if (item.name.startsWith(MCP_PREFIX)) return;
        this.#append(s, { kind: "activity", at: Date.now(), text: item.summary !== "" ? `${item.name}: ${item.summary}` : item.name });
        return;
      case "result":
        turn.gotResult = true;
        if (item.sessionId !== "" && s.meta.sessionId === null) s.meta.sessionId = item.sessionId;
        s.turnCostUsd += item.costUsd;
        this.#refreshSpent(s);
        if (item.isError) this.#append(s, { kind: "error", at: Date.now(), text: item.text });
    }
  }

  /** Ends the turn; person messages the agent never fetched start the next one. */
  #endTurn(s: Session, turn: Turn): void {
    if (s.current !== turn) return;
    s.current = null;
    s.token = null;
    s.turn = "idle";
    const queued = s.queue.splice(0);
    if (queued.length > 0) this.#startTurn(s, queued.join("\n\n"));
    else this.#saveMeta(s);
  }

  #append(s: Session, m: ChatMessage): void {
    const clean = this.#o.store.append(s.meta.id, m);
    this.#emit({ type: "chat:message", chatId: s.meta.id, message: clean });
  }

  #saveMeta(s: Session): void {
    s.meta.updatedAt = Date.now();
    this.#o.store.saveMeta(s.meta);
    this.#emitMeta(s);
  }

  #emitMeta(s: Session): void {
    this.#emit({ type: "chat:updated", chat: { ...s.meta }, turn: s.turn });
  }

  #emit(e: ChatEvent): void {
    for (const fn of [...this.#listeners]) fn(e);
  }
}

function validCeiling(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
