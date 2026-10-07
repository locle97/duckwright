import type { Decision } from "./brain.ts";
import type { SnapshotMode } from "./observe.ts";
import type { StepRecord } from "./prompt.ts";

export type Phase = "observing" | "thinking" | "acting";
export type ControlState = "running" | "paused" | "stepping" | "stopping";
export type ExportOutcome =
  | { kind: "off" }
  | { kind: "skipped" } // skipped: export on, run did not succeed
  | { kind: "written"; path: string }
  | { kind: "failed"; message: string };

/** What a 2FA wait is for: the TOTP secret itself, a code the human types, or a passkey approval. */
export type TwofaWait = "totp" | "sms" | "email" | "passkey";

export interface RunOutcome {
  status: "pass" | "fail" | "stop";
  exitCode: 0 | 1 | 130;
  success: boolean;
  answer: string;
  steps: number;
  costUsd: number;
  historyPath: string | null;
  export: ExportOutcome;
  warnings: string[];
  error: string | null; // the fail() message, e.g. "interrupted"
}

export type RunEvent =
  | { type: "run:start"; at: number; task: string; maxSteps: number; model: string; snapshot: SnapshotMode; headed: boolean; session: string; workdir: string }
  | { type: "step:start"; at: number; step: number }
  | { type: "phase"; at: number; step: number; phase: Phase }
  | { type: "decision"; at: number; step: number; decision: Decision; cost: number }
  | { type: "action:start"; at: number; step: number; index: number }
  | { type: "action:result"; at: number; step: number; index: number; result: string; code: string | null }
  | { type: "brain:error"; at: number; step: number; message: string; cost: number; failures: number }
  | { type: "step:end"; at: number; record: StepRecord; cost: number; durationMs: number }
  | { type: "twofa:wait"; at: number; kind: TwofaWait; deadline: number }
  | { type: "twofa:done"; at: number; outcome: "answered" | "cancelled" | "timeout" }
  | { type: "control"; at: number; state: ControlState }
  | { type: "run:end"; at: number; outcome: RunOutcome };

export type RunEventInput = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;

export class RunEvents {
  #nowFn: () => number;
  #listeners: Array<(e: RunEvent) => void> = [];

  constructor(now: () => number = Date.now) {
    this.#nowFn = now;
  }

  now(): number {
    return this.#nowFn();
  }

  emit(e: RunEventInput): void {
    const event = { ...e, at: this.now() } as RunEvent;
    for (const fn of [...this.#listeners]) {
      try {
        fn(event);
      } catch {
        // a throwing listener must not affect the run or other listeners
      }
    }
  }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.#listeners.push(fn);
    return () => {
      const i = this.#listeners.indexOf(fn);
      if (i >= 0) this.#listeners.splice(i, 1);
    };
  }
}
