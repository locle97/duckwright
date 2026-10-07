// Asks the person at the terminal for a 2FA secret, code or approval. Prompts go to stderr so stdout
// keeps only the run's own output. Reading is by hand (raw mode when there is one) so a secret is never echoed.
import { AbortedError } from "../proc.ts";
import type { Human } from "../twofa.ts";

/** What this needs from stdin: process.stdin has all of it, a PassThrough has all but setRawMode. */
export interface TtyInput {
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  off(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  setRawMode?(mode: boolean): unknown;
}

export interface TtyOptions {
  /** Names the task in every prompt, e.g. `duckwright` or `[2/3] tasks/b.md`. */
  label: string;
  stdin?: TtyInput;
  write?: (text: string) => void;
  /** Called on Ctrl-C, which raw mode delivers as a character. Default: send this process SIGINT. */
  onInterrupt?: () => void;
}

export function createTtyHuman(o: TtyOptions): Human {
  const stdin: TtyInput = o.stdin ?? process.stdin;
  const write = o.write ?? ((s: string) => { process.stderr.write(s); });
  const interrupt = o.onInterrupt ?? ((): void => { process.kill(process.pid, "SIGINT"); });

  function readLine(prompt: string, echo: boolean, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortedError());
        return;
      }
      let text = "";
      const finish = (): void => {
        stdin.off("data", onData);
        signal.removeEventListener("abort", onAbort);
        stdin.setRawMode?.(false);
        stdin.pause();
      };
      const onAbort = (): void => {
        finish();
        write("\n");
        reject(new AbortedError());
      };
      const onData = (chunk: Buffer | string): void => {
        for (const ch of String(chunk)) {
          if (ch === "\x03") {
            interrupt();
          } else if (ch === "\r" || ch === "\n") {
            finish();
            write("\n");
            resolve(text);
            return;
          } else if (ch === "\x7f" || ch === "\b") {
            if (text !== "") {
              text = [...text].slice(0, -1).join("");
              if (echo) write("\b \b");
            }
          } else if (ch >= " ") {
            text += ch;
            if (echo) write(ch);
          }
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
      write(prompt);
    });
  }

  return {
    secret: (signal) => readLine(`${o.label}: TOTP secret (input hidden): `, false, signal),
    code: (kind, signal) =>
      readLine(`${o.label}: ${kind === "sms" ? "SMS" : "email"} verification code: `, true, signal),
    approve: async (signal) => {
      await readLine(`${o.label}: approve the passkey prompt on your device, then press Enter: `, true, signal);
    },
  };
}
