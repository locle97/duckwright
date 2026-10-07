import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { Candidate } from "../../../src/tui/candidates.ts";
import { applyCompletion, mentionAt, submission } from "../../../src/tui/compose.ts";
import type { Dispatch } from "../actions.ts";
import { api } from "../api.ts";
import { clean } from "../clean.ts";
import { Button, Modal } from "../ui.tsx";

/** Adds a task (typed text plus `@file` mentions) or plans a plan file; `@` opens a ranked file list. */
export function AddDialog(p: { mode: "task" | "plan"; dispatch: Dispatch }) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<Candidate[]>([]);
  const [hl, setHl] = useState(0);
  const [listOpen, setListOpen] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);

  const query = mentionAt(text, cursor)?.path ?? null;
  const showList = listOpen && query !== null && items.length > 0;

  useEffect(() => {
    if (query === null) {
      seq.current++;
      setItems([]);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const r = await api.get(`/api/candidates?q=${encodeURIComponent(query)}`);
      if (mine === seq.current && r.ok) {
        setItems(r.items as Candidate[]);
        setHl(0);
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [query]);

  const close = (): void => p.dispatch({ type: "dialog", value: null });

  const accept = (c: Candidate): void => {
    const next = applyCompletion({ text, cursor, history: [], historyIndex: null, draft: "" }, c.path, c.folder ? "descend" : "accept");
    setText(next.text);
    setCursor(next.cursor);
    setListOpen(true);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const send = async (): Promise<void> => {
    const sub = submission(text);
    if (p.mode === "task") {
      if (sub.mentions.length === 0 && sub.typed === null) return setErrors(["Type a task, or @ a task file."]);
      setBusy(true);
      const r = await api.post("/api/tasks", { mentions: sub.mentions.map((m) => m.path), typed: sub.typed });
      setBusy(false);
      if (!r.ok) {
        setErrors(Array.isArray(r.errors) ? (r.errors as { message: string }[]).map((e) => e.message) : [r.error]);
        return;
      }
      close();
      const added = r.added as number[];
      if (added.length > 0) p.dispatch({ type: "select", selection: { kind: "task", id: added[0]! } });
      const dup = r.duplicates as string[];
      if (dup.length > 0) p.dispatch({ type: "toast", level: "info", message: `already in the list: ${dup.join(", ")}` });
      return;
    }
    const source = sub.mentions[0]?.path ?? sub.typed;
    if (!source) return setErrors(["Give a plan file or a planned folder (@ picks one)."]);
    setBusy(true);
    const r = await api.post("/api/plans", { source: source.trim() });
    setBusy(false);
    if (!r.ok) return setErrors([r.error]);
    close();
    p.dispatch({ type: "select", selection: { kind: "plan", id: r.id as number } });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showList) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, items.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); accept(items[hl]!); return; }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (p.mode === "plan" && !e.shiftKey))) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Modal
      title={p.mode === "task" ? "Add a task" : "Plan a test plan file"}
      onClose={() => (showList ? setListOpen(false) : close())}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button kind="green" disabled={busy} onClick={() => void send()}>{p.mode === "task" ? "Add" : "Plan"}</Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="add-text">{p.mode === "task" ? "Task" : "Plan file"}</label>
        <textarea id="add-text" ref={area} rows={p.mode === "task" ? 6 : 2} value={text} spellCheck={false}
          onChange={(e) => { setText(e.target.value); setCursor(e.target.selectionStart); setErrors([]); setListOpen(true); }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)} onKeyDown={onKeyDown} />
        <span className="hint">
          {p.mode === "task"
            ? "Describe what the agent should do. @ mentions a task file (@tasks/login.md) or a folder of them. Ctrl+Enter adds."
            : "@ picks the plan file, or type its path. Enter plans it."}
        </span>
      </div>
      {showList ? (
        <div className="completion" role="listbox" aria-label="Files">
          {items.map((c, i) => (
            <button type="button" key={c.path} role="option" aria-selected={i === hl} className={i === hl ? "hl" : ""}
              onMouseDown={(e) => { e.preventDefault(); accept(c); }}>
              {clean(c.path)}{c.folder ? `  (${c.count} task${c.count === 1 ? "" : "s"})` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {errors.map((m, i) => <p className="error" key={i}>{clean(m)}</p>)}
    </Modal>
  );
}
