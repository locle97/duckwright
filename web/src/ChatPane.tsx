// The test chat screen: the chats on the left; on the right the open conversation with its phase
// strip, messages and input (with @ file completion, uploads, model and spend ceiling).
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { ChatMeta, ChatMessage } from "../../src/chat/types.ts";
import type { Candidate } from "../../src/tui/candidates.ts";
import { applyCompletion, mentionAt } from "../../src/tui/compose.ts";
import { checked, shown } from "./actions.ts";
import type { Dispatch } from "./actions.ts";
import { api } from "./api.ts";
import { PHASES, groupMessages, planForFolder } from "./chat.ts";
import { clean } from "./clean.ts";
import type { WebState } from "./store.ts";
import { Button, Tag } from "./ui.tsx";

const MODELS = ["sonnet", "opus", "haiku"];
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Shows a chat: marks it open at once (so streamed messages are kept), then loads its history. */
export async function openChat(d: Dispatch, id: string): Promise<void> {
  d({ type: "chat:opening", id });
  const r = await shown(d, api.get(`/api/chats/${encodeURIComponent(id)}`));
  if (r.ok) d({ type: "chat:opened", chat: r.chat as ChatMeta, turn: r.turn as "idle" | "running" | "stopping", messages: r.messages as ChatMessage[] });
}

async function newChat(d: Dispatch): Promise<void> {
  const r = await shown(d, api.post("/api/chats"));
  if (r.ok) await openChat(d, (r.chat as ChatMeta).id);
}

export function ChatPane(p: { state: WebState; dispatch: Dispatch }) {
  const { chat: c } = p.state;
  const open = c.chats.find((x) => x.chat.id === c.openId) ?? null;
  // Coming to the chat view with nothing open shows the most recent chat.
  useEffect(() => {
    if (c.openId === null && c.chats.length > 0) void openChat(p.dispatch, c.chats[0]!.chat.id);
  }, [c.openId, c.chats.length === 0]);
  return (
    <div className="chat">
      <aside className="chat-list" aria-label="Chats">
        <Button kind="green" onClick={() => void newChat(p.dispatch)}>+ New chat</Button>
        <div className="list">
          {c.chats.map(({ chat, turn }) => (
            <button type="button" key={chat.id} className={`row ${chat.id === c.openId ? "sel" : ""}`} onClick={() => void openChat(p.dispatch, chat.id)}>
              <span className="name">{clean(chat.title)}</span>
              {turn !== "idle" ? <Tag tone="run">{turn === "stopping" ? "stopping" : "working"}</Tag> : null}
            </button>
          ))}
          {c.chats.length === 0 ? <span className="muted">No chats yet.</span> : null}
        </div>
      </aside>
      {open ? <Conversation key={open.chat.id} state={p.state} chat={open.chat} turn={open.turn} dispatch={p.dispatch} /> : (
        <main className="chat-main"><div className="card"><b>No chat open.</b><p className="muted">Start one with “+ New chat” and describe what you want tested.</p></div></main>
      )}
    </div>
  );
}

function Conversation(p: { state: WebState; chat: ChatMeta; turn: "idle" | "running" | "stopping"; dispatch: Dispatch }) {
  const { chat, turn } = p;
  const c = p.state.chat;
  const [cursor, setCursor] = useState(0);
  const [items, setItems] = useState<Candidate[]>([]);
  const [hl, setHl] = useState(0);
  const [listOpen, setListOpen] = useState(true);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const busy = useRef(false);

  const query = mentionAt(c.draft, cursor)?.path ?? null;
  const showList = listOpen && query !== null && items.length > 0;

  useEffect(() => {
    if (query === null) {
      seq.current++;
      setItems([]);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const r = await checked(p.dispatch, api.get(`/api/candidates?q=${encodeURIComponent(query)}`));
      if (mine === seq.current && r.ok) {
        setItems(r.items as Candidate[]);
        setHl(0);
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [c.messages.length]);

  const accept = (cand: Candidate): void => {
    const next = applyCompletion({ text: c.draft, cursor, history: [], historyIndex: null, draft: "" }, cand.path, cand.folder ? "descend" : "accept");
    p.dispatch({ type: "chat:draft", text: next.text });
    setCursor(next.cursor);
    setListOpen(true);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const send = async (): Promise<void> => {
    if (busy.current || (c.draft.trim() === "" && c.attachments.length === 0)) return;
    busy.current = true;
    setSending(true);
    try {
      const r = await shown(p.dispatch, api.post(`/api/chats/${chat.id}/messages`, { text: c.draft, attachments: c.attachments }));
      if (r.ok) p.dispatch({ type: "chat:sent" });
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  const upload = async (f: File): Promise<void> => {
    const r = await shown(p.dispatch, api.upload(`/api/chats/${chat.id}/uploads?name=${encodeURIComponent(f.name)}`, f));
    if (r.ok) p.dispatch({ type: "chat:attach", path: r.path as string });
  };

  const save = async (o: { model?: string; ceilingUsd?: number }): Promise<void> => {
    await shown(p.dispatch, api.put(`/api/chats/${chat.id}`, o));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showList) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(h + 1, items.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); accept(items[hl]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setListOpen(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const showPlan = (): void => {
    const plan = planForFolder(p.state.plans, chat.planFolder);
    if (!plan) return p.dispatch({ type: "toast", level: "error", message: `plan not found in the workspace: ${chat.planFolder}` });
    p.dispatch({ type: "view", view: "workspace" });
    p.dispatch({ type: "select", selection: { kind: "plan", id: plan.id } });
  };

  const groups = groupMessages(c.messages);
  return (
    <main className="chat-main">
      <div className="chat-bar">
        <b className="grow name">{clean(chat.title)}</b>
        <span className="muted" aria-label="Spend">{usd(chat.spentUsd)} / {usd(chat.ceilingUsd)}</span>
        {chat.planFolder !== null ? <Button small onClick={showPlan} title={clean(chat.planFolder)}>Show plan</Button> : null}
      </div>
      <div className="phases" aria-label="Phase">
        {PHASES.map((ph) => <span key={ph} className={`phase ${chat.phase === ph ? "on" : ""}`} aria-current={chat.phase === ph ? "step" : undefined}>{ph}</span>)}
      </div>
      <div className="chat-log" ref={log} role="log" aria-label="Conversation">
        {groups.map((g, i) => g.kind === "activity" ? (
          <details key={i} className="chat-activity">
            <summary>{g.lines.length === 1 ? clean(g.lines[0]!) : `${g.lines.length} steps · ${clean(g.lines[g.lines.length - 1]!)}`}</summary>
            {g.lines.map((l, j) => <div key={j}>{clean(l)}</div>)}
          </details>
        ) : <Message key={i} m={g.message} />)}
        {turn !== "idle" ? <div className="muted">{turn === "stopping" ? "Stopping…" : "Working…"}</div> : null}
      </div>
      <div className="chat-input">
        <div className="row-actions">
          <label className="muted">Model <input className="input chat-model" list="chat-models" defaultValue={chat.model} key={`m:${chat.model}`} aria-label="Model" spellCheck={false}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== "" && v !== chat.model) void save({ model: v }); }} /></label>
          <datalist id="chat-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
          <label className="muted">Ceiling $ <input className="input chat-ceiling" type="number" min="0" step="0.5" defaultValue={chat.ceilingUsd} key={`c:${chat.ceilingUsd}`} aria-label="Spend ceiling"
            onBlur={(e) => { const v = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(v) && v !== chat.ceilingUsd) void save({ ceilingUsd: v }); }} /></label>
        </div>
        {c.attachments.length > 0 ? (
          <div className="row-actions">
            {c.attachments.map((a) => (
              <span key={a} className="tag">{clean(a.split(/[\\/]/).pop() ?? a)} <button type="button" className="chip-x" aria-label={`Remove ${clean(a)}`} onClick={() => p.dispatch({ type: "chat:detach", path: a })}>✕</button></span>
            ))}
          </div>
        ) : null}
        <textarea id="chat-text" ref={area} className="input" rows={3} value={c.draft} spellCheck={false} aria-label="Message"
          placeholder="Describe what to test. @ mentions a file. Enter sends, Shift+Enter adds a line."
          onChange={(e) => { p.dispatch({ type: "chat:draft", text: e.target.value }); setCursor(e.target.selectionStart); setListOpen(true); }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)} onKeyDown={onKeyDown} />
        {showList ? (
          <div className="completion" role="listbox" aria-label="Files">
            {items.map((cand, i) => (
              <button type="button" key={cand.path} role="option" aria-selected={i === hl} className={i === hl ? "hl" : ""}
                onMouseDown={(e) => { e.preventDefault(); accept(cand); }}>
                {clean(cand.path)}{cand.folder ? `  (${cand.count} task${cand.count === 1 ? "" : "s"})` : ""}
              </button>
            ))}
          </div>
        ) : null}
        <div className="row-actions">
          <input ref={file} type="file" hidden data-chat-upload onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
          <Button onClick={() => file.current?.click()}>Upload</Button>
          <span className="grow" />
          {turn !== "idle" ? <Button kind="red" disabled={turn === "stopping"} onClick={() => void shown(p.dispatch, api.post(`/api/chats/${chat.id}/stop`))}>Stop</Button> : null}
          <Button kind="green" disabled={sending} onClick={() => void send()}>Send</Button>
        </div>
      </div>
    </main>
  );
}

function Message(p: { m: ChatMessage }) {
  const m = p.m;
  switch (m.kind) {
    case "person":
      return (
        <div className="msg person">
          <pre>{clean(m.text, { multiline: true })}</pre>
          {m.attachments.length > 0 ? <div className="muted">{m.attachments.map((a) => clean(a)).join(", ")}</div> : null}
        </div>
      );
    case "agent":
      return <div className="msg agent"><pre>{clean(m.text, { multiline: true })}</pre></div>;
    case "questions":
      return (
        <div className="card msg questions">
          <b>Questions</b>
          <ol>{m.questions.map((q, i) => <li key={i}>{clean(q)}</li>)}</ol>
        </div>
      );
    case "error":
      return <p className="error">{clean(m.text, { multiline: true })}</p>;
    case "activity":
      return <div className="muted">{clean(m.text)}</div>;
  }
}
