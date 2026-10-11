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
  /** Index of the enclosing line, or -1. */
  parent: number;
  /** Index of the nearest dialog/alertdialog ancestor, or -1. */
  dialog: number;
  /** Every ref this line is filed under: its own, plus (for an unparsed delete-like line) each ref it mentions. */
  refs: string[];
}

const REF_ALL = /\[ref=([^\]]*)\]/g;
const REF_SHAPE = /^(?:f\d+)?e\d+$/;

const QUOTED = /^'((?:[^']|'')*)'([^]*)$/;
const PROPERTY = /^\s*- \/\w+:/;
const JSON_NAME = /^"(?:[^"\\]|\\.)*"$/;
const ROLE = /^[A-Za-z][\w-]*/;
const ATTR = /^\[[^[\]\s]+\]$/;

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

/** Splits a key into its head and the run of ` [attr]` groups at its very end (scanned from the end, linear). */
function trailingAttrs(key: string): { head: string; attrs: string[] } {
  const attrs: string[] = [];
  let end = key.length;
  while (end > 0 && key[end - 1] === "]") {
    const open = key.lastIndexOf("[", end - 1);
    if (open < 1 || key[open - 1] !== " ") break;
    const group = key.slice(open, end);
    if (!ATTR.test(group)) break;
    attrs.unshift(group.slice(1, -1));
    end = open - 1;
  }
  return { head: key.slice(0, end), attrs };
}

interface Key {
  role: string;
  name: string;
  refs: string[];
  level: number | null;
}

/**
 * A key as playwright's createKey writes it: `role`, then optionally ` "json name"` or ` /raw name/`, then
 * the attribute run (` [level=1] [ref=e3] [cursor=pointer]`). Refs and levels come only from that run, so
 * nothing inside a name can supply one. null when the key has any other shape.
 */
function parseKey(key: string): Key | null {
  const role = ROLE.exec(key)?.[0];
  if (role === undefined) return null;
  const { head, attrs } = trailingAttrs(key);
  if (head.length < role.length) return null;
  const after = head.slice(role.length);
  let name: string;
  if (after === "") name = "";
  else if (after[0] !== " ") return null;
  else {
    const raw = after.slice(1);
    if (JSON_NAME.test(raw)) name = unescapeName(raw.slice(1, -1));
    else if (raw.length >= 2 && raw.startsWith("/") && raw.endsWith("/")) name = raw; // a /regex/ name is written raw
    else return null;
  }
  const refs = attrs.flatMap((a) => (a.startsWith("ref=") ? [a.slice(4)] : []));
  const lv = role === "heading" ? attrs.find((a) => /^level=\d+$/.test(a)) : undefined;
  return { role, name, refs, level: lv === undefined ? null : Number(lv.slice(6)) || null };
}

/** Splits the text after `- ` into key and inline value, unwrapping a single-quoted key. null when it cannot. */
function splitLine(body: string): { key: string; value: string } | null {
  if (body.startsWith("'")) {
    const q = QUOTED.exec(body);
    if (!q) return null;
    const rest = q[2];
    if (rest !== "" && rest !== ":" && !rest.startsWith(": ")) return null;
    return { key: q[1].replace(/''/g, "'"), value: rest.slice(1).trim() };
  }
  // An unquoted key never holds `: ` and never ends with `:` (playwright would quote it), so the first
  // `: ` (or a final `:`) ends the key.
  const sep = body.indexOf(": ");
  if (sep >= 0) return { key: body.slice(0, sep), value: body.slice(sep + 2).trim() };
  if (body.endsWith(":")) return { key: body.slice(0, -1), value: "" };
  return { key: body, value: "" };
}

const DELETE_LIKE = /\b(delete|remove|trash|discard|destroy|erase)\b/i;
const CONFIRM = /^(confirm|yes|ok|continue|proceed)\b/i;
const CONFIRM_ANY = /\b(confirm|yes|ok|continue|proceed)\b/i;
const isDialog = (role: string) => role === "dialog" || role === "alertdialog";

/** One line's fields before the structure pass. */
type Parsed = Omit<SnapLine, "parent" | "dialog">;

/** A line with a `[ref=` token that does not parse: an `unknown` control named by its raw text (fail closed). */
function unknownLine(indent: number, body: string, key: string): Parsed {
  const own = trailingAttrs(key).attrs.flatMap((a) => (a.startsWith("ref=") ? [a.slice(4)] : []));
  // A ref mentioned anywhere in a delete-like unparsed line is filed under it too: page text can only make
  // a click stricter.
  const mentioned = DELETE_LIKE.test(body) ? [...body.matchAll(REF_ALL)].map((m) => m[1]) : [];
  return { indent, role: "unknown", name: flat(body), ref: own[0] ?? null, text: "", level: null, refs: [...new Set([...own, ...mentioned])] };
}

function parseLine(raw: string): Parsed | null {
  if (raw.trim() === "" || PROPERTY.test(raw)) return null; // `- /url: x` is metadata, never a control
  const indent = /^\s*/.exec(raw)![0].length;
  const dashed = raw.startsWith("- ", indent);
  const body = raw.slice(dashed ? indent + 2 : indent);
  const split = dashed ? splitLine(body) : null;
  const key = split === null ? null : parseKey(split.key);
  if (split !== null && key !== null) {
    return { indent, role: key.role, name: key.name, ref: key.refs[0] ?? null, text: split.value, level: key.level, refs: key.refs };
  }
  return body.includes("[ref=") ? unknownLine(indent, body, split?.key ?? body) : null;
}

/**
 * The accessibility snapshot as lines with role, name, ref and inline text, plus each line's parent and
 * nearest dialog ancestor (one pass with an indentation stack). Keys playwright wraps in single quotes are
 * unwrapped; refs and heading levels come only from the attribute run at the end of the key. A line with a
 * `[ref=` token that still does not parse becomes an `unknown` control named by its raw text, so it can be
 * judged delete-like (fail closed); other unparsed lines and property lines (`- /url: x`) are skipped.
 */
export function parseSnapshot(snapshot: string): SnapLine[] {
  const out: SnapLine[] = [];
  const stack: number[] = [];
  for (const raw of snapshot.split(/\r?\n/)) {
    const p = parseLine(raw);
    if (p === null) continue;
    while (stack.length > 0 && out[stack[stack.length - 1]].indent >= p.indent) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
    const dialog = parent < 0 ? -1 : isDialog(out[parent].role) ? parent : out[parent].dialog;
    stack.push(out.length);
    out.push({ ...p, parent, dialog });
  }
  return out;
}

interface Analysis {
  byRef: Map<string, number[]>;
  outside: number;
  h1: string[];
  dialogText: Map<number, string>;
}

const analyses = new WeakMap<SnapLine[], Analysis>();

/** Per-snapshot indexes, built once in O(lines). */
function analyze(lines: SnapLine[]): Analysis {
  let a = analyses.get(lines);
  if (a !== undefined) return a;
  const byRef = new Map<string, number[]>();
  let outside = 0;
  const h1: string[] = [];
  lines.forEach((l, index) => {
    for (const r of l.refs) {
      const list = byRef.get(r);
      if (list === undefined) byRef.set(r, [index]);
      else list.push(index);
    }
    if (l.dialog < 0 && isDeleteLike(lines, { index, role: l.role, name: l.name })) outside++;
    if (l.role === "heading" && l.level === 1) h1.push(`${l.name} ${l.text}`);
  });
  a = { byRef, outside, h1, dialogText: new Map() };
  analyses.set(lines, a);
  return a;
}

export interface Control {
  index: number;
  role: string;
  name: string;
}

const control = (lines: SnapLine[], index: number): Control => ({ index, role: lines[index].role, name: lines[index].name });

/** Every line filed under the ref, in snapshot order. */
function linesFor(lines: SnapLine[], ref: string): number[] {
  return analyze(lines).byRef.get(ref) ?? [];
}

export function findControl(lines: SnapLine[], ref: string): Control | null {
  // Every line filed under the ref counts; a delete-like one wins so no look-alike line can shadow it.
  const matches = linesFor(lines, ref);
  if (matches.length === 0) return null;
  const pick = matches.find((i) => isDeleteLike(lines, control(lines, i))) ?? matches[0];
  return control(lines, pick);
}

/** Name and inline text of a dialog line and everything below it (cached per snapshot). */
function dialogText(lines: SnapLine[], index: number): string {
  const cache = analyze(lines).dialogText;
  let t = cache.get(index);
  if (t === undefined) {
    const parts = [lines[index].name, lines[index].text];
    for (let i = index + 1; i < lines.length && lines[i].indent > lines[index].indent; i++) parts.push(lines[i].name, lines[i].text);
    t = parts.join(" ");
    cache.set(index, t);
  }
  return t;
}

export function isDeleteLike(lines: SnapLine[], c: Control): boolean {
  if (DELETE_LIKE.test(c.name)) return true;
  if ((lines[c.index]?.dialog ?? -1) < 0) return false;
  if (c.role === "button") return CONFIRM.test(c.name);
  return c.role === "unknown" && CONFIRM_ANY.test(c.name); // a garbled line in a dialog fails closed
}

function titleOrH1Named(tabs: string, lines: SnapLine[], marker: string): boolean {
  return containsMarker(parsePage(tabs, null)?.title ?? "", marker) || analyze(lines).h1.some((t) => containsMarker(t, marker));
}

function unlocked(lines: SnapLine[], index: number, named: boolean, marker: string): boolean {
  const dialog = lines[index].dialog;
  if (dialog >= 0 && containsMarker(dialogText(lines, dialog), marker)) return true;
  return named && analyze(lines).outside <= 1;
}

/**
 * The marker unlocks a delete-like line when it shows in the dialog the line sits in, or in the tab title
 * or a level-1 heading of a page with at most one delete-like line outside dialogs (a list or grid page,
 * where the title or heading cannot say which row a Delete belongs to, stays locked).
 */
export function pageNamesMarker(tabs: string, lines: SnapLine[], c: Control, marker: string): boolean {
  return unlocked(lines, c.index, titleOrH1Named(tabs, lines, marker), marker);
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
    let parsed: SnapLine[] | null = null;
    try {
      parsed = snapshot === null || snapshot.trim() === "" ? null : parseSnapshot(snapshot);
    } catch {
      parsed = null; // never expected; an unparseable page refuses every click
    }
    this.lines = parsed !== null && parsed.length > 0 ? parsed : null;
    this.ledgerUrls = new Set(readLedger(this.workdir).flatMap((i) => (i.url === null ? [] : [i.url])));
  }

  /** null when the action may run, else the error result to report instead. */
  check(a: { cmd: string; args: string[] }): string | null {
    try {
      if (CLICKS.has(a.cmd)) return this.checkClick(positional(a.args)[0]);
      if (EDITS.has(a.cmd)) this.audit(a);
      return null;
    } catch {
      // Never expected; a click the guard could not judge is refused, an edit goes through unaudited.
      return CLICKS.has(a.cmd) ? "error: refused: cannot evaluate the page; try again next step" : null;
    }
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
    // Every delete-like line filed under the ref must be unlocked, each judged at its own position.
    const lines = this.lines;
    const deleteLike = linesFor(lines, ref).filter((i) => isDeleteLike(lines, control(lines, i)));
    if (deleteLike.length === 0) return null;
    const named = titleOrH1Named(this.tabs, lines, this.marker);
    const locked = deleteLike.find((i) => !unlocked(lines, i, named, this.marker));
    if (locked === undefined) return null;
    const name = flat(lines[locked].name).slice(0, 80);
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
