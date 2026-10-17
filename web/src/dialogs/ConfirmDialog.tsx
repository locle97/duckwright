import { useState } from "react";

import { quitServer, refreshEnvironments, removePlan, removeTask, shown } from "../actions.ts";
import { api } from "../api.ts";
import type { Dispatch } from "../actions.ts";
import type { Confirm } from "../store.ts";
import { Button, Modal } from "../ui.tsx";

export function ConfirmDialog(p: { confirm: Confirm; dispatch: Dispatch }) {
  const { confirm: c, dispatch } = p;
  const [deleteFile, setDeleteFile] = useState(false);
  // Removing an environment came from the Environments page, so closing goes back to it.
  const close = (): void => dispatch({ type: "dialog", value: c.kind === "removeEnvironment" ? { kind: "environments" } : null });
  const text = c.kind === "quit"
    ? { title: "Quit Duckwright?", body: `${c.count} run${c.count === 1 ? " is" : "s are"} active. Quitting stops ${c.count === 1 ? "it" : "them"} and shuts the server down.`, yes: "Stop and quit" }
    : c.kind === "remove"
      ? { title: "Remove this task?", body: "The task leaves the list. Its file is not deleted.", yes: "Remove" }
      : c.kind === "removeEnvironment"
        ? { title: `Remove environment ${c.name}?`, body: "Its base URL, login origins and accounts (with their passwords and TOTP secrets) are deleted.", yes: "Remove environment" }
        : { title: "Remove this plan?", body: "The plan and its tasks leave the list. Their files stay.", yes: "Remove plan" };
  const confirm = async (): Promise<void> => {
    if (c.kind === "quit") {
      await quitServer(dispatch);
      return;
    }
    if (c.kind === "removeEnvironment") {
      const r = await shown(dispatch, api.del(`/api/environments/${encodeURIComponent(c.name)}${deleteFile ? "?file=1" : ""}`));
      if (r.ok) {
        await refreshEnvironments(dispatch);
        close();
      }
      return;
    }
    const r = c.kind === "remove" ? await removeTask(dispatch, c.taskId) : await removePlan(dispatch, c.planId);
    if (r.ok) close();
  };
  return (
    <Modal title={text.title} onClose={close} footer={
      <>
        <Button onClick={close}>Cancel</Button>
        <Button kind="red" onClick={() => void confirm()}>{text.yes}</Button>
      </>
    }>
      <p>{text.body}</p>
      {c.kind === "removeEnvironment" ? (
        <label htmlFor="confirm-env-file">
          <input type="checkbox" id="confirm-env-file" checked={deleteFile} onChange={(e) => setDeleteFile(e.target.checked)} />
          {" "}Also delete environments/{c.name}.md
        </label>
      ) : null}
    </Modal>
  );
}
