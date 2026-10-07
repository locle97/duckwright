import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";

import { openEditor, quitServer, taskControl, runPlan } from "./actions.ts";
import { ConfirmDialog } from "./dialogs/ConfirmDialog.tsx";
import { AddDialog } from "./dialogs/AddDialog.tsx";
import { EditorDialog } from "./dialogs/EditorDialog.tsx";
import { HelpDialog } from "./dialogs/HelpDialog.tsx";
import { OptionsDialog } from "./dialogs/OptionsDialog.tsx";
import { TwofaDialog } from "./dialogs/TwofaDialog.tsx";
import { Header } from "./Header.tsx";
import { commandFor } from "./keys.ts";
import { MainPane } from "./MainPane.tsx";
import { OptionsStrip } from "./OptionsStrip.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { initialState, pendingTwofa, reduce } from "./store.ts";
import type { WebState } from "./store.ts";
import { Toasts } from "./ui.tsx";
import { useServer } from "./useServer.ts";

function Screen(p: { title: string; children?: ReactNode }) {
  return (
    <div className="screen">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>🦆 {p.title}</h1>
        {p.children}
      </div>
    </div>
  );
}

const editable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState(Date.now()));
  const [drawer, setDrawer] = useState(false);
  useServer(dispatch);

  // `auto` follows the system; `light` and `dark` (from --theme) are fixed.
  useEffect(() => {
    const root = document.documentElement;
    if (state.theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = state.theme;
  }, [state.theme]);

  const ref = useRef<WebState>(state);
  ref.current = state;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = ref.current;
      if (e.ctrlKey || e.metaKey || e.altKey || editable(e.target) || s.dialog !== null || pendingTwofa(s) !== null) return;
      const c = commandFor(e.key, s);
      if (!c) return;
      e.preventDefault();
      switch (c.type) {
        case "action": dispatch(c.action); break;
        case "task": void taskControl(dispatch, c.id, c.verb); break;
        case "runPlan": void runPlan(dispatch, c.id, "all"); break;
        case "editTask": void openEditor(dispatch, { kind: "task", id: c.id }, c.name); break;
        case "editSetup": void openEditor(dispatch, { kind: "setup", planId: c.planId }, c.name); break;
        case "focusFilter": document.querySelector<HTMLInputElement>("[data-filter]")?.focus(); break;
        case "quit": void quitServer(dispatch); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (state.expired) {
    return <Screen title="Session expired"><p>This page's token no longer works. Run <code>duckwright --web</code> again and open the new URL.</p></Screen>;
  }
  if (state.ended) return <Screen title="Duckwright stopped"><p>Every run was stopped and the server is shut down. You can close this tab.</p></Screen>;
  if (!state.loaded) return <Screen title="Connecting…"><p className="muted">Waiting for the Duckwright server.</p></Screen>;

  const twofa = pendingTwofa(state);
  const d = state.dialog;
  return (
    <div className="app">
      {!state.connected ? <div className="banner" role="alert">Disconnected. Retrying…</div> : null}
      <Header state={state} onHelp={() => dispatch({ type: "dialog", value: { kind: "help" } })}
        onQuit={() => {
          const live = state.tasks.filter((t) => t.state === "running" || t.state === "paused" || t.state === "stopping").length;
          if (live > 0) dispatch({ type: "dialog", value: { kind: "confirm", confirm: { kind: "quit", count: live } } });
          else void quitServer(dispatch);
        }}
        onDrawer={() => setDrawer((v) => !v)} />
      <div className="body">
        <Sidebar state={state} dispatch={dispatch} open={drawer} onPicked={() => setDrawer(false)} />
        <MainPane state={state} dispatch={dispatch} />
      </div>
      <OptionsStrip state={state} dispatch={dispatch} />
      {d?.kind === "add" ? <AddDialog mode={d.mode} dispatch={dispatch} /> : null}
      {d?.kind === "edit" ? <EditorDialog draft={d.draft} dispatch={dispatch} /> : null}
      {d?.kind === "options" ? <OptionsDialog state={state} taskId={d.taskId} dispatch={dispatch} /> : null}
      {d?.kind === "confirm" ? <ConfirmDialog confirm={d.confirm} dispatch={dispatch} /> : null}
      {d?.kind === "help" ? <HelpDialog dispatch={dispatch} /> : null}
      {twofa ? <TwofaDialog task={twofa} dispatch={dispatch} /> : null}
      <Toasts toasts={state.toasts} />
    </div>
  );
}
