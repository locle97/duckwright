import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CODE_MASK, SECRET_MASK, Scrubber, scrubTree } from "../src/scrub.ts";
import { tmpDir } from "./helpers.ts";

const SECRET = "gezd gnbv GY3TQOJQ";

test("empty_scrubber_changes_nothing", () => {
  const s = new Scrubber();
  assert.equal(s.empty, true);
  const v = { a: ["123456"], n: 1 };
  assert.equal(s.deep(v), v);
  assert.equal(s.scrub("123456"), "123456");
});

test("codes_and_secret_are_masked_everywhere_in_a_string", () => {
  const s = new Scrubber();
  s.addCode("493817");
  s.addSecret(SECRET);
  assert.equal(s.scrub("fill('493817') 493817"), `fill('${CODE_MASK}') ${CODE_MASK}`);
  assert.equal(s.scrub(`key=${SECRET}`), `key=${SECRET_MASK}`);
});

test("secret_is_also_masked_in_its_compact_and_uri_forms", () => {
  const s = new Scrubber();
  s.addSecret("otpauth://totp/Acme:linh?secret=GEZDGNBVGY3TQOJQ&issuer=Acme");
  assert.equal(s.scrub("GEZDGNBVGY3TQOJQ"), SECRET_MASK);
  const t = new Scrubber();
  t.addSecret("gezd-gnbv gy3tqojq");
  assert.equal(t.scrub("GEZD-GNBV-GY3TQOJQ is not it, GEZDGNBVGY3TQOJQ is"), `GEZD-GNBV-GY3TQOJQ is not it, ${SECRET_MASK} is`);
});

test("short_codes_are_not_scrubbed_from_free_text", () => {
  const s = new Scrubber();
  s.addCode("123");
  assert.equal(s.empty, true);
  assert.equal(s.scrub("step 123 of 456"), "step 123 of 456");
});

test("longer_value_wins_over_a_shorter_one_it_contains", () => {
  const s = new Scrubber();
  s.addCode("1234");
  s.addCode("123456");
  assert.equal(s.scrub("x123456y1234"), `x${CODE_MASK}y${CODE_MASK}`);
});

test("deep_scrubs_strings_in_nested_values_and_leaves_numbers_and_keys", () => {
  const s = new Scrubber();
  s.addCode("493817");
  const out = s.deep({ 493817: "k", list: ["a 493817", { code: "493817" }], n: 493817, ok: true, none: null });
  assert.deepEqual(out, { 493817: "k", list: [`a ${CODE_MASK}`, { code: CODE_MASK }], n: 493817, ok: true, none: null });
});

test("scrub_tree_rewrites_text_files_and_skips_binary", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "request.json"), '{"url":"http://h/?c=493817"}');
  fs.writeFileSync(path.join(dir, "a", "b", "response-body.txt"), "code 493817");
  const bin = Buffer.concat([Buffer.from("493817"), Buffer.from([0, 1, 2])]);
  fs.writeFileSync(path.join(dir, "a", "body.bin"), bin);
  fs.writeFileSync(path.join(dir, "a", "clean.txt"), "nothing here");
  const s = new Scrubber();
  s.addCode("493817");
  scrubTree(dir, s);
  assert.equal(fs.readFileSync(path.join(dir, "a", "request.json"), "utf8"), `{"url":"http://h/?c=${CODE_MASK}"}`);
  assert.equal(fs.readFileSync(path.join(dir, "a", "b", "response-body.txt"), "utf8"), `code ${CODE_MASK}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, "a", "body.bin")), bin);
  assert.equal(fs.readFileSync(path.join(dir, "a", "clean.txt"), "utf8"), "nothing here");
});

test("scrub_tree_ignores_a_missing_folder", () => {
  const s = new Scrubber();
  s.addCode("493817");
  assert.doesNotThrow(() => scrubTree(path.join(tmpDir(), "nope"), s));
});
