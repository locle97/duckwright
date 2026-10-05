import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { startTui } from "../../src/tui/index.ts";
import { FakeManager, snapshot } from "./fake-manager.ts";

const RESTORE = "\x1b[?1049l\x1b[?25h";
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  #data: string | null = null;
  setEncoding(): void {}
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    const d = this.#data;
    this.#data = null;
    return d;
  }
  type(data: string): void {
    this.#data = data;
    this.emit("readable");
    this.emit("data", data);
  }
}

class FakeOut extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  writes: string[] = [];
  write(s: string, cb?: () => void): boolean {
    this.writes.push(s);
    cb?.();
    return true;
  }
}

function setup(manager = new FakeManager()) {
  const stdin = new FakeStdin();
  const stdout = new FakeOut();
  const stderr = new FakeOut();
  const exits: number[] = [];
  const exit = (code: number): never => {
    exits.push(code);
    throw new Error("exit sentinel");
  };
  const handle = startTui({
    manager, exit,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  });
  return { stdin, stdout, stderr, exits, handle, manager };
}

const restores = (out: FakeOut): number => out.writes.filter((w) => w === RESTORE).length;

test("starttui_quit_resolves_done", async () => {
  const t = setup();
  await settle();
  t.stdin.type("q");
  await t.handle.done;
  assert.equal(t.manager.log.includes("stopAll"), false);
  t.handle.restoreTerminal();
  assert.equal(restores(t.stdout), 1);
});

test("starttui_force_exit_restores_then_exits", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 })]);
  m.active = 1;
  m.stopAllResult = new Promise(() => {});
  const t = setup(m);
  await settle();
  t.stdin.type("\x03");
  await settle();
  t.stdin.type("\x03");
  await settle();
  t.stdin.type("\x03");
  await settle();
  assert.deepEqual(t.exits, [130]);
  assert.equal(restores(t.stdout), 1);
});

test("starttui_restore_idempotent", async () => {
  const t = setup();
  await settle();
  t.handle.restoreTerminal();
  t.handle.restoreTerminal();
  assert.equal(restores(t.stdout), 1);
  t.stdin.type("q");
  await t.handle.done;
  t.handle.restoreTerminal();
  assert.equal(restores(t.stdout), 1);
});

test("starttui_crash_prints_error_before_done", async () => {
  const broken = { ...snapshot(1, "First"), effective: undefined } as unknown as ReturnType<typeof snapshot>;
  const t = setup(new FakeManager([broken]));
  let errAtDone = "";
  void t.handle.done.then(() => {
    errAtDone = t.stderr.writes.join("");
  });
  await t.handle.done;
  await settle(0);
  const err = t.stderr.writes.join("");
  assert.match(errAtDone, /tui error: /);
  assert.match(err, /tui error: /);
  assert.equal(restores(t.stdout), 1);
});

test("starttui_sigint_during_crash_window_force_exits", async () => {
  const broken = { ...snapshot(1, "First"), effective: undefined } as unknown as ReturnType<typeof snapshot>;
  const m = new FakeManager([broken]);
  m.stopAllResult = new Promise(() => {});
  const t = setup(m);
  await settle();
  assert.throws(() => process.emit("SIGINT"), /exit sentinel/);
  assert.deepEqual(t.exits, [130]);
  assert.equal(restores(t.stdout), 1);
});

test("starttui_setup_failure_restores_terminal", () => {
  const stdout = new FakeOut();
  const before = process.listenerCount("SIGINT");
  // Ink reads the window size while constructing, in or out of CI: fail there.
  Object.defineProperty(stdout, "columns", {
    get(): never {
      throw new Error("setup failed");
    },
  });
  assert.throws(() => startTui({
    manager: new FakeManager(),
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeOut() as unknown as NodeJS.WriteStream,
  }), /setup failed/);
  assert.equal(restores(stdout), 1);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("starttui_sigint_while_healthy_does_not_exit", async () => {
  const t = setup();
  await settle();
  assert.equal(t.stdin.isRaw, true);
  process.emit("SIGINT");
  assert.deepEqual(t.exits, []);
  assert.equal(restores(t.stdout), 0);
  t.stdin.type("q");
  await t.handle.done;
});

test("starttui_force_exit_survives_throwing_unmount", async () => {
  const broken = { ...snapshot(1, "First"), effective: undefined } as unknown as ReturnType<typeof snapshot>;
  const m = new FakeManager([broken]);
  m.stopAllResult = new Promise(() => {});
  const t = setup(m);
  await settle();
  // Ink unsubscribes from resizes while unmounting: make that throw.
  t.stdout.off = (): never => {
    throw new Error("unmount failed");
  };
  assert.throws(() => process.emit("SIGINT"), /exit sentinel/);
  assert.deepEqual(t.exits, [130]);
  assert.equal(restores(t.stdout), 1);
});

test("starttui_quit_stops_all_then_resolves_done", async () => {
  const m = new FakeManager([snapshot(1, "First", { state: "running", runId: "r1", runCount: 1 })]);
  m.active = 1;
  const t = setup(m);
  await settle();
  t.handle.quit();
  t.handle.quit(); // twice: one stop
  await t.handle.done;
  assert.deepEqual(m.log, ["stopAll"]);
  t.handle.restoreTerminal();
});

test("start_tui_resolves_theme", async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeOut();
  const stderr = new FakeOut();
  const handle = startTui({
    manager: new FakeManager(), exit: ((): never => { throw new Error("exit"); }) as (code: number) => never,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    theme: "light", env: { NO_COLOR: "1" }, notices: ["n1"],
  });
  await settle();
  const out = stdout.writes.join("");
  assert.match(out, /n1/);
  assert.match(out, /┏/);
  handle.quit();
  await handle.done;
});
