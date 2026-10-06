export const REDACTED = "[REDACTED]";

export interface Header {
  name: string;
  value: string;
}

const SECRET_HEADER_EXACT = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);
const SECRET_HEADER_PARTS = ["token", "secret", "auth", "session", "api-key", "api_key", "apikey", "password", "csrf", "xsrf"];

export function isSecretHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HEADER_EXACT.has(n) || SECRET_HEADER_PARTS.some((p) => n.includes(p));
}

const SECRET_KEY_PARTS = ["password", "passwd", "secret", "token", "apikey", "csrf", "xsrf", "credential", "privatekey", "sessionid", "cookie"];
const SECRET_KEY_EXACT = new Set(["auth", "authorization", "session", "sid", "pin", "otp"]);

export function isSecretKey(key: string): boolean {
  const n = key.toLowerCase().replace(/[-_]/g, "");
  return SECRET_KEY_EXACT.has(n) || SECRET_KEY_PARTS.some((p) => n.includes(p));
}

const BEARER = /\b(bearer)(\s+)[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC = /\b(basic)(\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9+/=])/gi;

export function redactText(text: string): string {
  return text
    .replace(BEARER, `$1$2${REDACTED}`)
    .replace(BASIC, (m, word: string, ws: string, token: string) =>
      Buffer.from(token, "base64").toString("utf8").includes(":") ? `${word}${ws}${REDACTED}` : m,
    );
}

function redactPairs(s: string): string {
  return s
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return part;
      const rawKey = part.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        // keep the raw key
      }
      return isSecretKey(key) ? `${rawKey}=${REDACTED}` : part;
    })
    .join("&");
}

export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  if (q === -1 || (h !== -1 && q > h)) return url;
  const end = h === -1 ? url.length : h;
  return url.slice(0, q + 1) + redactPairs(url.slice(q + 1, end)) + url.slice(end);
}

function walk(value: unknown): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) if (walk(item)) changed = true;
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (isSecretKey(key)) {
        obj[key] = REDACTED;
        changed = true;
      } else if (walk(obj[key])) {
        changed = true;
      }
    }
  }
  return changed;
}

export function redactBody(text: string, contentType: string | null): string {
  let out = text;
  if (contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    out = redactPairs(text);
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && walk(parsed)) out = JSON.stringify(parsed);
    } catch {
      // not JSON: treat as text
    }
  }
  return redactText(out);
}

export function redactHeaders(headers: Header[]): Header[] {
  return headers.map(({ name, value }) => {
    if (isSecretHeader(name)) return { name, value: REDACTED };
    const lower = name.toLowerCase();
    const v = lower === "referer" || lower === "location" ? redactUrl(value) : value;
    return { name, value: redactText(v) };
  });
}
