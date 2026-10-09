import assert from "node:assert/strict";
import { test } from "node:test";

import { envBody, envDraft, envOptions, envValue } from "../../web/src/environment.ts";

test("envValue shows none for no environment", () => {
  assert.equal(envValue(null), "none");
  assert.equal(envValue("qa"), "qa");
});

test("envDraft maps overrides to a select value", () => {
  assert.equal(envDraft({}), "");
  assert.equal(envDraft({ env: null }), "none");
  assert.equal(envDraft({ env: "qa" }), "qa");
});

test("envBody maps a select value to override fields", () => {
  assert.deepEqual(envBody(""), {});
  assert.deepEqual(envBody("none"), { env: null });
  assert.deepEqual(envBody("qa"), { env: "qa" });
});

test("envOptions lists inherit, none, names and an unlisted draft", () => {
  assert.deepEqual(envOptions(null, [], ""), [
    { value: "", label: "inherit (none)" },
    { value: "none", label: "none" },
  ]);
  assert.deepEqual(
    envOptions("staging", ["qa", "staging"], "old").map((o) => o.value),
    ["", "none", "qa", "staging", "old"],
  );
  assert.equal(envOptions("staging", ["qa", "staging"], "old")[0]?.label, "inherit (staging)");
});
