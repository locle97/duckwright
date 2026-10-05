// Appends every run event to a JSONL file. The first failed write disables the sink and
// reports once; the run itself is never affected.
import fs from "node:fs";

import type { RunEvent } from "../events.ts";

export function jsonlSink(file: string, onFail: (message: string) => void): (e: RunEvent) => void {
  let dead = false;
  return (e) => {
    if (dead) return;
    try {
      fs.appendFileSync(file, JSON.stringify(e) + "\n");
    } catch (err) {
      dead = true;
      onFail(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
