import fs from "node:fs";
import path from "node:path";

import { AbortedError } from "./proc.ts";
import type { PlaywrightCLI } from "./pw.ts";
import { redactBody, redactHeaders, redactUrl } from "./redact.ts";
import type { Header } from "./redact.ts";
import { codePointLength, flat, neutralise, sliceCodePoints } from "./text.ts";

export type { Header } from "./redact.ts";

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string;
  type: string | null;
  durationMs: number | null;
}

export interface ListedRequest {
  n: number;
  method: string;
  url: string;
  status: number | null;
  statusText: string;
}

export interface RequestDetails {
  type: string | null;
  mimeType: string | null;
  durationMs: number | null;
  requestHeaders: Header[];
  responseHeaders: Header[];
  hasRequestBody: boolean;
  hasResponseBody: boolean;
}

export const NETWORK_DIR = "network";

export function networkDir(workdir: string): string {
  return path.join(workdir, NETWORK_DIR);
}

export function requestId(n: number): string {
  return String(n).padStart(4, "0");
}

export function stripResult(stdout: string): string {
  const m = /^### Result\r?\n/.exec(stdout);
  if (m) return stdout.slice(m[0].length);
  return stdout === "### Result" ? "" : stdout;
}

export function parseDuration(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === "s" ? 1000 : 1));
}

function parseOutcome(outcome: string): { status: number | null; statusText: string } {
  let m = /^\[(\d+)\] ?(.*)$/.exec(outcome);
  if (m) return { status: Number.parseInt(m[1], 10), statusText: m[2].trim() };
  m = /^\[FAILED\] ?(.*)$/.exec(outcome);
  if (m) return { status: null, statusText: m[1].trim() };
  return { status: null, statusText: outcome.trim() };
}

export function parseRequestList(stdout: string): ListedRequest[] {
  const out: ListedRequest[] = [];
  for (const line of stripResult(stdout).split(/\r?\n/)) {
    const m = /^(\d+)\. \[([^\]]+)\] (\S+) => (.*)$/.exec(line);
    if (!m) continue;
    out.push({ n: Number.parseInt(m[1], 10), method: m[2], url: m[3], ...parseOutcome(m[4]) });
  }
  return out;
}

export function parseRequestDetails(stdout: string, n: number): RequestDetails {
  const d: RequestDetails = {
    type: null,
    mimeType: null,
    durationMs: null,
    requestHeaders: [],
    responseHeaders: [],
    hasRequestBody: false,
    hasResponseBody: false,
  };
  let section: "general" | "req" | "res" | null = null;
  for (const line of stripResult(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (t === "General") section = "general";
    else if (t === "Request headers") section = "req";
    else if (t === "Response headers") section = "res";
    else if (t.startsWith("Run `")) {
      section = null;
      if (t.includes(`\`request-body ${n}\``)) d.hasRequestBody = true;
      if (t.includes(`\`response-body ${n}\``)) d.hasResponseBody = true;
    } else if (section && t !== "" && /^\s/.test(line)) {
      const i = t.indexOf(":", 1);
      if (i < 0) continue;
      const name = t.slice(0, i).trim();
      const value = t.slice(i + 1).trim();
      if (section === "req") d.requestHeaders.push({ name, value });
      else if (section === "res") d.responseHeaders.push({ name, value });
      else if (name === "duration") d.durationMs = parseDuration(value);
      else if (name === "type") d.type = value;
      else if (name === "mimeType") d.mimeType = value;
    }
  }
  return d;
}

function clip(s: string): string {
  return codePointLength(s) > 300 ? sliceCodePoints(s, 300) : s;
}

function message(r: { stdout: string; stderr: string }): string {
  return clip(r.stderr.trim() || r.stdout.trim());
}

/** Runs one command; returns stdout on exit 0, else records "<label>: <message>" and returns null. */
async function runCmd(pw: PlaywrightCLI, cmd: string, args: string[], label: string, errors: string[]): Promise<string | null> {
  try {
    const r = await pw.run(cmd, args);
    if (r.code === 0) return r.stdout;
    errors.push(`${label}: ${message(r)}`);
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    errors.push(`${label}: ${clip(e instanceof Error ? e.message : String(e))}`);
  }
  return null;
}

export async function clearRequests(pw: PlaywrightCLI): Promise<string | null> {
  const errors: string[] = [];
  await runCmd(pw, "requests", ["--clear"], "requests --clear", errors);
  return errors[0] ?? null;
}

function contentType(headers: Header[]): string | null {
  return headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? null;
}

function emptyDetails(): RequestDetails {
  return { type: null, mimeType: null, durationMs: null, requestHeaders: [], responseHeaders: [], hasRequestBody: false, hasResponseBody: false };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function captureStep(
  pw: PlaywrightCLI, workdir: string, step: number, nextId: number,
): Promise<{ entries: NetworkEntry[]; errors: string[]; nextId: number }> {
  const entries: NetworkEntry[] = [];
  const errors: string[] = [];
  const listOut = await runCmd(pw, "requests", [], "requests", errors);
  const listed = listOut === null ? [] : parseRequestList(listOut);

  for (const l of listed) {
    const id = requestId(nextId++);
    const dir = path.join(networkDir(workdir), id);
    let d = emptyDetails();
    const detailsOut = await runCmd(pw, "request", [String(l.n)], `request ${l.n}`, errors);
    if (detailsOut !== null) d = parseRequestDetails(detailsOut, l.n);

    let dirOk = true;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      dirOk = false;
      errors.push(`write ${id}: ${errMsg(e)}`);
    }

    const write = (name: string, data: string | Buffer): void => {
      try {
        fs.writeFileSync(path.join(dir, name), data);
      } catch (e) {
        errors.push(`write ${id}: ${errMsg(e)}`);
      }
    };

    let requestBody = "";
    let responseFile: { name: string; data: string | Buffer } | null = null;
    if (dirOk) {
      if (d.hasRequestBody) {
        const out = await runCmd(pw, "request-body", [String(l.n)], `request-body ${l.n}`, errors);
        if (out !== null) requestBody = stripResult(out).replace(/\r?\n$/, "");
      }
      if (d.hasResponseBody) {
        const raw = path.join(dir, "response-body.raw");
        try {
          const out = await runCmd(pw, "response-body", [String(l.n), `--filename=${raw}`], `response-body ${l.n}`, errors);
          if (out !== null) {
            try {
              if (!fs.existsSync(raw)) {
                errors.push(`response-body ${l.n}: no file written`);
              } else {
                const bytes = fs.readFileSync(raw);
                if (bytes.length > 0) {
                  let text: string | null = null;
                  if (!bytes.includes(0)) {
                    try {
                      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                    } catch {
                      text = null;
                    }
                  }
                  if (text !== null) {
                    responseFile = { name: "response-body.txt", data: redactBody(text, contentType(d.responseHeaders)) };
                  } else {
                    fs.renameSync(raw, path.join(dir, "response-body.bin"));
                  }
                }
              }
            } catch (e) {
              errors.push(`write ${id}: ${errMsg(e)}`);
            }
          }
        } finally {
          try {
            fs.rmSync(raw, { force: true, recursive: true });
          } catch {
            // best effort
          }
        }
      }
    }

    const url = redactUrl(l.url);
    if (dirOk) {
      write("request.json", JSON.stringify({ id, step, method: l.method, url, headers: redactHeaders(d.requestHeaders) }, null, 2));
      write("response.json", JSON.stringify({
        status: l.status, statusText: l.statusText, type: d.type, mimeType: d.mimeType,
        durationMs: d.durationMs, headers: redactHeaders(d.responseHeaders),
      }, null, 2));
      if (requestBody !== "") write("request-body.txt", redactBody(requestBody, contentType(d.requestHeaders)));
      if (responseFile) write(responseFile.name, responseFile.data);
    }
    entries.push({ id, method: l.method, url, status: l.status, statusText: l.statusText, type: d.type, durationMs: d.durationMs });
  }

  const clearErr = await clearRequests(pw);
  if (clearErr !== null) errors.push(clearErr);
  return { entries, errors, nextId };
}

const SUMMARY_MAX = 10;
const URL_CLIP = 200;

function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/** Prompt text listing the last step's calls, or null when there were none. */
export function networkSummary(entries: NetworkEntry[], tabs: string): string | null {
  if (!entries.length) return null;
  const cur = tabs.split(/\r?\n/).find((l) => /^- \d+: \(current\) /.test(l));
  const found = cur?.match(/https?:\/\/\S+/g)?.at(-1)?.replace(/[)\]]+$/, "");
  const curOrigin = found ? originOf(found) : null;
  const lines = entries.slice(0, SUMMARY_MAX).map((en) => {
    let url = en.url;
    const origin = originOf(en.url);
    if (curOrigin !== null && origin === curOrigin) {
      const rest = en.url.slice(en.url.indexOf("://") + 3);
      const slash = rest.indexOf("/");
      url = slash < 0 ? "/" : rest.slice(slash).split("#")[0];
    }
    if (codePointLength(url) > URL_CLIP) url = sliceCodePoints(url, URL_CLIP) + "\u2026";
    const outcome = en.status === null
      ? (en.statusText || "(no response)")
      : `${en.status} ${en.statusText}`;
    return neutralise(flat(`${en.method} ${url} \u2192 ${outcome}`.trim()));
  });
  if (entries.length > SUMMARY_MAX) lines.push(`\u2026and ${entries.length - SUMMARY_MAX} more`);
  return lines.join("\n");
}
