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
