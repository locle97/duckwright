import fs from "node:fs";
import path from "node:path";

import { flat } from "../text.ts";
import { parsePage } from "./pages.ts";
import { containsMarker, readLedger, startsWithMarker } from "./writes.ts";

export const REFUSED_FILE = "refused.jsonl";
export const AUDIT_FILE = "audit.jsonl";

export interface Refusal {
  step: number;
  control: string;
  url: string | null;
}

export interface AuditEntry {
  step: number;
  url: string | null;
  control: string;
  cmd: string;
}

export interface SnapLine {
  indent: number;
  role: string;
  name: string;
  ref: string | null;
  text: string;
  level: number | null;
}

const LINE = /^(\s*)- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;
const REF = /\[ref=([^\]]+)\]/;
const LEVEL = /\[level=(\d+)\]/;

/** The accessibility snapshot as lines with role, name, ref and inline text (lines like `- /url: x` are skipped). */
export function parseSnapshot(snapshot: string): SnapLine[] {
  const out: SnapLine[] = [];
  for (const raw of snapshot.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const rest = m[4] ?? "";
    out.push({
      indent: m[1].length,
      role: m[2],
      name: (m[3] ?? "").replace(/\\(.)/g, "$1"),
      ref: REF.exec(rest)?.[1] ?? null,
      level: m[2] === "heading" ? Number(LEVEL.exec(rest)?.[1] ?? NaN) || null : null,
      text: rest.replace(/\[[^\]]*\]/g, "").trim().replace(/^:\s*/, ""),
    });
  }
  return out;
}

export interface Control {
  index: number;
  role: string;
  name: string;
}

export function findControl(lines: SnapLine[], ref: string): Control | null {
  const index = lines.findIndex((l) => l.ref === ref);
  return index < 0 ? null : { index, role: lines[index].role, name: lines[index].name };
}

/** Indices of the enclosing lines, nearest first. */
function ancestorIndices(lines: SnapLine[], index: number): number[] {
  const out: number[] = [];
  let indent = lines[index].indent;
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    if (lines[i].indent < indent) {
      out.push(i);
      indent = lines[i].indent;
    }
  }
  return out;
}

/** Name and inline text of a line and everything below it. */
function subtreeText(lines: SnapLine[], index: number): string {
  const parts = [lines[index].name, lines[index].text];
  for (let i = index + 1; i < lines.length && lines[i].indent > lines[index].indent; i++) parts.push(lines[i].name, lines[i].text);
  return parts.join(" ");
}

const DELETE_LIKE = /\b(delete|remove|trash|discard|destroy|erase)\b/i;
const CONFIRM = /^(confirm|yes|ok|continue|proceed)\b/i;
const isDialog = (role: string) => role === "dialog" || role === "alertdialog";

export function isDeleteLike(lines: SnapLine[], c: Control): boolean {
  if (DELETE_LIKE.test(c.name)) return true;
  return c.role === "button" && CONFIRM.test(c.name) && ancestorIndices(lines, c.index).some((i) => isDialog(lines[i].role));
}

/** Delete-like controls with a ref that sit outside any dialog. */
function deleteLikeOutsideDialogs(lines: SnapLine[]): number {
  let n = 0;
  lines.forEach((l, index) => {
    if (l.ref === null || ancestorIndices(lines, index).some((i) => isDialog(lines[i].role))) return;
    if (isDeleteLike(lines, { index, role: l.role, name: l.name })) n++;
  });
  return n;
}

/**
 * The marker unlocks a delete-like click when it shows in the dialog the control sits in, or in the tab
 * title or a level-1 heading of a page with at most one delete-like control outside dialogs (a list or
 * grid page, where the title or heading cannot say which row a Delete belongs to, stays locked).
 */
export function pageNamesMarker(tabs: string, lines: SnapLine[], c: Control, marker: string): boolean {
  const dialog = ancestorIndices(lines, c.index).find((i) => isDialog(lines[i].role));
  if (dialog !== undefined && containsMarker(subtreeText(lines, dialog), marker)) return true;
  const named = containsMarker(parsePage(tabs, null)?.title ?? "", marker)
    || lines.some((l) => l.role === "heading" && l.level === 1 && containsMarker(`${l.name} ${l.text}`, marker));
  return named && deleteLikeOutsideDialogs(lines) <= 1;
}

const CLICKS = new Set(["click", "dblclick"]);
const EDITS = new Set(["fill", "type", "select", "check", "uncheck"]);

const VALUE_FLAGS = new Set(["--modifiers"]);

/** Positional arguments: flags, and the value of a flag that takes one, are dropped. */
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-{1,2}[A-Za-z]/.test(a)) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Per-step write guard for `explore --allow-writes`. The loop calls `begin` with the step's tab list and
 * snapshot; `execute` calls `check` for every action. Delete-like clicks on a page that does not name the
 * run marker are refused; unmarked edits are only recorded (audit.jsonl).
 */
export class WriteGuard {
  step = 0;
  readonly workdir: string;
  readonly marker: string;
  private tabs = "";
  private lines: SnapLine[] | null = null;
  private ledgerUrls = new Set<string>();

  constructor(workdir: string, marker: string) {
    this.workdir = workdir;
    this.marker = marker;
  }

  begin(step: number, tabs: string, snapshot: string | null): void {
    this.step = step;
    this.tabs = tabs;
    const parsed = snapshot === null || snapshot.trim() === "" ? null : parseSnapshot(snapshot);
    this.lines = parsed !== null && parsed.length > 0 ? parsed : null;
    this.ledgerUrls = new Set(readLedger(this.workdir).flatMap((i) => (i.url === null ? [] : [i.url])));
  }

  /** null when the action may run, else the error result to report instead. */
  check(a: { cmd: string; args: string[] }): string | null {
    if (CLICKS.has(a.cmd)) return this.checkClick(positional(a.args)[0]);
    if (EDITS.has(a.cmd)) this.audit(a);
    return null;
  }

  private page(): { url: string | null; title: string } {
    const p = parsePage(this.tabs, null);
    return { url: p?.url ?? null, title: p?.title ?? "" };
  }

  private checkClick(ref: string | undefined): string | null {
    if (this.lines === null) {
      this.refuse("(unreadable page)");
      return "error: refused: cannot evaluate the page; try again next step";
    }
    if (!ref) return null;
    const c = findControl(this.lines, ref);
    if (c === null || !isDeleteLike(this.lines, c)) return null;
    if (pageNamesMarker(this.tabs, this.lines, c, this.marker)) return null;
    const name = flat(c.name).slice(0, 80);
    this.refuse(name);
    return `error: refused: '${name}' acts on a page that does not carry the marker ${this.marker}; open the item you created first, or skip it`;
  }

  private refuse(control: string): void {
    append(this.workdir, REFUSED_FILE, { step: this.step, control, url: this.page().url });
  }

  private audit(a: { cmd: string; args: string[] }): void {
    if (this.lines === null) return;
    const pos = positional(a.args);
    let control: string;
    let value: string;
    if (a.cmd === "type") {
      // type has no ref: it writes into the focused element.
      control = "(focused element)";
      value = pos[0] ?? "";
    } else {
      if (!pos[0]) return;
      const c = findControl(this.lines, pos[0]);
      if (c === null) return;
      if (c.role === "searchbox" || /search|filter/i.test(c.name)) return;
      control = `${c.role} "${flat(c.name).slice(0, 80)}"`;
      value = a.cmd === "fill" || a.cmd === "select" ? (pos[1] ?? "") : "";
    }
    const { url, title } = this.page();
    if (containsMarker(title, this.marker)) return;
    if (url !== null && (containsMarker(url, this.marker) || this.ledgerUrls.has(url))) return;
    if (value !== "" && startsWithMarker(value, this.marker)) return; // naming a new item
    append(this.workdir, AUDIT_FILE, { step: this.step, url, control, cmd: a.cmd });
  }
}

function append(workdir: string, file: string, line: object): void {
  try {
    fs.appendFileSync(path.join(workdir, file), JSON.stringify(line) + "\n");
  } catch {
    // recording is best effort; the refusal itself still happens
  }
}

function readJsonl<T>(workdir: string, file: string, ok: (o: Record<string, unknown>) => T | null): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workdir, file), "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    try {
      const o: unknown = JSON.parse(line);
      if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
      const v = ok(o as Record<string, unknown>);
      if (v !== null) out.push(v);
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

export function readRefusals(workdir: string): Refusal[] {
  return readJsonl(workdir, REFUSED_FILE, (o) =>
    typeof o.step === "number" && typeof o.control === "string"
      ? { step: o.step, control: o.control, url: typeof o.url === "string" ? o.url : null }
      : null);
}

export function readAudit(workdir: string): AuditEntry[] {
  return readJsonl(workdir, AUDIT_FILE, (o) =>
    typeof o.step === "number" && typeof o.control === "string" && typeof o.cmd === "string"
      ? { step: o.step, url: typeof o.url === "string" ? o.url : null, control: o.control, cmd: o.cmd }
      : null);
}
