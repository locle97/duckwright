import { useState } from "react";

import { shown } from "../actions.ts";
import type { Dispatch } from "../actions.ts";
import { api } from "../api.ts";
import { accountBody, duplicateAccountWarning, shortPasswordWarning } from "../environment.ts";
import type { AccountDraft } from "../environment.ts";
import { Button } from "../ui.tsx";

export interface AccountSummaryView { env: string; id: string; label: string; role: string; username: string; hasPassword: boolean; hasTotp: boolean }

const blank: AccountDraft = { id: "", label: "", role: "", username: "", password: "", totpSecret: "", clearTotp: false };

/**
 * Adds or edits one account. Secret inputs start empty (the server never returns them); empty keeps the stored one.
 * Adding refuses an id already in `existingIds`, since saving would overwrite that account.
 */
export function AccountForm(p: {
  env: string; hasBaseUrl: boolean; editing: AccountSummaryView | null; existingIds: readonly string[]; dispatch: Dispatch; onDone(): void;
}) {
  const e = p.editing;
  const [d, setD] = useState<AccountDraft>(e ? { ...blank, id: e.id, label: e.label, role: e.role, username: e.username } : blank);
  const [busy, setBusy] = useState(false);
  const off = !p.hasBaseUrl || busy;
  const set = (k: keyof AccountDraft, v: string | boolean): void => setD({ ...d, [k]: v });
  const warn = shortPasswordWarning(d.password);
  const duplicate = duplicateAccountWarning(d.id, p.existingIds, !!e);
  const save = async (): Promise<void> => {
    if (duplicate !== null) return;
    setBusy(true);
    const r = await shown(p.dispatch, api.put(`/api/environments/${encodeURIComponent(p.env)}/accounts/${encodeURIComponent(d.id)}`, accountBody(d)));
    setBusy(false);
    if (r.ok) {
      setD(blank);
      p.onDone();
    }
  };
  return (
    <fieldset className="evidence" disabled={!p.hasBaseUrl}>
      <legend>{e ? `Edit account ${e.id}` : "Add an account"}</legend>
      {!p.hasBaseUrl ? <p className="hint">Save a base URL first: accounts only type their secrets on that origin.</p> : null}
      <div className="field">
        <label htmlFor="acc-id">id</label>
        <input id="acc-id" value={d.id} readOnly={!!e} placeholder="admin" onChange={(ev) => set("id", ev.target.value.toLowerCase())} />
        {duplicate ? <span className="hint" role="alert">{duplicate}</span> : null}
      </div>
      <div className="field">
        <label htmlFor="acc-label">label</label>
        <input id="acc-label" value={d.label} onChange={(ev) => set("label", ev.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="acc-role">role</label>
        <input id="acc-role" value={d.role} onChange={(ev) => set("role", ev.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="acc-username">username</label>
        <input id="acc-username" value={d.username} autoComplete="off" onChange={(ev) => set("username", ev.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="acc-password">password</label>
        <input id="acc-password" type="password" autoComplete="new-password" value={d.password}
          placeholder={e?.hasPassword ? "set (leave empty to keep)" : ""} onChange={(ev) => set("password", ev.target.value)} />
        {warn ? <span className="hint" role="note">{warn}</span> : null}
      </div>
      <div className="field">
        <label htmlFor="acc-totp">TOTP secret</label>
        <input id="acc-totp" type="password" autoComplete="new-password" value={d.totpSecret} disabled={d.clearTotp}
          placeholder={e?.hasTotp ? "set (leave empty to keep)" : ""} onChange={(ev) => set("totpSecret", ev.target.value)} />
        {e?.hasTotp ? (
          <label htmlFor="acc-clear-totp">
            <input type="checkbox" id="acc-clear-totp" checked={d.clearTotp} onChange={(ev) => set("clearTotp", ev.target.checked)} />
            {" "}Clear the TOTP secret
          </label>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="green" disabled={off || d.id === "" || duplicate !== null} onClick={() => void save()}>{e ? "Save account" : "Add account"}</Button>
        {e ? <Button onClick={p.onDone}>Cancel</Button> : null}
      </div>
    </fieldset>
  );
}
