// The chat view's state: the chat list, the open chat's messages and the input draft. Plain
// TypeScript (no DOM, no React) so it is tested with node --test; store.ts routes chat events here.
import type { ChatEvent, ChatId, ChatMessage, ChatMeta, Phase, TurnState } from "../../src/chat/types.ts";
import type { PlanSnapshot } from "../../src/runs/manager.ts";

export interface ChatUiState {
  chats: Array<{ chat: ChatMeta; turn: TurnState }>;
  openId: ChatId | null;
  messages: ChatMessage[];
  draft: string;
  attachments: string[];
}

export type ChatAction =
  | { type: "chat:list"; items: ChatUiState["chats"] }
  | { type: "chat:opened"; chat: ChatMeta; turn: TurnState; messages: ChatMessage[] }
  | { type: "chat:draft"; text: string } | { type: "chat:attach"; path: string } | { type: "chat:detach"; path: string }
  | { type: "chat:sent" } | ChatEvent;

/** The phases the agent moves through, in order, as the phase strip shows them. */
export const PHASES: Phase[] = ["read", "clarify", "plan", "probe", "write", "run", "report", "playwright"];

export const initialChat = (): ChatUiState => ({ chats: [], openId: null, messages: [], draft: "", attachments: [] });

/** Most recently updated first. */
const byUpdated = (items: ChatUiState["chats"]): ChatUiState["chats"] =>
  [...items].sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);

function upsert(items: ChatUiState["chats"], entry: ChatUiState["chats"][number]): ChatUiState["chats"] {
  const found = items.some((x) => x.chat.id === entry.chat.id);
  return byUpdated(found ? items.map((x) => (x.chat.id === entry.chat.id ? entry : x)) : [...items, entry]);
}

export function reduceChat(s: ChatUiState, a: ChatAction): ChatUiState {
  switch (a.type) {
    case "chat:list":
      return { ...s, chats: byUpdated(a.items) };
    case "chat:opened":
      // Switching chats starts a fresh input: a draft or attachment belongs to the chat it was typed in.
      return {
        ...s, chats: upsert(s.chats, { chat: a.chat, turn: a.turn }), openId: a.chat.id, messages: a.messages,
        ...(s.openId === a.chat.id ? {} : { draft: "", attachments: [] }),
      };
    case "chat:updated":
      return { ...s, chats: upsert(s.chats, { chat: a.chat, turn: a.turn }) };
    case "chat:message":
      return a.chatId === s.openId ? { ...s, messages: [...s.messages, a.message] } : s;
    case "chat:draft":
      return { ...s, draft: a.text };
    case "chat:attach":
      return s.attachments.includes(a.path) ? s : { ...s, attachments: [...s.attachments, a.path] };
    case "chat:detach":
      return { ...s, attachments: s.attachments.filter((x) => x !== a.path) };
    case "chat:sent":
      return { ...s, draft: "", attachments: [] };
  }
}

export const isChatAction = (a: { type: string }): a is ChatAction => a.type.startsWith("chat:");

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** The plan whose folder is the chat's plan folder (compared as normalised strings). */
export function planForFolder(plans: PlanSnapshot[], folder: string | null): PlanSnapshot | null {
  if (folder === null) return null;
  const want = norm(folder);
  return plans.find((p) => p.folder !== null && norm(p.folder) === want) ?? null;
}

export type MessageGroup = { kind: "message"; message: ChatMessage } | { kind: "activity"; lines: string[] };

/** The messages to draw: consecutive activity lines collapse into one group. */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.kind !== "activity") out.push({ kind: "message", message: m });
    else if (last?.kind === "activity") last.lines.push(m.text);
    else out.push({ kind: "activity", lines: [m.text] });
  }
  return out;
}
