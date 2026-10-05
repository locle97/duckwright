import { mentionToken } from "../text.ts";
import type { KeyPress } from "./keypress.ts";

export interface ComposeState {
  text: string;
  /** Index into `text`. */
  cursor: number;
  history: string[];
  historyIndex: number | null;
  /** Text typed before history browsing began. */
  draft: string;
}

export const EMPTY_COMPOSE: ComposeState = { text: "", cursor: 0, history: [], historyIndex: null, draft: "" };

function lineStart(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  return text.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const i = text.indexOf("\n", cursor);
  return i === -1 ? text.length : i;
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

function wordStartBefore(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSpace(text[i - 1])) i--;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  return i;
}

function wordEndAfter(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && isSpace(text[i])) i++;
  while (i < text.length && !isSpace(text[i])) i++;
  return i;
}

function withText(s: ComposeState, text: string, cursor: number): ComposeState {
  return { ...s, text, cursor };
}

export function insertText(s: ComposeState, text: string): ComposeState {
  if (text === "") return s;
  return withText(s, s.text.slice(0, s.cursor) + text + s.text.slice(s.cursor), s.cursor + text.length);
}

export function lines(s: ComposeState): { lines: string[]; row: number; col: number } {
  const start = lineStart(s.text, s.cursor);
  return {
    lines: s.text.split("\n"),
    row: s.text.slice(0, s.cursor).split("\n").length - 1,
    col: s.cursor - start,
  };
}

function showHistory(s: ComposeState, index: number | null, draft: string): ComposeState {
  const text = index === null ? draft : (s.history[index] ?? "");
  return { ...s, text, cursor: text.length, historyIndex: index, draft };
}

function up(s: ComposeState): ComposeState {
  const start = lineStart(s.text, s.cursor);
  if (start === 0) {
    if (s.history.length === 0) return s;
    if (s.historyIndex === null) return showHistory(s, s.history.length - 1, s.text);
    return s.historyIndex === 0 ? s : showHistory(s, s.historyIndex - 1, s.draft);
  }
  const col = s.cursor - start;
  const prevStart = lineStart(s.text, start - 1);
  return { ...s, cursor: prevStart + Math.min(col, start - 1 - prevStart) };
}

function down(s: ComposeState): ComposeState {
  const end = lineEnd(s.text, s.cursor);
  if (end === s.text.length) {
    if (s.historyIndex === null) return s;
    return s.historyIndex === s.history.length - 1
      ? showHistory(s, null, s.draft)
      : showHistory(s, s.historyIndex + 1, s.draft);
  }
  const col = s.cursor - lineStart(s.text, s.cursor);
  const nextStart = end + 1;
  return { ...s, cursor: nextStart + Math.min(col, lineEnd(s.text, nextStart) - nextStart) };
}

export function composeKey(s: ComposeState, k: KeyPress): ComposeState {
  const { text, cursor } = s;
  if (k.name !== null) {
    switch (k.name) {
      case "left":
        if (k.meta) return { ...s, cursor: wordStartBefore(text, cursor) };
        return { ...s, cursor: Math.max(0, cursor - 1) };
      case "right":
        if (k.meta) return { ...s, cursor: wordEndAfter(text, cursor) };
        return { ...s, cursor: Math.min(text.length, cursor + 1) };
      case "home":
        return { ...s, cursor: lineStart(text, cursor) };
      case "end":
        return { ...s, cursor: lineEnd(text, cursor) };
      case "backspace":
        return cursor === 0 ? s : withText(s, text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
      case "delete":
        return cursor >= text.length ? s : withText(s, text.slice(0, cursor) + text.slice(cursor + 1), cursor);
      case "return":
        return k.meta ? insertText(s, "\n") : s;
      case "up":
        return up(s);
      case "down":
        return down(s);
      default:
        return s;
    }
  }
  if (k.ctrl && !k.meta) {
    switch (k.input) {
      case "a":
        return { ...s, cursor: lineStart(text, cursor) };
      case "e":
        return { ...s, cursor: lineEnd(text, cursor) };
      case "w": {
        const from = wordStartBefore(text, cursor);
        return withText(s, text.slice(0, from) + text.slice(cursor), from);
      }
      case "u": {
        const from = lineStart(text, cursor);
        return withText(s, text.slice(0, from) + text.slice(cursor), from);
      }
      default:
        return s;
    }
  }
  if (k.ctrl || k.meta || k.input === "") return s;
  return insertText(s, k.input);
}

export function submit(s: ComposeState): { state: ComposeState; task: string | null } {
  const task = s.text.trim();
  if (task === "") return { state: s, task: null };
  return {
    state: { text: "", cursor: 0, history: [...s.history, task], historyIndex: null, draft: "" },
    task,
  };
}

// --- @ mentions. The box holds only text; mentions are parsed from it whenever they are needed.

/** [start, end) covers the `@` through the last path character or the closing quote. */
export interface Mention { start: number; end: number; path: string; quoted: boolean }

/**
 * Every mention in `text`: an `@` at the start or after whitespace (so not `me@x` or `\@`),
 * running to the next whitespace, or `@"…"` running to the closing quote (or the end of the line).
 */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "@" || (i > 0 && !isSpace(text[i - 1]))) {
      i++;
      continue;
    }
    let end: number;
    if (text[i + 1] === '"') {
      const close = text.indexOf('"', i + 2);
      const eol = lineEnd(text, i + 2);
      if (close !== -1 && close < eol) {
        out.push({ start: i, end: close + 1, path: text.slice(i + 2, close), quoted: true });
        end = close + 1;
      } else {
        out.push({ start: i, end: eol, path: text.slice(i + 2, eol), quoted: true });
        end = eol;
      }
    } else {
      end = i + 1;
      while (end < text.length && !isSpace(text[end])) end++;
      out.push({ start: i, end, path: text.slice(i + 1, end), quoted: false });
    }
    i = Math.max(end, i + 1);
  }
  return out;
}

/** The mention the cursor is in (just after its `@` up to just after its end), or null. */
export function mentionAt(text: string, cursor: number): Mention | null {
  return parseMentions(text).find((m) => m.start < cursor && cursor <= m.end) ?? null;
}

const GAP = "\u0000";

/** Mentions with a path, and what is left once they are taken out, as one typed task (or null). */
export function submission(text: string): { mentions: Mention[]; typed: string | null } {
  const mentions = parseMentions(text).filter((m) => m.path !== "");
  let marked = "";
  let pos = 0;
  for (const m of mentions) {
    marked += text.slice(pos, m.start) + GAP;
    pos = m.end;
  }
  marked += text.slice(pos);
  const typed = marked.replace(/[ \t]*(?:\u0000[ \t]*)+/g, " ").replaceAll("\\@", "@").trim();
  return { mentions, typed: typed === "" ? null : typed };
}

/** Backspace right after a mention with a path deletes all of it; null when not after one. */
export function deleteMentionBefore(s: ComposeState): ComposeState | null {
  const m = parseMentions(s.text).find((x) => x.end === s.cursor && x.path !== "");
  return m ? withText(s, s.text.slice(0, m.start) + s.text.slice(m.end), m.start) : null;
}

/**
 * Replace the mention under the cursor with `path`. `descend` (into a folder) leaves the cursor
 * inside the mention to keep typing; `accept` puts it after the mention and a following space.
 */
export function applyCompletion(s: ComposeState, path: string, how: "descend" | "accept"): ComposeState {
  const m = mentionAt(s.text, s.cursor);
  if (m === null) return s;
  const token = mentionToken(path);
  const before = s.text.slice(0, m.start);
  let after = s.text.slice(m.end);
  if (how === "descend") {
    const quoted = token.endsWith('"');
    return withText(s, before + token + after, m.start + token.length - (quoted ? 1 : 0));
  }
  if (!/^[ \t]/.test(after)) after = " " + after;
  return withText(s, before + token + after, m.start + token.length + 1);
}

export type SpanKind = "text" | "mention" | "missing";
export interface Span { start: number; text: string; kind: SpanKind }

/** `text` cut into plain text and mentions, each mention marked by whether its path exists. */
export function spans(text: string, exists: (path: string) => boolean): Span[] {
  const out: Span[] = [];
  const push = (start: number, end: number, kind: SpanKind): void => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += text.slice(start, end);
    else out.push({ start, text: text.slice(start, end), kind });
  };
  let pos = 0;
  for (const m of parseMentions(text)) {
    push(pos, m.start, "text");
    push(m.start, m.end, m.path === "" ? "text" : exists(m.path) ? "mention" : "missing");
    pos = m.end;
  }
  push(pos, text.length, "text");
  return out;
}
