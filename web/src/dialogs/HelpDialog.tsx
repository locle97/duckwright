import type { Dispatch } from "../actions.ts";
import { SHORTCUTS } from "../shortcuts.ts";
import { Button, Modal } from "../ui.tsx";

export function HelpDialog(p: { dispatch: Dispatch }) {
  const close = (): void => p.dispatch({ type: "dialog", value: null });
  return (
    <Modal title="Keyboard shortcuts" onClose={close} footer={<Button onClick={close}>Close</Button>}>
      <p className="muted">These work when no text field has the focus.</p>
      <table>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.key}>
              <td style={{ paddingRight: 16, whiteSpace: "nowrap" }}><kbd>{s.key}</kbd></td>
              <td>{s.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
