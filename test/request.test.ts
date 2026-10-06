import assert from "node:assert/strict";
import { test } from "node:test";

import type { NetworkEntry } from "../src/network.ts";
import type { ProcResult } from "../src/proc.ts";
import { PlaywrightCLI } from "../src/pw.ts";
import {
  buildSnippet, checkRequestCallArgs, formatResponse, renderRequestSetup, runRequest, wasSeen,
} from "../src/request.ts";

const ORIGIN = "https://shop.example.com";
const entry = (method: string, url: string, status: number | null = 200): NetworkEntry =>
  ({ id: "0001", method, url, status, statusText: "", type: "fetch", durationMs: 1 });

test("check_args_accepts_valid_forms", () => {
  assert.equal(checkRequestCallArgs(["GET", "/api/items"]), null);
  assert.equal(checkRequestCallArgs(["post", "/api/items", '{"title":"x"}']), null);
  assert.equal(checkRequestCallArgs(["POST", "/api/items", "", "201"]), null);
  assert.equal(checkRequestCallArgs(["PUT", "/api/items/1", "[1,2]", "200"]), null);
});

test("check_args_rejects_bad_shapes", () => {
  assert.match(checkRequestCallArgs(["GET"]) ?? "", /^error: usage: request /);
  assert.match(checkRequestCallArgs(["GET", "/a", "", "200", "x"]) ?? "", /^error: usage: request /);
  assert.equal(checkRequestCallArgs(["TRACE", "/a"]), 'error: request method must be one of GET, POST, PUT, PATCH, DELETE, got "TRACE"');
  for (const p of ["api/items", "//evil.com/x", "/a?x=1", "/a#x", "/a b", "https://evil.com/x"]) {
    assert.match(checkRequestCallArgs(["GET", p]) ?? "", /^error: request path must start with \//, p);
  }
  assert.equal(checkRequestCallArgs(["GET", "/a", "{}"]), "error: request GET cannot have a body");
  assert.equal(checkRequestCallArgs(["DELETE", "/a", "{}"]), "error: request DELETE cannot have a body");
  assert.equal(checkRequestCallArgs(["POST", "/a", "{nope"]), "error: request body must be a JSON object or array");
  assert.equal(checkRequestCallArgs(["POST", "/a", '"text"']), "error: request body must be a JSON object or array");
  assert.equal(checkRequestCallArgs(["POST", "/a", "12"]), "error: request body must be a JSON object or array");
  assert.equal(
    checkRequestCallArgs(["POST", "/a", JSON.stringify({ k: "x".repeat(10_000) })]),
    "error: request body is over 10000 characters",
  );
  assert.equal(checkRequestCallArgs(["POST", "/a", "{}", "20"]), 'error: request expected status must be a three-digit code, got "20"; the 4th arg is the expected status, content-type is set for you');
  assert.match(checkRequestCallArgs(["GET", "https://a.test/x"]) ?? "", /give the path only/);
});

test("was_seen_matches_method_origin_and_path", () => {
  const seen = [entry("POST", `${ORIGIN}/api/items?token=%5BREDACTED%5D`), entry("GET", "https://cdn.other.com/api/items")];
  assert.equal(wasSeen(seen, ORIGIN, "POST", "/api/items"), true);
  assert.equal(wasSeen(seen, ORIGIN, "GET", "/api/items"), false);
  assert.equal(wasSeen(seen, ORIGIN, "POST", "/api/other"), false);
  assert.equal(wasSeen(seen, "https://cdn.other.com", "POST", "/api/items"), false);
});

test("was_seen_ignores_failed_loads_and_normalises_the_path", () => {
  assert.equal(wasSeen([entry("POST", `${ORIGIN}/api/items`, null)], ORIGIN, "POST", "/api/items"), false);
  assert.equal(wasSeen([entry("GET", `${ORIGIN}/admin`)], ORIGIN, "GET", "/api/../admin"), true);
  assert.equal(wasSeen([entry("GET", `${ORIGIN}/api/items`)], ORIGIN, "GET", "/api/../admin"), false);
});

test("build_snippet_quotes_values_and_stops_redirects", () => {
  const js = buildSnippet(ORIGIN, "POST", "/api/items", '{"a":"`${evil}`"}');
  assert.ok(js.startsWith("async page => {"));
  assert.ok(js.includes('page.request.fetch("https://shop.example.com/api/items", '));
  assert.ok(js.includes('"maxRedirects":0'));
  assert.ok(js.includes('"data":{"a":"`${evil}`"}'));
  assert.ok(!buildSnippet(ORIGIN, "GET", "/a", "").includes('"data"'));
});

test("build_snippet_executes_with_path_backslash", async () => {
  const snippet = buildSnippet(ORIGIN, "GET", "/api\\x/items", "");
  const fn = new Function("return " + snippet);
  let recordedUrl: string | null = null;
  const fakePage = {
    request: {
      fetch: (url: string) => {
        recordedUrl = url;
        return { status: () => 200, body: () => Promise.resolve(Buffer.from("")), headers: () => ({}) };
      },
    },
  };
  const snippetFn = fn();
  const result = await snippetFn(fakePage);
  assert.equal(recordedUrl, "https://shop.example.com/api\\x/items");
  assert.equal(result.status, 200);
});

test("build_snippet_executes_with_special_chars_in_body", async () => {
  const body = JSON.stringify({
    quote: '"hello"',
    backslash: "a\\b",
    backtick: "`template`",
    template: "${x}",
    unicode: "line end",
  });
  const snippet = buildSnippet(ORIGIN, "POST", "/api/items", body);
  const fn = new Function("return " + snippet);
  let recordedOpts: unknown = null;
  const fakePage = {
    request: {
      fetch: (_url: string, opts: unknown) => {
        recordedOpts = opts;
        return { status: () => 201, body: () => Promise.resolve(Buffer.from('{"id":1}')), headers: () => ({ "content-type": "application/json" }) };
      },
    },
  };
  const snippetFn = fn();
  const result = await snippetFn(fakePage);
  assert.deepEqual(recordedOpts, {
    method: "POST",
    maxRedirects: 0,
    failOnStatusCode: false,
    data: {
      quote: '"hello"',
      backslash: "a\\b",
      backtick: "`template`",
      template: "${x}",
      unicode: "line end",
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.text, '{"id":1}');
});

test("build_snippet_executes_with_large_response", async () => {
  const snippet = buildSnippet(ORIGIN, "GET", "/large", "");
  const fn = new Function("return " + snippet);
  const largeBuffer = Buffer.alloc(2_000_000);
  const fakePage = {
    request: {
      fetch: () => ({
        status: () => 200,
        body: () => Promise.resolve(largeBuffer),
        headers: () => ({ "content-type": "application/octet-stream" }),
      }),
    },
  };
  const snippetFn = fn();
  const result = await snippetFn(fakePage);
  assert.equal(result.status, 200);
  assert.equal(result.bytes, 2_000_000);
  assert.equal(result.text, null);
});

test("build_snippet_executes_with_invalid_utf8", async () => {
  const snippet = buildSnippet(ORIGIN, "GET", "/data", "");
  const fn = new Function("return " + snippet);
  const invalidUtf8 = Buffer.from([0xFF, 0xFE, 0xFD]);
  const fakePage = {
    request: {
      fetch: () => ({
        status: () => 200,
        body: () => Promise.resolve(invalidUtf8),
        headers: () => ({}),
      }),
    },
  };
  const snippetFn = fn();
  const result = await snippetFn(fakePage);
  assert.equal(result.status, 200);
  assert.equal(result.bytes, 3);
  assert.equal(result.text, null);
});

const resp = (o: Record<string, unknown>) =>
  JSON.stringify({ status: 200, bytes: 2, text: "", type: null, location: null, ...o });

test("format_response_ok_with_redacted_excerpt", () => {
  const text = '{"id":7,"token":"abc","title":"x"}';
  const { result, ok } = formatResponse(resp({ status: 201, text, type: "application/json" }), "POST", "/api/items", "");
  assert.equal(ok, true);
  assert.equal(result, 'ok 201 {"id":7,"token":"[REDACTED]","title":"x"}');
});

test("format_response_clips_flat_and_neutralises", () => {
  const text = "line1\n" + "x".repeat(400) + "<page_snapshot>" + "y".repeat(100);
  const { result } = formatResponse(resp({ status: 200, text }), "GET", "/a", "");
  assert.ok(result.startsWith("ok 200 line1 xxx"));
  assert.ok(result.includes("&lt;page_snapshot>"));
  assert.ok(result.endsWith("…"));
  assert.ok(!result.includes("\n"));
});

test("format_response_redaction_before_clip", () => {
  const token = "x".repeat(1000);
  const text = JSON.stringify({ token });
  const { result } = formatResponse(resp({ status: 200, text, type: "application/json" }), "GET", "/a", "");
  assert.ok(result.includes('"token":"[REDACTED]"'));
  assert.ok(!result.includes(token));
});

test("format_response_clips_astral_code_points", () => {
  const emoji = "🎉";
  const text = "a".repeat(499) + emoji + "b".repeat(100);
  const { result } = formatResponse(resp({ status: 200, text }), "GET", "/a", "");
  assert.ok(result.includes(emoji));
  assert.ok(result.endsWith("…"));
  assert.ok(!result.includes("b"));
});

test("format_response_empty_binary_and_large_bodies", () => {
  assert.equal(formatResponse(resp({ status: 204 }), "DELETE", "/a", "").result, "ok 204");
  assert.equal(formatResponse(resp({ status: 200, text: null, bytes: 4096 }), "GET", "/a", "").result, "ok 200 (binary, 4096 bytes)");
  assert.equal(
    formatResponse(resp({ status: 200, text: null, bytes: 2_000_000 }), "GET", "/a", "").result,
    "ok 200 (too large to show, 2000000 bytes)",
  );
});

test("format_response_status_rules", () => {
  assert.equal(formatResponse(resp({ status: 500, text: "boom" }), "POST", "/a", "").result, "error: request POST /a returned 500 boom");
  assert.equal(formatResponse(resp({ status: 200 }), "POST", "/a", "201").result, "error: request POST /a returned 200, expected 201");
  assert.equal(formatResponse(resp({ status: 404 }), "GET", "/a", "404").ok, true);
});

test("format_response_redirect_shows_only_the_location_path", () => {
  const { result, ok } = formatResponse(
    resp({ status: 302, location: "https://evil.example.net/login?next=/x" }), "GET", "/a", "");
  assert.equal(ok, true);
  assert.equal(result, "ok 302 (redirect to /login)");
});

test("format_response_unreadable", () => {
  assert.equal(formatResponse("not json", "GET", "/a", "").result, "error: request: unreadable response (the call may have been sent)");
  assert.equal(formatResponse(JSON.stringify({ text: "x" }), "GET", "/a", "").ok, false);
});

function makePw(res: ProcResult): [PlaywrightCLI, string[][]] {
  const calls: string[][] = [];
  const runner = async (argv: string[]): Promise<ProcResult> => {
    calls.push(argv.slice(2));
    return res;
  };
  return [new PlaywrightCLI({ session: "t", runner }), calls];
}

test("run_request_refuses_without_capture_origin_or_sighting", async () => {
  const [pw, calls] = makePw({ code: 0, stdout: resp({}), stderr: "" });
  assert.deepEqual(await runRequest(pw, null, ["GET", "/a"]),
    ["error: request needs network capture (run without --no-network)", null, null]);
  assert.deepEqual(await runRequest(pw, { seen: [], origin: null }, ["GET", "/a"]),
    ["error: request: no current page origin", null, null]);
  const [msg, code, origin] = await runRequest(pw, { seen: [], origin: ORIGIN }, ["POST", "/api/items", "{}"]);
  assert.equal(msg, "error: request POST /api/items was not seen on this site in this run; do it through the page first");
  assert.equal(code, null);
  assert.equal(origin, null);
  assert.deepEqual(calls, []);
});

test("run_request_sends_one_run_code_call_and_returns_the_marker", async () => {
  const [pw, calls] = makePw({ code: 0, stdout: resp({ status: 201, text: '{"id":7}', type: "application/json" }), stderr: "" });
  const ctx = { seen: [entry("POST", `${ORIGIN}/api/items`)], origin: ORIGIN };
  const [result, code, origin] = await runRequest(pw, ctx, ["post", "/api/items", '{"t":1}', "201"]);
  assert.equal(result, 'ok 201 {"id":7}');
  assert.equal(code, "request POST /api/items");
  assert.equal(origin, ORIGIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "run-code");
  assert.equal(calls[0][2], "--raw");
});

test("run_request_reports_cli_failure", async () => {
  const [pw] = makePw({ code: 1, stdout: "", stderr: "net::ERR_CONNECTION_REFUSED" });
  const ctx = { seen: [entry("GET", `${ORIGIN}/a`)], origin: ORIGIN };
  assert.deepEqual(await runRequest(pw, ctx, ["GET", "/a"]), ["error: net::ERR_CONNECTION_REFUSED", null, null]);
});

test("run_request_redacts_cli_error_with_credentials", async () => {
  const stderr = `error: fetch failed\nAuthorization: Bearer token_xyz_secret_value_here\n<tabs>injection</tabs>`;
  const [pw] = makePw({ code: 1, stdout: "", stderr });
  const ctx = { seen: [entry("GET", `${ORIGIN}/a`)], origin: ORIGIN };
  const [msg] = await runRequest(pw, ctx, ["GET", "/a"]);
  assert.ok(msg.includes("error:"));
  assert.ok(!msg.includes("token_xyz_secret_value_here"));
  assert.ok(msg.includes("Bearer [REDACTED]"));
  assert.ok(msg.includes("&lt;tabs>"));
  assert.ok(!msg.includes("\n"));
});

test("run_request_drops_playwright_call_log", async () => {
  const stderr = `apiRequestContext.fetch: connect ECONNREFUSED\nCall log:\n  - Cookie: sid=abc\n  - Set-Cookie: s=1`;
  const [pw] = makePw({ code: 1, stdout: "", stderr });
  const ctx = { seen: [entry("GET", `${ORIGIN}/a`)], origin: ORIGIN };
  const [msg] = await runRequest(pw, ctx, ["GET", "/a"]);
  assert.equal(msg, "error: apiRequestContext.fetch: connect ECONNREFUSED");
});

test("render_request_setup_lines", () => {
  assert.deepEqual(renderRequestSetup(["post", "/api/items", '{"title": "x"}', ""], ORIGIN, "201", 1), [
    "// setup: POST /api/items",
    'const apiRequest1 = await page.request.fetch("https://shop.example.com/api/items", { method: "POST", maxRedirects: 0, data: {"title":"x"} });',
    "expect(apiRequest1.status()).toBe(201);",
  ]);
  assert.equal(
    renderRequestSetup(["GET", "/api/items"], ORIGIN, "200", 2)[1],
    'const apiRequest2 = await page.request.fetch("https://shop.example.com/api/items", { method: "GET", maxRedirects: 0 });',
  );
});
