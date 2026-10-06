import { cliError } from "./expect.ts";
import type { NetworkEntry } from "./network.ts";
import type { PlaywrightCLI } from "./pw.ts";
import { redactBody, redactText } from "./redact.ts";
import { codePointLength, flat, neutralise, sliceCodePoints } from "./text.ts";

export const REQUEST_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const MAX_BODY_CHARS = 10_000;
export const EXCERPT_CHARS = 500;
// Bigger responses are not decoded in the page: a cut-off JSON body could not be redacted by key.
const MAX_RESPONSE_BYTES = 1_000_000;

const USAGE = "error: usage: request <METHOD> <path> [<json body> [<expected status>]]";
const q = (s: string) => JSON.stringify(s);

/** Static check of a request action's args; an error string, or null if well formed. */
export function checkRequestCallArgs(args: string[]): string | null {
  if (args.length < 2 || args.length > 4) return USAGE;
  const [rawMethod, path, body = "", status = ""] = args;
  const method = rawMethod.toUpperCase();
  if (!REQUEST_METHODS.includes(method)) {
    return `error: request method must be one of ${REQUEST_METHODS.join(", ")}, got ${q(rawMethod)}`;
  }
  if (!/^\/(?!\/)[^\s?#]*$/.test(path)) {
    return `error: request path must start with / and have no query, fragment or spaces, got ${q(path)}`;
  }
  if (body !== "") {
    if (method === "GET" || method === "DELETE") return `error: request ${method} cannot have a body`;
    if (body.length > MAX_BODY_CHARS) return `error: request body is over ${MAX_BODY_CHARS} characters`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return "error: request body must be a JSON object or array";
    }
    if (parsed === null || typeof parsed !== "object") return "error: request body must be a JSON object or array";
  }
  if (status !== "" && !/^[1-5]\d\d$/.test(status)) {
    return `error: request expected status must be a three-digit code, got ${q(status)}`;
  }
  return null;
}

/** True when an earlier captured call used this method on this origin and (normalised) path. */
export function wasSeen(entries: NetworkEntry[], origin: string, method: string, path: string): boolean {
  let want: string;
  try {
    want = new URL(origin + path).pathname;
  } catch {
    return false;
  }
  return entries.some((en) => {
    if (en.status === null || en.method.toUpperCase() !== method) return false;
    try {
      const u = new URL(en.url);
      return u.origin === origin && u.pathname === want;
    } catch {
      return false;
    }
  });
}

/** The run-code function that sends the call. Only quoted values come from the model. */
export function buildSnippet(origin: string, method: string, path: string, body: string): string {
  const opts: Record<string, unknown> = { method, maxRedirects: 0, failOnStatusCode: false };
  if (body !== "") opts.data = JSON.parse(body);
  return "async page => { "
    + `const r = await page.request.fetch(${q(origin + path)}, ${JSON.stringify(opts)}); `
    + "const b = await r.body(); "
    + "let text = null; "
    + `if (b.length <= ${MAX_RESPONSE_BYTES}) { try { text = new TextDecoder("utf-8", { fatal: true }).decode(b); } catch (e) {} } `
    + 'return { status: r.status(), bytes: b.length, text, type: r.headers()["content-type"] ?? null, '
    + 'location: r.headers()["location"] ?? null }; }';
}

function locationPath(location: string): string | null {
  try {
    return new URL(location, "http://placeholder.invalid").pathname;
  } catch {
    return null;
  }
}

/** Turn the run-code output into the action's result string. */
export function formatResponse(
  stdout: string, method: string, path: string, expected: string,
): { result: string; ok: boolean } {
  const unreadable = { result: "error: request: unreadable response (the call may have been sent)", ok: false };
  let data: { status?: unknown; bytes?: unknown; text?: unknown; type?: unknown; location?: unknown };
  try {
    data = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  if (typeof data !== "object" || data === null || typeof data.status !== "number") return unreadable;
  const status = data.status;
  let excerpt = "";
  if (status >= 300 && status < 400) {
    const loc = typeof data.location === "string" ? locationPath(data.location) : null;
    if (loc !== null) excerpt = `(redirect to ${loc})`;
  } else if (typeof data.text === "string") {
    if (data.text.trim() !== "") {
      let text = redactBody(data.text, typeof data.type === "string" ? data.type : null);
      if (codePointLength(text) > EXCERPT_CHARS) text = sliceCodePoints(text, EXCERPT_CHARS) + "…";
      excerpt = neutralise(flat(text));
    }
  } else if (typeof data.bytes === "number") {
    excerpt = data.bytes > MAX_RESPONSE_BYTES
      ? `(too large to show, ${data.bytes} bytes)` : `(binary, ${data.bytes} bytes)`;
  }
  const tail = excerpt === "" ? "" : ` ${excerpt}`;
  const bad = expected !== "" ? status !== Number(expected) : status >= 400;
  if (bad) {
    const want = expected !== "" ? `, expected ${expected}` : "";
    return { result: `error: request ${method} ${path} returned ${status}${want}${tail}`, ok: false };
  }
  return { result: `ok ${status}${tail}`, ok: true };
}

/** What `runRequest` checks against: every call captured so far, and the current tab's origin. */
export interface RequestCallContext {
  seen: NetworkEntry[];
  origin: string | null;
}

/**
 * Run one request action. Returns [result, code, origin]: code is a marker only when the call
 * passed, and origin is the origin it was sent to. Expects checkRequestCallArgs(args) to be null.
 */
export async function runRequest(
  pw: PlaywrightCLI, ctx: RequestCallContext | null, args: string[],
): Promise<[result: string, code: string | null, origin: string | null]> {
  if (ctx === null) return ["error: request needs network capture (run without --no-network)", null, null];
  if (ctx.origin === null) return ["error: request: no current page origin", null, null];
  const method = args[0].toUpperCase();
  const [, path, body = "", expected = ""] = args;
  if (!wasSeen(ctx.seen, ctx.origin, method, path)) {
    return [`error: request ${method} ${path} was not seen on this site in this run; do it through the page first`, null, null];
  }
  const res = await pw.run("run-code", [buildSnippet(ctx.origin, method, path, body), "--raw"]);
  if (res.code !== 0) {
    let error = cliError(res);
    const lines = error.slice(7).split("\n");
    const callLogIndex = lines.findIndex((line) => /^\s*Call log:/.test(line));
    if (callLogIndex !== -1) lines.splice(callLogIndex);
    const trimmed = lines.join("\n");
    const redacted = "error: " + neutralise(flat(redactText(trimmed)));
    return [redacted, null, null];
  }
  const { result, ok } = formatResponse(res.stdout, method, path, expected);
  return ok ? [result, `request ${method} ${path}`, ctx.origin] : [result, null, null];
}

/** Export lines for one passing request: a setup call and a status check. */
export function renderRequestSetup(args: string[], origin: string, status: string, n: number): string[] {
  const method = args[0].toUpperCase();
  const path = args[1];
  const body = args[2] ?? "";
  const opts = [`method: ${q(method)}`, "maxRedirects: 0"];
  if (body !== "") opts.push(`data: ${JSON.stringify(JSON.parse(body))}`);
  const res = `apiRequest${n}`;
  return [
    `// setup: ${method} ${path}`,
    `const ${res} = await page.request.fetch(${q(origin + path)}, { ${opts.join(", ")} });`,
    `expect(${res}.status()).toBe(${status});`,
  ];
}
