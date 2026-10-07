// Who may talk to the web server: a random per-launch token (kept in a cookie after the first
// visit), a loopback Host (blocks DNS rebinding) and, for changes, a matching Origin (blocks
// other sites from posting to it).
import crypto from "node:crypto";

// Cookies are scoped to the host, not the port, so each instance names its own.
export const cookieName = (port: number): string => `dw_token_${port}`;

export const newToken = (): string => crypto.randomBytes(24).toString("base64url");

/** Compares in constant time, whatever the lengths. */
export function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const hostOk = (host: string | undefined, port: number): boolean =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}`;

export const originOk = (origin: string | undefined, port: number): boolean =>
  origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

export type AuthResult =
  | { ok: true; setCookie: string | null; redirectTo: string | null }
  | { ok: false; status: 401 | 403 };

export interface AuthRequest {
  method: string;
  /** The request target, e.g. `/api/state?x=1`. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Authorize a request. When redirectTo is non-null, the caller must send the redirect
 * response and must not run the request handler (the ?t= branch runs before the Origin check).
 */
export function authorize(req: AuthRequest, o: { token: string; port: number }): AuthResult {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (!hostOk(header("host"), o.port)) return { ok: false, status: 403 };
  let url: URL;
  try {
    url = new URL(req.url, `http://localhost:${o.port}`);
  } catch {
    return { ok: false, status: 401 };
  }
  const given = url.searchParams.get("t");
  if (given !== null) {
    if (!sameToken(given, o.token)) return { ok: false, status: 401 };
    url.searchParams.delete("t");
    return {
      ok: true,
      setCookie: `${cookieName(o.port)}=${o.token}; HttpOnly; SameSite=Strict; Path=/`,
      redirectTo: url.pathname.replace(/^\/+/, "/") + url.search,
    };
  }
  if (!sameToken(cookieValue(header("cookie"), cookieName(o.port)), o.token)) return { ok: false, status: 401 };
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !originOk(header("origin"), o.port)) return { ok: false, status: 403 };
  return { ok: true, setCookie: null, redirectTo: null };
}
