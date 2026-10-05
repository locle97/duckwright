// Top bar: the app name on the left; task counts, total cost and time open on the right.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { TaskState } from "../runs/manager.ts";
import { fixed4 } from "../text.ts";
import { headerCounts } from "./state.ts";
import type { ViewState } from "./state.ts";
import { paneBorder } from "./theme.ts";
import { useTheme } from "./themeContext.ts";

const ORDER: readonly TaskState[] = ["running", "paused", "stopping", "passed", "failed", "stopped", "idle"];

const two = (n: number): string => String(n).padStart(2, "0");

/** `HH:MM:SS` for a duration. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${two(Math.floor(total / 3600))}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}`;
}

export function headerSummary(s: ViewState): string {
  const { counts, cost, elapsedMs } = headerCounts(s);
  const parts = ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${counts[k]} ${k}`);
  return [...parts, `$${fixed4(cost)}`, clock(elapsedMs)].join(" · ");
}

export function Header({ s, width }: { s: ViewState; width: number }): ReactElement {
  const theme = useTheme();
  return h(Box, { ...paneBorder(theme, false), paddingX: 1, width, flexShrink: 0 },
    h(Box, { flexShrink: 0, marginRight: 2 }, h(Text, { bold: true, wrap: "truncate-end" }, "🦆 duckwright")),
    h(Box, { flexGrow: 1, flexShrink: 1, justifyContent: "flex-end" }, h(Text, { wrap: "truncate-end" }, headerSummary(s))));
}
