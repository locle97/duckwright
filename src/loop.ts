import { execute } from "./actions.ts";
import { BrainError } from "./brain.ts";
import type { DecideFn } from "./brain.ts";
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
  readonly onStep: ((rec: StepRecord) => void) | undefined;
  readonly snapshotMode: SnapshotMode;
  readonly signal: AbortSignal | undefined;
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
    this.onStep = opts.onStep;
    this.snapshotMode = opts.snapshotMode ?? "full";
    this.signal = opts.signal;
  }

  private record(history: StepRecord[], rec: StepRecord): void {
    history.push(rec);
    this.onStep?.(rec);
  }

  async run(): Promise<RunResult> {
    try {
      const res = await this.pw.open(this.headed);
      if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout);
      if (this.state) await this.pw.stateLoad(this.state);
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
      const obs = await observe(this.pw, this.workdir);
      const nudge = isRepeating(history) ? REPEAT_NUDGE : null;
      const paste = pasteSnapshot(this.snapshotMode, obs);
      const prompt = buildPrompt(this.task, step, this.maxSteps, history, memory, obs, { nudge, paste });
      steps = step;
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
        this.record(history, {
          step,
          decision: { evaluationPreviousGoal: "", memory, nextGoal: "", actions: [] },
          results: [`brain error: ${e.message}`],
          codes: [],
        });
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
      const { results, done } = await execute(this.pw, decision.actions, codes);
      this.record(history, { step, decision, results, codes });
      if (done !== null) return { success: done.success, answer: done.answer, steps, costUsd: this.costUsd, history };
    }
    return { success: false, answer: "max steps reached", steps, costUsd: this.costUsd, history };
  }
}
