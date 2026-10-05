// Short-lived messages, stacked at the top right of the panes.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { Dialog } from "./dialog.ts";
import { sanitize } from "./sanitize.ts";
import type { Toast } from "./state.ts";
import { useTheme } from "./themeContext.ts";

export function Toasts({ toasts, width }: { toasts: Toast[]; width: number }): ReactElement | null {
  const theme = useTheme();
  if (toasts.length === 0) return null;
  const boxWidth = Math.max(10, Math.min(60, width - 4));
  return h(Box, { position: "absolute", top: 0, left: 0, width, flexDirection: "column", alignItems: "flex-end", paddingRight: 1 },
    ...toasts.map((t) => {
      const color = t.level === "error" ? theme.role.error : theme.role.accent;
      const message = sanitize(t.message);
      return h(Dialog, {
        key: t.id, width: Math.min(boxWidth, [...message].length + 4), borderColor: color,
        rows: [h(Text, { wrap: "truncate-end" }, message)],
      });
    }));
}
