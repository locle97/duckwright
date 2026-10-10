import { AbortedError } from "./proc.ts";
import { stripResult } from "./network.ts";
import type { PlaywrightCLI } from "./pw.ts";
import { redactText, redactUrl } from "./redact.ts";
import { codePointLength, flat, sliceCodePoints, splitLines } from "./text.ts";

export const CONSOLE_MESSAGE_MAX = 500;
export const CONSOLE_STEP_MAX = 50;
const ERROR_MAX = 300;

/** Parse `playwright-cli console error` output into one message per line. */
export function parseConsoleErrors(stdout: string): string[] {
  const out: string[] = [];
  for (const line of splitLines(stripResult(stdout))) {
    if (line.startsWith("### ")) break;
    if (line.trim() === "" || /^\s/.test(line)) continue;
    if (line.startsWith("Total messages") || line.startsWith("Returning ")) continue;
    out.push(codePointLength(line) > CONSOLE_MESSAGE_MAX ? sliceCodePoints(line, CONSOLE_MESSAGE_MAX) : line);
    if (out.length >= CONSOLE_STEP_MAX) break;
  }
  return out;
}

export function redactConsole(text: string): string {
  return redactText(flat(text)).replace(/https?:\/\/\S+/g, redactUrl);
}

export async function captureConsoleErrors(pw: PlaywrightCLI): Promise<{ messages: string[]; error: string | null }> {
  try {
    const r = await pw.run("console", ["error"]);
    if (r.code === 0) return { messages: parseConsoleErrors(r.stdout).map(redactConsole), error: null };
    const text = (r.stderr.trim() || r.stdout.trim());
    return { messages: [], error: codePointLength(text) > ERROR_MAX ? sliceCodePoints(text, ERROR_MAX) : text };
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    const text = e instanceof Error ? e.message : String(e);
    return { messages: [], error: codePointLength(text) > ERROR_MAX ? sliceCodePoints(text, ERROR_MAX) : text };
  }
}
