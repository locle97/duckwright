// The Ink workspace: holds the view state, feeds it manager events, clock ticks and key presses,
// runs the keymap's commands, and lays the panes out for the terminal size.
import { Box, Text, useInput, useWindowSize } from "ink";
import type { Key as InkKey } from "ink";
import { Component, createElement as h, useEffect, useReducer, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ManagerLike } from "../runs/manager.ts";
import { AddBox, addBoxHeight } from "./addBox.ts";
import { submit } from "./compose.ts";
import { Confirm, question } from "./confirm.ts";
import { Detail } from "./detail.ts";
import { Footer, quittingText } from "./footer.ts";
import { FormView } from "./formView.ts";
import { Header } from "./header.ts";
import { Help } from "./help.ts";
import type { KeyName, KeyPress } from "./keypress.ts";
import { keymap, tooSmallKeymap } from "./keys.ts";
import type { Command } from "./keys.ts";
import { sanitize } from "./sanitize.ts";
import { Sidebar } from "./sidebar.ts";
import { initialState, reduce } from "./state.ts";
import type { UiAction, ViewState } from "./state.ts";
import { ROLE } from "./theme.ts";
import { Toasts } from "./toast.ts";

export type { InkKey };

export interface AppProps {
  manager: ManagerLike;
  /** Fixed terminal size, for tests; by default the real size, following resizes. */
  size?: { columns: number; rows: number };
  /** Clock tick for spinners, elapsed times and toast expiry. Default 100. */
  tickMs?: number;
  /** Aborting it quits as a confirmed quit does: stop every run, then leave. */
  quitSignal?: AbortSignal;
  /** After quit, after stopAll on a confirmed quit, or after a render crash (with its error). */
  onQuit(error?: Error): void;
  onForceExit(): void;
}

const HEADER_ROWS = 3;
const FOOTER_ROWS = 1;
const MIN_COLUMNS = 40;
const MIN_ROWS = 8;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Ink's key flags as a KeyPress. Ink 8 already reads \x7f and \b as backspace, so its `delete` is the Delete key. */
export function fromInk(input: string, key: InkKey): KeyPress {
  const flags: [boolean, KeyName][] = [
    [key.return, "return"], [key.escape, "escape"], [key.tab, "tab"], [key.backspace, "backspace"], [key.delete, "delete"],
    [key.upArrow, "up"], [key.downArrow, "down"], [key.leftArrow, "left"], [key.rightArrow, "right"],
    [key.pageUp, "pageUp"], [key.pageDown, "pageDown"], [key.home, "home"], [key.end, "end"],
  ];
  const name = flags.find(([on]) => on)?.[1] ?? null;
  return { input: name === null ? input : "", name, ctrl: key.ctrl, meta: key.meta, shift: key.shift };
}

function Workspace(p: AppProps): ReactElement {
  const { manager } = p;
  // The view state lives in a ref that `dispatch` updates at once, so a key that arrives before
  // React re-renders (held keys, split pastes) is mapped against the state the previous key left.
  const state = useRef<ViewState | null>(null);
  if (state.current === null) state.current = initialState(Date.now(), manager.list());
  const s = state.current;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const dispatch = (a: UiAction): void => {
    state.current = reduce(state.current ?? s, a);
    rerender();
  };
  // A synchronous throw while running a key's commands is rethrown in render, for the crash guard.
  const [thrown, setThrown] = useState<Error | null>(null);
  if (thrown !== null) throw thrown;
  const toastsSeen = useRef(0);
  const quitting = useRef(false);
  const terminal = useWindowSize();
  const { columns, rows } = p.size ?? terminal;

  useEffect(() => manager.subscribe((event) => {
    if (event.type === "toast") toastsSeen.current++;
    dispatch({ type: "manager", event });
  }), [manager]);

  const tickMs = p.tickMs ?? 100;
  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);

  const quit = (stopFirst: boolean): void => {
    if (quitting.current) return;
    quitting.current = true;
    if (!stopFirst) {
      p.onQuit();
      return;
    }
    // The panes stay up, showing each run stopping; only Ctrl-C acts from here on.
    dispatch({ type: "quitting" });
    void manager.stopAll().then(() => p.onQuit(), (e: unknown) => p.onQuit(e instanceof Error ? e : new Error(String(e))));
  };

  const { quitSignal } = p;
  useEffect(() => {
    if (quitSignal === undefined) return undefined;
    const onAbort = (): void => quit(true);
    if (quitSignal.aborted) onAbort();
    quitSignal.addEventListener("abort", onAbort, { once: true });
    return () => quitSignal.removeEventListener("abort", onAbort);
  }, [quitSignal]);

  const run = (c: Command): void => {
    switch (c.kind) {
      case "ui":
        dispatch(c.action);
        return;
      case "manager": {
        if (c.call !== "start") {
          manager[c.call](c.id);
          return;
        }
        // The manager already toasts preflight and launch failures; toast the other refusals here.
        const seen = toastsSeen.current;
        const r = manager.start(c.id);
        if (!r.ok && toastsSeen.current === seen) dispatch({ type: "toast", level: "error", message: r.reason });
        return;
      }
      case "openCompletion":
        return;
      case "addSubmission": {
        const r = manager.add({ mentions: c.mentions.map((m) => m.path), typed: c.typed });
        if (!r.ok) {
          const first = c.mentions[r.errors[0]?.mention ?? 0];
          const cursor = first?.start ?? (state.current ?? s).compose.cursor;
          dispatch({ type: "addFailed", errors: r.errors.map((e) => e.message), cursor });
          return;
        }
        dispatch({ type: "compose", next: submit((state.current ?? s).compose).state });
        for (const d of r.duplicates) dispatch({ type: "toast", level: "info", message: `already added: ${d}` });
        const added = r.added[0];
        if (added !== undefined) dispatch({ type: "selectTask", id: added });
        return;
      }
      case "saveOverrides":
        manager.setOverrides(c.id, c.overrides);
        return;
      case "quit":
        quit(false);
        return;
      case "stopAllAndQuit":
        quit(true);
        return;
      case "forceExit":
        p.onForceExit();
        return;
    }
  };

  const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;
  useInput((input, key) => {
    try {
      const map = tooSmall ? tooSmallKeymap : keymap;
      for (const c of map(fromInk(input, key), state.current ?? s, manager.activeCount())) run(c);
    } catch (e) {
      setThrown(e instanceof Error ? e : new Error(String(e)));
    }
  });

  if (tooSmall) {
    // No panes fit, so only quitting acts here (see tooSmallKeymap); say how, whatever the mode.
    const lines = s.mode === "quitting" ? [quittingText(s)]
      : s.mode === "confirm" && s.confirm !== null ? [question(s), "y yes · n no"]
      : ["q quit"];
    return h(Box, { flexDirection: "column" },
      h(Text, { wrap: "truncate-end" }, "terminal too small"),
      ...lines.map((line, i) => h(Text, { key: i, color: ROLE.muted, wrap: "truncate-end" }, line)));
  }

  const paneHeight = Math.max(0, rows - HEADER_ROWS - FOOTER_ROWS - addBoxHeight(s.compose));
  const listFocused = s.focus === "list" && s.mode !== "compose";
  const detailFocused = s.focus === "detail" && s.mode !== "compose";
  let panes: ReactElement[];
  if (columns < 60) {
    panes = [s.focus === "list"
      ? h(Sidebar, { key: "list", s, width: columns, height: paneHeight, focused: listFocused, showCost: true })
      : h(Detail, { key: "detail", s, width: columns, height: paneHeight, focused: detailFocused })];
  } else {
    const wide = columns >= 90;
    const sideWidth = wide ? clamp(Math.round(columns * 0.3), 24, 40) : clamp(Math.round(columns * 0.3), 18, 26);
    panes = [
      h(Sidebar, { key: "list", s, width: sideWidth, height: paneHeight, focused: listFocused, showCost: wide }),
      h(Detail, { key: "detail", s, width: columns - sideWidth, height: paneHeight, focused: detailFocused }),
    ];
  }
  const area = { width: columns, height: paneHeight };
  const overlay = s.mode === "help" ? h(Help, { key: "help", s, ...area })
    : s.mode === "form" && s.form !== null ? h(FormView, { key: "form", form: s.form, ...area })
    : s.mode === "confirm" && s.confirm !== null ? h(Confirm, { key: "confirm", s, ...area })
    : null;

  return h(Box, { flexDirection: "column", width: columns, height: rows },
    h(Header, { s, width: columns }),
    h(Box, { flexDirection: "row", width: columns, height: paneHeight, flexShrink: 0 },
      ...panes, overlay, h(Toasts, { key: "toasts", toasts: s.toasts, width: columns })),
    h(AddBox, { compose: s.compose, focused: s.mode === "compose", width: columns }),
    h(Footer, { s, width: columns }));
}

interface GuardProps { onError(error: Error): void; children: ReactNode }

/** Catches a render crash: shows the error and reports it once. */
class CrashGuard extends Component<GuardProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error instanceof Error ? error : new Error(String(error)));
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return h(Box, { flexDirection: "column" },
      h(Text, { color: ROLE.error }, `duckwright crashed: ${sanitize(error.message)}`),
      h(Text, { color: ROLE.muted }, "stopping runs…"));
  }
}

export function App(p: AppProps): ReactElement {
  const onError = (error: Error): void => {
    void p.manager.stopAll().then(() => p.onQuit(error), () => p.onQuit(error));
  };
  return h(CrashGuard, { onError, children: h(Workspace, p) });
}
