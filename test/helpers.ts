import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProcResult, Runner } from "../src/proc.ts";

export interface Call {
  argv: string[];
  stdin: string | null;
  timeoutSec: number;
  cwd?: string;
  signal?: AbortSignal;
}

export type FakeRunner = Runner & { calls: Call[] };

export function fakeRunner(
  result: ProcResult | ((argv: string[], stdin: string | null) => ProcResult),
): FakeRunner {
  const calls: Call[] = [];
  const run = async (
    argv: string[], stdin: string | null, timeoutSec: number,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<ProcResult> => {
    calls.push({ argv, stdin, timeoutSec, cwd: opts?.cwd, signal: opts?.signal });
    return typeof result === "function" ? result(argv, stdin) : result;
  };
  return Object.assign(run, { calls });
}

export function ok(stdout = ""): ProcResult {
  return { code: 0, stdout, stderr: "" };
}

export function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dw-")));
}

export const ROOT = path.resolve(import.meta.dirname, "..");
