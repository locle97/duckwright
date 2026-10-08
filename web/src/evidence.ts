// Pure helpers for the evidence (video and screenshot) parts of the web UI.

/** The URL of one step's screenshot; `rel` is the run-relative path such as `screenshots/step-001.png`. */
export function screenshotUrl(runId: string, rel: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

export function videoUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/video.webm`;
}

/** A checkbox was set to `next`: null (inherit) when that equals the inherited value, else the override. */
export function draftToggle(next: boolean, inherited: boolean): boolean | null {
  return next === inherited ? null : next;
}

export function evidenceSummary(e: { video: boolean; screenshot: boolean }): string {
  return ` · video ${e.video ? "on" : "off"} · screenshots ${e.screenshot ? "on" : "off"}`;
}

/** The evidence part of the Save body: only the keys the user changed. */
export function evidenceBody(d: { video: boolean | null; screenshot: boolean | null }): { video?: boolean; screenshot?: boolean } {
  const o: { video?: boolean; screenshot?: boolean } = {};
  if (d.video !== null) o.video = d.video;
  if (d.screenshot !== null) o.screenshot = d.screenshot;
  return o;
}
