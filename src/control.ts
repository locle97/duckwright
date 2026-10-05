import type { ControlState } from "./events.ts";
import { RunEvents } from "./events.ts";
import { AbortedError } from "./proc.ts";

/** Pause/step/stop state machine; the agent loop awaits gate() before each step. */
export class RunControl {
  #controller: AbortController;
  #events: RunEvents;
  #state: ControlState = "running";
  #waiters: Array<() => void> = [];

  constructor(controller: AbortController, events: RunEvents = new RunEvents()) {
    this.#controller = controller;
    this.#events = events;
  }

  get state(): ControlState {
    return this.#state;
  }

  pause(): void {
    if (this.#state === "running" || this.#state === "stepping") this.#set("paused");
  }

  resume(): void {
    if (this.#state === "paused") this.#set("running");
  }

  step(): void {
    if (this.#state === "paused") this.#set("stepping");
  }

  stop(): void {
    if (this.#state === "stopping") return;
    this.#set("stopping");
    this.#controller.abort();
  }

  async gate(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new AbortedError();
      if (this.#state === "stepping") {
        this.#set("paused");
        return;
      }
      if (this.#state !== "paused") return;
      await this.#waitForChange(signal);
    }
  }

  #set(state: ControlState): void {
    this.#state = state;
    this.#events.emit({ type: "control", state });
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  #waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((w) => w !== wake);
        reject(new AbortedError());
      };
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(wake);
    });
  }
}
