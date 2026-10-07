// Every run's events since the server started, so a browser that opens or reconnects mid-run can
// rebuild that run's timeline from the first message instead of showing an empty pane.
import type { RunEvent } from "../events.ts";
import type { ManagerEvent, ManagerLike, TaskId } from "../runs/manager.ts";
import type { LoggedRun } from "./api.ts";

export class RunLog {
  #runs = new Map<string, { taskId: TaskId; events: RunEvent[] }>();
  #off: () => void;

  constructor(manager: ManagerLike) {
    this.#off = manager.subscribe((e: ManagerEvent) => {
      if (e.type === "run") {
        const run = this.#runs.get(e.runId) ?? { taskId: e.taskId, events: [] };
        run.events.push(e.event);
        this.#runs.set(e.runId, run);
      } else if (e.type === "task:removed") {
        for (const [runId, run] of this.#runs) if (run.taskId === e.taskId) this.#runs.delete(runId);
      }
    });
  }

  /** The runs seen so far, oldest first, as copies. */
  entries(): LoggedRun[] {
    return [...this.#runs].map(([runId, r]) => ({ taskId: r.taskId, runId, events: [...r.events] }));
  }

  close(): void {
    this.#off();
    this.#runs.clear();
  }
}
