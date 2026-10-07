import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  alreadyOpen, cannotStart, findPlaywrightCli, NOT_INSTALLED, SpecReplays,
  type ChildLike, type SpawnFn,
} from "../src/replay.ts";
import { tmpDir } from "./helpers.ts";

class FakeChild extends EventEmitter {
  unrefs = 0;
  unref() { this.unrefs++; }
}
const CLI = { cli: "/nm/@playwright/test/cli.js", nodeModules: "/nm" };

function setup(opts: { throwOnSpawn?: Error; cli?: boolean } = {}) {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (cmd, args, o) => {
    calls.push({ cmd, args, opts: o });
    if (opts.throwOnSpawn) throw opts.throwOnSpawn;
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildLike;
  };
  const replays = new SpecReplays({ spawn, cli: () => (opts.cli === false ? null : CLI) });
  return { calls, children, replays };
}

function fakePkg(bin: unknown) {
  const root = tmpDir();
  const dir = path.join(root, "node_modules", "@playwright", "test");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ bin }));
  fs.writeFileSync(path.join(dir, "cli.js"), "");
  return { root, dir, pkgJson: path.join(dir, "package.json") };
}

test("findPlaywrightCli resolves cli and nodeModules", () => {
  for (const bin of [{ playwright: "cli.js" }, "cli.js"]) {
    const p = fakePkg(bin);
    const r = findPlaywrightCli(() => p.pkgJson);
    assert.deepEqual(r, { cli: path.join(p.dir, "cli.js"), nodeModules: path.join(p.root, "node_modules") });
  }
});

test("findPlaywrightCli returns null", () => {
  assert.equal(findPlaywrightCli(() => { throw new Error("nope"); }), null);
  assert.equal(findPlaywrightCli(() => fakePkg({}).pkgJson), null);
  const p = fakePkg({ playwright: "cli.js" });
  fs.rmSync(path.join(p.dir, "cli.js"));
  assert.equal(findPlaywrightCli(() => p.pkgJson), null);
});

test("findPlaywrightCli finds the installed package by default", () => {
  const r = findPlaywrightCli();
  assert.ok(r);
  assert.ok(fs.existsSync(r.cli));
});

test("launch spawns node with the bare spec name", async () => {
  const saved = process.env.NODE_PATH;
  try {
    for (const pre of [undefined, "/pre"]) {
      if (pre) process.env.NODE_PATH = pre; else delete process.env.NODE_PATH;
      const { calls, children, replays } = setup();
      const p = replays.launch("r1", "/abs/runs/r1/duckwright.spec.ts", () => {});
      children[0].emit("spawn");
      assert.deepEqual(await p, { ok: true });
      const { cmd, args, opts } = calls[0];
      assert.equal(cmd, process.execPath);
      assert.deepEqual(args, [CLI.cli, "test", "duckwright.spec.ts", "--debug"]);
      assert.equal(opts.cwd, "/abs/runs/r1");
      assert.equal(opts.stdio, "ignore");
      assert.equal(opts.detached, true);
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.shell, undefined);
      assert.equal(opts.env.NODE_PATH, pre ? `/nm${path.delimiter}/pre` : "/nm");
      assert.equal(children[0].unrefs, 1);
    }
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = saved;
  }
});

test("a second launch while open is refused", async () => {
  const { calls, children, replays } = setup();
  const p1 = replays.launch("r1", "/a/r1/duckwright.spec.ts", () => {});
  children[0].emit("spawn");
  await p1;
  assert.equal(replays.isOpen("r1"), true);
  assert.deepEqual(await replays.launch("r1", "/a/r1/duckwright.spec.ts", () => {}), { ok: false, error: alreadyOpen("r1") });
  assert.equal(calls.length, 1);
  assert.equal(replays.isOpen("r1"), true);
  const p2 = replays.launch("r2", "/a/r2/duckwright.spec.ts", () => {});
  children[1].emit("spawn");
  assert.deepEqual(await p2, { ok: true });
  children[0].emit("exit", 0);
  assert.equal(replays.isOpen("r1"), false);
  const p3 = replays.launch("r1", "/a/r1/duckwright.spec.ts", () => {});
  children[2].emit("spawn");
  assert.deepEqual(await p3, { ok: true });
  assert.equal(calls.length, 3);
});

test("an error before spawn releases the lock", async () => {
  const { children, replays } = setup();
  let exits = 0;
  const p = replays.launch("r1", "/a/r1/duckwright.spec.ts", () => { exits++; });
  children[0].emit("error", new Error("ENOENT x"));
  assert.deepEqual(await p, { ok: false, error: "cannot start Playwright: ENOENT x" });
  assert.equal(replays.isOpen("r1"), false);
  children[0].emit("exit", 1);
  assert.equal(exits, 0);
});

test("a synchronous spawn throw releases the lock", async () => {
  const { replays } = setup({ throwOnSpawn: new Error("EACCES") });
  assert.deepEqual(await replays.launch("r1", "/a/r1/duckwright.spec.ts", () => {}), { ok: false, error: cannotStart("EACCES") });
  assert.equal(replays.isOpen("r1"), false);
});

test("a late error after spawn is swallowed", async () => {
  const { children, replays } = setup();
  const p = replays.launch("r1", "/a/r1/duckwright.spec.ts", () => {});
  children[0].emit("spawn");
  await p;
  assert.doesNotThrow(() => children[0].emit("error", new Error("late")));
  assert.equal(replays.isOpen("r1"), true);
});

test("exit passes its code", async () => {
  for (const code of [3, null]) {
    const { children, replays } = setup();
    const seen: (number | null)[] = [];
    const p = replays.launch("r1", "/a/r1/duckwright.spec.ts", (c) => seen.push(c));
    children[0].emit("spawn");
    await p;
    children[0].emit("exit", code);
    assert.deepEqual(seen, [code]);
    assert.equal(replays.isOpen("r1"), false);
  }
});

test("no CLI gives the not-installed error", async () => {
  const { calls, replays } = setup({ cli: false });
  assert.deepEqual(await replays.launch("r1", "/a/r1/duckwright.spec.ts", () => {}), { ok: false, error: NOT_INSTALLED });
  assert.equal(calls.length, 0);
  assert.equal(replays.isOpen("r1"), false);
});
