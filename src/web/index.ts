// The web frontend's entry point, the counterpart of src/tui/index.ts: starts the server for a
// manager and hands back a handle the CLI awaits.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ManagerLike } from "../runs/manager.ts";
import { nodeReadDir, walk } from "../tui/candidates.ts";
import type { ThemeName } from "../tui/theme.ts";
import type { ApiContext } from "./api.ts";
import { newToken } from "./auth.ts";
import { RunLog } from "./runlog.ts";
import { startServer } from "./server.ts";
import type { RunningServer } from "./server.ts";

/** The built UI. Resolves to <package>/dist/web-ui from both src/web (dev) and dist/web (installed). */
export const DEFAULT_UI_DIR = path.resolve(import.meta.dirname, "../../dist/web-ui");

export interface StartWebOptions {
  manager: ManagerLike;
  /** Default: a free port. */
  port?: number;
  maxParallel: number;
  notices?: string[];
  theme?: ThemeName;
  uiDir?: string;
  /** The folder `@` completion searches. Default: the process's current folder. */
  cwd?: string;
  /** Default: the system's browser opener. */
  open?: (url: string) => void;
}

/** `done` settles once the server is closed; `quit()` stops every run, then closes it. */
export interface WebHandle { url: string; done: Promise<void>; quit(): void }

/** Opens `url` in the default browser. Best effort: the printed URL is enough when it fails. */
export function openBrowser(url: string): void {
  try {
    const child = process.platform === "darwin"
      ? spawn("open", [url], { stdio: "ignore", detached: true })
      : process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true })
        : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignored
  }
}

export async function startWeb(o: StartWebOptions): Promise<WebHandle> {
  const uiDir = o.uiDir ?? DEFAULT_UI_DIR;
  const index = path.join(uiDir, "index.html");
  if (!fs.existsSync(index)) throw new Error(`the web UI is not built: ${index} is missing (run npm run build)`);

  const token = newToken();
  const log = new RunLog(o.manager);
  let server: RunningServer | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let quitting: Promise<void> | null = null;
  const quit = (): void => {
    quitting ??= (async () => {
      try {
        await o.manager.stopAll();
      } finally {
        log.close();
        await server?.close();
        resolveDone();
      }
    })().catch(() => {});
  };

  const ctx: ApiContext = {
    manager: o.manager, maxParallel: o.maxParallel, notices: o.notices ?? [], theme: o.theme ?? "auto",
    quit, runs: () => log.entries(), candidates: () => walk(nodeReadDir(o.cwd ?? process.cwd())),
  };
  try {
    server = await startServer({ ctx, token, port: o.port, uiDir });
  } catch (e) {
    log.close();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`port ${o.port} is already in use`);
    throw e;
  }
  const url = `http://127.0.0.1:${server.port}/?t=${token}`;
  (o.open ?? openBrowser)(url);
  return { url, done, quit };
}
