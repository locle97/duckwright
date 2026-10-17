import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CODE_MASK, SECRET_MASK, Scrubber, scrubTree, secretMarker } from "../src/scrub.ts";
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

test("named_secret_scrubs_to_marker", () => {
  const s = new Scrubber();
  s.addNamedSecret("hunter2", secretMarker("a"));
  assert.equal(s.empty, false);
  assert.equal(s.scrub("fill('hunter2')"), "fill('[SECRET a.password]')");
});

test("prefix_passwords_each_get_own_marker", () => {
  const s = new Scrubber();
  s.addNamedSecret("abc12345", secretMarker("a"));
  s.addNamedSecret("abc123456", secretMarker("b"));
  assert.equal(s.scrub("abc123456 abc12345"), "[SECRET b.password] [SECRET a.password]");
});

test("short_values_never_match_inside_masks", () => {
  const s = new Scrubber();
  s.addNamedSecret("e", secretMarker("x"));
  s.addSecret("RED");
  s.addSecret("tok");
  assert.equal(s.scrub("e tok RED hello"), "[SECRET x.password] [REDACTED] [REDACTED] h[SECRET x.password]llo");
});

test("scrub_is_idempotent_when_no_value_occurs_in_a_mask", () => {
  const s = new Scrubber();
  s.addNamedSecret("e", secretMarker("x"));
  s.addSecret("tok");
  const once = s.scrub("e tok hello");
  assert.equal(s.scrub(once), once);
});

test("code_equal_to_account_id_is_not_matched_inside_a_marker", () => {
  const s = new Scrubber();
  s.addNamedSecret("pw", secretMarker("1234"));
  s.addCode("1234");
  assert.equal(s.scrub("pw 1234"), `[SECRET 1234.password] ${CODE_MASK}`);
});

test("named_marker_wins_over_plain_secret_and_code_for_the_same_value", () => {
  const s = new Scrubber();
  s.addSecret("samevalue");
  s.addCode("samevalue");
  s.addNamedSecret("samevalue", secretMarker("a"));
  assert.equal(s.scrub("samevalue"), "[SECRET a.password]");
});

test("named_secret_is_found_in_quoted_code", () => {
  const s = new Scrubber();
  s.addNamedSecret(`it's "x"\\`, secretMarker("a"));
  assert.equal(s.scrub(`fill('it\\'s "x"\\\\')`), `fill('[SECRET a.password]')`);
  assert.equal(s.scrub(`{"v":"it's \\"x\\"\\\\"}`), `{"v":"[SECRET a.password]"}`);
  assert.equal(s.scrub(`typed it's "x"\\ here`), `typed [SECRET a.password] here`);
});

test("named_secret_is_found_url_encoded", () => {
  const s = new Scrubber();
  s.addNamedSecret("p@ss word&", secretMarker("a"));
  assert.equal(s.scrub("user=u&password=p%40ss+word%26&x=1"), "user=u&password=[SECRET a.password]&x=1");
  assert.equal(s.scrub("?pw=p%40ss%20word%26"), "?pw=[SECRET a.password]");
});
