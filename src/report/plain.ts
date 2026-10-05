// Plain-text output for a run: step lines as they happen, then the final summary.
import type { RunEvents, RunOutcome } from "../events.ts";
import { stepLine } from "../prompt.ts";
import { fixed4 } from "../text.ts";

export function attachPlain(events: RunEvents, out: (line: string) => void): () => void {
  return events.subscribe((e) => {
    if (e.type === "step:end") out(stepLine(e.record));
  });
}

export function printOutcome(o: RunOutcome, out: (l: string) => void, err: (l: string) => void): void {
  if (o.error !== null) {
    err(o.error);
    return;
  }
  out(`Result: ${o.success ? "success" : "failure"}`);
  out(`Answer: ${o.answer}`);
  out(`Steps: ${o.steps}  Cost: $${fixed4(o.costUsd)}`);
  out(`History: ${o.historyPath}`);
  for (const w of o.warnings) err(`warning: ${w}`);
  const x = o.export;
  if (x.kind === "skipped") out("Test: not exported (run did not succeed)");
  else if (x.kind === "written") out(`Test: ${x.path}`);
  else if (x.kind === "failed") err(`export failed: ${x.message}`);
}
