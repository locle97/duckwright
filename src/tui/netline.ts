// One captured call as a single timeline row of text. Pure; sanitising happens at render time.
import type { NetworkEntry } from "../network.ts";

export const MAX_CALLS = 8;

export function callFailed(e: NetworkEntry): boolean {
  return e.status === null || e.status >= 400;
}

function took(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function formatCall(e: NetworkEntry): string {
  const url = e.url.replace(/^https?:\/\//, "");
  const outcome = e.status === null ? (e.statusText || "(no response)") : `${e.status} ${e.statusText}`.trim();
  const time = took(e.durationMs);
  return `${e.method} ${url} → ${outcome}${time ? `  ${time}` : ""}`;
}
