// Chats on disk: `<root>/.duckwright/chats/<id>/` holds chat.json (meta) and transcript.jsonl (one
// message per line); the person's uploads go to `<root>/.duckwright/uploads/<id>/`, outside the
// chats folder the agent may not read. Secrets are redacted before a message is written.
import fs from "node:fs";
import path from "node:path";
import { randomLabel } from "../rundir.ts";
import { redactText } from "../redact.ts";
import type { ChatId, ChatMessage, ChatMeta } from "./types.ts";

export const isChatId = (s: string): boolean => /^[a-z0-9-]{1,80}$/.test(s);

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A copy of `m` with every text it shows passed through `fn`. */
export function mapMessageText(m: ChatMessage, fn: (text: string) => string): ChatMessage {
  switch (m.kind) {
    case "person": return { ...m, text: fn(m.text) };
    case "questions": return { ...m, questions: m.questions.map(fn) };
    default: return { ...m, text: fn(m.text) };
  }
}

const redactMessage = (m: ChatMessage): ChatMessage => mapMessageText(m, redactText);

export class ChatStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly dir: string;

  constructor(root: string, now: () => number = Date.now) {
    this.root = root;
    this.now = now;
    this.dir = path.join(root, ".duckwright", "chats");
  }

  folder(id: ChatId): string {
    return path.join(this.dir, id);
  }

  create(o: { model: string; ceilingUsd: number }): ChatMeta {
    const base = `${stamp(new Date(this.now()))}-${randomLabel()}`;
    fs.mkdirSync(this.dir, { recursive: true });
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      try {
        fs.mkdirSync(this.folder(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      const t = this.now();
      const meta: ChatMeta = {
        id, title: "New chat", model: o.model, ceilingUsd: o.ceilingUsd, sessionId: null,
        spentUsd: 0, phase: null, planFolder: null, createdAt: t, updatedAt: t,
      };
      this.saveMeta(meta);
      return meta;
    }
  }

  list(): ChatMeta[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: ChatMeta[] = [];
    for (const name of names) {
      if (!isChatId(name)) continue;
      const meta = this.readMeta(name);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  load(id: ChatId): { meta: ChatMeta; messages: ChatMessage[] } | null {
    if (!isChatId(id)) return null;
    const meta = this.readMeta(id);
    if (!meta) return null;
    const messages: ChatMessage[] = [];
    try {
      for (const line of fs.readFileSync(path.join(this.folder(id), "transcript.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line) as ChatMessage); } catch { /* skip a torn line */ }
      }
    } catch { /* no transcript yet */ }
    return { meta, messages };
  }

  saveMeta(meta: ChatMeta): void {
    const file = path.join(this.folder(meta.id), "chat.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
  }

  append(id: ChatId, m: ChatMessage): ChatMessage {
    const clean = redactMessage(m);
    fs.appendFileSync(path.join(this.folder(id), "transcript.jsonl"), JSON.stringify(clean) + "\n");
    return clean;
  }

  saveUpload(id: ChatId, name: string, data: Buffer): string {
    const dir = path.join(this.root, ".duckwright", "uploads", id);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(name.replaceAll("\\", "/")).replace(/^\.+$/, "") || "file";
    const { name: stem, ext } = path.parse(base);
    for (let n = 1; ; n++) {
      const file = n === 1 ? base : `${stem}-${n}${ext}`;
      try {
        fs.writeFileSync(path.join(dir, file), data, { flag: "wx" });
        return path.relative(this.root, path.join(dir, file)).split(path.sep).join("/");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }

  private readMeta(id: ChatId): ChatMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.folder(id), "chat.json"), "utf8")) as ChatMeta;
    } catch {
      return null;
    }
  }
}
