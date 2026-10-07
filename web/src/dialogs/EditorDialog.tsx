import { useState } from "react";

import { saveEditor } from "../actions.ts";
import type { Dispatch } from "../actions.ts";
import { clean } from "../clean.ts";
import type { EditDraft } from "../store.ts";
import { Button, Modal } from "../ui.tsx";

/** Edits a task file (or a typed task, or a plan's shared setup) as text. */
export function EditorDialog(p: { draft: EditDraft; dispatch: Dispatch }) {
  const { draft, dispatch } = p;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = draft.text !== draft.original;
  const close = (): void => dispatch({ type: "dialog", value: null });
  const save = async (): Promise<void> => {
    setBusy(true);
    await saveEditor(dispatch, draft);
    setBusy(false);
  };
  return (
    <Modal
      wide
      title={`Edit ${draft.title}`}
      onClose={() => (changed ? setAsking(true) : close())}
      footer={
        <>
          <Button onClick={() => (changed ? setAsking(true) : close())}>Cancel</Button>
          <Button kind="green" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      {asking ? (
        <p className="error">
          Discard your changes?{" "}
          <Button small kind="red" onClick={close}>Discard</Button>{" "}
          <Button small onClick={() => setAsking(false)}>Keep editing</Button>
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="edit-text">{clean(draft.title)}</label>
        <textarea id="edit-text" className="mono" style={{ minHeight: 320 }} spellCheck={false} value={draft.text}
          onChange={(e) => dispatch({ type: "editText", text: e.target.value })}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              if (changed) void save();
            }
          }} />
        <span className="hint">Ctrl+S saves.</span>
      </div>
      {draft.error ? <p className="error">{clean(draft.error)}</p> : null}
    </Modal>
  );
}
