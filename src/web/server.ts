// The web server: static files for the UI, the JSON API, and one Server-Sent Events stream.
// Loopback only; every request goes through authorize() first.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { handleApi, snapshotOf } from "./api.ts";
import type { ApiContext } from "./api.ts";
import { authorize } from "./auth.ts";

export interface ServerOptions {
  ctx: ApiContext;
  token: string;
  /** Default: a free port. */
  port?: number;
  /** The built UI (index.html and assets/). */
  uiDir: string;
}

export interface RunningServer { port: number; close(): Promise<void> }

const MAX_BODY = 1024 * 1024;
const PING_MS = 15_000;

const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...SECURITY, ...extra });
  res.end(body);
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void =>
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8", { "Cache-Control": "no-store", ...extra });

/** The request's JSON body, `undefined` when it is empty. Reads past the cap without keeping it, then says 413. */
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return reject(new HttpError(413, "the request is too large"));
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "malformed JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const uiRoot = path.resolve(o.uiDir);
  const streams = new Map<http.ServerResponse, () => void>();
  const realRoot = fs.realpathSync(uiRoot);
  let port = 0;

  function events(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SECURITY,
    });
    res.write("retry: 2000\n\n");
    let done = false;
    const raw = (text: string): void => {
      if (done || res.writableEnded || res.destroyed) return cleanup();
      try {
        res.write(text);
      } catch {
        cleanup();
      }
    };
    const write = (data: unknown): void => raw(`data: ${JSON.stringify(data)}\n\n`);
    // The snapshot and the subscription happen in the same tick, so no event falls between them.
    write({ type: "state", ...snapshotOf(o.ctx) });
    const off = o.ctx.manager.subscribe((e) => write(e));
    const ping = setInterval(() => raw(": ping\n\n"), PING_MS);
    function cleanup(): void {
      if (done) return;
      done = true;
      off();
      clearInterval(ping);
      streams.delete(res);
    }
    streams.set(res, cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { ok: false, error: "method not allowed" });
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { ok: false, error: "bad request" });
    }
    if (rel.includes("\0")) return sendJson(res, 400, { ok: false, error: "bad request" });
    if (rel === "/") rel = "/index.html";
    if (rel.split("/").some((seg) => seg.startsWith("."))) return sendJson(res, 404, { ok: false, error: "not found" });
    const file = path.resolve(uiRoot, "." + rel);
    if (file !== uiRoot && !file.startsWith(uiRoot + path.sep)) return sendJson(res, 404, { ok: false, error: "not found" });
    let target = file;
    if (isFile(file)) {
      // Follow symlinks, then require the real file to still be inside the real UI folder.
      let real: string;
      try {
        real = fs.realpathSync(file);
      } catch {
        return sendJson(res, 404, { ok: false, error: "not found" });
      }
      if (!real.startsWith(realRoot + path.sep)) return sendJson(res, 404, { ok: false, error: "not found" });
      target = real;
    } else {
      // A client-side route falls back to the page; a missing file with an extension is a real 404.
      if (path.extname(rel) !== "") return sendJson(res, 404, { ok: false, error: "not found" });
      target = path.join(realRoot, "index.html");
    }
    const type = TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    const hashed = target.startsWith(path.join(realRoot, "assets") + path.sep);
    const data = await fs.promises.readFile(target);
    res.writeHead(200, {
      "Content-Type": type, "Content-Length": data.length, ...SECURITY,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    // Refuse targets that are not a plain absolute path (//host/x, /\\host/x) before parsing; a cheap sanity check, not the security boundary (authorize and the path checks are).
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return sendJson(res, 400, { ok: false, error: "bad request" });
    const auth = authorize({ method: req.method ?? "GET", url: raw, headers: req.headers }, { token: o.token, port });
    const url = new URL(raw, "http://localhost");
    const isApi = url.pathname.startsWith("/api/");
    if (!auth.ok) {
      if (isApi) return sendJson(res, auth.status, { ok: false, error: auth.status === 401 ? "unauthorized" : "forbidden" });
      const text = auth.status === 401
        ? "Unauthorized. Open the URL that duckwright --web printed.\n"
        : "Forbidden.\n";
      return send(res, auth.status, text, "text/plain; charset=utf-8");
    }
    if (auth.redirectTo !== null) {
      res.writeHead(302, { Location: auth.redirectTo, "Set-Cookie": auth.setCookie!, ...SECURITY });
      return void res.end();
    }
    if (!isApi) return serveStatic(req, res, url.pathname);
    if (req.method === "GET" && url.pathname === "/api/events") return events(res);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readJson(req);
    const r = await handleApi(o.ctx, { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
    sendJson(res, r.status, r.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) sendJson(res, e.status, { ok: false, error: e.message });
      else sendJson(res, 500, { ok: false, error: "internal error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Unsubscribe first, so no event or ping can write to a response that is ending.
        for (const [res, cleanup] of [...streams]) {
          cleanup();
          res.end();
        }
        streams.clear();
        server.close(() => resolve());
        // Idle keep-alive connections close with the server; this is for a browser that holds one open.
        setTimeout(() => server.closeAllConnections(), 500).unref();
      }),
  };
}
