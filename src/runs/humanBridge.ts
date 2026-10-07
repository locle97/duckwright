// The TUI's Human for one run: a request waits here, shown on the task, until the dialog answers
// it, the user cancels, or the run stops or times out.
import type { TwofaWait } from "../events.ts";
import { AbortedError } from "../proc.ts";
import { CancelledError } from "../twofa.ts";
import type { Human } from "../twofa.ts";

interface Waiting {
  kind: TwofaWait;
  settle(value: string | null): void;
}

export class HumanBridge implements Human {
  #waiting: Waiting | null = null;
  #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get pending(): { kind: TwofaWait } | null {
    return this.#waiting === null ? null : { kind: this.#waiting.kind };
  }

  secret(signal: AbortSignal): Promise<string> {
    return this.#ask("secret", signal);
  }

  code(kind: "sms" | "email", signal: AbortSignal): Promise<string> {
    return this.#ask(kind, signal);
  }

  async approve(signal: AbortSignal): Promise<void> {
    await this.#ask("passkey", signal);
  }

  /** Answer the waiting request; `null` cancels it. False when nothing is waiting. */
  answer(value: string | null): boolean {
    const waiting = this.#waiting;
    if (waiting === null) return false;
    waiting.settle(value);
    return true;
  }

  #ask(kind: TwofaWait, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortedError());
        return;
      }
      const onAbort = (): void => {
        this.#clear();
        reject(new AbortedError());
      };
      this.#waiting = {
        kind,
        settle: (value) => {
          signal.removeEventListener("abort", onAbort);
          this.#clear();
          if (value === null) reject(new CancelledError());
          else resolve(value);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#onChange();
    });
  }

  #clear(): void {
    this.#waiting = null;
    this.#onChange();
  }
}
