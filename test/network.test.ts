import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDuration, parseRequestDetails, parseRequestList, requestId } from "../src/network.ts";

const LIST = "### Result\n2. [POST] http://localhost:8765/api/login => [201] Created\n\nNote: 1 static request not shown, run with --static option to see it.\n";
const DETAILS = "### Result\n#2 [POST] http://localhost:8765/api/login\n\n  General\n    status:    [201] Created\n    duration:  2ms\n    type:      fetch\n    mimeType:  application/json\n\n  Request headers\n    authorization: Bearer abc123\n    content-type: application/json\n\n  Response headers\n    content-type: application/json\n\nRun `request-body 2` to read the request body.\nRun `response-body 2` to read the response body.\n";
const FAILED = "### Result\n#4 [GET] http://localhost:1/dead\n\n  General\n    status:    [FAILED] net::ERR_UNSAFE_PORT\n    type:      fetch\n\n  Request headers\n    accept: */*\n";

test("request_id", () => {
  assert.equal(requestId(1), "0001");
  assert.equal(requestId(9999), "9999");
  assert.equal(requestId(10000), "10000");
});

test("list_probe_sample", () => {
  const want = [{ n: 2, method: "POST", url: "http://localhost:8765/api/login", status: 201, statusText: "Created" }];
  assert.deepEqual(parseRequestList(LIST), want);
  assert.deepEqual(parseRequestList(LIST.replace("### Result\n", "")), want);
  assert.deepEqual(parseRequestList(LIST.replace(/\n/g, "\r\n")), want);
});

test("list_failed_load", () => {
  assert.deepEqual(parseRequestList("4. [GET] http://localhost:1/dead => [FAILED] net::ERR_UNSAFE_PORT"), [
    { n: 4, method: "GET", url: "http://localhost:1/dead", status: null, statusText: "net::ERR_UNSAFE_PORT" },
  ]);
});

test("list_other_outcomes", () => {
  const r = parseRequestList("5. [GET] http://h/x => [204]\n6. [GET] http://h/y => pending \n");
  assert.equal(r[0].status, 204);
  assert.equal(r[0].statusText, "");
  assert.equal(r[1].status, null);
  assert.equal(r[1].statusText, "pending");
});

test("list_non_contiguous_and_empty", () => {
  const r = parseRequestList("2. [GET] http://h/a => [200] OK\n5. [GET] http://h/b => [200] OK\n");
  assert.deepEqual(r.map((x) => x.n), [2, 5]);
  assert.deepEqual(parseRequestList(""), []);
  assert.deepEqual(parseRequestList("### Result\n"), []);
});

test("duration_values", () => {
  assert.equal(parseDuration("2ms"), 2);
  assert.equal(parseDuration("1.5ms"), 2);
  assert.equal(parseDuration("0.25s"), 250);
  assert.equal(parseDuration("1.2345s"), 1235);
  assert.equal(parseDuration(" 2ms "), 2);
  for (const v of ["-", "2 ms", "1m", ""]) assert.equal(parseDuration(v), null, v);
});

test("details_probe_sample", () => {
  const d = parseRequestDetails(DETAILS, 2);
  assert.deepEqual(d, {
    type: "fetch",
    mimeType: "application/json",
    durationMs: 2,
    requestHeaders: [
      { name: "authorization", value: "Bearer abc123" },
      { name: "content-type", value: "application/json" },
    ],
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    hasRequestBody: true,
    hasResponseBody: true,
  });
  assert.equal("status" in d, false);
});

test("details_failed_load", () => {
  const d = parseRequestDetails(FAILED, 4);
  assert.equal(d.durationMs, null);
  assert.equal(d.mimeType, null);
  assert.equal(d.type, "fetch");
  assert.deepEqual(d.responseHeaders, []);
  assert.equal(d.hasResponseBody, false);
  assert.equal(d.hasRequestBody, false);
});

test("details_hint_only_from_run_lines", () => {
  const a = "  Response headers\n    x-note: run response-body 3 later\n  Run `response-body 4` to read\n";
  assert.equal(parseRequestDetails(a, 3).hasResponseBody, false);
  assert.equal(parseRequestDetails("Run `response-body 3` to read the response body.\n", 3).hasResponseBody, true);
  const b = parseRequestDetails("Run `request-body 3` to read the request body.\n", 3);
  assert.equal(b.hasRequestBody, true);
  assert.equal(b.hasResponseBody, false);
});

test("details_header_line_shapes", () => {
  const s = "  Request headers\n    :authority: example.com\n    x-foo:\n    x-bar:baz\n    nocolon\n";
  assert.deepEqual(parseRequestDetails(s, 1).requestHeaders, [
    { name: ":authority", value: "example.com" },
    { name: "x-foo", value: "" },
    { name: "x-bar", value: "baz" },
  ]);
});

test("details_missing_sections", () => {
  for (const s of ["", "garbage\n"]) {
    assert.deepEqual(parseRequestDetails(s, 1), {
      type: null, mimeType: null, durationMs: null,
      requestHeaders: [], responseHeaders: [], hasRequestBody: false, hasResponseBody: false,
    });
  }
});

test("details_run_line_ends_section", () => {
  const s = "  Response headers\n    a: 1\nRun `response-body 1` to read.\n    x-after: 1\n";
  assert.deepEqual(parseRequestDetails(s, 1).responseHeaders, [{ name: "a", value: "1" }]);
});
