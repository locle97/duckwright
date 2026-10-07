// The 2FA dialog: a masked input for a code or the TOTP secret, or an approve/cancel question for a passkey.
import { Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import type { TaskSnapshot } from "../runs/manager.ts";
import { Centered, Dialog } from "./dialog.ts";
import { sanitize } from "./sanitize.ts";
import { useTheme } from "./themeContext.ts";

export interface TwofaDialogProps { task: TaskSnapshot; typed: string; width: number; height: number }

export function TwofaDialog({ task, typed, width, height }: TwofaDialogProps): ReactElement | null {
  const { role } = useTheme();
  if (task.twofa === null) return null;
  const kind = task.twofa.kind;
  const name = sanitize(task.name);
  const title = kind === "secret" ? "TOTP secret" : kind === "passkey" ? "Passkey" : kind === "sms" ? "SMS code" : "Email code";
  const ask = kind === "secret" ? `Enter the TOTP secret for ${name}`
    : kind === "passkey" ? `Approve the passkey prompt on your device for ${name}`
    : `Enter the ${kind === "sms" ? "SMS" : "email"} code for ${name}`;
  const rows: ReactElement[] = [h(Text, { bold: true, wrap: "truncate-end" }, ask)];
  if (kind !== "passkey") rows.push(h(Text, { wrap: "truncate-end" }, `${"•".repeat([...typed].length)}▌`));
  rows.push(h(Text, { color: role.muted, wrap: "truncate-end" },
    kind === "passkey" ? "y/⏎ approved · n/esc cancel" : "⏎ submit · esc cancel · input is hidden"));
  const dialogWidth = Math.min(width, Math.max(30, Math.min(64, width - 4)));
  return h(Centered, { width, height, child: h(Dialog, { width: dialogWidth, borderColor: role.accent, rows, title }) });
}
