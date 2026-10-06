import assert from "node:assert/strict";
import { test } from "node:test";

import type { NetworkEntry } from "../../src/network.ts";
import { callFailed, formatCall, MAX_CALLS } from "../../src/tui/netline.ts";

const entry = (o: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: "0001", method: "GET", url: "https://shop.test/api/items?page=2", status: 200, statusText: "OK", type: "fetch", durationMs: 45, ...o,
});

test("netline_formats_a_normal_call", () => {
  assert.equal(formatCall(entry()), "GET shop.test/api/items?page=2 → 200 OK  45ms");
  assert.equal(callFailed(entry()), false);
  assert.equal(MAX_CALLS, 8);
});

test("netline_duration_in_seconds_and_missing", () => {
  assert.equal(formatCall(entry({ durationMs: 1234 })), "GET shop.test/api/items?page=2 → 200 OK  1.2s");
  assert.equal(formatCall(entry({ durationMs: null })), "GET shop.test/api/items?page=2 → 200 OK");
});

test("netline_failed_load_has_no_status", () => {
  const e = entry({ status: null, statusText: "net::ERR_UNSAFE_PORT", durationMs: null });
  assert.equal(formatCall(e), "GET shop.test/api/items?page=2 → net::ERR_UNSAFE_PORT");
  assert.equal(formatCall(entry({ status: null, statusText: "", durationMs: null })), "GET shop.test/api/items?page=2 → (no response)");
  assert.equal(callFailed(e), true);
});

test("netline_http_errors_count_as_failed", () => {
  assert.equal(callFailed(entry({ status: 404, statusText: "Not Found" })), true);
  assert.equal(callFailed(entry({ status: 399 })), false);
  assert.equal(callFailed(entry({ status: 500 })), true);
});
