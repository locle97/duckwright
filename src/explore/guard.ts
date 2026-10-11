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

const REF = /\[ref=([^\]]+)\]/;
const LEVEL = /\[level=(\d+)\]/;
const ATTRS = /^(?:\s*\[[^\]]*\])*/;
const REF_SHAPE = /^(?:f\d+)?e\d+$/;

const QUOTED = /^(\s*)- '((?:[^']|'')*)'(.*)$/;
const PROPERTY = /^\s*- \/\w+:/;

/** Names are written with JSON.stringify; decode them exactly, falling back to dropping backslashes. */
function unescapeName(inner: string): string {
  try {
    const v: unknown = JSON.parse(`"${inner}"`);
    if (typeof v === "string") return v;
  } catch {
    // fall through
  }
  return inner.replace(/\\(.)/g, "$1");
}

/** One `role "name" [attrs]: text` body (after `- `), or null when it has another shape. */
function parseBody(indent: number, body: string, tail: string): SnapLine | null {
  const m = /^([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(body);
  if (!m) return null;
  const all = (m[3] ?? "") + tail;
  const attrs = ATTRS.exec(all)?.[0] ?? ""; // only these bracket groups are attributes; inline text can't supply one
  const rest = all.slice(attrs.length);
  const role = m[1];
  const ref = REF.exec(attrs)?.[1] ?? null;
  if (ref === null && !rest.trimStart().startsWith(":") && REF.test(rest)) return null; // exotic name: fail closed below
  return {
    indent,
    role,
    name: unescapeName(m[2] ?? ""),
    ref,
    level: role === "heading" ? Number(LEVEL.exec(attrs)?.[1] ?? NaN) || null : null,
    text: rest.trim().replace(/^:\s*/, ""),
  };
}

/**
 * The accessibility snapshot as lines with role, name, ref and inline text. Keys playwright wraps in single
 * quotes (names with `: `, ` #`, braces or backticks) are unwrapped. A line with a ref that still does not
 * parse becomes an `unknown` control named by its raw text, so it can be judged delete-like (fail closed);
 * lines without a ref (like `- /url: x`) are skipped.
 */
export function parseSnapshot(snapshot: string): SnapLine[] {
  const out: SnapLine[] = [];
  for (const raw of snapshot.split(/\r?\n/)) {
    if (PROPERTY.test(raw)) continue; // `- /url: x` is metadata, never a control
    const q = QUOTED.exec(raw);
    const plain = q ? null : /^(\s*)- (.*)$/.exec(raw);
    let line: SnapLine | null = null;
    let text = "";
    let indent = 0;
    if (q) {
      indent = q[1].length;
      text = q[2].replace(/''/g, "'");
      line = parseBody(indent, text, q[3]);
    } else if (plain) {
      indent = plain[1].length;
      text = plain[2];
      line = parseBody(indent, text, "");
    }
    if (line === null && (q || plain)) {
      const ref = REF.exec(text)?.[1];
      if (ref !== undefined) line = { indent, role: "unknown", name: flat(text), ref, level: null, text: "" };
    }
    if (line !== null) out.push(line);
  }
  return out;
}

export interface Control {
  index: number;
  role: string;
  name: string;
}

export function findControl(lines: SnapLine[], ref: string): Control | null {
  // Every line carrying the ref counts; a delete-like one wins so no earlier look-alike line can shadow it.
  const matches = lines.flatMap((l, index) => (l.ref === ref ? [index] : []));
  if (matches.length === 0) return null;
  const control = (index: number): Control => ({ index, role: lines[index].role, name: lines[index].name });
  const pick = matches.find((i) => isDeleteLike(lines, control(i))) ?? matches[0];
  return control(pick);
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
  const refs = new Set<string>();
  lines.forEach((l, index) => {
    if (l.ref === null || ancestorIndices(lines, index).some((i) => isDialog(lines[i].role))) return;
    if (isDeleteLike(lines, { index, role: l.role, name: l.name })) refs.add(l.ref);
  });
  return refs.size;
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
    if (!REF_SHAPE.test(ref)) {
      this.refuse(flat(ref).slice(0, 80));
      return "error: refused: click targets must be a ref from the snapshot; use the ref of the control";
    }
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
