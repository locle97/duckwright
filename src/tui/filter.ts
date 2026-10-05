// Pure sidebar filter: case-insensitive substring match on a task's name or text, and the
// query-editing rules (cursor always at the end).
import type { KeyPress } from "./keypress.ts";

interface Filterable { name: string; text: string }

export function matches(task: Filterable, query: string): boolean {
  if (query === "") return true;
  const q = query.toLowerCase();
  return task.name.toLowerCase().includes(q) || task.text.toLowerCase().includes(q);
}

export function visibleIndexes(tasks: Filterable[], query: string): number[] {
  const out: number[] = [];
  tasks.forEach((t, i) => { if (matches(t, query)) out.push(i); });
  return out;
}

/** The query after one key press, or `null` when the key is not a query edit. */
export function filterKey(query: string, key: KeyPress): string | null {
  if (key.ctrl && key.name === null && key.input === "u") return "";
  if (key.name === "backspace") return Array.from(query).slice(0, -1).join("");
  if (key.name !== null || key.ctrl || key.meta) return null;
  const text = Array.from(key.input).filter((c) => c >= " " && c !== "\x7f").join("");
  return text === "" ? null : query + text;
}
