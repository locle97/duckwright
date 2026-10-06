import path from "node:path";

import type { Header } from "./redact.ts";

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
