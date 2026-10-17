// Live chats: one `claude -p` process per turn, its stream turned into chat messages, person messages
// queued mid-turn, spend tracked against the ceiling, turns stopped, and each chat's MCP endpoint.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactText } from "../redact.ts";
import type { Scrubber } from "../scrub.ts";
import type { ManagerEvent, ManagerLike, TaskId } from "../runs/manager.ts";
import { newToken as defaultNewToken } from "../web/auth.ts";
import { claudeArgv, mcpConfig, parseStreamLine } from "./claude.ts";
import type { ClaudeProcess, ClaudeSpawner, StreamItem } from "./claude.ts";
import { handleMcp } from "./mcp.ts";
import type { EnvAccounts, JsonRpc, McpHost } from "./mcp.ts";
import { projectScrubber } from "./secrets.ts";
import { ChatStore, isChatId, mapMessageText } from "./store.ts";
import type { ChatEvent, ChatId, ChatMessage, ChatMeta, TurnState } from "./types.ts";
import { RunTracker } from "./tracker.ts";

export interface ChatSessionsOptions {
  root: string; manager: ManagerLike; store: ChatStore;
  spawn: ClaudeSpawner; skillsDir: string; systemPrompt: string;
  mcpUrl(chatId: ChatId): string;               // filled by the server once it knows its port
  defaultModel?: string;                         // "sonnet"
  defaultCeilingUsd?: number;                    // 5
  newToken?: () => string;                       // per-chat MCP token; default auth.ts newToken
  scrubber?: () => Scrubber;                     // project secrets to mask; default projectScrubber(root)
  environments?: () => EnvAccounts[];            // environments and accounts the agent may see; default none
}

type Ok = { ok: true } | { ok: false; error: string };

const TITLE_MAX = 60;
const MCP_PREFIX = "mcp__duckwright__";
const KILL_WAIT_MS = 5000;
const STALE_SESSION = "No conversation found";

interface Turn { gen: number; proc: ClaudeProcess; gotResult: boolean; resultText: string }

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
  scrubber: Scrubber | null; // rebuilt on each send and turn, so accounts saved meanwhile are masked
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export class ChatSessions {
  #o: ChatSessionsOptions;
  #sessions = new Map<ChatId, Session>();
  #listeners = new Set<(e: ChatEvent) => void>();
  #newToken: () => string;
  #scrubberOf: () => Scrubber;
  #systemPromptFile: string;

  constructor(o: ChatSessionsOptions) {
    this.#o = o;
    this.#newToken = o.newToken ?? defaultNewToken;
    this.#scrubberOf = o.scrubber ?? (() => projectScrubber(o.root));
    // Passed to claude as a file: a long prompt in argv breaks on Windows' command line limit.
    this.#systemPromptFile = path.join(o.root, ".duckwright", "chats", "system-prompt.md");
    fs.mkdirSync(path.dirname(this.#systemPromptFile), { recursive: true });
    fs.writeFileSync(this.#systemPromptFile, o.systemPrompt);
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
    s.scrubber = this.#scrubberOf();
    this.#append(s, { kind: "person", at: Date.now(), text, attachments: [...attachments] });
    if (!s.titled) {
      s.titled = true;
      const title = this.#clean(s, text.trim().replace(/\s+/g, " ")).slice(0, TITLE_MAX);
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
      s.scrubber = this.#scrubberOf();
      s.meta.title = this.#clean(s, o.title.trim());
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

  /** Saves a file the person attached; the path is relative to the project root, ready to hand to `send`. */
  upload(id: ChatId, name: string, data: Buffer): { ok: true; path: string } | { ok: false; error: string } {
    if (!isChatId(id) || this.#o.store.load(id) === null) return { ok: false, error: "no such chat" };
    return { ok: true, path: this.#o.store.saveUpload(id, name, data) };
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
      titled, tracker: null, unsubscribe: null, twofa: new Set(), scrubber: null,
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
      environments: () => this.#o.environments?.() ?? [],
    };
  }

  #startTurn(s: Session, prompt: string): void {
    // --max-budget-usd caps the agent's own spend in this turn, which the chat only learns at its end.
    const remaining = Math.floor((s.meta.ceilingUsd - this.#spent(s)) * 100 + 1e-9) / 100;
    if (remaining <= 0) {
      s.queue = [];
      this.#append(s, { kind: "error", at: Date.now(), text: `Spend ceiling of $${s.meta.ceilingUsd.toFixed(2)} reached — raise it to continue` });
      this.#saveMeta(s);
      return;
    }
    const gen = ++s.gen;
    s.token = this.#newToken();
    s.turn = "running";
    s.scrubber = this.#scrubberOf();
    const turn: Turn = { gen, proc: null as unknown as ClaudeProcess, gotResult: false, resultText: "" };
    s.current = turn;
    this.#emitMeta(s);
    try {
      // The bearer lives in a file only this user can read, not in the process list.
      const mcpConfigFile = path.join(this.#o.store.folder(s.meta.id), "mcp.json");
      fs.writeFileSync(mcpConfigFile, mcpConfig(this.#o.mcpUrl(s.meta.id), s.token), { mode: 0o600 });
      fs.chmodSync(mcpConfigFile, 0o600);
      const argv = claudeArgv({
        model: s.meta.model, resume: s.meta.sessionId, skillsDir: this.#o.skillsDir,
        systemPromptFile: this.#systemPromptFile, mcpConfigFile, maxBudgetUsd: remaining,
      });
      turn.proc = this.#o.spawn(argv, this.#o.root, (line) => {
        if (s.gen !== gen || turn.gotResult) return;
        for (const item of parseStreamLine(line)) {
          if (s.gen !== gen || turn.gotResult) return;
          this.#onItem(s, turn, item);
        }
      }, prompt);
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
      if ((!turn.gotResult || code !== 0 || turn.resultText !== "") && s.meta.sessionId !== null
        && (stderr.includes(STALE_SESSION) || turn.resultText.includes(STALE_SESSION))) {
        // The saved session is gone (deleted, or made on another machine): the next turn starts a fresh one.
        s.meta.sessionId = null;
        this.#saveMeta(s);
        this.#append(s, { kind: "error", at: Date.now(), text: "The agent's earlier conversation could not be resumed. Send your message again to start a fresh one." });
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
        for (const d of item.denials) {
          this.#append(s, { kind: "activity", at: Date.now(), text: `Not allowed: ${d.name}${d.summary !== "" ? ` ${d.summary}` : ""}` });
        }
        if (item.isError) {
          turn.resultText = item.text;
          this.#append(s, { kind: "error", at: Date.now(), text: item.text });
        }
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

  /** redactText plus the project's secrets. */
  #clean(s: Session, text: string): string {
    s.scrubber ??= this.#scrubberOf();
    return s.scrubber.scrub(redactText(text));
  }

  #append(s: Session, m: ChatMessage): void {
    const clean = this.#o.store.append(s.meta.id, mapMessageText(m, (t) => this.#clean(s, t)));
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
