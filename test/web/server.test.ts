import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import type { ManagerEvent } from "../../src/runs/manager.ts";
import type { ApiContext } from "../../src/web/api.ts";
import { cookieName } from "../../src/web/auth.ts";
import { startServer } from "../../src/web/server.ts";
import type { RunningServer } from "../../src/web/server.ts";
import { tmpDir } from "../helpers.ts";
import { FakeManager, snapshot } from "../tui/fake-manager.ts";

class CountingManager extends FakeManager {
  subs = 0;
  override subscribe(fn: (e: ManagerEvent) => void): () => void {
    this.subs++;
    const off = super.subscribe(fn);
    return () => {
      this.subs--;
      off();
    };
  }
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, urlPath: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: { host: `127.0.0.1:${port}`, ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

/** An open event stream: `next()` resolves with each message's parsed JSON, in order. */
function openStream(port: number, headers: Record<string, string>) {
  return new Promise<{ status: number; next(): Promise<any>; close(): void }>((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const queue: unknown[] = [];
        const waiters: Array<(v: unknown) => void> = [];
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (data === "") continue;
            const message = JSON.parse(data);
            const waiter = waiters.shift();
            if (waiter) waiter(message);
            else queue.push(message);
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          next: () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
  });
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TOKEN = "tok";
let tmp: string;
let manager: CountingManager;
let server: RunningServer;
let ctx: ApiContext;
const authedFor = (port: number) => ({ cookie: `${cookieName(port)}=${TOKEN}` });
const authed = { get cookie() { return authedFor(server.port).cookie; } };
const changing = () => ({ ...authed, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" });

function makeCtx(m: FakeManager): ApiContext {
  return {
    manager: m, maxParallel: 3, notices: [], theme: "auto", quit: () => {}, runs: () => [],
    candidates: () => ({ items: [], truncated: false }),
  };
}

before(async () => {
  tmp = tmpDir();
  fs.mkdirSync(path.join(tmp, "ui", "assets"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "ui", "index.html"), "<!doctype html><title>dw</title>");
  fs.writeFileSync(path.join(tmp, "ui", "assets", "app-abc.js"), "console.log(1)");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "SECRET");
  fs.writeFileSync(path.join(tmp, "ui", ".hidden"), "HIDDEN");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(tmp, "ui", "link.txt"));
  manager = new CountingManager([snapshot(1, "one")]);
  ctx = makeCtx(manager);
  server = await startServer({ ctx, token: TOKEN, uiDir: path.join(tmp, "ui") });
});
after(async () => {
  await server.close();
});

test("binds loopback on a free port", () => {
  assert.ok(server.port > 0);
});

test("requests without the token are refused", async () => {
  assert.equal((await request(server.port, "GET", "/api/state")).status, 401);
  const page = await request(server.port, "GET", "/");
  assert.equal(page.status, 401);
  assert.ok(page.body.includes("duckwright --web"));
});

test("?t= sets the cookie and redirects to the bare URL", async () => {
  const r = await request(server.port, "GET", `/?t=${TOKEN}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/");
  assert.ok(String(r.headers["set-cookie"]).startsWith(`${cookieName(server.port)}=${TOKEN};`));
});

test("a wrong Host header is forbidden", async () => {
  assert.equal((await request(server.port, "GET", "/api/state", { headers: { ...authed, host: "evil.example" } })).status, 403);
});

test("GET /api/state returns the snapshot with security headers", async () => {
  const r = await request(server.port, "GET", "/api/state", { headers: authed });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).tasks.length, 1);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(String(r.headers["content-security-policy"]).includes("default-src 'self'"));
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});

test("a change needs an Origin", async () => {
  const before = manager.log.length;
  assert.equal((await request(server.port, "POST", "/api/tasks/1/start", { headers: authed })).status, 403);
  assert.equal(manager.log.length, before);
  const r = await request(server.port, "POST", "/api/tasks/1/start", { headers: changing() });
  assert.equal(r.status, 200);
  assert.ok(manager.log.includes("start:1"));
});

test("malformed JSON is 400 and an oversize body is 413, and the manager is not called", async () => {
  const before = manager.log.length;
  assert.equal((await request(server.port, "POST", "/api/tasks", { headers: changing(), body: "{nope" })).status, 400);
  const big = JSON.stringify({ mentions: [], typed: "x".repeat(2 * 1024 * 1024) });
  assert.equal((await request(server.port, "POST", "/api/tasks", { headers: changing(), body: big })).status, 413);
  assert.equal(manager.log.length, before);
});

test("an API call with a JSON body reaches the manager", async () => {
  const r = await request(server.port, "POST", "/api/tasks", { headers: changing(), body: JSON.stringify({ mentions: [], typed: "go" }) });
  assert.equal(r.status, 200);
  assert.ok(manager.log.includes("add:|go"));
});

test("static files: the page, hashed assets, the SPA fallback", async () => {
  const page = await request(server.port, "GET", "/", { headers: authed });
  assert.equal(page.status, 200);
  assert.ok(page.headers["content-type"]!.startsWith("text/html"));
  assert.ok(page.body.includes("<title>dw</title>"));
  assert.equal(page.headers["cache-control"], "no-store");
  const js = await request(server.port, "GET", "/assets/app-abc.js", { headers: authed });
  assert.equal(js.status, 200);
  assert.ok(js.headers["content-type"]!.startsWith("text/javascript"));
  assert.ok(String(js.headers["cache-control"]).includes("immutable"));
  const spa = await request(server.port, "GET", "/some/route", { headers: authed });
  assert.equal(spa.status, 200);
  assert.ok(spa.body.includes("<title>dw</title>"));
  assert.equal((await request(server.port, "GET", "/missing.js", { headers: authed })).status, 404);
  assert.equal((await request(server.port, "POST", "/index.html", { headers: changing() })).status, 405);
});

test("path traversal never serves a file outside the UI folder", async () => {
  for (const p of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/%00", "/%zz"]) {
    const r = await request(server.port, "GET", p, { headers: authed });
    assert.ok(r.status === 400 || r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!r.body.includes("SECRET"), p);
  }
});

test("the event stream starts with the state, then the manager's events, and cleans up", async () => {
  const stream = await openStream(server.port, authed);
  assert.equal(stream.status, 200);
  const first = await stream.next();
  assert.equal(first.type, "state");
  assert.equal(first.tasks.length, manager.list().length);
  assert.equal(manager.subs, 1);
  manager.emit({ type: "toast", level: "info", message: "hello" });
  assert.deepEqual(await stream.next(), { type: "toast", level: "info", message: "hello" });
  stream.close();
  await until(() => manager.subs === 0);
});

test("the event stream needs the token too", async () => {
  const stream = await openStream(server.port, {});
  assert.equal(stream.status, 401);
  stream.close();
});

test("close ends open streams instead of hanging", { timeout: 5000 }, async () => {
  const m = new CountingManager([]);
  const s2 = await startServer({ ctx: makeCtx(m), token: TOKEN, uiDir: path.join(tmp, "ui") });
  const stream = await openStream(s2.port, authedFor(s2.port));
  await stream.next();
  await s2.close();
  assert.equal(m.subs, 0);
  stream.close();
});

test("a symlink out of the UI folder and dotfiles are not served", async () => {
  const link = await request(server.port, "GET", "/link.txt", { headers: authed });
  assert.equal(link.status, 404);
  assert.ok(!link.body.includes("SECRET"));
  const dot = await request(server.port, "GET", "/.hidden", { headers: authed });
  assert.equal(dot.status, 404);
  assert.ok(!dot.body.includes("HIDDEN"));
});

test("a malformed request target is 400", async () => {
  assert.equal((await request(server.port, "GET", "//evil", { headers: authed })).status, 400);
  assert.equal((await request(server.port, "GET", "/\\evil", { headers: authed })).status, 400);
});

test("close with a manager event in flight does not crash and unsubscribes", { timeout: 5000 }, async () => {
  const errors: unknown[] = [];
  const onError = (e: unknown): void => void errors.push(e);
  process.on("uncaughtException", onError);
  try {
    const m = new CountingManager([]);
    const s2 = await startServer({ ctx: makeCtx(m), token: TOKEN, uiDir: path.join(tmp, "ui") });
    const stream = await openStream(s2.port, authedFor(s2.port));
    await stream.next();
    m.emit({ type: "toast", level: "info", message: "before" });
    const closing = s2.close();
    m.emit({ type: "toast", level: "info", message: "after" });
    await closing;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.subs, 0);
    assert.deepEqual(errors, []);
    stream.close();
  } finally {
    process.off("uncaughtException", onError);
  }
});
