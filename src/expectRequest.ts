import fs from "node:fs";
import path from "node:path";

import { networkDir } from "./network.ts";
import type { NetworkEntry } from "./network.ts";
import { REDACTED, isSecretKey } from "./redact.ts";
import { flat, neutralise } from "./text.ts";

const USAGE = "error: usage: expect-request <METHOD> <path-or-url> <status> [<field> <expected>]";
const q = (s: string) => JSON.stringify(s);

function parseUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Static check of an expect-request action's args; an error string, or null if well formed. */
export function checkRequestArgs(args: string[]): string | null {
  if (args.length !== 3 && args.length !== 5) return USAGE;
  const [, target, status, field] = args;
  if (!/^[1-5]\d\d$/.test(status)) {
    return `error: expect-request status must be a three-digit code, got ${q(status)}`;
  }
  if (target.includes("?") || target.includes("#")) {
    return "error: expect-request url must not include a query or fragment";
  }
  if (!target.startsWith("/") && parseUrl(target) === null) {
    return "error: expect-request url must be a path starting with / or an http(s) URL";
  }
  if (field !== undefined && field.split(".").some((seg) => seg === "")) {
    return "error: expect-request field must be dot-separated keys, e.g. data.items.0.id";
  }
  return null;
}

function accessor(seg: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(seg)) return `?.${seg}`;
  if (/^\d+$/.test(seg)) return `?.[${seg}]`;
  return `?.[${q(seg)}]`;
}

/**
 * Playwright code for a verified expect-request: `arm` must run before the request is made,
 * `check` after. Expects checkRequestArgs(args) to be null.
 */
export function renderRequestExpect(args: string[], n: number): { arm: string; check: string[] } {
  const [method, target, status, field, expected] = args;
  const url = parseUrl(target);
  const urlTest = url === null
    ? `new URL(r.url()).pathname === ${q(target)}`
    : `(u => u.origin + u.pathname)(new URL(r.url())) === ${q(url.origin + url.pathname)}`;
  const res = `apiResponse${n}`;
  const check = [`expect((await ${res}).status()).toBe(${status});`];
  if (field !== undefined) {
    const body = `apiBody${n}`;
    check.push(
      `const ${body} = await (await ${res}).json();`,
      `expect(String(${body}${field.split(".").map(accessor).join("")})).toBe(${q(expected)});`,
    );
  }
  return {
    arm: `const ${res} = page.waitForResponse((r) => r.request().method() === ${q(method.toUpperCase())} && ${urlTest});`,
    check,
  };
}

/** What `runExpectRequest` verifies against: the previous step's captured calls and their folder. */
export interface RequestContext {
  entries: NetworkEntry[];
  workdir: string;
}

const SAW_MAX = 5;

function urlOf(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function matches(en: NetworkEntry, method: string, target: string): boolean {
  if (en.method.toUpperCase() !== method) return false;
  const u = urlOf(en.url);
  if (u === null) return false;
  const want = parseUrl(target);
  return want === null ? u.pathname === target : u.origin + u.pathname === want.origin + want.pathname;
}

function readField(workdir: string, id: string, field: string): { value: string } | { problem: string } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(networkDir(workdir), id, "response-body.txt"), "utf8");
  } catch {
    return { problem: "no text response body was captured" };
  }
  let cur: unknown;
  try {
    cur = JSON.parse(text);
  } catch {
    return { problem: "response body is not JSON" };
  }
  for (const seg of field.split(".")) {
    if (isSecretKey(seg)) return { problem: `field ${field} is redacted in the capture; it cannot be asserted` };
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object" && cur !== null && Object.hasOwn(cur, seg)) cur = (cur as Record<string, unknown>)[seg];
    else return { problem: `field ${field} not found` };
    if (cur === undefined) return { problem: `field ${field} not found` };
  }
  if (cur === REDACTED) return { problem: `field ${field} is redacted in the capture; it cannot be asserted` };
  if (cur !== null && typeof cur !== "string" && typeof cur !== "number" && typeof cur !== "boolean") {
    return { problem: `field ${field} is not a string, number, boolean or null` };
  }
  return { value: String(cur) };
}

/**
 * Verify one expect-request against the previous step's captured calls. Returns
 * ["ok", assertion code] on pass, or ["error: ...", null]. Expects checkRequestArgs(args) to be null.
 */
export function runExpectRequest(
  ctx: RequestContext | null, args: string[],
): [result: string, code: string | null] {
  if (ctx === null) return ["error: expect-request needs network capture (run without --no-network)", null];
  const method = args[0].toUpperCase();
  const [, target, status, field, expected] = args;
  const fail = (detail: string): [string, null] =>
    [neutralise(flat(`error: expect-request failed: ${detail}`)), null];

  const found = ctx.entries.filter((en) => matches(en, method, target));
  if (found.length === 0) {
    const saw = ctx.entries.slice(0, SAW_MAX)
      .map((en) => `${en.method} ${urlOf(en.url)?.pathname ?? en.url} ${en.status ?? "no response"}`);
    return fail(`no ${method} ${target} in the previous step's calls (saw: ${saw.join("; ") || "no calls"})`);
  }
  let problem = "";
  for (const en of found) {
    if (en.status !== Number(status)) {
      problem = `${method} ${target} returned ${en.status ?? "no response"}, expected ${status}`;
      continue;
    }
    if (field === undefined) {
      problem = "";
      break;
    }
    const got = readField(ctx.workdir, en.id, field);
    if ("problem" in got) {
      problem = `${method} ${target} ${got.problem}`;
      continue;
    }
    if (got.value !== expected) {
      problem = `${method} ${target} field ${field} is ${q(got.value)}, expected ${q(expected)}`;
      continue;
    }
    problem = "";
    break;
  }
  if (problem !== "") return fail(problem);
  const { arm, check } = renderRequestExpect(args, 1);
  return ["ok", [arm, ...check].join("\n")];
}
