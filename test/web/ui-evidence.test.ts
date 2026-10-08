import assert from "node:assert/strict";
import { test } from "node:test";

import { draftToggle, evidenceBody, evidenceSummary, screenshotUrl, videoUrl } from "../../web/src/evidence.ts";

test("screenshot_url", () => {
  assert.equal(screenshotUrl("20261008-034720-a b", "screenshots/step-001.png"), "/api/runs/20261008-034720-a%20b/screenshots/step-001.png");
  assert.equal(videoUrl("r/1"), "/api/runs/r%2F1/video.webm");
});

test("draft_toggle", () => {
  assert.equal(draftToggle(true, true), null);
  assert.equal(draftToggle(true, false), true);
  assert.equal(draftToggle(false, true), false);
});

test("evidence_summary", () => {
  assert.equal(evidenceSummary({ video: true, screenshot: false }), " · video on · screenshots off");
});

test("evidence_body_sends_changed_keys_only", () => {
  assert.deepEqual(evidenceBody({ video: null, screenshot: null }), {});
  assert.deepEqual(evidenceBody({ video: true, screenshot: null }), { video: true });
  assert.deepEqual(evidenceBody({ video: null, screenshot: false }), { screenshot: false });
});
