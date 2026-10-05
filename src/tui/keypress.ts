export type KeyName =
  | "return"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end";

/** One key press, independent of Ink. Printable characters arrive in `input`; special keys in `name`. */
export interface KeyPress {
  input: string;
  name: KeyName | null;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

const NAMES: readonly KeyName[] = [
  "return", "escape", "tab", "backspace", "delete", "up", "down", "left", "right", "pageUp", "pageDown", "home", "end",
];

/** Build a KeyPress from a spec such as "a", "ctrl+c", "alt+return", "up", "shift+tab", "space". */
export function key(spec: string): KeyPress {
  const parts = spec.split("+");
  let last = parts.pop() ?? "";
  if (last === "" && parts.length > 0) last = "+"; // "ctrl++"
  const k: KeyPress = { input: "", name: null, ctrl: false, meta: false, shift: false };
  for (const mod of parts) {
    if (mod === "ctrl") k.ctrl = true;
    else if (mod === "alt" || mod === "meta") k.meta = true;
    else if (mod === "shift") k.shift = true;
    else if (mod !== "") throw new Error(`unknown modifier in key spec: ${spec}`);
  }
  const name = NAMES.find((n) => n.toLowerCase() === last.toLowerCase());
  if (name !== undefined && last.length > 1) k.name = name;
  else k.input = last === "space" ? " " : last;
  return k;
}
