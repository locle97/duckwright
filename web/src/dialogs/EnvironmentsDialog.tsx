import { useCallback, useEffect, useState } from "react";

import { refreshEnvironments, shown } from "../actions.ts";
import type { Dispatch } from "../actions.ts";
import { api } from "../api.ts";
import { clean } from "../clean.ts";
import { Button, Modal, Tag } from "../ui.tsx";
import { AccountForm } from "./AccountForm.tsx";
import type { AccountSummaryView } from "./AccountForm.tsx";

interface EnvView { name: string; baseUrl: string | null; loginOrigins: string[]; accounts: AccountSummaryView[] }

/** The environments page: the list, and for the chosen one its base URL, login origins, context and accounts. */
export function EnvironmentsDialog(p: { dispatch: Dispatch }) {
  const [items, setItems] = useState<EnvView[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [form, setForm] = useState<{ baseUrl: string; origins: string; context: string } | null>(null);
  const [editing, setEditing] = useState<AccountSummaryView | null>(null);
  const close = (): void => p.dispatch({ type: "dialog", value: null });

  const reload = useCallback(async (): Promise<EnvView[]> => {
    const r = await shown(p.dispatch, api.get("/api/environments"));
    const list = r.ok ? ((r as unknown as { items: EnvView[] }).items) : [];
    setItems(list);
    return list;
  }, [p.dispatch]);
  const open = useCallback(async (n: string): Promise<void> => {
    const r = await shown(p.dispatch, api.get(`/api/environments/${encodeURIComponent(n)}`));
    if (!r.ok) return;
    const e = (r as unknown as { environment: EnvView & { context: string } }).environment;
    setName(n);
    setEditing(null);
    setForm({ baseUrl: e.baseUrl ?? "", origins: e.loginOrigins.join("\n"), context: e.context });
  }, [p.dispatch]);
  useEffect(() => { void reload(); }, [reload]);

  const current = items.find((i) => i.name === name) ?? null;
  const create = async (): Promise<void> => {
    const n = newName.trim();
    const r = await shown(p.dispatch, api.post("/api/environments", { name: n, context: "" }));
    if (!r.ok) return;
    setNewName("");
    await reload();
    await refreshEnvironments(p.dispatch);
    await open(n);
  };
  const saveSettings = async (): Promise<void> => {
    if (!name || !form) return;
    const origins = form.origins.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const r = await shown(p.dispatch, api.put(`/api/environments/${encodeURIComponent(name)}`, {
      baseUrl: form.baseUrl.trim() === "" ? null : form.baseUrl.trim(), loginOrigins: origins, context: form.context,
    }));
    if (r.ok) await reload();
  };
  const removeAccount = async (a: AccountSummaryView): Promise<void> => {
    const r = await shown(p.dispatch, api.del(`/api/environments/${encodeURIComponent(a.env)}/accounts/${encodeURIComponent(a.id)}`));
    if (r.ok) await reload();
  };

  return (
    <Modal wide title="Environments" onClose={close} footer={<Button onClick={close}>Close</Button>}>
      <div className="field">
        <label htmlFor="env-new">new environment</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="env-new" value={newName} placeholder="dev" style={{ flex: 1 }}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim() !== "") void create(); }} />
          <Button kind="green" disabled={newName.trim() === ""} onClick={() => void create()}>Create</Button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {items.length === 0 ? <span className="muted">No environments yet.</span> : null}
        {items.map((i) => (
          <Button key={i.name} small kind={i.name === name ? "blue" : "default"} onClick={() => void open(i.name)}>
            {clean(i.name)}
          </Button>
        ))}
      </div>
      {name && form ? (
        <section aria-label={`Environment ${name}`}>
          <h3 style={{ margin: "0 0 8px" }}>{clean(name)}</h3>
          <div className="field">
            <label htmlFor="env-base">base URL</label>
            <input id="env-base" value={form.baseUrl} placeholder="https://dev.example.com" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="env-origins">login origins (one per line)</label>
            <textarea id="env-origins" style={{ minHeight: 60 }} value={form.origins} onChange={(e) => setForm({ ...form, origins: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="env-context">context</label>
            <textarea id="env-context" value={form.context} onChange={(e) => setForm({ ...form, context: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <Button kind="green" onClick={() => void saveSettings()}>Save environment</Button>
            <Button kind="red" onClick={() => p.dispatch({ type: "dialog", value: { kind: "confirm", confirm: { kind: "removeEnvironment", name } } })}>Remove environment</Button>
          </div>
          <table>
            <thead><tr><th>id</th><th>label</th><th>role</th><th>username</th><th>secrets</th><th /></tr></thead>
            <tbody>
              {(current?.accounts ?? []).map((a) => (
                <tr key={a.id}>
                  <td>{clean(a.id)}</td><td>{clean(a.label)}</td><td>{clean(a.role)}</td><td>{clean(a.username)}</td>
                  <td>
                    {a.hasPassword ? <Tag tone="pass">password set</Tag> : <Tag>no password</Tag>}
                    {a.hasTotp ? <Tag tone="pass">TOTP set</Tag> : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button small onClick={() => setEditing(a)}>Edit</Button>{" "}
                    <Button small kind="red" onClick={() => void removeAccount(a)}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AccountForm key={`${name}:${editing?.id ?? "new"}`} env={name} hasBaseUrl={(current?.baseUrl ?? null) !== null} editing={editing}
            dispatch={p.dispatch} onDone={() => { setEditing(null); void reload(); }} />
        </section>
      ) : null}
    </Modal>
  );
}
