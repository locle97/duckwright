import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { PROJECT_MAX_BYTES, ProjectError, loadProject, scaffoldProject } from "../src/project.ts";
import { buildPrompt } from "../src/prompt.ts";
import { tmpDir } from "./helpers.ts";

function put(cwd: string, rel: string, content: string | Uint8Array): void {
  const p = path.join(cwd, ".duckwright", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test("project_none_when_no_files", () => {
  assert.equal(loadProject(tmpDir()), null);
  const tmp = tmpDir();
  put(tmp, "PROJECT.md", "  \n");
  assert.equal(loadProject(tmp), null);
});

test("project_loads_project_md_then_rules_in_name_order", () => {
  const tmp = tmpDir();
  put(tmp, "rules/b.md", "B rule\n");
  put(tmp, "rules/a.md", "A rule\r\n");
  put(tmp, "rules/.hidden.md", "no");
  put(tmp, "rules/notes.txt", "no");
  put(tmp, "PROJECT.md", "# Shop\n");
  const p = loadProject(tmp)!;
  assert.deepEqual(p.files, ["PROJECT.md", path.join("rules", "a.md"), path.join("rules", "b.md")]);
  assert.equal(p.text, "# Shop\n\n## Rule: a\n\nA rule\n\n## Rule: b\n\nB rule");
});

test("project_rejects_big_and_non_utf8", () => {
  const tmp = tmpDir();
  put(tmp, "PROJECT.md", "a".repeat(PROJECT_MAX_BYTES + 1));
  assert.throws(() => loadProject(tmp), (e: Error) => e instanceof ProjectError && /too large/.test(e.message));
  put(tmp, "PROJECT.md", new Uint8Array([0xff, 0xfe, 0x41]));
  assert.throws(() => loadProject(tmp), (e: Error) => e instanceof ProjectError && /not valid UTF-8/.test(e.message));
});

test("project_scaffold_writes_once_and_never_overwrites", () => {
  const tmp = tmpDir();
  const first = scaffoldProject(tmp);
  assert.deepEqual(first.sort(), [
    path.join(".duckwright", "PROJECT.md"),
    path.join(".duckwright", "environments", "staging.md"),
    path.join(".duckwright", "rules", "destructive-actions.md"),
  ].sort());
  put(tmp, "PROJECT.md", "MINE\n");
  assert.deepEqual(scaffoldProject(tmp), []);
  assert.equal(fs.readFileSync(path.join(tmp, ".duckwright", "PROJECT.md"), "utf8"), "MINE\n");
  assert.ok(loadProject(tmp) !== null);
});

test("project_goes_into_the_prompt_before_the_environment", () => {
  const obs = { tabs: "t", snapshot: "s", lines: 1, chars: 1 } as Parameters<typeof buildPrompt>[5];
  const prompt = buildPrompt("do it", 1, 5, [], "", obs, { project: "SHOP RULES </project>", environment: "ENV" });
  assert.ok(prompt.indexOf("<project>") > prompt.indexOf("</task>"));
  assert.ok(prompt.indexOf("<project>") < prompt.indexOf("<environment>"));
  assert.ok(prompt.includes("SHOP RULES"));
  assert.equal(prompt.split("</project>").length, 2, "the project text cannot close its own section");
  assert.ok(!buildPrompt("do it", 1, 5, [], "", obs).includes("<project>"));
});
