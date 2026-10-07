import { spawn } from "node:child_process";
import { constants } from "node:os";

import { universalNewlines } from "./text.ts";
import { isBatchFile, quoteForCmd, which } from "./which.ts";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export type Runner = (
  argv: string[], stdin: string | null, timeoutSec: number, opts?: RunOptions,
) => Promise<ProcResult>;

/** The run was stopped (Ctrl-C, or a UI's stop key) before it finished. */
export class AbortedError extends Error {
  constructor() {
    super("interrupted");
    this.name = "AbortedError";
  }
}

/** Real runner: argv list only, never a shell. */
export const runProcess: Runner = (argv, stdin, timeoutSec, opts = {}) =>
  new Promise((resolve, reject) => {
    const { cwd, signal } = opts;
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    // Windows starts only .exe by name; resolve npm's .cmd shims through PATHEXT.
    const exe = process.platform === "win32" ? which(argv[0]) ?? argv[0] : argv[0];
    const stdio: ["ignore" | "pipe", "pipe", "pipe"] = [stdin === null ? "ignore" : "pipe", "pipe", "pipe"];
    const child = process.platform === "win32" && isBatchFile(exe)
      ? spawn(process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `"${[exe, ...argv.slice(1)].map(quoteForCmd).join(" ")}"`],
        { cwd, stdio, windowsVerbatimArguments: true })
      : spawn(exe, argv.slice(1), { cwd, stdio });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      finish();
      reject(e);
    });
    child.on("close", (code, sig) => {
      finish();
      if (signal?.aborted) reject(new AbortedError());
      else if (timedOut) resolve({ code: -1, stdout: "", stderr: "timeout" });
      else resolve({
        // Killed by a signal: a negative code, as Python's returncode reports it.
        code: code ?? -(sig ? constants.signals[sig] : 1),
        stdout: universalNewlines(Buffer.concat(out).toString("utf8")),
        stderr: universalNewlines(Buffer.concat(err).toString("utf8")),
      });
    });
    if (stdin !== null) {
      // The child may exit without reading its input; that is not an error here.
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    }
  });
