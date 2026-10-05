// The real `--tui` entry point: mounts the Ink workspace on the alternate screen and hands back
// a handle the CLI awaits, and uses to put the terminal back, whatever happened.
import { render } from "ink";
import { createElement as h } from "react";

import type { TuiHandle } from "../cli.ts";
import type { ManagerLike } from "../runs/manager.ts";
import { App } from "./app.ts";

/** Leave the alternate screen and show the cursor. */
const RESTORE = "\x1b[?1049l\x1b[?25h";

export interface StartTuiOptions {
  manager: ManagerLike;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  exit?: (code: number) => never;
}

export function startTui(o: StartTuiOptions): TuiHandle {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const stderr = o.stderr ?? process.stderr;
  const exit = o.exit ?? ((code: number): never => process.exit(code));

  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    stdout.write(RESTORE);
  };

  // After a render crash the app takes no keys, so Ink drops raw mode and a Ctrl-C reaches the
  // process as SIGINT. Treat it as a force exit, so the terminal is never left on the alternate screen.
  // While the app is healthy stdin is raw, so any SIGINT then is an outside signal and is left to
  // bin.ts's clean abort.
  const onSigint = (): void => {
    if (stdin.isRaw === true) return;
    forceExit();
  };
  const stopWatchingSigint = (): void => {
    process.off("SIGINT", onSigint);
  };

  let instance: ReturnType<typeof render> | null = null;
  const forceExit = (): void => {
    stopWatchingSigint();
    try {
      instance?.unmount();
    } catch {
      // The terminal is restored and the process exits regardless.
    }
    restoreTerminal();
    exit(130);
  };

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const onQuit = (error?: Error): void => {
    stopWatchingSigint();
    const inst = instance;
    instance = null;
    // A throwing unmount must not leave `done` pending.
    try {
      inst?.unmount();
    } catch (e) {
      error ??= e instanceof Error ? e : new Error(String(e));
    }
    void (inst?.waitUntilExit() ?? Promise.resolve()).catch(() => {}).then(() => {
      if (error) {
        restoreTerminal();
        stderr.write(`tui error: ${error.stack ?? error.message}\n`);
      }
      resolveDone();
    });
  };

  const quitRequest = new AbortController();
  try {
    process.on("SIGINT", onSigint);
    instance = render(h(App, { manager: o.manager, quitSignal: quitRequest.signal, onQuit, onForceExit: forceExit }), {
      stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: true, alternateScreen: true,
    });
  } catch (e) {
    stopWatchingSigint();
    restoreTerminal();
    throw e;
  }
  return { done, restoreTerminal, quit: () => quitRequest.abort() };
}
