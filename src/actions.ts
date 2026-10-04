import { ALLOWED_COMMANDS } from "./brain.ts";
import type { Action } from "./brain.ts";
import { checkArgs, runExpect } from "./expect.ts";
import { PlaywrightCLI } from "./pw.ts";
import { sliceCodePoints } from "./text.ts";

export const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_COMMANDS);
export const ALLOWED_LIST = ALLOWED_COMMANDS.join(", ");
export const PAGE_CHANGING: ReadonlySet<string> = new Set([
  "goto", "click", "press", "tab-new", "tab-select", "tab-close", "go-back",
]);

// Harmless flags per command (from `playwright-cli <cmd> --help`). Any other flag,
// including global ones like -s/--session and --filename, is rejected.
export const ALLOWED_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  fill: new Set(["--submit"]),
  type: new Set(["--submit"]),
  click: new Set(["--modifiers"]),
  screenshot: new Set(["--type", "--full-page", "--hires"]),
};
const FLAG = /^-{1,2}[A-Za-z]/;

// playwright-cli prints the code it ran as "### Ran Playwright code" + a fenced block.
// (?<![^\n]) is Python's MULTILINE ^: JS's /m would also start a line after \r, U+2028 or U+2029.
const RAN_CODE = /(?<![^\n])### Ran Playwright code\n```\w*\n((?:(?!```)[^\n]*\n)*?(?!```)[^\n]+)\n```/;

export const MAX_ERROR_CHARS = 300;
export const EARLIER_FAILED = "error: an earlier action failed; verify before finishing";

const clip = (msg: string) => sliceCodePoints(msg, "error: ".length + MAX_ERROR_CHARS);

function badFlag(cmd: string, args: string[]): string | null {
  const allowed = Object.hasOwn(ALLOWED_FLAGS, cmd) ? ALLOWED_FLAGS[cmd] : new Set<string>();
  for (const arg of args) {
    if (FLAG.test(arg) && !allowed.has(arg.split("=", 1)[0])) return arg;
  }
  return null;
}

/** Static allowlist check, so a rejected action is reported even when skipped. */
function rejection(a: Action): string | null {
  if (!ALLOWED.has(a.cmd)) return `error: command '${a.cmd}' not allowed (allowed: ${ALLOWED_LIST})`;
  // Its args never reach playwright-cli as given, so expected text may look like a flag.
  if (a.cmd === "expect") return checkArgs(a.args);
  const bad = badFlag(a.cmd, a.args);
  return bad !== null ? `error: flag '${bad}' not allowed` : null;
}

export function extractCode(stdout: string): string | null {
  return RAN_CODE.exec(stdout)?.[1] ?? null;
}

export interface Executed {
  results: string[];
  done: { success: boolean; answer: string } | null;
}

/**
 * Run allowed actions. If `codes` is given, it is extended with one entry per
 * action: the Playwright code playwright-cli ran for it, or null if none ran.
 */
export async function execute(
  pw: PlaywrightCLI, actions: Action[], codes?: (string | null)[],
): Promise<Executed> {
  const results: string[] = [];
  let done: Executed["done"] = null;
  let skip: string | null = null;
  const ran = new Map<number, string>();
  for (const [i, a] of actions.entries()) {
    const rejected = rejection(a);
    if (rejected !== null) {
      results.push(rejected);
      continue;
    }
    if (skip) {
      results.push(skip);
      continue;
    }
    if (a.cmd === "done") {
      if (!a.args.length || (a.args[0] !== "success" && a.args[0] !== "failure")) {
        const got = a.args.map((x) => JSON.stringify(x)).join(", ");
        results.push(`error: done needs ["success"|"failure", "<answer>"], got [${got}]`);
        continue;
      }
      const success = a.args[0] === "success";
      if (success && results.some((r) => r.startsWith("error:"))) {
        results.push(EARLIER_FAILED);
        continue;
      }
      done = { success, answer: a.args.length > 1 ? a.args[1] : "" };
      results.push("done");
      skip = "skipped: done";
      continue;
    }
    if (a.cmd === "expect") {
      const [result, code] = await runExpect(pw, a.args);
      results.push(clip(result));
      if (code !== null) ran.set(i, code);
      continue;
    }
    const res = await pw.run(a.cmd, a.args);
    if (res.code === 0) {
      results.push("ok");
      const code = extractCode(res.stdout);
      if (code !== null) ran.set(i, code);
    } else {
      results.push(clip(`error: ${res.stderr.trim() || res.stdout.trim()}`));
    }
    // A timeout (-1) may still have navigated, so treat it like success here.
    if (PAGE_CHANGING.has(a.cmd) && (res.code === 0 || res.code === -1)) {
      skip = "skipped: page may have changed";
    }
  }
  codes?.push(...actions.map((_, i) => ran.get(i) ?? null));
  return { results, done };
}
