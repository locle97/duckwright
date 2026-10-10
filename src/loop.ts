import path from "node:path";

import { execute } from "./actions.ts";
import { BrainError } from "./brain.ts";
import type { DecideFn, StepInput } from "./brain.ts";
import { RunControl } from "./control.ts";
import { RunEvents } from "./events.ts";
import { startVideo, stopVideo, takeScreenshot } from "./evidence.ts";
import type { Evidence } from "./evidence.ts";
import { captureConsoleErrors } from "./console.ts";
import { flat } from "./text.ts";
import { captureStep, clearRequests, currentOrigin, networkDir } from "./network.ts";
import { observe, pageDir, pasteSnapshot } from "./observe.ts";
import type { SnapshotMode } from "./observe.ts";
import { AbortedError } from "./proc.ts";
import { buildPrompt, historyLines, latestClaudeGoal } from "./prompt.ts";
import type { StepRecord } from "./prompt.ts";
import { PlaywrightCLI, PlaywrightError } from "./pw.ts";
import type { RequestCallContext } from "./request.ts";
import { scrubTree } from "./scrub.ts";
import type { TwoFactor } from "./twofa.ts";

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
  consoleErrors?: boolean;
  twofa?: TwoFactor;
  video?: boolean;
  screenshot?: boolean;
  environment?: string | null;
  fillValues?: Record<string, string>;
  beforeClose?: (result: RunResult) => Promise<void>;
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
  readonly consoleErrors: boolean;
  readonly twofa: TwoFactor | undefined;
  readonly video: boolean;
  readonly screenshot: boolean;
  readonly environment: string | null;
  readonly fillValues: Record<string, string> | undefined;
  readonly beforeClose: ((result: RunResult) => Promise<void>) | undefined;
  evidence: Evidence = { video: null, warnings: [] };
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
    this.consoleErrors = opts.consoleErrors ?? false;
    this.twofa = opts.twofa;
    this.video = opts.video ?? false;
    this.screenshot = opts.screenshot ?? false;
    this.environment = opts.environment ?? null;
    this.fillValues = opts.fillValues;
    this.beforeClose = opts.beforeClose;
    const onStep = opts.onStep;
    if (onStep) this.events.subscribe((e) => { if (e.type === "step:end") onStep(e.record); });
  }

  /** Removes the TOTP secret and every code handed out so far; identity when there is no 2FA. */
  private scrub = (text: string): string => (this.twofa ? this.twofa.scrubber.scrub(text) : text);

  private async record(history: StepRecord[], rec: StepRecord, cost: number, startedAt: number): Promise<void> {
    if (this.screenshot) {
      const shot = await takeScreenshot(this.pw, this.workdir, rec.step, this.signal);
      if ("rel" in shot) {
        rec.screenshot = shot.rel;
      } else {
        const error = this.scrub(shot.error);
        rec.screenshotError = error;
        this.evidence.warnings.push(`screenshot failed at step ${rec.step}: ${error}`);
      }
    }
    history.push(rec);
    this.events.emit({ type: "step:end", record: rec, cost, durationMs: this.events.now() - startedAt });
  }

  async run(): Promise<RunResult> {
    let videoStarted = false;
    try {
      const res = await this.pw.open(this.headed);
      if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout);
      if (this.video) {
        const warning = await startVideo(this.pw, this.workdir);
        if (warning === null) videoStarted = true;
        else this.evidence.warnings.push(this.scrub(warning));
      }
      if (this.state) await this.pw.stateLoad(this.state);
      if (this.network) {
        const err = await clearRequests(this.pw);
        if (err) this.pendingNetworkErrors = [`initial ${err}`];
      }
      const result = await this.loop();
      if (result.success) await this.beforeClose?.(result);
      return result;
    } finally {
      if (videoStarted) {
        const stopped = await stopVideo(this.pw, this.workdir);
        this.evidence.video = stopped.video;
        if (stopped.warning !== null) this.evidence.warnings.push(this.scrub(stopped.warning));
      }
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
      // In grep mode Claude reads page/snapshot.yml itself, so the file must be clean before the brain runs.
      if (this.twofa) scrubTree(pageDir(this.workdir), this.twofa.scrubber);
      const nudge = isRepeating(history) ? REPEAT_NUDGE : null;
      const paste = pasteSnapshot(this.snapshotMode, obs);
      const prompt = this.scrub(buildPrompt(this.task, step, this.maxSteps, history, memory, obs, { nudge, paste, environment: this.environment }));
      steps = step;
      this.events.emit({ type: "phase", step, phase: "thinking" });
      let decision;
      let cost;
      const previousFailed = (history.at(-1)?.results ?? []).some((r) => r.startsWith("error:") || r.startsWith("brain error:"));
      const stepInput: StepInput = {
        obs: { ...obs, tabs: this.scrub(obs.tabs), snapshot: this.scrub(obs.snapshot) },
        ctx: {
          step,
          task: this.scrub(this.task),
          memory: this.scrub(memory),
          historyLines: historyLines(history).map(this.scrub),
          goal: this.scrub(latestClaudeGoal(history)),
          nudged: nudge !== null,
          previousFailed,
        },
      };
      try {
        [decision, cost] = await this.brain.decide(prompt, !paste, stepInput);
      } catch (e) {
        if (!(e instanceof BrainError)) throw e;
        this.costUsd += e.cost;
        // Ctrl-C reaches claude too, and its exit can arrive before the abort does.
        if (this.signal?.aborted) throw new AbortedError();
        failures += 1;
        this.events.emit({ type: "brain:error", step, message: e.message, cost: e.cost, failures });
        if (this.network) await clearRequests(this.pw);
        await this.record(history, {
          step,
          decision: { evaluationPreviousGoal: "", memory, nextGoal: "", actions: [], source: "claude", jev: e.jev },
          results: [`brain error: ${e.message}`],
          codes: [],
          costUsd: e.cost,
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
      if (this.twofa) decision = this.twofa.scrubber.deep(decision);
      memory = decision.memory;
      const codes: (string | null)[] = [];
      this.events.emit({ type: "decision", step, decision, cost });
      this.events.emit({ type: "phase", step, phase: "acting" });
      const requestCtx = this.network ? { entries: history.at(-1)?.network ?? [], workdir: this.workdir } : null;
      const callCtx: RequestCallContext | null = this.network
        ? { seen: history.flatMap((r) => r.network ?? []), origin: currentOrigin(obs.tabs) }
        : null;
      const { results, done, origins } = await execute(this.pw, decision.actions, codes, {
        start: (index) => this.events.emit({ type: "action:start", step, index }),
        result: (index, result, code) => this.events.emit({
          type: "action:result", step, index, result: this.scrub(result), code: code === null ? null : this.scrub(code),
        }),
      }, requestCtx, callCtx, this.twofa ?? null, this.fillValues);
      const rec: StepRecord = {
        step, decision, results: results.map(this.scrub), codes: codes.map((c) => (c === null ? null : this.scrub(c))),
        costUsd: cost,
      };
      if (origins.some((o) => o !== null)) rec.requestOrigins = origins;
      if (this.network) {
        const cap = await captureStep(this.pw, this.workdir, step, this.nextNetworkId);
        this.nextNetworkId = cap.nextId;
        const scrubber = this.twofa?.scrubber;
        const entries = scrubber ? scrubber.deep(cap.entries) : cap.entries;
        if (scrubber && !scrubber.empty) {
          for (const e of cap.entries) scrubTree(path.join(networkDir(this.workdir), e.id), scrubber);
        }
        const errs = [...this.pendingNetworkErrors, ...cap.errors].map(this.scrub);
        this.pendingNetworkErrors = [];
        rec.network = entries;
        if (errs.length) rec.networkErrors = errs;
      }
      if (this.consoleErrors) {
        const cap = await captureConsoleErrors(this.pw);
        const messages = cap.messages.map(this.scrub);
        if (messages.length) rec.consoleErrors = messages;
        if (cap.error !== null) this.evidence.warnings.push(`console capture failed at step ${step}: ${this.scrub(flat(cap.error))}`);
      }
      await this.record(history, rec, cost, startedAt);
      if (done !== null) return { success: done.success, answer: this.scrub(done.answer), steps, costUsd: this.costUsd, history };
    }
    return { success: false, answer: "max steps reached", steps, costUsd: this.costUsd, history };
  }
}
