// Pure keymap: one key press plus the current screen state becomes commands for the app to run.
// Bindings live in tables so the footer hints and the help overlay are generated from the same data.
// No ink/react here.
import type { EditTarget, Overrides, PlanId, PlanSnapshot, TaskId, TaskSnapshot } from "../runs/manager.ts";
import { applyCompletion, composeKey, deleteMentionBefore, insertText, mentionAt, submission } from "./compose.ts";
import type { ComposeState, Mention } from "./compose.ts";
import { formKey, formResult, openForm } from "./form.ts";
import type { KeyPress } from "./keypress.ts";
import { filterKey } from "./filter.ts";
import { completionItems, planOf, planTally, selectedPlan, selectedRun, selectedTask } from "./state.ts";
import type { UiAction, ViewState } from "./state.ts";

export type Command =
  | { kind: "ui"; action: UiAction }
  | { kind: "manager"; call: "start" | "pause" | "resume" | "step" | "stop" | "remove"; id: TaskId }
  | { kind: "openCompletion" }
  | { kind: "addSubmission"; mentions: Mention[]; typed: string | null }
  | { kind: "saveOverrides"; id: TaskId; overrides: Overrides }
  | { kind: "saveGlobals"; overrides: Overrides }
  | { kind: "plan"; call: "runAll" | "runFailed" | "stop" | "cancel" | "retry" | "remove"; id: PlanId }
  | { kind: "planSubmission"; path: string }
  | { kind: "move"; id: TaskId; delta: number }
  | { kind: "openEdit"; target: EditTarget; title: string }
  | { kind: "saveEdit" }
  | { kind: "quit" }
  | { kind: "stopAllAndQuit" } | { kind: "forceExit" };

export interface Hint { key: string; label: string }

const PAGE = 10;
const ui = (action: UiAction): Command => ({ kind: "ui", action });

/** `p`: the plan whose header is selected; `plan`: the selected task's plan. */
interface Ctx { s: ViewState; t: TaskSnapshot | null; p: PlanSnapshot | null; plan: PlanSnapshot | null; activeRuns: number }
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
const hasRow = (c: Ctx): boolean => c.t !== null || c.p !== null;
const planBusy = (c: Ctx, p: PlanSnapshot | null): boolean => p !== null && planTally(c.s, p).running;
const planCall = (call: Extract<Command, { kind: "plan" }>["call"]) => (c: Ctx): Command[] =>
  c.p ? [{ kind: "plan", call, id: c.p.id }] : [];
/** The plan the selection is in: its header, or the selected task's plan. */
const anyPlan = (c: Ctx): PlanSnapshot | null => c.p ?? c.plan;
/** Open the add box: focusing it makes it take a task, so the plan box adds its own action after. */
const compose = (value: "task" | "plan") => (): Command[] =>
  [ui({ type: "focus", target: "compose" }), ...(value === "plan" ? [ui({ type: "composeFor", value })] : [])];
const editable = (c: Ctx): boolean =>
  (c.t !== null && !isLive(c.t) && c.t.past === undefined) || (c.p !== null && c.p.setupPath !== null && !planBusy(c, c.p));
function editCommand(c: Ctx): Command[] {
  if (c.t) return [{ kind: "openEdit", target: { kind: "task", id: c.t.id }, title: c.t.source.kind === "file" ? c.t.source.path : c.t.name }];
  if (c.p?.setupPath) return [{ kind: "openEdit", target: { kind: "setup", planId: c.p.id }, title: c.p.setupPath }];
  return [];
}
const movable = (c: Ctx): boolean => c.t !== null && c.plan !== null && !planBusy(c, c.plan) && !c.s.collapsed.includes(c.plan.id);
const moveIn = (delta: number) => (c: Ctx): Command[] => (c.t ? [{ kind: "move", id: c.t.id, delta }] : []);
const manager = (call: "start" | "pause" | "resume" | "step" | "stop" | "remove") => (c: Ctx): Command[] =>
  c.t ? [{ kind: "manager", call, id: c.t.id }] : [];

function quitCommands(s: ViewState, activeRuns: number): Command[] {
  return activeRuns === 0 ? [{ kind: "quit" }] : [ui({ type: "confirm", value: { kind: "quit", count: activeRuns } })];
}

/** Bindings that mean the same in the list and the detail view. */
const SHARED: Binding[] = [
  { match: char("a"), when: () => true, run: compose("task"), hint: { key: "a", label: "add" }, footer: false },
  { match: char("P"), when: () => true, run: compose("plan"), hint: { key: "P", label: "plan a file" }, footer: false },
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
    match: char("O"), when: (c) => c.s.globals !== null,
    run: (c) => (c.s.globals ? [ui({ type: "form", next: openForm(null, c.s.globals.base, c.s.globals.overrides) })] : []),
    hint: { key: "O", label: "global options" }, footer: false,
  },
  {
    match: char("d"), when: (c) => hasTask(c) && !isLive(c.t),
    run: (c) => (c.t ? [ui({ type: "confirm", value: { kind: "remove", taskId: c.t.id } })] : []),
    hint: { key: "d", label: "remove" }, footer: true,
  },
  { match: char("/"), when: () => true, run: () => [ui({ type: "openFilter" })], hint: { key: "/", label: "filter" }, footer: false },
  { match: char("?"), when: () => true, run: () => [ui({ type: "help", open: true })], hint: { key: "?", label: "help" }, footer: true },
  { match: char("q"), when: () => true, run: (c) => quitCommands(c.s, c.activeRuns), hint: { key: "q", label: "quit" }, footer: false },
];

const move = (delta: number) => (): Command[] => [ui({ type: "select", delta })];
/** Keys on a plan's header row, and the plan keys that also act from one of its tasks. */
const PLAN: Binding[] = [
  {
    match: char(" "), when: (c) => c.p?.state === "ready" && !planBusy(c, c.p) && c.p.taskIds.length > 0,
    run: planCall("runAll"), hint: { key: "space", label: "run plan" }, footer: true,
  },
  { match: char(" "), when: (c) => c.p?.state === "failed", run: planCall("retry"), hint: { key: "space", label: "plan again" }, footer: true },
  {
    match: char("F"), when: (c) => { const p = anyPlan(c); return p !== null && !planBusy(c, p) && planTally(c.s, p).failed > 0; },
    run: (c) => { const p = anyPlan(c); return p ? [{ kind: "plan", call: "runFailed", id: p.id }] : []; },
    hint: { key: "F", label: "rerun failed" }, footer: true,
  },
  { match: char("s"), when: (c) => c.p?.state === "planning", run: planCall("cancel"), hint: { key: "s", label: "cancel" }, footer: true },
  { match: char("s"), when: (c) => planBusy(c, c.p), run: planCall("stop"), hint: { key: "s", label: "stop plan" }, footer: true },
  {
    match: char("d"), when: (c) => c.p !== null && c.p.state !== "planning" && !planBusy(c, c.p),
    run: (c) => (c.p ? [ui({ type: "confirm", value: { kind: "removePlan", planId: c.p.id } })] : []),
    hint: { key: "d", label: "remove plan" }, footer: true,
  },
  {
    match: char("c"), when: (c) => anyPlan(c) !== null,
    run: (c) => { const p = anyPlan(c); return p ? [ui({ type: "collapse", id: p.id })] : []; },
    hint: { key: "c", label: "fold plan" }, footer: false,
  },
  { match: char("J"), when: movable, run: moveIn(1), hint: { key: "J/K", label: "move in plan" }, footer: false },
  { match: char("K"), when: movable, run: moveIn(-1), hint: { key: "J/K", label: "move in plan" }, footer: false },
];
const LIST_ONLY: Binding[] = [
  { match: named("escape"), when: (c) => c.s.filter !== "", run: () => [ui({ type: "filterClear" })], hint: { key: "esc", label: "clear filter" }, footer: true },
  ...PLAN,
  { match: char(" "), when: (c) => hasTask(c) && !isLive(c.t), run: manager("start"), hint: { key: "space", label: "run" }, footer: true },
  { match: named("return"), when: hasRow, run: () => [ui({ type: "focus", target: "detail" })], hint: { key: "⏎", label: "details" }, footer: true },
  { match: char("e"), when: editable, run: editCommand, hint: { key: "e", label: "edit" }, footer: true },
  { match: named("tab"), when: () => true, run: compose("task"), hint: { key: "tab", label: "add" }, footer: true },
  { match: named("right"), when: (c) => hasTask(c) && c.t?.runId != null, run: () => [ui({ type: "focus", target: "detail" })], hint: { key: "→", label: "details" }, footer: false },
  { match: char("h", "l"), when: (c) => c.s.globals !== null, run: () => [ui({ type: "focus", target: "options" })], hint: { key: "h/l", label: "options" }, footer: false },
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
  { match: named("tab"), when: () => true, run: () => [ui({ type: "focus", target: "list" })], hint: { key: "tab", label: "tasks" }, footer: true },
  { match: named("escape"), when: () => true, run: () => [ui({ type: "escape" })], hint: { key: "esc", label: "back" }, footer: false },
];

/** The options pane: pick a field, edit it in place; h/l go back to the tasks. */
const OPTIONS: Binding[] = [
  { match: anyOf(named("up"), char("k")), when: () => true, run: () => [ui({ type: "optionsMove", delta: -1 })], hint: { key: "↑↓ j/k", label: "move" }, footer: true },
  { match: anyOf(named("down"), char("j")), when: () => true, run: () => [ui({ type: "optionsMove", delta: 1 })], hint: { key: "↑↓ j/k", label: "move" }, footer: true },
  {
    match: anyOf(named("return"), char("O")), when: (c) => c.s.globals !== null,
    run: (c) => (c.s.globals ? [ui({ type: "form", next: openForm(null, c.s.globals.base, c.s.globals.overrides, c.s.optionsSelected) })] : []),
    hint: { key: "⏎", label: "edit" }, footer: true,
  },
  { match: anyOf(char("h", "l"), named("escape"), named("tab")), when: () => true, run: () => [ui({ type: "focus", target: "list" })], hint: { key: "h/l", label: "tasks" }, footer: true },
  { match: char("a"), when: () => true, run: compose("task"), hint: { key: "a", label: "add" }, footer: false },
  { match: char("?"), when: () => true, run: () => [ui({ type: "help", open: true })], hint: { key: "?", label: "help" }, footer: true },
  { match: char("q"), when: () => true, run: (c) => quitCommands(c.s, c.activeRuns), hint: { key: "q", label: "quit" }, footer: false },
];

/** The binding table for a list, detail or options screen: mode-specific bindings first, then the shared ones. */
function table(mode: "list" | "detail" | "options"): Binding[] {
  if (mode === "options") return OPTIONS;
  return mode === "list" ? [...LIST_ONLY, ...SHARED] : [...DETAIL_ONLY, ...PLAN, ...SHARED];
}

function ctx(s: ViewState, activeRuns: number): Ctx {
  const t = selectedTask(s);
  return { s, t, p: selectedPlan(s), plan: planOf(s, t), activeRuns };
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
  if (k.name === "tab" && !open && !k.ctrl && !k.meta) return [ui({ type: "focus", target: "list" })];
  if (k.name === "return" && !k.meta) {
    if (s.compose.text.trim() === "") return [];
    const { mentions, typed } = submission(s.compose.text);
    if (s.composeFor === "plan") {
      // One plan file or planned folder: a mention, or the path typed as is.
      if (mentions.length + (typed !== null ? 1 : 0) !== 1) {
        return [ui({ type: "addFailed", errors: ["give one plan file or planned folder"], cursor: s.compose.cursor })];
      }
      return [closeList, { kind: "planSubmission", path: mentions[0]?.path ?? typed! }];
    }
    return [closeList, { kind: "addSubmission", mentions, typed }];
  }
  const next: ComposeState = (k.name === "backspace" && !open ? deleteMentionBefore(s.compose) : null) ?? composeKey(s.compose, k);
  if (next === s.compose) return [];
  const cmds: Command[] = [ui({ type: "compose", next })];
  const mention = mentionAt(next.text, next.cursor);
  if (open) {
    const before = mentionAt(s.compose.text, s.compose.cursor);
    if (mention === null || mention.start !== before?.start) cmds.push(closeList);
    else if (mention.path !== before.path) cmds.push(reopen());
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
    if (!r.ok) return [];
    const save: Command = f.taskId === null
      ? { kind: "saveGlobals", overrides: r.overrides }
      : { kind: "saveOverrides", id: f.taskId, overrides: r.overrides };
    return [save, ui({ type: "form", next: null })];
  }
  const next = formKey(f, k);
  return next === f ? [] : [ui({ type: "form", next })];
}

function editCommands(k: KeyPress, s: ViewState): Command[] {
  const e = s.edit;
  if (e === null) return [ui({ type: "escape" })];
  if (k.ctrl && !k.meta && k.name === null && k.input === "s") return [{ kind: "saveEdit" }];
  if (k.name === "escape") {
    return e.compose.text === e.original ? [ui({ type: "edit", value: null })] : [ui({ type: "confirm", value: { kind: "discard" } })];
  }
  // An editor: ⏎ starts a new line, tab indents.
  const next = k.name === "return" && !k.ctrl ? insertText(e.compose, "\n")
    : k.name === "tab" && !k.ctrl && !k.meta ? insertText(e.compose, "  ")
    : composeKey(e.compose, k);
  return next === e.compose ? [] : [ui({ type: "editText", next })];
}

function confirmCommands(k: KeyPress, s: ViewState): Command[] {
  const c = s.confirm;
  if (c !== null && (char("y")(k) || named("return")(k))) {
    if (c.kind === "quit") return [{ kind: "stopAllAndQuit" }];
    if (c.kind === "discard") return [ui({ type: "edit", value: null })];
    if (c.kind === "removePlan") return [ui({ type: "confirm", value: null }), { kind: "plan", call: "remove", id: c.planId }];
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
    case "edit":
      return editCommands(k, s);
    case "help":
      return named("escape")(k) || char("?")(k) ? [ui({ type: "help", open: false })] : [];
    case "confirm":
      return confirmCommands(k, s);
    case "filter": {
      if (named("return")(k)) return [ui({ type: "filterKeep" })];
      if (named("escape")(k)) return [ui({ type: "filterClear" })];
      const draft = s.filterDraft ?? "";
      const next = filterKey(draft, k);
      return next !== null && next !== draft ? [ui({ type: "filterEdit", query: next })] : [];
    }
    case "quitting":
      return [];
    case "list":
    case "detail":
    case "options": {
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
      if (s.composeFor === "plan") return [{ key: "⏎", label: "plan" }, { key: "@", label: "file" }, { key: "esc", label: "back" }];
      return [
        { key: "⏎", label: "add" }, { key: "@", label: "file" }, { key: "alt+⏎", label: "newline" },
        { key: "↑↓", label: "history" }, { key: "tab", label: "tasks" }, { key: "esc", label: "back" },
      ];
    case "edit":
      return [{ key: "ctrl+s", label: "save" }, { key: "⏎", label: "newline" }, { key: "esc", label: "cancel" }];
    case "form": {
      const save: Hint[] = s.form !== null && formResult(s.form).ok ? [{ key: "⏎", label: "save" }] : [];
      return [...save, { key: "ctrl+r", label: "reset" }, { key: "esc", label: "cancel" }];
    }
    case "help":
      return [{ key: "esc", label: "close" }];
    case "confirm":
      return [{ key: "y", label: "yes" }, { key: "n", label: "no" }];
    case "filter":
      return [{ key: "⏎", label: "keep" }, { key: "esc", label: "clear" }];
    case "quitting":
      return [];
    case "list":
    case "detail":
    case "options": {
      const c = ctx(s, 0);
      return dedupe(table(s.mode).filter((b) => b.footer && b.when(c)).map((b) => b.hint));
    }
  }
}

/** Every binding of the screen the help overlay was opened from, regardless of the current task. */
export function helpBindings(s: ViewState): Hint[] {
  const mode = s.focus;
  return dedupe(table(mode).map((b) => b.hint));
}

/** Raw text placed before the footer hints: the filter being typed, or the active filter. */
export function hintPrefix(s: ViewState): string {
  if (s.mode === "filter") return `/${s.filterDraft ?? ""}▌  `;
  if ((s.mode === "list" || s.mode === "detail" || s.mode === "options") && s.filter !== "") return `filter "${s.filter}" · `;
  return "";
}
