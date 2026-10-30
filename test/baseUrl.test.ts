import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { AccountStore } from "../src/accounts/store.ts";
import { baseUrlOfText, baseUrlProblem, envBaseUrl, fillBaseUrl, toBaseUrl } from "../src/baseUrl.ts";
import { EnvError } from "../src/environment.ts";
import { tmpDir } from "./helpers.ts";

function project(envText: string | null, dbBase?: string): string {
  const dir = tmpDir();
  if (envText !== null) {
    fs.mkdirSync(path.join(dir, "environments"));
    fs.writeFileSync(path.join(dir, "environments", "local.md"), envText);
  }
  if (dbBase !== undefined) {
    const s = AccountStore.open(dir, { create: true })!;
    s.setEnvSettings({ name: "local", baseUrl: dbBase, loginOrigins: [] });
    s.close();
  }
  return dir;
}

test("base_url_of_text_reads_the_base_url_section", () => {
  assert.equal(baseUrlOfText("# Local\n\n## Base URL\n\nhttp://localhost:3000 (dev server)\n"), "http://localhost:3000/");
  assert.equal(baseUrlOfText("Base URL: https://staging.example.com/app/\n"), "https://staging.example.com/app/");
  assert.equal(baseUrlOfText("# Local\nno url here\n"), null);
});

test("env_base_url_prefers_the_environments_page_then_the_file", () => {
  assert.equal(envBaseUrl("local", project("Base URL: http://localhost:3000\n")), "http://localhost:3000/");
  assert.equal(envBaseUrl("local", project("Base URL: http://localhost:3000\n", "https://dev.example.com")), "https://dev.example.com");
  assert.equal(envBaseUrl("local", project("# no url\n")), null);
  assert.equal(envBaseUrl("local", project(null)), null);
});

test("fill_base_url_replaces_every_placeholder_without_a_double_slash", () => {
  const t = "Open {{BASE_URL}}/cart. Then open {{BASE_URL}}/.";
  assert.equal(fillBaseUrl(t, "local", "http://localhost:3000/"), "Open http://localhost:3000/cart. Then open http://localhost:3000/.");
  assert.equal(fillBaseUrl(t, "local", "https://x.example/app/"), "Open https://x.example/app/cart. Then open https://x.example/app/.");
  assert.equal(fillBaseUrl("Open https://a.example.", null, null), "Open https://a.example.");
});

test("fill_base_url_without_an_environment_or_base_url_is_an_env_error", () => {
  assert.throws(() => fillBaseUrl("Open {{BASE_URL}}/", null, null), (e) => e instanceof EnvError && /no environment/.test(e.message));
  assert.throws(() => fillBaseUrl("Open {{BASE_URL}}/", "local", null), (e) => e instanceof EnvError && /'local' has no base URL/.test(e.message));
});

test("base_url_problem_checks_only_tasks_that_use_it", () => {
  const dir = project("# no url\n");
  assert.equal(baseUrlProblem("Open https://a.example/", null, dir), null);
  assert.match(baseUrlProblem("Open {{BASE_URL}}/", "local", dir)!, /has no base URL/);
  assert.equal(baseUrlProblem("Open {{BASE_URL}}/", "local", project("Base URL: http://localhost:3000\n")), null);
});

test("to_base_url_rewrites_urls_under_the_base_only", () => {
  const base = "http://localhost:3000/";
  assert.equal(
    toBaseUrl("Open http://localhost:3000/cart, then http://localhost:3000 and http://localhost:30001/x.", base),
    "Open {{BASE_URL}}/cart, then {{BASE_URL}} and http://localhost:30001/x.",
  );
  assert.equal(toBaseUrl("Open https://shop.example.com.evil/ and https://sso.example.com/", "https://shop.example.com"),
    "Open https://shop.example.com.evil/ and https://sso.example.com/");
  assert.equal(toBaseUrl("Open https://x.example/app/cart, not https://x.example/apple.", "https://x.example/app/"),
    "Open {{BASE_URL}}/cart, not https://x.example/apple.");
});
