// Loads node:sqlite without its ExperimentalWarning reaching stderr (and nothing else is silenced).
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

type Sqlite = typeof import("node:sqlite");
let sqlite: Sqlite | null = null;

function load(): Sqlite {
  if (sqlite !== null) return sqlite;
  const original = process.emitWarning;
  // One-shot: drop only the SQLite ExperimentalWarning raised while the module loads.
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    const first = rest[0];
    const type = typeof first === "string" ? first
      : typeof first === "object" && first !== null ? (first as { type?: string }).type
      : undefined;
    const name = typeof warning === "string" ? type : warning.name;
    if (name === "ExperimentalWarning" && /sqlite/i.test(message)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite") as Sqlite;
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

export function openDatabase(file: string): DatabaseSync {
  return new (load().DatabaseSync)(file);
}
