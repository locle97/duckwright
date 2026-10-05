import { flat, neutralise } from "../text.ts";

// OSC (ended by BEL or ST), CSI, then any other two-character escape.
const ESCAPES = new RegExp(
  "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?"
    + "|\\x1b\\[[0-?]*[ -/]*[@-~]?"
    + "|\\x1b[ -/]*[0-~]?",
  "g",
);
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Make untrusted text safe to draw in the terminal: no escapes, no controls, no harness tags. */
export function sanitize(s: string, opts: { multiline?: boolean } = {}): string {
  const multiline = opts.multiline ?? false;
  const kept = String(s).replace(ESCAPES, "").replace(/\t/g, " ")
    .replace(multiline ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g : CONTROLS, "");
  const safe = neutralise(kept);
  return multiline ? safe : flat(safe);
}
