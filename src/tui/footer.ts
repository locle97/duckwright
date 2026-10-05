// Bottom row: the keys that act right now.
import { Box, Text } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";

import { hints } from "./keys.ts";
import type { ViewState } from "./state.ts";

export function Footer({ s, width }: { s: ViewState; width: number }): ReactElement {
  const text = hints(s).map((x) => `${x.key} ${x.label}`).join(" · ");
  return h(Box, { width, paddingX: 1, flexShrink: 0 }, h(Text, { wrap: "truncate-end" }, text));
}
