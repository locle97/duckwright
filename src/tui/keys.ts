// Pure keymap: one key press plus the current screen state becomes commands for the app to run.
// Bindings live in tables so the footer hints and the help overlay are generated from the same data.
// No ink/react here.
import type { Overrides, TaskId, TaskSnapshot } from "../runs/manager.ts";
import { applyCompletion, composeKey, deleteMentionBefore, mentionAt, submission } from "./compose.ts";
import type { ComposeState, Mention } from "./compose.ts";
import { formKey, formResult, openForm } from "./form.ts";
import type { KeyPress } from "./keypress.ts";
import { completionItems, selectedRun, selectedTask } from "./state.ts";
import type { UiAction, ViewState } from "./state.ts";

export type Command =
  | { kind: "ui"; action: UiAction }
  | { kind: "manager"; call: "start" | "pause" | "resume" | "step" | "stop" | "remove"; id: TaskId }
  | { kind: "openCompletion" }
  | { kind: "addSubmission"; mentions: Mention[]; typed: string | null }
  | { kind: "saveOverrides"; id: TaskId; overrides: Overrides }
  | { kind: "quit" }
  | { kind: "stopAllAndQuit" } | { kind: "forceExit" };

export interface Hint { key: string; label: string }

const PAGE = 10;
const ui = (action: UiAction): Command => ({ kind: "ui", action });

interface Ctx { s: ViewState; t: TaskSnapshot | null; activeRuns: number }
interface Binding {
  match: (k: KeyPress) => boolean;
  /** Whether the binding acts in this context. */
  when: (c: Ctx) => boolean;
  run: (c: Ctx) => Command[];
  hint: Hint;
  /** Shown in the footer (otherwise only in the help overlay). */
  footer: boolean;
}

const plain = (k: KeyPress): boolean => !k.ctrl && !k.meta;
const char = (...chars: string[]) => (k: KeyPress): boolean => k.name === null && plain(k) && chars.includes(k.input);
const named = (...names: NonNullable<KeyPress["name"]>[]) => (k: KeyPress): boolean => k.name !== null && names.includes(k.name);
const isCtrlC = (k: KeyPress): boolean => k.ctrl && !k.meta && k.name === null && k.input === "c";
const anyOf = (...ms: ((k: KeyPress) => boolean)[]) => (k: KeyPress): boolean => ms.some((m) => m(k));

const isLive = (t: TaskSnapshot | null): boolean => t !== null && (t.state === "running" || t.state === "paused" || t.state === "stopping");
const hasTask = (c: Ctx): boolean => c.t !== null;
const manager = (call: "start" | "pause" | "resume" | "step" | "stop" | "remove") => (c: Ctx): Command[] =>
  c.t ? [{ kind: "manager", call, id: c.t.id }] : [];

function quitCommands(s: ViewState, activeRuns: number): Command[] {
  return activeRuns === 0 ? [{ kind: "quit" }] : [ui({ type: "confirm", value: { kind: "quit", count: activeRuns } })];
}

/** Bindings that mean the same in the list and the detail view. */
const SHARED: Binding[] = [
  { match: char("a"), when: () => true, run: () => [ui({ type: "focus", target: "compose" })], hint: { key: "a", label: "add" }, footer: true },
  { match: char("p"), when: (c) => c.t?.state === "running", run: manager("pause"), hint: { key: "p", label: "pause" }, footer: true },
  { match: char("r"), when: (c) => c.t?.state === "paused", run: manager("resume"), hint: { key: "r", label: "resume" }, footer: true },
  { match: char("n", "."), when: (c) => c.t?.state === "paused", run: manager("step"), hint: { key: "n", label: "step" }, footer: true },
  { match: char("s"), when: (c) => c.t?.state === "running" || c.t?.state === "paused", run: manager("stop"), hint: { key: "s", label: "stop" }, footer: true },
  {
    match: char("o"), when: (c) => hasTask(c) && !isLive(c.t),
    run: (c) => (c.t ? [ui({ type: "form", next: openForm(c.t.id, c.t.effective, c.t.overrides) })] : []),
    hint: { key: "o", label: "options" }, footer: true,
  },
  {
    match: char("d"), when: (c) => hasTask(c) && !isLive(c.t),
    run: (c) => (c.t ? [ui({ type: "confirm", value: { kind: "remove", taskId: c.t.id } })] : []),
    hint: { key: "d", label: "remove" }, footer: true,
  },
  { match: named("tab"), when: (c) => hasTask(c) && (c.s.focus === "detail" || c.t?.runId != null), run: () => [ui({ type: "toggleFocus" })], hint: { key: "tab", label: "focus" }, footer: true },
  { match: char("?"), when: () => true, run: () => [ui({ type: "help", open: true })], hint: { key: "?", label: "help" }, footer: true },
  { match: char("q"), when: () => true, run: (c) => quitCommands(c.s, c.activeRuns), hint: { key: "q", label: "quit" }, footer: false },
];

const move = (delta: number) => (): Command[] => [ui({ type: "select", delta })];
const LIST_ONLY: Binding[] = [
  {
    match: named("return"), when: hasTask,
    run: (c) => (c.t ? (isLive(c.t) ? [ui({ type: "focus", target: "detail" })] : [{ kind: "manager", call: "start", id: c.t.id }]) : []),
    hint: { key: "⏎", label: "run" }, footer: true,
  },
  { match: anyOf(named("up"), char("k")), when: hasTask, run: move(-1), hint: { key: "↑↓ j/k", label: "move" }, footer: false },
  { match: anyOf(named("down"), char("j")), when: hasTask, run: move(1), hint: { key: "↑↓ j/k", label: "move" }, footer: false },
  { match: named("pageUp"), when: hasTask, run: move(-PAGE), hint: { key: "pgup/pgdn", label: "page" }, footer: false },
  { match: named("pageDown"), when: hasTask, run: move(PAGE), hint: { key: "pgup/pgdn", label: "page" }, footer: false },
  { match: char("g"), when: hasTask, run: () => [ui({ type: "selectEdge", edge: "first" })], hint: { key: "g/G", label: "first / last" }, footer: false },
  { match: char("G"), when: hasTask, run: () => [ui({ type: "selectEdge", edge: "last" })], hint: { key: "g/G", label: "first / last" }, footer: false },
];

const hasRun = (c: Ctx): boolean => selectedRun(c.s) !== null;
const tl = (op: Extract<UiAction, { type: "timeline" }>["op"], delta?: number) => (): Command[] =>
  [ui(delta === undefined ? { type: "timeline", op } : { type: "timeline", op, delta })];
const DETAIL_ONLY: Binding[] = [
  { match: anyOf(named("up"), char("k")), when: hasRun, run: tl("move", -1), hint: { key: "↑↓", label: "move" }, footer: true },
  { match: anyOf(named("down"), char("j")), when: hasRun, run: tl("move", 1), hint: { key: "↑↓", label: "move" }, footer: false },
  { match: named("pageUp"), when: hasRun, run: tl("page", -PAGE), hint: { key: "pgup/pgdn", label: "page" }, footer: false },
  { match: named("pageDown"), when: hasRun, run: tl("page", PAGE), hint: { key: "pgup/pgdn", label: "page" }, footer: false },
  { match: anyOf(char("g"), named("home")), when: hasRun, run: tl("first"), hint: { key: "g", label: "first step" }, footer: false },
  { match: anyOf(named("return"), char(" ")), when: hasRun, run: tl("toggle"), hint: { key: "⏎", label: "expand" }, footer: true },
  { match: anyOf(char("G"), named("end")), when: hasRun, run: tl("last"), hint: { key: "G", label: "last step" }, footer: true },
  { match: char("e"), when: hasRun, run: tl("expandAll"), hint: { key: "e", label: "expand all" }, footer: false },
  { match: char("c"), when: hasRun, run: tl("collapseAll"), hint: { key: "c", label: "collapse all" }, footer: false },
  { match: named("escape"), when: () => true, run: () => [ui({ type: "escape" })], hint: { key: "esc", label: "back" }, footer: false },
];

/** The binding table for a list or detail screen: mode-specific bindings first, then the shared ones. */
function table(mode: "list" | "detail"): Binding[] {
  return mode === "list" ? [...LIST_ONLY, ...SHARED] : [...DETAIL_ONLY, ...SHARED];
}

function ctx(s: ViewState, activeRuns: number): Ctx {
  return { s, t: selectedTask(s), activeRuns };
}

function ctrlC(s: ViewState, activeRuns: number): Command[] {
  if (s.ctrlC >= 2) return [{ kind: "forceExit" }];
  // The ui ctrlC goes last: the reducer resets the counter on any other key's action.
  const count = ui({ type: "ctrlC" });
  if (s.mode === "quitting") return [count];
  if (s.mode === "confirm" && s.confirm?.kind === "quit") return [{ kind: "stopAllAndQuit" }, count];
  return [...quitCommands(s, activeRuns), count];
}

const closeList = ui({ type: "completion", value: null });

function composeCommands(k: KeyPress, s: ViewState): Command[] {
  const list = s.completion;
  const open = list !== null;
  const reopen = (): Command => ui({ type: "completion", value: list && { index: list.index, highlight: 0 } });
  if (k.name === "escape") return [open ? closeList : ui({ type: "escape" })];
  if (open && !k.ctrl && !k.meta) {
    const items = completionItems(s);
    const item = items[Math.min(list.highlight, items.length - 1)];
    if (k.name === "up" || k.name === "down") return [ui({ type: "completionMove", delta: k.name === "up" ? -1 : 1 })];
    if (k.name === "tab") {
      if (item === undefined) return [];
      if (item.folder) {
        return [ui({ type: "compose", next: applyCompletion(s.compose, item.path, "descend") }), reopen()];
      }
      return [ui({ type: "compose", next: applyCompletion(s.compose, item.path, "accept") }), closeList];
    }
    if (k.name === "return" && item !== undefined) {
      return [ui({ type: "compose", next: applyCompletion(s.compose, item.path, "accept") }), closeList];
    }
  }
  if (k.name === "return" && !k.meta) {
    if (s.compose.text.trim() === "") return [];
    const { mentions, typed } = submission(s.compose.text);
    return [closeList, { kind: "addSubmission", mentions, typed }];
  }
  const next: ComposeState = (k.name === "backspace" && !open ? deleteMentionBefore(s.compose) : null) ?? composeKey(s.compose, k);
  if (next === s.compose) return [];
  const cmds: Command[] = [ui({ type: "compose", next })];
  const mention = mentionAt(next.text, next.cursor);
  if (open) {
    const before = mentionAt(s.compose.text, s.compose.cursor);
    if (mention === null) cmds.push(closeList);
    else if (mention.path !== before?.path) cmds.push(reopen());
  } else if (mention !== null && k.name === null && !k.ctrl && !k.meta) {
    // Only typing opens the list: moving the cursor into a mention, or a paste that ends past it, does not.
    cmds.push({ kind: "openCompletion" });
  }
  return cmds;
}

function formCommands(k: KeyPress, s: ViewState): Command[] {
  const f = s.form;
  if (f === null) return [ui({ type: "escape" })];
  if (k.name === "escape") return [ui({ type: "form", next: null })];
  if (k.name === "return") {
    const r = formResult(f);
    return r.ok ? [{ kind: "saveOverrides", id: f.taskId, overrides: r.overrides }, ui({ type: "form", next: null })] : [];
  }
  const next = formKey(f, k);
  return next === f ? [] : [ui({ type: "form", next })];
}

function confirmCommands(k: KeyPress, s: ViewState): Command[] {
  const c = s.confirm;
  if (c !== null && (char("y")(k) || named("return")(k))) {
    if (c.kind === "quit") return [{ kind: "stopAllAndQuit" }];
    return [ui({ type: "confirm", value: null }), { kind: "manager", call: "remove", id: c.taskId }];
  }
  if (char("n")(k) || named("escape")(k)) return [ui({ type: "confirm", value: null })];
  return [];
}

export function keymap(k: KeyPress, s: ViewState, activeRuns: number): Command[] {
  if (isCtrlC(k)) return ctrlC(s, activeRuns);
  switch (s.mode) {
    case "compose":
      return composeCommands(k, s);
    case "form":
      return formCommands(k, s);
    case "help":
      return named("escape")(k) || char("?")(k) ? [ui({ type: "help", open: false })] : [];
    case "confirm":
      return confirmCommands(k, s);
    case "quitting":
      return [];
    case "list":
    case "detail": {
      const c = ctx(s, activeRuns);
      const b = table(s.mode).find((x) => x.match(k) && x.when(c));
      return b ? b.run(c) : [];
    }
  }
}

/**
 * The "terminal too small" screen shows no panes, so only quitting acts there, whatever the mode:
 * `q` or `esc` quits (or asks first), the quit or remove question takes y/n, and Ctrl-C counts as usual.
 */
export function tooSmallKeymap(k: KeyPress, s: ViewState, activeRuns: number): Command[] {
  if (isCtrlC(k)) return ctrlC(s, activeRuns);
  if (s.mode === "quitting") return [];
  if (s.mode === "confirm") return confirmCommands(k, s);
  return char("q")(k) || named("escape")(k) ? quitCommands(s, activeRuns) : [];
}

const dedupe = (list: Hint[]): Hint[] => list.filter((h, i) => list.findIndex((x) => x.key === h.key && x.label === h.label) === i);

/** Footer hints: only the bindings that act right now. */
export function hints(s: ViewState): Hint[] {
  switch (s.mode) {
    case "compose":
      if (s.completion !== null) {
        return [{ key: "↑↓", label: "move" }, { key: "tab", label: "complete" }, { key: "⏎", label: "accept" }, { key: "esc", label: "close" }];
      }
      return [
        { key: "⏎", label: "add" }, { key: "@", label: "file" }, { key: "alt+⏎", label: "newline" },
        { key: "↑↓", label: "history" }, { key: "esc", label: "back" },
      ];
    case "form": {
      const save: Hint[] = s.form !== null && formResult(s.form).ok ? [{ key: "⏎", label: "save" }] : [];
      return [...save, { key: "ctrl+r", label: "reset" }, { key: "esc", label: "cancel" }];
    }
    case "help":
      return [{ key: "esc", label: "close" }];
    case "confirm":
      return [{ key: "y", label: "yes" }, { key: "n", label: "no" }];
    case "quitting":
      return [];
    case "list":
    case "detail": {
      const c = ctx(s, 0);
      const live = table(s.mode).filter((b) => b.footer && b.when(c)).map((b) => b.hint);
      // Return opens a live run but starts anything else; the table's hint says "run".
      const open = s.mode === "list" && isLive(c.t);
      return dedupe(live.map((h) => (open && h.key === "⏎" ? { key: "⏎", label: "open" } : h)));
    }
  }
}

/** Every binding of the screen the help overlay was opened from, regardless of the current task. */
export function helpBindings(s: ViewState): Hint[] {
  const mode = s.focus;
  const rows = table(mode).map((b) => b.hint);
  const extra: Hint[] = mode === "list" ? [{ key: "⏎", label: "open run (live task)" }] : [];
  return dedupe([...rows, ...extra]);
}
