// Shared shapes for the web test chat: what is stored on disk and what the server pushes to browsers.

export type ChatId = string; // "20261017-101500-brave-otter" style
export type Phase = "read" | "clarify" | "plan" | "probe" | "write" | "run" | "report" | "playwright";
export type TurnState = "idle" | "running" | "stopping";

export interface ChatMeta {
  id: ChatId;
  title: string;
  model: string;
  ceilingUsd: number;
  sessionId: string | null; // Claude Code session id, set after the first turn
  spentUsd: number; // agent turns + runs it started
  phase: Phase | null;
  planFolder: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ChatMessage =
  | { kind: "person"; at: number; text: string; attachments: string[] }
  | { kind: "agent"; at: number; text: string }
  | { kind: "activity"; at: number; text: string } // one-line tool activity
  | { kind: "questions"; at: number; questions: string[] }
  | { kind: "error"; at: number; text: string };

export type ChatEvent =
  | { type: "chat:updated"; chat: ChatMeta; turn: TurnState }
  | { type: "chat:message"; chatId: ChatId; message: ChatMessage };
