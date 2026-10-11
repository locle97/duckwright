import fs from "node:fs";
import path from "node:path";

import { redactText } from "../redact.ts";
import { codePointLength, flat } from "../text.ts";
import { normalizeUrl } from "./site.ts";
import type { NoteKind } from "./site.ts";
import { CREATED_FILE, itemKey, startsWithMarker } from "./writes.ts";

export const NOTE_KINDS: readonly NoteKind[] = ["business", "page", "quirk", "off-limits", "account", "flow", "created", "removed", "function"];
export const NOTE_TEXT_MAX = 400;
export const NOTES_FILE = "notes.jsonl";

export interface NoteLine {
  step: number;
  kind: NoteKind;
  text: string;
  url: string | null;
}

const SECRET_ASSIGN = /\b(pass(word|wd)?|secret|token|api[-_ ]?key|otp|pin)\b\s*[:=]\s*\S+/i;
const LONG_TOKEN = /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{32,}\b/;

export function looksLikeSecret(text: string): boolean {
  return redactText(text) !== text || SECRET_ASSIGN.test(text) || LONG_TOKEN.test(text);
}

/** The error text for an invalid note action, or null when it is fine. */
export function checkNoteArgs(args: string[], host: string, marker?: string): string | null {
  if (args.length < 2 || args.length > 3) return "error: note needs [kind, text] or [kind, text, url]";
  if (!NOTE_KINDS.includes(args[0] as NoteKind)) return `error: note kind must be one of ${NOTE_KINDS.join(", ")}`;
  const text = flat(args[1]).trim();
  if (text === "") return "error: note text is empty";
  if (codePointLength(text) > NOTE_TEXT_MAX) return `error: note text is longer than ${NOTE_TEXT_MAX} characters`;
  if (looksLikeSecret(text)) {
    return "error: note looks like it contains a secret; name where the credential comes from instead of its value";
  }
  if (args[0] === "created" || args[0] === "removed") {
    if (marker === undefined) return `error: ${args[0]} notes are only available with --allow-writes`;
    if (!startsWithMarker(text, marker)) return `error: ${args[0]} note must start with the run marker ${marker}`;
  }
  if (args.length === 3) {
    const url = normalizeUrl(args[2]);
    if (url === null) return "error: note url must be an http(s) url";
    if (new URL(url).host !== host) return `error: note url must be on the host ${host}`;
  }
  return null;
}

/** Appends validated notes to `<workdir>/notes.jsonl`; the loop sets `step` before each execute. */
export class NoteSink {
  step = 0;
  readonly workdir: string;
  readonly host: string;
  readonly marker: string | undefined;
  private readonly created = new Set<string>();

  constructor(workdir: string, host: string, marker?: string) {
    this.workdir = workdir;
    this.host = host;
    this.marker = marker;
  }

  /** Count a refused note: a marker line, never the refused text. On disk at once, so a crash keeps it. */
  private refuse(message: string): string {
    try {
      fs.appendFileSync(path.join(this.workdir, NOTES_FILE), JSON.stringify({ rejected: 1 }) + "\n");
    } catch {
      // counting is best effort
    }
    return message;
  }

  add(args: string[]): string {
    const err = checkNoteArgs(args, this.host, this.marker);
    if (err !== null) return this.refuse(err);
    const kind = args[0] as NoteKind;
    const text = flat(args[1]).trim();
    const url = args.length === 3 ? normalizeUrl(args[2]) : null;
    if (kind === "removed" && !this.created.has(itemKey(text))) {
      return this.refuse("error: removed note does not match an item created in this run");
    }
    const line: NoteLine = { step: this.step, kind, text, url };
    fs.appendFileSync(path.join(this.workdir, NOTES_FILE), JSON.stringify(line) + "\n");
    if (kind === "created") {
      this.created.add(itemKey(text));
      fs.appendFileSync(path.join(this.workdir, CREATED_FILE), JSON.stringify({ step: this.step, created: text, url }) + "\n");
    } else if (kind === "removed") {
      fs.appendFileSync(path.join(this.workdir, CREATED_FILE), JSON.stringify({ step: this.step, removed: text }) + "\n");
    }
    return "ok";
  }
}

/** Never throws: a missing file is no notes, an unreadable line is skipped. */
export function readNotes(workdir: string): NoteLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workdir, NOTES_FILE), "utf8");
  } catch {
    return [];
  }
  const out: NoteLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as NoteLine;
      if (NOTE_KINDS.includes(o.kind) && typeof o.text === "string" && typeof o.step === "number") {
        out.push({ step: o.step, kind: o.kind, text: o.text, url: typeof o.url === "string" ? o.url : null });
      }
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

/** How many notes the sink refused in this run; never throws. */
export function readRejected(workdir: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workdir, NOTES_FILE), "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split("\n")) {
    try {
      const o = JSON.parse(line) as { rejected?: unknown };
      if (typeof o.rejected === "number") n += o.rejected;
    } catch {
      // skip a damaged line
    }
  }
  return n;
}
