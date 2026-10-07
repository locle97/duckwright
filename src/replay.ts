import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface PlaywrightCli { cli: string; nodeModules: string }

export function findPlaywrightCli(
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
): PlaywrightCli | null {
  try {
    const pkgJson = resolve("@playwright/test/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.playwright;
    if (typeof bin !== "string" || !bin) return null;
    const cli = path.resolve(path.dirname(pkgJson), bin);
    if (!fs.existsSync(cli)) return null;
    return { cli, nodeModules: path.dirname(path.dirname(path.dirname(pkgJson))) };
  } catch {
    return null;
  }
}

export interface ChildLike {
  once(ev: "spawn", fn: () => void): unknown;
  once(ev: "exit", fn: (code: number | null) => void): unknown;
  on(ev: "error", fn: (err: Error) => void): unknown;
  unref(): void;
}
export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildLike;
export type LaunchResult = { ok: true } | { ok: false; error: string };

export const NOT_INSTALLED = "cannot replay: @playwright/test is not installed with Duckwright; reinstall duckwright";
export const alreadyOpen = (runId: string) => `the spec of run ${runId} is already open in the Playwright Inspector`;
export const cannotStart = (message: string) => `cannot start Playwright: ${message}`;

export class SpecReplays {
  readonly #open = new Set<string>();
  readonly #spawn: SpawnFn;
  readonly #cli: () => PlaywrightCli | null;

  constructor(o: { spawn?: SpawnFn; cli?: () => PlaywrightCli | null } = {}) {
    this.#spawn = o.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.#cli = o.cli ?? (() => findPlaywrightCli());
  }

  isOpen(runId: string): boolean {
    return this.#open.has(runId);
  }

  launch(runId: string, specPath: string, onExit: (code: number | null) => void): Promise<LaunchResult> {
    if (this.#open.has(runId)) return Promise.resolve({ ok: false, error: alreadyOpen(runId) });
    const pw = this.#cli();
    if (!pw) return Promise.resolve({ ok: false, error: NOT_INSTALLED });
    this.#open.add(runId);
    return new Promise<LaunchResult>((resolve) => {
      let settled = false;
      let failed = false;
      const settle = (r: LaunchResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const fail = (message: string) => {
        failed = true;
        this.#open.delete(runId);
        settle({ ok: false, error: cannotStart(message) });
      };
      try {
        const env = {
          ...process.env,
          NODE_PATH: [pw.nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
        };
        const child = this.#spawn(process.execPath, [pw.cli, "test", path.basename(specPath), "--debug"], {
          cwd: path.dirname(specPath), stdio: "ignore", detached: true, windowsHide: true, env,
        });
        // Persistent: a late error must never reach the EventEmitter as unhandled.
        child.on("error", (err) => { if (!settled) fail(err.message); });
        child.once("spawn", () => {
          if (failed) return;
          child.unref();
          settle({ ok: true });
        });
        child.once("exit", (code) => {
          if (failed) return;
          this.#open.delete(runId);
          onExit(code);
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  }
}
