// Untrusted text (page titles, snapshots, answers) is drawn as text by React, which already
// escapes markup. This also drops terminal escape sequences and control characters, so nothing
// odd reaches the screen or a copy-paste. Mirrors the TUI's src/tui/sanitize.ts.
const ESCAPES = new RegExp(
  "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?"
    + "|\\x1b\\[[0-?]*[ -/]*[@-~]?"
    + "|\\x1b[ -/]*[0-~]?",
  "g",
);
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const CONTROLS_KEEP_NEWLINES = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

export function clean(s: string, opts: { multiline?: boolean } = {}): string {
  const multiline = opts.multiline ?? false;
  const kept = String(s).replace(ESCAPES, "").replace(/\t/g, " ").replace(multiline ? CONTROLS_KEEP_NEWLINES : CONTROLS, "");
  return multiline ? kept : kept.replace(/\r?\n|\r/g, " ");
}
