import type { ProcResult } from "./proc.ts";
import { PlaywrightCLI } from "./pw.ts";

// Check name -> its argument names. playwright-cli has no assertion command, so the
// harness reads the element's state with a fixed run-code snippet and compares it here.
export const CHECKS: Readonly<Record<string, readonly string[]>> = {
  visible: ["ref"],
  text: ["ref", "expected"],
  contains: ["ref", "expected"],
  value: ["ref", "expected"],
  checked: ["ref"],
  unchecked: ["ref"],
  url: ["expected"],
};
const CHECK_LIST = Object.keys(CHECKS).join(", ");

const REF = /^[a-z0-9]+$/;

// The locator from generate-locator is spliced into run-code, so it must be a plain
// locator chain. Literals are blanked out first (a regex literal only where an argument
// starts, so a division cannot pass as one); what is left may only call these methods,
// and has no operators, statements or template strings.
const LITERAL = new RegExp(
  String.raw`'(?:[^'\\\n]|\\.)*'` + String.raw`|"(?:[^"\\\n]|\\.)*"`
  + String.raw`|(?:(?<=\()|(?<=, )|(?<=: ))/(?:[^/\\\n]|\\.)+/[a-z]*`,
  "g",
);
const LOCATOR_START = /^(?:getBy[A-Za-z]+|locator|frameLocator)\(/;
const LOCATOR_CHARS = /^[A-Za-z0-9_.(){}:, ]*$/;
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const LOCATOR_METHODS: ReadonlySet<string> = new Set([
  "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText",
  "getByTitle", "getByTestId", "locator", "frameLocator", "contentFrame",
  "first", "last", "nth", "filter", "and", "or",
]);

// Playwright's toHaveText drops U+200B, then trims and collapses JS whitespace (\s).
const JS_WS = new RegExp(
  "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+", "g",
);

const READ: Readonly<Record<string, string>> = {
  visible: "isVisible()",
  text: "textContent()",
  contains: "textContent()",
  value: "inputValue()",
  checked: "isChecked()",
  unchecked: "isChecked()",
};
const URL_JS = "async page => page.url()";

const q = (s: string) => JSON.stringify(s);

function norm(s: unknown): string {
  return String(s ?? "").replaceAll("\u200b", "").replace(JS_WS, " ").replace(/^ +| +$/g, "");
}

function isLocator(loc: string): boolean {
  if (loc.includes("\n") || !LOCATOR_START.test(loc)) return false;
  const rest = loc.replace(LITERAL, "0");
  return LOCATOR_CHARS.test(rest)
    && [...rest.matchAll(CALL)].every((m) => LOCATOR_METHODS.has(m[1]));
}

/** Accept the ref-first order models sometimes write (`e15 text Hello`). */
function ordered(args: string[]): string[] {
  if (args.length >= 2 && !isCheck(args[0]) && isCheck(args[1])) {
    return [args[1], args[0], ...args.slice(2)];
  }
  return args;
}

function isCheck(name: string): boolean {
  return Object.hasOwn(CHECKS, name);
}

/** Static check of an expect action's args; an error string, or null if well formed. */
export function checkArgs(args: string[]): string | null {
  args = ordered(args);
  const check = args[0] ?? "";
  if (!isCheck(check)) {
    return `error: expect check '${check}' not allowed (allowed: ${CHECK_LIST}); `
      + 'args are [<check>, <ref>, <expected>], e.g. ["text", "e15", "Hello"]';
  }
  const names = CHECKS[check];
  if (args.length - 1 !== names.length) {
    return `error: usage: expect ${check} ${names.map((n) => `<${n}>`).join(" ")}`;
  }
  if (names[0] === "ref" && !REF.test(args[1])) {
    return `error: expect ref must be a snapshot ref like e15, got ${q(args[1])}`;
  }
  return null;
}

export function cliError(res: ProcResult): string {
  return `error: ${res.stderr.trim() || res.stdout.trim()}`;
}

/**
 * Verify one check against the live page. Returns ["ok", assertion code] on pass,
 * or ["error: ...", null]. Expects checkArgs(args) to be null.
 */
export async function runExpect(
  pw: PlaywrightCLI, args: string[],
): Promise<[result: string, code: string | null]> {
  args = ordered(args);
  const check = args[0];
  let subject: string;
  let js: string;
  if (check === "url") {
    subject = "page";
    js = URL_JS;
  } else {
    const res = await pw.run("generate-locator", [args[1], "--raw"]);
    if (res.code !== 0) return [cliError(res), null];
    const loc = res.stdout.trim();
    if (!isLocator(loc)) return [`error: expect: unusable locator ${q(loc)}`, null];
    subject = `page.${loc}`;
    js = `async page => await page.${loc}.${READ[check]}`;
  }
  const res = await pw.run("run-code", [js, "--raw"]);
  if (res.code !== 0) return [cliError(res), null];
  let actual: unknown;
  try {
    actual = JSON.parse(res.stdout);
  } catch {
    return [`error: expect: unreadable result ${q(res.stdout.trim())}`, null];
  }

  let matcher: string;
  if (check === "visible" || check === "checked" || check === "unchecked") {
    const want = check !== "unchecked";
    if (actual !== want) {
      const state = check === "visible" ? "not visible" : check === "checked" ? "not checked" : "checked";
      return [`error: expect ${check} failed: element is ${state}`, null];
    }
    matcher = { visible: "toBeVisible()", checked: "toBeChecked()", unchecked: "not.toBeChecked()" }[check];
  } else {
    let expected = args[args.length - 1];
    let got: string;
    if (check === "text" || check === "contains") {
      expected = norm(expected);
      got = norm(actual);
    } else {
      got = typeof actual === "string" ? actual : actual == null ? "" : String(actual);
    }
    if (check === "contains" ? !got.includes(expected) : got !== expected) {
      const rel = check === "contains" ? "to contain" : "";
      return [`error: expect ${check} failed: expected ${rel ? rel + " " : ""}${q(expected)}, got ${q(got)}`, null];
    }
    const name = { text: "toHaveText", contains: "toContainText", value: "toHaveValue", url: "toHaveURL" }[check as "text" | "contains" | "value" | "url"];
    matcher = `${name}(${q(expected)})`;
  }
  return ["ok", `await expect(${subject}).${matcher};`];
}
