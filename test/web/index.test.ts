import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

import { startWeb } from "../../src/web/index.ts";
import { tmpDir } from "../helpers.ts";
import { FakeManager, ev, snapshot } from "../tui/fake-manager.ts";

function uiDir(): string {
  const dir = path.join(tmpDir(), "ui");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>dw</title>");
  return dir;
}

function request(url: URL, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: url.port, method, path: urlPath, agent: false, headers: { host: `127.0.0.1:${url.port}`, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

const cookieOf = (url: URL) => ({ cookie: `dw_token=${url.searchParams.get("t")}`, origin: `http://127.0.0.1:${url.port}` });

test("startWeb serves on loopback, prints a tokened URL and opens the browser", async () => {
  const m = new FakeManager([snapshot(1, "one")]);
  const opened: string[] = [];
  const web = await startWeb({ manager: m, maxParallel: 2, uiDir: uiDir(), open: (u) => void opened.push(u) });
  try {
    const url = new URL(web.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok((url.searchParams.get("t") ?? "").length >= 32);
    assert.deepEqual(opened, [web.url]);
    assert.equal(await request(url, "GET", "/api/state"), 401);
    assert.equal(await request(url, "GET", "/api/state", cookieOf(url)), 200);
  } finally {
    web.quit();
    await web.done;
  }
});

test("startWeb refuses when the UI is not built", async () => {
  const empty = path.join(tmpDir(), "none");
  await assert.rejects(
    startWeb({ manager: new FakeManager(), maxParallel: 1, uiDir: empty, open: () => {} }),
    /the web UI is not built: .*index\.html is missing \(run npm run build\)/,
  );
});

test("startWeb says when the port is taken", async () => {
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  const port = (busy.address() as net.AddressInfo).port;
  try {
    await assert.rejects(
      startWeb({ manager: new FakeManager(), maxParallel: 1, port, uiDir: uiDir(), open: () => {} }),
      new RegExp(`port ${port} is already in use`),
    );
  } finally {
    busy.close();
  }
});

test("the snapshot carries a running run's events", async () => {
  const m = new FakeManager([snapshot(1, "one")]);
  const web = await startWeb({ manager: m, maxParallel: 1, uiDir: uiDir(), open: () => {} });
  try {
    m.run(1, "r1", [ev.start(), ev.step(1)]);
    const url = new URL(web.url);
    const body: string = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: url.port, path: "/api/state", headers: { host: `127.0.0.1:${url.port}`, ...cookieOf(url) } }, (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(s));
      }).on("error", reject);
    });
    const state = JSON.parse(body);
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].runId, "r1");
    assert.equal(state.runs[0].events.length, 2);
  } finally {
    web.quit();
    await web.done;
  }
});

test("POST /api/quit stops the runs, closes the server and resolves done", { timeout: 5000 }, async () => {
  const m = new FakeManager();
  const web = await startWeb({ manager: m, maxParallel: 1, uiDir: uiDir(), open: () => {} });
  const url = new URL(web.url);
  assert.equal(await request(url, "POST", "/api/quit", cookieOf(url)), 200);
  await web.done;
  assert.deepEqual(m.log.filter((l) => l === "stopAll"), ["stopAll"]);
  await assert.rejects(request(url, "GET", "/api/state", cookieOf(url)), /ECONNREFUSED/);
});

test("quit() is idempotent", { timeout: 5000 }, async () => {
  const m = new FakeManager();
  const web = await startWeb({ manager: m, maxParallel: 1, uiDir: uiDir(), open: () => {} });
  web.quit();
  web.quit();
  await web.done;
  assert.deepEqual(m.log.filter((l) => l === "stopAll"), ["stopAll"]);
});
