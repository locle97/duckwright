import { quitServer, removePlan, removeTask } from "../actions.ts";
import type { Dispatch } from "../actions.ts";
import type { Confirm } from "../store.ts";
import { Button, Modal } from "../ui.tsx";

export function ConfirmDialog(p: { confirm: Confirm; dispatch: Dispatch }) {
  const { confirm: c, dispatch } = p;
  const close = (): void => dispatch({ type: "dialog", value: null });
  const text = c.kind === "quit"
    ? { title: "Quit Duckwright?", body: `${c.count} run${c.count === 1 ? " is" : "s are"} active. Quitting stops ${c.count === 1 ? "it" : "them"} and shuts the server down.`, yes: "Stop and quit" }
    : c.kind === "remove"
      ? { title: "Remove this task?", body: "The task leaves the list. Its file is not deleted.", yes: "Remove" }
      : { title: "Remove this plan?", body: "The plan and its tasks leave the list. Their files stay.", yes: "Remove plan" };
  const confirm = async (): Promise<void> => {
    if (c.kind === "quit") {
      await quitServer(dispatch);
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
    </Modal>
  );
}
