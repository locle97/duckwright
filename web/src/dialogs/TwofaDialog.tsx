import { useState } from "react";

import type { TaskSnapshot } from "../../../src/runs/manager.ts";
import { shown } from "../actions.ts";
import type { Dispatch } from "../actions.ts";
import { api } from "../api.ts";
import { clean } from "../clean.ts";
import { twofaWaitKey } from "../store.ts";
import { Button, Modal } from "../ui.tsx";

/** A masked box for a code, or approve/cancel for a passkey. Remounts for each wait, so typed text never carries over. */
export function TwofaDialog(p: { task: TaskSnapshot; dispatch: Dispatch }) {
  return <TwofaForm key={twofaWaitKey(p.task)} task={p.task} dispatch={p.dispatch} />;
}

function TwofaForm(p: { task: TaskSnapshot; dispatch: Dispatch }) {
  const kind = p.task.twofa!.kind;
  const [code, setCode] = useState("");
  const answer = (value: string | null): void => void shown(p.dispatch, api.post(`/api/tasks/${p.task.id}/twofa`, { value }));
  const title = kind === "totp" ? "Authenticator code" : kind === "passkey" ? "Passkey" : kind === "sms" ? "SMS code" : "Email code";
  const name = clean(p.task.name);
  return (
    <Modal
      title={title}
      onClose={() => answer(null)}
      footer={
        <>
          <Button onClick={() => answer(null)}>Cancel</Button>
          {kind === "passkey"
            ? <Button kind="green" onClick={() => answer("")}>Approved</Button>
            : <Button kind="green" disabled={code.trim() === ""} onClick={() => answer(code.trim())}>Submit</Button>}
        </>
      }
    >
      {kind === "passkey" ? (
        <p>Approve the passkey prompt on your device for {name}, then press Approved.</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (code.trim() !== "") answer(code.trim()); }}>
          <div className="field">
            <label htmlFor="twofa-code">{kind === "totp" ? `Authenticator code for ${name}` : `${kind === "sms" ? "SMS" : "Email"} code for ${name}`}</label>
            <input id="twofa-code" type="password" autoComplete="off" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            <span className="hint">The code is hidden and goes only to the running task.</span>
          </div>
        </form>
      )}
    </Modal>
  );
}
