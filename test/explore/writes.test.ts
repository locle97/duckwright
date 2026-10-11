import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { containsMarker, itemKey, makeMarker, readLedger, startsWithMarker } from "../../src/explore/writes.ts";
import { tmpDir } from "../helpers.ts";

test("makeMarker is DW-<yymmdd>-<4 hex>- from the UTC date", () => {
  const m = makeMarker(new Date(Date.UTC(2026, 9, 11, 23, 59)), () => 0xa3f9 / 0x10000);
  assert.equal(m, "DW-261011-a3f9-");
  assert.match(makeMarker(), /^DW-\d{6}-[0-9a-f]{4}-$/);
  assert.notEqual(makeMarker(new Date(), () => 0.1), makeMarker(new Date(), () => 0.9));
});

test("marker comparisons are case-insensitive and whitespace-tolerant", () => {
  const m = "DW-261011-a3f9-";
  assert.equal(startsWithMarker("  dw-261011-A3F9-Pasta  ", m), true);
  assert.equal(startsWithMarker("Pasta DW-261011-a3f9-", m), false);
  assert.equal(startsWithMarker("DW-261011-ffff-Pasta", m), false);
  assert.equal(containsMarker("Recipe | dw-261011-a3f9-Pasta | Mealie", m), true);
  assert.equal(containsMarker("Recipe | Pasta", m), false);
  assert.equal(itemKey("  DW-1  Pasta\nX "), "dw-1 pasta x");
});

test("readLedger resolves removed lines, skips damaged lines and a missing file", () => {
  assert.deepEqual(readLedger(tmpDir()), []);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "created.jsonl"), [
    JSON.stringify({ step: 1, created: "DW-1-A", url: "https://s.test/r/a" }),
    "not json",
    "5",
    JSON.stringify({ step: 2, created: "DW-1-B", url: null }),
    JSON.stringify({ step: 3, removed: "dw-1-a" }),
    JSON.stringify({ step: 4, removed: "never created" }),
  ].join("\n") + "\n");
  assert.deepEqual(readLedger(dir), [
    { name: "DW-1-A", url: "https://s.test/r/a", removed: true },
    { name: "DW-1-B", url: null, removed: false },
  ]);
});
