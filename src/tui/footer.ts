// Bottom row: the keys that act right now, or how the quit is going.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { hintPrefix, hints } from "./keys.ts";
import { sanitize } from "./sanitize.ts";
import { liveCount } from "./state.ts";
import type { ViewState } from "./state.ts";

/** Shown while a confirmed quit waits for the runs to stop. */
export function quittingText(s: ViewState): string {
  const n = liveCount(s);
  return n === 0 ? "quitting…" : `stopping ${n} run${n === 1 ? "" : "s"}…`;
}

export function Footer({ s, width }: { s: ViewState; width: number }): ReactElement {
  const text = s.mode === "quitting" ? quittingText(s) : sanitize(hintPrefix(s)) + hints(s).map((x) => `${x.key} ${x.label}`).join(" · ");
  return h(Box, { width, paddingX: 1, flexShrink: 0 }, h(Text, { wrap: "truncate-end" }, text));
}
