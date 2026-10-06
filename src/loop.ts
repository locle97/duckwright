import { execute } from "./actions.ts";
import { BrainError } from "./brain.ts";
import type { DecideFn } from "./brain.ts";
import { RunControl } from "./control.ts";
import { RunEvents } from "./events.ts";
import { captureStep, clearRequests } from "./network.ts";
import { observe, pasteSnapshot } from "./observe.ts";
import type { SnapshotMode } from "./observe.ts";
import { AbortedError } from "./proc.ts";
import { buildPrompt } from "./prompt.ts";
import type { StepRecord } from "./prompt.ts";
import { PlaywrightCLI, PlaywrightError } from "./pw.ts";

export const REPEAT_NUDGE = "You are repeating the same actions; try a different approach.";
export const REPEAT_THRESHOLD = 3;

export interface RunResult {
  success: boolean;
  answer: string;
  steps: number;
  costUsd: number;
  history: StepRecord[];
}

function actionKey(rec: StepRecord): string {
  return JSON.stringify(rec.decision.actions.map((a) => [a.cmd, a.args]));
}

export function isRepeating(history: StepRecord[]): boolean {
  const last = history.slice(-REPEAT_THRESHOLD);
  if (last.length < REPEAT_THRESHOLD || !last.every((r) => r.decision.actions.length)) return false;
  const keys = last.map(actionKey);
  return keys.every((k) => k === keys[0]);
}

export interface AgentOptions {
  task: string;
  pw: PlaywrightCLI;
  brain: DecideFn;
  workdir: string;
  maxSteps?: number;
  maxFailures?: number;
  headed?: boolean;
  state?: string | null;
  onStep?: (rec: StepRecord) => void;
  snapshotMode?: SnapshotMode;
  signal?: AbortSignal;
  events?: RunEvents;
  control?: RunControl;
  network?: boolean;
}

export class Agent {
  readonly task: string;
  readonly pw: PlaywrightCLI;
  readonly brain: DecideFn;
  readonly workdir: string;
  readonly maxSteps: number;
  readonly maxFailures: number;
  readonly headed: boolean;
  readonly state: string | null;
  readonly snapshotMode: SnapshotMode;
  readonly signal: AbortSignal | undefined;
  readonly events: RunEvents;
  readonly control: RunControl | undefined;
  readonly network: boolean;
  private nextNetworkId = 1;
  private pendingNetworkErrors: string[] = [];
  // Updated as the run goes, so a caller can still read it after run() throws.
  costUsd = 0;

  constructor(opts: AgentOptions) {
    this.task = opts.task;
    this.pw = opts.pw;
    this.brain = opts.brain;
    this.workdir = opts.workdir;
    this.maxSteps = opts.maxSteps ?? 25;
    this.maxFailures = opts.maxFailures ?? 3;
    this.headed = opts.headed ?? false;
    this.state = opts.state ?? null;
    this.snapshotMode = opts.snapshotMode ?? "full";
    this.signal = opts.signal;
    this.events = opts.events ?? new RunEvents();
    this.control = opts.control;
    this.network = opts.network ?? false;
    const onStep = opts.onStep;
    if (onStep) this.events.subscribe((e) => { if (e.type === "step:end") onStep(e.record); });
  }

  private record(history: StepRecord[], rec: StepRecord, cost: number, startedAt: number): void {
    history.push(rec);
    this.events.emit({ type: "step:end", record: rec, cost, durationMs: this.events.now() - startedAt });
  }

  async run(): Promise<RunResult> {
    try {
      const res = await this.pw.open(this.headed);
      if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout);
      if (this.state) await this.pw.stateLoad(this.state);
      if (this.network) {
        const err = await clearRequests(this.pw);
        if (err) this.pendingNetworkErrors = [`initial ${err}`];
      }
      return await this.loop();
    } finally {
      await this.pw.close();
    }
  }

  private async loop(): Promise<RunResult> {
    const history: StepRecord[] = [];
    let memory = "";
    this.costUsd = 0;
    let failures = 0;
    let steps = 0;
    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.signal?.aborted) throw new AbortedError();
      await this.control?.gate(this.signal ?? new AbortController().signal);
      const startedAt = this.events.now();
      this.events.emit({ type: "step:start", step });
      this.events.emit({ type: "phase", step, phase: "observing" });
      const obs = await observe(this.pw, this.workdir);
      const nudge = isRepeating(history) ? REPEAT_NUDGE : null;
      const paste = pasteSnapshot(this.snapshotMode, obs);
      const prompt = buildPrompt(this.task, step, this.maxSteps, history, memory, obs, { nudge, paste });
      steps = step;
      this.events.emit({ type: "phase", step, phase: "thinking" });
      let decision;
      let cost;
      try {
        [decision, cost] = await this.brain.decide(prompt, !paste);
      } catch (e) {
        if (!(e instanceof BrainError)) throw e;
        this.costUsd += e.cost;
        // Ctrl-C reaches claude too, and its exit can arrive before the abort does.
        if (this.signal?.aborted) throw new AbortedError();
        failures += 1;
        this.events.emit({ type: "brain:error", step, message: e.message, cost: e.cost, failures });
        if (this.network) await clearRequests(this.pw);
        this.record(history, {
          step,
          decision: { evaluationPreviousGoal: "", memory, nextGoal: "", actions: [] },
          results: [`brain error: ${e.message}`],
          codes: [],
        }, e.cost, startedAt);
        if (failures >= this.maxFailures) {
          return {
            success: false,
            answer: `stopped after ${failures} consecutive brain failures: ${e.message}`,
            steps,
            costUsd: this.costUsd,
            history,
          };
        }
        continue;
      }
      failures = 0;
      this.costUsd += cost;
      memory = decision.memory;
      const codes: (string | null)[] = [];
      this.events.emit({ type: "decision", step, decision, cost });
      this.events.emit({ type: "phase", step, phase: "acting" });
      const { results, done } = await execute(this.pw, decision.actions, codes, {
        start: (index) => this.events.emit({ type: "action:start", step, index }),
        result: (index, result, code) => this.events.emit({ type: "action:result", step, index, result, code }),
      });
      const rec: StepRecord = { step, decision, results, codes };
      if (this.network) {
        const cap = await captureStep(this.pw, this.workdir, step, this.nextNetworkId);
        this.nextNetworkId = cap.nextId;
        const errs = [...this.pendingNetworkErrors, ...cap.errors];
        this.pendingNetworkErrors = [];
        rec.network = cap.entries;
        if (errs.length) rec.networkErrors = errs;
      }
      this.record(history, rec, cost, startedAt);
      if (done !== null) return { success: done.success, answer: done.answer, steps, costUsd: this.costUsd, history };
    }
    return { success: false, answer: "max steps reached", steps, costUsd: this.costUsd, history };
  }
}
