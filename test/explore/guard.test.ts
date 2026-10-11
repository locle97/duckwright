// test/explore/guard.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { WriteGuard, findControl, isDeleteLike, parseSnapshot, readAudit, readRefusals } from "../../src/explore/guard.ts";
import { tmpDir } from "../helpers.ts";

const M = "DW-261011-a3f9-";
const tabs = (title: string, url = "https://s.test/r/pasta") => `### Result\n- 0: (current) [${title}](${url})\n`;
const detail = [
  "- main [ref=e1]:",
  `  - heading "${M}Pasta" [level=1] [ref=e2]`,
  '  - button "Edit" [ref=e3]',
  '  - button "Delete" [ref=e4]',
  '  - searchbox "Search recipes" [ref=e5]',
  '  - textbox "Name" [ref=e6]',
].join("\n");
const list = [
  "- main [ref=e1]:",
  '  - heading "Recipes" [level=1] [ref=e2]',
  "  - list [ref=e3]:",
  "    - listitem [ref=e4]:",
  `      - link "${M}Pasta" [ref=e5]`,
  '      - button "Delete" [ref=e6]',
  "    - listitem [ref=e7]:",
  '      - link "Old soup" [ref=e8]',
  '      - button "Delete" [ref=e9]',
].join("\n");
const dialogPage = [
  '- heading "Recipes" [level=1] [ref=e1]',
  '- alertdialog "Delete recipe?" [ref=e2]:',
  `  - paragraph [ref=e3]: Delete ${M}Pasta for good?`,
  '  - button "Cancel" [ref=e4]',
  '  - button "Confirm" [ref=e5]',
].join("\n");

function guard(snapshot: string | null, title: string, url?: string) {
  const dir = tmpDir();
  const g = new WriteGuard(dir, M);
  g.begin(3, tabs(title, url), snapshot);
  return { g, dir };
}

test("parseSnapshot reads roles, quoted names, refs and inline text", () => {
  const lines = parseSnapshot(['- button "Delete \\"x\\"" [ref=e4]', "  - paragraph [ref=e5]: £5", "- /url: a.html"].join("\n"));
  assert.deepEqual(lines.map((l) => [l.role, l.name, l.ref, l.text]), [
    ["button", 'Delete "x"', "e4", ""],
    ["paragraph", "", "e5", "£5"],
  ]);
});

test("delete-like detection: names, confirm in a dialog, and plain buttons", () => {
  const lines = parseSnapshot(dialogPage);
  assert.equal(isDeleteLike(lines, findControl(lines, "e5")!), true); // Confirm inside alertdialog
  assert.equal(isDeleteLike(lines, findControl(lines, "e4")!), false); // Cancel
  const plain = parseSnapshot(detail);
  assert.equal(isDeleteLike(plain, findControl(plain, "e4")!), true);
  assert.equal(isDeleteLike(plain, findControl(plain, "e3")!), false);
  const confirmOutside = parseSnapshot('- button "Confirm" [ref=e1]');
  assert.equal(isDeleteLike(confirmOutside, findControl(confirmOutside, "e1")!), false);
});

test("a delete on a page whose title names the marker is allowed", () => {
  const { g } = guard(detail, `${M}Pasta | Mealie`);
  assert.equal(g.check({ cmd: "click", args: ["e4"] }), null);
});

test("a delete on a page whose heading names the marker is allowed even with a plain title", () => {
  const { g } = guard(detail, "Mealie");
  assert.equal(g.check({ cmd: "dblclick", args: ["e4"] }), null);
});

test("a delete in an open dialog that names the marker is allowed", () => {
  const { g } = guard(dialogPage, "Recipes");
  assert.equal(g.check({ cmd: "click", args: ["e5"] }), null);
});

test("a delete from a list page is refused, counted and recorded", () => {
  const { g, dir } = guard(list, "Recipes", "https://s.test/g/home");
  // The marker appears in a link name in the list, not in the title, a heading or a dialog.
  const out = g.check({ cmd: "click", args: ["e9"] });
  assert.equal(out, `error: refused: 'Delete' acts on a page that does not carry the marker ${M}; open the item you created first, or skip it`);
  assert.deepEqual(readRefusals(dir), [{ step: 3, control: "Delete", url: "https://s.test/g/home" }]);
});

test("another run's marker or a marker only in body text does not unlock a delete", () => {
  const other = guard(detail.replace(M, "DW-261011-ffff-"), "DW-261011-ffff-Pasta | Mealie");
  assert.match(other.g.check({ cmd: "click", args: ["e4"] }) ?? "", /^error: refused:/);
  const body = guard([`- paragraph [ref=e1]: ${M} is mentioned here`, '- button "Delete" [ref=e2]'].join("\n"), "Mealie");
  assert.match(body.g.check({ cmd: "click", args: ["e2"] }) ?? "", /^error: refused:/);
});

test("non-destructive clicks, unknown refs and press pass; an unreadable snapshot refuses every click", () => {
  const ok = guard(detail, "Mealie");
  assert.equal(ok.g.check({ cmd: "click", args: ["e3"] }), null);
  assert.equal(ok.g.check({ cmd: "click", args: ["e99"] }), null);
  assert.equal(ok.g.check({ cmd: "press", args: ["Enter"] }), null);
  assert.equal(ok.g.check({ cmd: "hover", args: ["e4"] }), null);
  const blind = guard(null, "Mealie");
  assert.equal(blind.g.check({ cmd: "click", args: ["e3"] }), "error: refused: cannot evaluate the page; try again next step");
  assert.deepEqual(readRefusals(blind.dir).map((r) => r.control), ["(unreadable page)"]);
  assert.match(guard("   ", "Mealie").g.check({ cmd: "click", args: ["e3"] }) ?? "", /cannot evaluate/);
});

test("edits on an unmarked page are audited, never blocked", () => {
  const { g, dir } = guard(detail.replace(M, ""), "Mealie", "https://s.test/r/old");
  assert.equal(g.check({ cmd: "fill", args: ["e6", "Renamed"] }), null);
  assert.deepEqual(readAudit(dir), [{ step: 3, url: "https://s.test/r/old", control: 'textbox "Name"', cmd: "fill" }]);
});

test("audit skips marked pages, marker-valued names, search controls and ledger URLs", () => {
  const marked = guard(detail, `${M}Pasta | Mealie`);
  marked.g.check({ cmd: "fill", args: ["e6", "Renamed"] });
  assert.deepEqual(readAudit(marked.dir), []);

  const naming = guard(detail.replace(M, ""), "Mealie");
  naming.g.check({ cmd: "fill", args: ["e6", `${M}Soup`] });
  assert.deepEqual(readAudit(naming.dir), []);

  const search = guard(detail.replace(M, ""), "Mealie");
  search.g.check({ cmd: "fill", args: ["e5", "soup"] });
  assert.deepEqual(readAudit(search.dir), []);

  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "created.jsonl"), JSON.stringify({ step: 1, created: `${M}Pasta`, url: "https://s.test/r/pasta" }) + "\n");
  const g = new WriteGuard(dir, M);
  g.begin(5, tabs("Mealie", "https://s.test/r/pasta"), detail.replace(M, ""));
  g.check({ cmd: "select", args: ["e6", "x"] });
  assert.deepEqual(readAudit(dir), []);
});

test("readRefusals and readAudit tolerate missing and damaged files", () => {
  assert.deepEqual(readRefusals(tmpDir()), []);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "refused.jsonl"), 'garbage\n{"step":1,"control":"Delete","url":null}\n');
  assert.deepEqual(readRefusals(dir), [{ step: 1, control: "Delete", url: null }]);
});

test("parseSnapshot copes with a realistic nested snapshot and odd lines", () => {
  const snap = [
    "- generic [active] [ref=e1]:",
    '  - dialog "Remove \\"Pasta\\"?" [ref=e2]:',
    '    - button "Close" [ref=e3] [cursor=pointer]',
    '      - img',
    "    - text: Are you sure?",
    '    - link "Home" [ref=e4] [cursor=pointer]:',
    "      - /url: /g/home",
    "  garbage without a dash",
    '  - button "unterminated [ref=e5]',
    "",
  ].join("\n");
  const lines = parseSnapshot(snap);
  assert.equal(findControl(lines, "e3")?.name, "Close");
  assert.equal(findControl(lines, "e2")?.name, 'Remove "Pasta"?');
  assert.equal(lines.find((l) => l.role === "text")?.text, "Are you sure?");
  assert.equal(findControl(lines, "e4")?.role, "link");
});

const grid = [
  "- main [ref=e1]:",
  '  - article [ref=e2]:',
  `    - heading "${M}Pasta" [level=2] [ref=e3]`,
  '    - button "Delete" [ref=e4]',
  '  - article [ref=e5]:',
  '    - heading "Old soup" [level=2] [ref=e6]',
  '    - button "Delete" [ref=e7]',
].join("\n");

test("flag-first refs are still evaluated and audited", () => {
  const { g } = guard(list, "Recipes");
  const refused = /^error: refused:/;
  assert.match(g.check({ cmd: "click", args: ["--modifiers=Shift", "e9"] }) ?? "", refused);
  assert.match(g.check({ cmd: "click", args: ["--modifiers", "Shift", "e9"] }) ?? "", refused);
  assert.match(g.check({ cmd: "dblclick", args: ["e9"] }) ?? "", refused);
  const a = guard(detail.replace(M, ""), "Mealie");
  a.g.check({ cmd: "fill", args: ["--submit", "e6", "x"] });
  assert.deepEqual(readAudit(a.dir).map((e) => e.control), ['textbox "Name"']);
});

test("iframe refs like f1e3 are evaluated", () => {
  const snap = ['- iframe [ref=e2]:', '  - main [ref=f1e1]:', '    - button "Delete" [ref=f1e3]'].join("\n");
  const { g } = guard(snap, "Recipes");
  assert.match(g.check({ cmd: "click", args: ["f1e3"] }) ?? "", /^error: refused: 'Delete'/);
});

test("a marked title or h1 unlocks a delete only on a page with at most one delete-like control", () => {
  assert.equal(guard(detail, "Mealie").g.check({ cmd: "click", args: ["e4"] }), null);
  const second = guard(grid, "Recipes").g;
  assert.match(second.check({ cmd: "click", args: ["e7"] }) ?? "", /^error: refused:/);
  assert.match(second.check({ cmd: "click", args: ["e4"] }) ?? "", /^error: refused:/); // non-h1 heading never unlocks
  const results = [
    '- heading "Results for \"' + M + 'x\"" [level=1] [ref=e1]',
    '- button "Delete" [ref=e2]',
    '- button "Delete" [ref=e3]',
  ].join("\n");
  const r = guard(results, "Recipes").g;
  assert.match(r.check({ cmd: "click", args: ["e2"] }) ?? "", /^error: refused:/);
  assert.match(r.check({ cmd: "click", args: ["e3"] }) ?? "", /^error: refused:/);
  // Safe by design: two delete-like buttons on a marked detail page are refused too.
  const two = detail + '\n  - button "Remove photo" [ref=e8]';
  assert.match(guard(two, `${M}Pasta | Mealie`).g.check({ cmd: "click", args: ["e4"] }) ?? "", /^error: refused:/);
});

test("a generic dialog on a marked detail page with one delete-like control outside still allows Confirm", () => {
  const snap = [
    `- heading "${M}Pasta" [level=1] [ref=e1]`,
    '- button "Delete" [ref=e2]',
    '- dialog "Are you sure?" [ref=e3]:',
    '  - button "Confirm" [ref=e4]',
  ].join("\n");
  assert.equal(guard(snap, "Mealie").g.check({ cmd: "click", args: ["e4"] }), null);
});

test("type edits are audited as the focused element unless marker-valued", () => {
  const a = guard(detail.replace(M, ""), "Mealie", "https://s.test/r/old");
  a.g.check({ cmd: "type", args: ["Renamed"] });
  assert.deepEqual(readAudit(a.dir), [{ step: 3, url: "https://s.test/r/old", control: "(focused element)", cmd: "type" }]);
  const b = guard(detail.replace(M, ""), "Mealie");
  b.g.check({ cmd: "type", args: [`${M}x`] });
  assert.deepEqual(readAudit(b.dir), []);
});

test("a snapshot that parses to no lines is unreadable", () => {
  const { g, dir } = guard("<html>error</html>", "Mealie");
  assert.match(g.check({ cmd: "click", args: ["e3"] }) ?? "", /cannot evaluate/);
  assert.deepEqual(readRefusals(dir).map((r) => r.control), ["(unreadable page)"]);
});

test("clicks by selector or locator are refused and recorded; ref-shaped unknown refs and target-less clicks pass", () => {
  const { g, dir } = guard(detail, `${M}Pasta | Mealie`, "https://s.test/r/pasta");
  const msg = "error: refused: click targets must be a ref from the snapshot; use the ref of the control";
  assert.equal(g.check({ cmd: "click", args: ["#delete"] }), msg);
  assert.equal(g.check({ cmd: "dblclick", args: ["--modifiers=Shift", "getByRole('button', { name: 'Delete' })"] }), msg);
  assert.deepEqual(readRefusals(dir).map((r) => r.control), ["#delete", "getByRole('button', { name: 'Delete' })"]);
  assert.equal(g.check({ cmd: "click", args: ["e99"] }), null);
  assert.equal(g.check({ cmd: "click", args: ["f1e99"] }), null);
  assert.equal(g.check({ cmd: "click", args: ["e3"] }), null);
  assert.equal(g.check({ cmd: "click", args: [] }), null);
});

test("inline text cannot spoof a ref or a heading level", () => {
  const snap = ["- text: note [ref=e9]", '- button "Delete" [ref=e9] [cursor=pointer]'].join("\n");
  const { g } = guard(snap, "Recipes");
  assert.match(g.check({ cmd: "click", args: ["e9"] }) ?? "", /^error: refused: 'Delete'/);
  const lines = parseSnapshot(['- heading "T" [level=1] [ref=e2]', "- paragraph [ref=e3]: see [level=1] here"].join("\n"));
  assert.equal(lines[0].level, 1);
  assert.equal(lines[0].ref, "e2");
  assert.equal(lines[1].level, null);
  assert.equal(lines[1].text, "see [level=1] here");
  assert.equal(parseSnapshot("- paragraph: [level=1] [ref=e5]")[0].ref, null);
});

test("single-quoted YAML keys are unwrapped so delete-like names are still found", () => {
  const refused = /^error: refused: /;
  for (const line of [
    `- 'button "Delete #3" [ref=e9]'`,
    `- 'button "Delete: Pasta" [ref=e9]': inline`,
    `- 'button "It''s gone: Delete" [ref=e9]'`,
  ]) {
    const { g } = guard(`- main [ref=e1]:\n  ${line}`, "Recipes");
    assert.match(g.check({ cmd: "click", args: ["e9"] }) ?? "", refused, line);
  }
  assert.equal(parseSnapshot(`- 'button "It''s gone: Delete" [ref=e9]'`)[0].name, "It's gone: Delete");
});

test("a quoted level-1 heading with the marker unlocks the one delete on a detail page", () => {
  const snap = [`- 'heading "${M}x: y" [level=1] [ref=e2]'`, '- button "Delete" [ref=e3]'].join("\n");
  assert.equal(parseSnapshot(snap)[0].level, 1);
  assert.equal(guard(snap, "Mealie").g.check({ cmd: "click", args: ["e3"] }), null);
});

test("unparsed controls fail closed; unparsed lines without a ref are ignored", () => {
  const { g } = guard("- main [ref=e1]:\n  - button /Delete \\d+/ [ref=e9]", "Recipes");
  assert.match(g.check({ cmd: "click", args: ["e9"] }) ?? "", /^error: refused: /);
  assert.equal(parseSnapshot("- /url: /x\n- ??? weird").length, 0);
  const harmless = guard("- /url: /x\n- button \"Edit\" [ref=e3]", "Recipes").g;
  assert.equal(harmless.check({ cmd: "click", args: ["e3"] }), null);
});

test("inline text in the quoted form cannot spoof a ref", () => {
  const snap = [`- 'text: note [ref=e9]'`, '- button "Delete" [ref=e9]'].join("\n");
  assert.match(guard(snap, "Recipes").g.check({ cmd: "click", args: ["e9"] }) ?? "", /^error: refused: 'Delete'/);
});

const refusedAny = /^error: refused: /;
const clickE9 = (snap: string) => guard(snap, "Recipes").g.check({ cmd: "click", args: ["e9"] }) ?? "";

test("property lines never shadow the real control", () => {
  assert.match(clickE9('- link "Docs" [ref=e3]:\n  - /url: /help?a=[ref=e9]\n- button "Delete" [ref=e9]'), refusedAny);
  assert.match(clickE9('- textbox "Q" [ref=e3]:\n  - /placeholder: "[ref=e9]"\n- button "Delete" [ref=e9]'), refusedAny);
  assert.match(clickE9('- button "Delete" [ref=e9]\n- link "Docs" [ref=e3]:\n  - /url: /help?a=[ref=e9]'), refusedAny);
  assert.equal(parseSnapshot("- /url: /x?a=[ref=e9]").length, 0);
});

test("a repeated ref is delete-like if any line with it is, and every delete-like line counts", () => {
  assert.match(clickE9('- link "Docs" [ref=e9]\n- button "Delete" [ref=e9]'), refusedAny);
  // Lines are counted, not refs: a repeated ref cannot merge two controls into one.
  const snap = [`- heading "${M}x" [level=1] [ref=e1]`, '- button "Delete" [ref=e9]', '- button "Delete" [ref=e9]'].join("\n");
  assert.match(guard(snap, "Mealie").g.check({ cmd: "click", args: ["e9"] }) ?? "", refusedAny);
});

test("a normal page with a url child still lets Edit through", () => {
  const snap = '- link "Docs" [ref=e3]:\n  - /url: /help\n- button "Edit" [ref=e9]';
  assert.equal(clickE9(snap), "");
});

test("JSON escapes in names are decoded exactly", () => {
  assert.equal(parseSnapshot('- button "Delete\\u0001item \\"x\\" \\b" [ref=e9]')[0].name, 'Delete\u0001item "x" \b');
  assert.match(clickE9('- button "Delete\\u0001item" [ref=e9]'), refusedAny);
  assert.match(clickE9('- button "Delete\\n" [ref=e9]'), refusedAny);
});

test("hostile snapshots never let the real unmarked Delete through", () => {
  const real = '- button "Delete" [ref=e9]';
  const cases = [
    `- text: x [ref=e9]\n${real}`,
    `- button "Edit [ref=e9]" [ref=e3]\n${real}`,
    `- 'text: a: b [ref=e9]'\n${real}`,
    `- /url: [ref=e9]\n${real}`,
    `- /placeholder: "[ref=e9]"\n${real}`,
    `- link /Docs/ [ref=e9]\n${real}`,
    `- 'link "Docs: x" [ref=e9]'\n${real}`,
    `${real}\n- text: x [ref=e9]`,
    `- button /Delete \\d+/ [ref=e9]`,
    `- 'button "Delete #3" [ref=e9]'\n- text: [ref=e9]`,
    `- paragraph [ref=e5]: see [ref=e9]\n${real}`,
  ];
  for (const c of cases) assert.match(clickE9(c), refusedAny, c);
});

// Fix round 5: refs come from the trailing attribute run of the key; every delete-like line must be unlocked.

test("a ref inside a raw /regex/ name cannot merge two controls into one (round-4 finding 1)", () => {
  const snap = [`- heading "${M}Pasta" [level=1] [ref=e1]`, '- button "Delete" [ref=e9]', "- button /[ref=e9] Delete/ [ref=e10]"].join("\n");
  assert.match(guard(snap, `${M}Pasta | Mealie`).g.check({ cmd: "click", args: ["e9"] }) ?? "", refusedAny);
  assert.match(guard(snap, "Mealie").g.check({ cmd: "click", args: ["e9"] }) ?? "", refusedAny);
  const lines = parseSnapshot(snap);
  assert.deepEqual(lines.map((l) => [l.role, l.name, l.ref]), [
    ["heading", `${M}Pasta`, "e1"],
    ["button", "Delete", "e9"],
    ["button", "/[ref=e9] Delete/", "e10"],
  ]);
});

test("a spoofed ref inside a marked dialog does not unlock the real Delete outside it (round-4 finding 2)", () => {
  const snap = ['- dialog "N" [ref=e2]:', `  - text: ${M}`, "  - button /[ref=e9] remove/ [ref=e4]", '- button "Delete" [ref=e9]'].join("\n");
  assert.match(clickE9(snap), refusedAny);
  // Poisoned form: the spoof line has no usable trailing ref, so the ref it mentions is filed under it too.
  const poisoned = ['- dialog "N" [ref=e2]:', `  - text: ${M}`, "  - button /[ref=e9] remove/ x", '- button "Delete" [ref=e9]'].join("\n");
  assert.match(clickE9(poisoned), refusedAny);
});

test("a control named /[ref=e1] Delete everything/ is found by its real ref e10", () => {
  const snap = ['- button "Edit" [ref=e1]', "- button /[ref=e1] Delete everything/ [ref=e10]"].join("\n");
  assert.match(guard(snap, "Recipes").g.check({ cmd: "click", args: ["e10"] }) ?? "", /^error: refused: '\/\[ref=e1\] Delete everything\/'/);
  assert.equal(guard(snap, "Recipes").g.check({ cmd: "click", args: ["e1"] }), null);
  assert.equal(parseSnapshot(snap)[1].ref, "e10");
});

test("spoof lines before and after the real Delete on a marked page refuse it", () => {
  const head = `- heading "${M}Pasta" [level=1] [ref=e1]`;
  const real = '- button "Delete" [ref=e9]';
  for (const spoof of ["- button /[ref=e9] Delete/ [ref=e10]", "- link /x [ref=e9] remove/ [ref=e11]", "- button /[ref=e9] Delete/ x"]) {
    for (const snap of [[head, spoof, real], [head, real, spoof]]) {
      assert.match(guard(snap.join("\n"), `${M}Pasta | Mealie`).g.check({ cmd: "click", args: ["e9"] }) ?? "", refusedAny, snap.join(" / "));
    }
  }
});

test("an unparsed delete-like line without a trailing ref makes every ref it mentions stricter", () => {
  assert.match(clickE9('- button /x/ Delete [ref=e9] trailing\n- button "Edit" [ref=e9]'), refusedAny);
  assert.match(clickE9('- button "Edit" [ref=e9]\n- button[ref=e9] Delete'), refusedAny);
  // Without a delete word the mention changes nothing.
  assert.equal(clickE9('- button /x/ keep [ref=e9] trailing\n- button "Edit" [ref=e9]'), "");
});

test("a normal page with unique refs behaves as before", () => {
  const ok = guard(detail, "Mealie").g;
  assert.equal(ok.check({ cmd: "click", args: ["e4"] }), null);
  assert.equal(ok.check({ cmd: "click", args: ["e3"] }), null);
  assert.match(guard(detail.replace(M, ""), "Mealie").g.check({ cmd: "click", args: ["e4"] }) ?? "", /^error: refused: 'Delete'/);
  assert.equal(guard(dialogPage, "Recipes").g.check({ cmd: "click", args: ["e5"] }), null);
  assert.match(guard(list, "Recipes").g.check({ cmd: "click", args: ["e6"] }) ?? "", refusedAny);
  const lines = parseSnapshot(detail);
  assert.deepEqual(lines.map((l) => l.ref), ["e1", "e2", "e3", "e4", "e5", "e6"]);
  assert.equal(lines[1].level, 1);
  assert.equal(parseSnapshot('- button "Delete" [disabled] [ref=e7] [cursor=pointer] [box=1,2,3,4]')[0].ref, "e7");
});

test("hostile snapshots in the regex and attribute-run forms never loosen a click", () => {
  const marked = `- heading "${M}Pasta" [level=1] [ref=e1]`;
  const real = '- button "Delete" [ref=e9]';
  // Each case: [snapshot, tab title]; clicking e9 must be refused.
  const cases: [string, string][] = [
    [`${marked}\n${real}\n- button /[ref=e9] Delete/ [ref=e10]`, `${M}Pasta | Mealie`],
    [`${marked}\n- button /[ref=e9] Delete/ [ref=e10]\n${real}`, "Mealie"],
    [`- dialog "N" [ref=e2]:\n  - text: ${M}\n  - button /[ref=e9] remove/ [ref=e4]\n${real}`, "Recipes"],
    [`- dialog "N" [ref=e2]:\n  - text: ${M}\n  - 'button /[ref=e9] remove/'\n${real}`, "Recipes"],
    [`- dialog "${M}" [ref=e2]:\n  - button "Delete" [ref=e9]\n${real}`, "Recipes"],
    [`${real}\n- dialog "${M}" [ref=e2]:\n  - button "Delete" [ref=e9]`, "Recipes"],
    [`- button /a/ [ref=e9] /b/ [ref=e3]\n${real}`, "Recipes"],
    [`- button "x" [ref=e3] [ref=e9]\n${real}`, "Recipes"],
    [`- button /x/ "[ref=e9] Delete" [ref=e10]\n${real}`, "Recipes"],
    [`${marked}\n${real}\n- button[ref=e9] remove`, `${M}Pasta | Mealie`],
    [`${marked}\n${real}\n- 'button "remove: x" [ref=e12]'`, `${M}Pasta | Mealie`],
    [`${marked}\n- 'button /[ref=e9] Delete/' [ref=e10]\n${real}`, `${M}Pasta | Mealie`],
    [`- 'button "Delete" [ref=e9]\n- button "Edit" [ref=e9]`, "Recipes"],
    [`  garbage Delete [ref=e9]\n- button "Edit" [ref=e9]`, "Recipes"],
    [`- alertdialog "Sure?" [ref=e2]:\n  - 'button "Confirm" [ref=e9]`, "Recipes"],
  ];
  for (const [snap, title] of cases) assert.match(guard(snap, title).g.check({ cmd: "click", args: ["e9"] }) ?? "", refusedAny, snap);
});

test("a deterministic fuzz of hostile snapshots never throws and always answers a string or null", () => {
  const tokens = ["- ", "'", '"', "[ref=e1]", "[level=1]", ": ", "/url:", "/", "\\", "\n", "\r\n", "é 😀", "Delete", "Confirm", M, "  ", "button ", "dialog ", "heading "];
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 20; round++) {
    const parts: string[] = [];
    let lines = 0;
    while (lines < 100) {
      const t = tokens[rnd(tokens.length)];
      if (t === "\n" || t === "\r\n") lines++;
      parts.push(t);
    }
    const snap = parts.join("");
    assert.doesNotThrow(() => parseSnapshot(snap), snap); // the parser itself, not only the guard's catch
    const { g } = guard(snap, round % 2 ? `${M}x` : "Recipes");
    for (const a of [
      { cmd: "click", args: ["e1"] },
      { cmd: "dblclick", args: ["e2"] },
      { cmd: "click", args: ["f1e1"] },
      { cmd: "fill", args: ["e1", "x"] },
      { cmd: "type", args: ["x"] },
      { cmd: "click", args: ["[ref=e1]"] },
    ]) {
      const out = g.check(a);
      assert.ok(out === null || typeof out === "string", snap);
    }
  }
});

test("a large snapshot with many siblings is checked quickly", () => {
  const n = 100_000;
  const rows = [`- main [ref=e1]:`, `  - heading "${M}Pasta" [level=1] [ref=e2]`, '  - button "Delete" [ref=e3]'];
  for (let i = 4; i < n; i++) rows.push(`  - button "Edit ${i}" [ref=e${i}]`);
  const snap = rows.join("\n");
  const start = Date.now();
  const { g } = guard(snap, "Mealie");
  for (let i = 0; i < 20; i++) assert.equal(g.check({ cmd: "click", args: [i % 2 ? "e3" : `e${n - 1 - i}`] }), null);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
});
