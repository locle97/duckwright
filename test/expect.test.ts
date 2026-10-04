import assert from "node:assert/strict";
import { test } from "node:test";

import { checkArgs, runExpect } from "../src/expect.ts";
import type { ProcResult } from "../src/proc.ts";
import { PlaywrightCLI } from "../src/pw.ts";

const LOC: ProcResult = { code: 0, stdout: "getByTestId('msg')\n", stderr: "" };
const ALLOWED_MSG = "(allowed: visible, text, value, checked, unchecked, url)";

function val(v: unknown): ProcResult {
  return { code: 0, stdout: JSON.stringify(v) + "\n", stderr: "" };
}

function makePw(responses: Record<string, ProcResult>): [PlaywrightCLI, string[][]] {
  const calls: string[][] = [];
  const runner = async (argv: string[]): Promise<ProcResult> => {
    calls.push(argv.slice(2));
    return responses[argv[2]];
  };
  return [new PlaywrightCLI({ session: "t", runner }), calls];
}

for (const args of [
  ["visible", "e1"], ["text", "e1", "Hi"], ["value", "e1", ""],
  ["checked", "e1"], ["unchecked", "e1"], ["url", "https://x/"],
]) {
  test(`check_args_accepts_each_check ${args[0]}`, () => {
    assert.equal(checkArgs(args), null);
  });
}

test("check_args_unknown_check", () => {
  assert.ok(checkArgs(["exists", "e1"])!.startsWith(`error: expect check 'exists' not allowed ${ALLOWED_MSG}`));
  assert.ok(checkArgs([])!.startsWith(`error: expect check '' not allowed ${ALLOWED_MSG}`));
});

test("check_args_wrong_arity", () => {
  assert.equal(checkArgs(["text", "e1"]), "error: usage: expect text <ref> <expected>");
  assert.equal(checkArgs(["visible", "e1", "x"]), "error: usage: expect visible <ref>");
  assert.equal(checkArgs(["url"]), "error: usage: expect url <expected>");
});

for (const ref of ["--session=x", "#id", ""]) {
  test(`check_args_bad_ref ${JSON.stringify(ref)}`, () => {
    assert.equal(
      checkArgs(["visible", ref]),
      `error: expect ref must be a snapshot ref like e15, got ${JSON.stringify(ref)}`,
    );
  });
}

test("visible_pass_records_code", async () => {
  const [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val(true) });
  assert.deepEqual(await runExpect(pw, ["visible", "e7"]), [
    "ok", "await expect(page.getByTestId('msg')).toBeVisible();",
  ]);
  assert.deepEqual(calls, [
    ["generate-locator", "e7", "--raw"],
    ["run-code", "async page => await page.getByTestId('msg').isVisible()", "--raw"],
  ]);
});

test("text_pass_records_code", async () => {
  const [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val("Welcome, Linh") });
  assert.deepEqual(await runExpect(pw, ["text", "e7", "Welcome, Linh"]), [
    "ok", "await expect(page.getByTestId('msg')).toHaveText(\"Welcome, Linh\");",
  ]);
  assert.ok(calls[1][1].endsWith(".textContent()"));
});

test("text_compares_normalized_whitespace", async () => {
  const [pw] = makePw({ "generate-locator": LOC, "run-code": val("  Hello \n  World ") });
  for (const expected of ["Hello World", "Hello  World "]) {
    const [res, code] = await runExpect(pw, ["text", "e7", expected]);
    assert.equal(res, "ok");
    assert.ok(code!.endsWith('toHaveText("Hello World");'));
  }
});

test("text_mismatch_reports_actual", async () => {
  const [pw] = makePw({ "generate-locator": LOC, "run-code": val("Hello, !") });
  assert.deepEqual(await runExpect(pw, ["text", "e7", "Hello, Linh!"]), [
    'error: expect text failed: expected "Hello, Linh!", got "Hello, !"', null,
  ]);
});

test("text_null_content_is_empty", async () => {
  const [pw] = makePw({ "generate-locator": LOC, "run-code": val(null) });
  assert.equal((await runExpect(pw, ["text", "e7", ""]))[0], "ok");
});

test("value_pass_and_mismatch", async () => {
  let [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val("a@b.c") });
  const [res, code] = await runExpect(pw, ["value", "e7", "a@b.c"]);
  assert.equal(res, "ok");
  assert.equal(code, "await expect(page.getByTestId('msg')).toHaveValue(\"a@b.c\");");
  assert.ok(calls[1][1].endsWith(".inputValue()"));
  [pw] = makePw({ "generate-locator": LOC, "run-code": val("a ") });
  assert.deepEqual(await runExpect(pw, ["value", "e7", "a"]), [
    'error: expect value failed: expected "a", got "a "', null,
  ]);
});

test("value_non_string_result_is_stringified", async () => {
  const [pw] = makePw({ "generate-locator": LOC, "run-code": val(5) });
  assert.equal((await runExpect(pw, ["value", "e7", "5"]))[0], "ok");
});

test("checked_and_unchecked", async () => {
  let [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val(true) });
  assert.equal((await runExpect(pw, ["checked", "e7"]))[1], "await expect(page.getByTestId('msg')).toBeChecked();");
  assert.ok(calls[1][1].endsWith(".isChecked()"));
  assert.deepEqual(await runExpect(pw, ["unchecked", "e7"]), [
    "error: expect unchecked failed: element is checked", null,
  ]);
  [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val(false) });
  assert.equal(
    (await runExpect(pw, ["unchecked", "e7"]))[1],
    "await expect(page.getByTestId('msg')).not.toBeChecked();",
  );
  assert.ok(calls[1][1].endsWith(".isChecked()"));
  assert.deepEqual(await runExpect(pw, ["checked", "e7"]), [
    "error: expect checked failed: element is not checked", null,
  ]);
  assert.deepEqual(await runExpect(pw, ["visible", "e7"]), [
    "error: expect visible failed: element is not visible", null,
  ]);
});

test("boolean_check_needs_a_real_boolean", async () => {
  const [pw] = makePw({ "generate-locator": LOC, "run-code": val(1) });
  assert.deepEqual(await runExpect(pw, ["visible", "e7"]), [
    "error: expect visible failed: element is not visible", null,
  ]);
});

test("url_skips_locator", async () => {
  let [pw, calls] = makePw({ "run-code": val("https://x/") });
  assert.deepEqual(await runExpect(pw, ["url", "https://x/"]), [
    "ok", 'await expect(page).toHaveURL("https://x/");',
  ]);
  assert.deepEqual(calls, [["run-code", "async page => page.url()", "--raw"]]);
  [pw] = makePw({ "run-code": val("https://x/a") });
  assert.deepEqual(await runExpect(pw, ["url", "https://x/"]), [
    'error: expect url failed: expected "https://x/", got "https://x/a"', null,
  ]);
});

test("generate_locator_error_is_reported", async () => {
  const err: ProcResult = {
    code: 1,
    stdout: "### Error\nError: Ref e99 not found in the current page snapshot. Try capturing new snapshot.",
    stderr: "",
  };
  let [pw, calls] = makePw({ "generate-locator": err });
  const [res, code] = await runExpect(pw, ["visible", "e99"]);
  assert.ok(res.startsWith("error: "));
  assert.ok(res.includes("Ref e99 not found"));
  assert.equal(code, null);
  assert.deepEqual(calls.map((c) => c[0]), ["generate-locator"]);

  [pw] = makePw({ "generate-locator": { code: -1, stdout: "", stderr: "timeout" } });
  assert.deepEqual(await runExpect(pw, ["visible", "e1"]), ["error: timeout", null]);
});

test("run_code_error_is_reported", async () => {
  const err: ProcResult = { code: 1, stdout: "### Error\nError: strict mode violation: resolved to 2 elements", stderr: "" };
  const [pw] = makePw({ "generate-locator": LOC, "run-code": err });
  const [res, code] = await runExpect(pw, ["visible", "e7"]);
  assert.ok(res.startsWith("error: "));
  assert.ok(res.includes("strict mode violation"));
  assert.equal(code, null);
});

for (const out of ["getByText('a')\nevil()", "page.goto('x')", ""]) {
  test(`unusable_locator_is_rejected ${JSON.stringify(out)}`, async () => {
    const [pw, calls] = makePw({ "generate-locator": { code: 0, stdout: out, stderr: "" } });
    assert.deepEqual(await runExpect(pw, ["visible", "e7"]), [
      `error: expect: unusable locator ${JSON.stringify(out.trim())}`, null,
    ]);
    assert.deepEqual(calls.map((c) => c[0]), ["generate-locator"]);
  });
}

test("non_json_run_code_output_is_error", async () => {
  const [pw] = makePw({ "generate-locator": LOC, "run-code": { code: 0, stdout: "oops", stderr: "" } });
  assert.deepEqual(await runExpect(pw, ["visible", "e7"]), ['error: expect: unreadable result "oops"', null]);
});

test("expected_text_never_reaches_cli", async () => {
  const expected = 'It\'s "ok"\\\n--x';
  const pageText = expected.split(/\s+/).filter(Boolean).join(" ");
  const [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val(pageText) });
  const [res, code] = await runExpect(pw, ["text", "e7", expected]);
  assert.equal(res, "ok");
  assert.ok(!calls.some((call) => call.some((part) => part.includes("It's"))));
  assert.ok(code!.endsWith("toHaveText(" + JSON.stringify(pageText) + ");"));
});

for (const out of [
  "getByRole('heading', { name: 'Hello World' })",
  "getByRole('button', { name: 'Go' }).first()",
  "getByRole('heading', { name: 'Hi', exact: true, level: 1 })",
  "getByText(/Total: \\d+/i)",
  "getByText('it\\'s ); evil()')",
  "locator('#main').getByText(\"a;b\").nth(2)",
  "locator('iframe').contentFrame().getByTestId('x')",
  "getByRole('listitem').filter({ hasText: 'Milk' })",
]) {
  test(`generated_locator_shapes_accepted ${out}`, async () => {
    const [pw, calls] = makePw({ "generate-locator": { code: 0, stdout: out + "\n", stderr: "" }, "run-code": val(true) });
    assert.equal((await runExpect(pw, ["visible", "e7"]))[0], "ok");
    assert.equal(calls[1][1], `async page => await page.${out}.isVisible()`);
  });
}

for (const out of [
  "locator('a').evaluate(() => fetch('//x'))",
  "getByText('a').fill('x')",
  "getByText('a'); fetch('x'); getByText('b')",
  "getByText(`a${fetch('x')}`)",
  "getByText('a' + fetch('x'))",
  "getByText('unterminated)",
  "getByText('a')/fetch('x')/a.first()",
]) {
  test(`locator_with_other_calls_is_rejected ${out}`, async () => {
    const [pw, calls] = makePw({ "generate-locator": { code: 0, stdout: out, stderr: "" } });
    const [res, code] = await runExpect(pw, ["visible", "e7"]);
    assert.ok(res.startsWith("error: expect: unusable locator "));
    assert.equal(code, null);
    assert.deepEqual(calls.map((c) => c[0]), ["generate-locator"]);
  });
}

test("text_normalizes_like_playwright", async () => {
  // Playwright drops U+200B and collapses only JS whitespace (\s), not \x1c-\x1f.
  let [pw] = makePw({ "generate-locator": LOC, "run-code": val("Hello\u200bWorld\u00a0!") });
  assert.equal((await runExpect(pw, ["text", "e7", "HelloWorld !"]))[0], "ok");
  [pw] = makePw({ "generate-locator": LOC, "run-code": val("a\x1fb") });
  assert.ok((await runExpect(pw, ["text", "e7", "a b"]))[0].startsWith("error: expect text failed"));
});

test("ref_first_order_is_accepted", async () => {
  assert.equal(checkArgs(["e1356", "text", "Hadilao"]), null);
  assert.equal(checkArgs(["e1", "visible"]), null);
  const [pw, calls] = makePw({ "generate-locator": LOC, "run-code": val("Hadilao") });
  assert.deepEqual(await runExpect(pw, ["e1356", "text", "Hadilao"]), [
    "ok", "await expect(page.getByTestId('msg')).toHaveText(\"Hadilao\");",
  ]);
  assert.deepEqual(calls[0], ["generate-locator", "e1356", "--raw"]);
});

test("unknown_check_error_shows_usage", () => {
  const msg = checkArgs(["e1356", "toHaveText", "Hadilao"])!;
  assert.ok(msg.startsWith(`error: expect check 'e1356' not allowed ${ALLOWED_MSG}`));
  assert.ok(msg.includes('args are [<check>, <ref>, <expected>], e.g. ["text", "e15", "Hello"]'));
});
