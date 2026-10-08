import fs from "node:fs";
import path from "node:path";

import { AbortedError } from "./proc.ts";
import type { PlaywrightCLI } from "./pw.ts";

export const SCREENSHOTS_DIR = "screenshots";
export const VIDEO_NAME = "video.webm";

export interface Evidence {
  video: string | null;
  warnings: string[];
}

export function screenshotName(step: number): string {
  return `step-${String(step).padStart(3, "0")}.png`;
}

export function screenshotRel(step: number): string {
  return `${SCREENSHOTS_DIR}/${screenshotName(step)}`;
}

export function shortMessage(text: string): string {
  const first = text.trim().split(/\r?\n/)[0].trim().slice(0, 200);
  return first === "" ? "unknown error" : first;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function takeScreenshot(
  pw: PlaywrightCLI, workdir: string, step: number, signal?: AbortSignal,
): Promise<{ rel: string } | { error: string }> {
  const abs = path.join(workdir, SCREENSHOTS_DIR, screenshotName(step));
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await pw.screenshot(abs);
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    if (signal?.aborted) throw new AbortedError();
    return { error: shortMessage(message(e)) };
  }
  if (!fs.existsSync(abs)) return { error: "no file was written" };
  return { rel: screenshotRel(step) };
}

export async function startVideo(pw: PlaywrightCLI, workdir: string): Promise<string | null> {
  try {
    await pw.videoStart(path.join(workdir, VIDEO_NAME));
    return null;
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    return `video failed to start: ${shortMessage(message(e))}`;
  }
}

export async function stopVideo(
  pw: PlaywrightCLI, workdir: string,
): Promise<{ video: string | null; warning: string | null }> {
  try {
    await pw.videoStop();
  } catch (e) {
    return { video: null, warning: `video failed to stop: ${shortMessage(message(e))}` };
  }
  try {
    if (fs.statSync(path.join(workdir, VIDEO_NAME)).size > 0) return { video: VIDEO_NAME, warning: null };
  } catch {
    // fall through
  }
  return { video: null, warning: `video was not saved: ${VIDEO_NAME} is missing or empty` };
}
