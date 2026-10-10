import fs from "node:fs";

import { runProcess } from "./proc.ts";
import { universalNewlines } from "./text.ts";
import type { ProcResult, Runner } from "./proc.ts";

export class PlaywrightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaywrightError";
  }
}

export interface PlaywrightOptions {
  session?: string;
  runner?: Runner;
  timeout?: number;
  allowFileAccess?: boolean;
  signal?: AbortSignal;
}

export class PlaywrightCLI {
  readonly session: string;
  readonly runner: Runner;
  readonly timeout: number;
  readonly allowFileAccess: boolean;
  readonly signal: AbortSignal | undefined;

  constructor(opts: PlaywrightOptions = {}) {
    this.session = opts.session ?? "duckwright";
    this.runner = opts.runner ?? runProcess;
    this.timeout = opts.timeout ?? 30;
    this.allowFileAccess = opts.allowFileAccess ?? false;
    this.signal = opts.signal;
  }

  run(cmd: string, args: string[]): Promise<ProcResult> {
    const argv = ["playwright-cli", `-s=${this.session}`, cmd, ...args];
    return this.runner(argv, null, this.timeout, { signal: this.signal });
  }

  open(headed: boolean): Promise<ProcResult> {
    const args = ["about:blank", ...(headed ? ["--headed"] : [])];
    let argv = ["playwright-cli", `-s=${this.session}`, "open", ...args];
    if (this.allowFileAccess) {
      // playwright-cli blocks file: URLs unless the browser daemon starts with
      // this env var (no CLI flag exists). Scoped to this one child process.
      argv = ["env", "PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1", ...argv];
    }
    return this.runner(argv, null, this.timeout, { signal: this.signal });
  }

  async stateLoad(path: string): Promise<void> {
    const res = await this.run("state-load", [path]);
    if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout);
  }

  async stateSave(path: string): Promise<void> {
    const res = await this.run("state-save", [path]);
    if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout || `exit ${res.code}`);
  }

  /** Never throws, and runs even after the run was aborted, so the browser always closes. */
  async close(): Promise<void> {
    try {
      await this.runner(["playwright-cli", `-s=${this.session}`, "close"], null, this.timeout);
    } catch {
      // nothing left to do
    }
  }

  async snapshot(path: string): Promise<string> {
    const res = await this.run("snapshot", [`--filename=${path}`]);
    if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout);
    return universalNewlines(fs.readFileSync(path).toString("utf8"));
  }

  async screenshot(path: string): Promise<void> {
    const res = await this.run("screenshot", [`--filename=${path}`]);
    if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout || `exit ${res.code}`);
  }

  async videoStart(path: string): Promise<void> {
    const res = await this.run("video-start", [path]);
    if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout || `exit ${res.code}`);
  }

  /** Runs without the abort signal, so the video is finalized even after an interrupt. */
  async videoStop(): Promise<void> {
    const res = await this.runner(["playwright-cli", `-s=${this.session}`, "video-stop"], null, 60);
    if (res.code !== 0) throw new PlaywrightError(res.stderr || res.stdout || `exit ${res.code}`);
  }
}
