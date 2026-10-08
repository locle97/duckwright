import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { matchEvidence, parseRange, resolveEvidence } from "../../src/web/evidence.ts";
import { tmpDir } from "../helpers.ts";

const ID = "20261008-034720-demo";

test("match_evidence_accepts", () => {
  assert.deepEqual(matchEvidence(`/api/runs/${ID}/screenshots/step-001.png`), { runId: ID, rel: "screenshots/step-001.png", type: "image/png" });
  assert.deepEqual(matchEvidence(`/api/runs/${ID}/video.webm`), { runId: ID, rel: "video.webm", type: "video/webm" });
});

test("match_evidence_rejects", () => {
  for (const p of [
    "/api/runs/../x",
    `/api/runs/${ID}/screenshots/..%2Fhistory.json`,
    `/api/runs/${ID}/history.json`,
    `/api/runs/${ID}/screenshots/step-01.png`,
    `/api/runs/${ID}/screenshots/step-001.png/x`,
    "/api/runs/bad/video.webm",
    "/api/runs/20261008-034720-Demo/video.webm",
    `/api/runs/${ID}/video.webm/`,
  ]) assert.equal(matchEvidence(p), null, p);
});

test("resolve_evidence", () => {
  const tmp = tmpDir();
  const runs = path.join(tmp, "runs");
  const shots = path.join(runs, ID, "screenshots");
  fs.mkdirSync(path.join(shots, "step-003.png"), { recursive: true });
  fs.writeFileSync(path.join(shots, "step-001.png"), "x");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "S");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(shots, "step-002.png"));
  assert.equal(resolveEvidence(runs, ID, "screenshots/step-001.png"), fs.realpathSync(path.join(shots, "step-001.png")));
  assert.equal(resolveEvidence(runs, ID, "screenshots/step-009.png"), null);
  assert.equal(resolveEvidence(runs, ID, "screenshots/step-003.png"), null);
  assert.equal(resolveEvidence(runs, ID, "screenshots/step-002.png"), null);
  assert.equal(resolveEvidence(path.join(tmp, "nope"), ID, "video.webm"), null);
});

test("parse_range_cases", () => {
  assert.deepEqual(parseRange("bytes=0-9", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=0-99", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=0-0", 0), "unsatisfiable");
  for (const h of [undefined, "bytes=abc", "bytes=5-2", "bytes=0-1,3-4", "items=0-1"]) assert.equal(parseRange(h, 10), null, String(h));
});
