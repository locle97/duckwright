// Placeholder until the Ink workspace lands.
import type { TuiHandle } from "../cli.ts";
import type { ManagerLike } from "../runs/manager.ts";

export function startTui(_o: { manager: ManagerLike }): TuiHandle {
  throw new Error("TUI not built yet");
}
