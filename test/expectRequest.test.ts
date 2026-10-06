import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRequestArgs, renderRequestExpect } from "../src/expectRequest.ts";

test("check_args_accepts_status_only_and_field_forms", () => {
  assert.equal(checkRequestArgs(["POST", "/api/login", "201"]), null);
  assert.equal(checkRequestArgs(["get", "https://shop.example.com/api/items", "200", "data.items.0.id", "42"]), null);
});

test("check_args_rejects_bad_shapes", () => {
  const usage = "error: usage: expect-request <METHOD> <path-or-url> <status> [<field> <expected>]";
  assert.equal(checkRequestArgs(["POST", "/a"]), usage);
  assert.equal(checkRequestArgs(["POST", "/a", "201", "id"]), usage);
  assert.equal(checkRequestArgs(["POST", "/a", "20"]), 'error: expect-request status must be a three-digit code, got "20"');
  assert.equal(checkRequestArgs(["GET", "/api/items?page=2", "200"]), "error: expect-request url must not include a query or fragment");
  assert.equal(checkRequestArgs(["GET", "/a#x", "200"]), "error: expect-request url must not include a query or fragment");
  assert.equal(checkRequestArgs(["GET", "api/login", "200"]), "error: expect-request url must be a path starting with / or an http(s) URL");
  assert.equal(checkRequestArgs(["GET", "/a", "200", "a..b", "x"]), "error: expect-request field must be dot-separated keys, e.g. data.items.0.id");
});

test("render_path_target_status_only", () => {
  assert.deepEqual(renderRequestExpect(["post", "/api/login", "201"], 1), {
    arm: 'const apiResponse1 = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/login");',
    check: ["expect((await apiResponse1).status()).toBe(201);"],
  });
});

test("render_url_target_with_field", () => {
  assert.deepEqual(renderRequestExpect(["GET", "https://shop.example.com/api/items", "200", "data.items.0.id", "42"], 2), {
    arm: 'const apiResponse2 = page.waitForResponse((r) => r.request().method() === "GET" && (u => u.origin + u.pathname)(new URL(r.url())) === "https://shop.example.com/api/items");',
    check: [
      "expect((await apiResponse2).status()).toBe(200);",
      "const apiBody2 = await (await apiResponse2).json();",
      'expect(String(apiBody2?.data?.items?.[0]?.id)).toBe("42");',
    ],
  });
});
