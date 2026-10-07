// What a key does inside the 2FA dialog: edit the typed text, answer, or cancel. Pure, so the typed
// text can live in the view layer only (see Workspace) and never reaches the view state or the manager
// until it is answered.
import type { TwofaWait } from "../events.ts";
import type { KeyPress } from "./keypress.ts";

export type TwofaStep = { buffer: string } | { answer: string | null };

const CONTROL = /[\x00-\x1f\x7f]/g;

export function twofaKey(kind: TwofaWait, buffer: string, k: KeyPress): TwofaStep {
  const typed = k.name === null && !k.ctrl && !k.meta ? k.input : "";
  if (kind === "passkey") {
    if (k.name === "return" || typed === "y") return { answer: "" };
    if (k.name === "escape" || typed === "n") return { answer: null };
    return { buffer };
  }
  if (k.name === "escape") return { answer: null };
  if (k.name === "return") return buffer.trim() === "" ? { buffer } : { answer: buffer.trim() };
  if (k.name === "backspace") return { buffer: [...buffer].slice(0, -1).join("") };
  const printable = typed.replace(CONTROL, "");
  return printable === "" ? { buffer } : { buffer: buffer + printable };
}
