import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSystemPrompt } from "../../src/chat/prompt.ts";

test("prompt substitutes the skills folder", () => {
  const p = chatSystemPrompt("/pkg/skills");
  assert.ok(p.includes("/pkg/skills/duckwright-tasks/SKILL.md"));
  assert.ok(!p.includes("{{SKILLS}}"));
  assert.ok(p.startsWith("You are running inside Duckwright's web chat. The person reads your messages in a browser."));
});

test("prompt has no front matter", () => {
  const p = chatSystemPrompt("/pkg/skills");
  assert.ok(!p.startsWith("---"));
  assert.ok(!p.includes("name: duckwright-autotest"));
});

test("prompt names every MCP tool", () => {
  const p = chatSystemPrompt("/pkg/skills");
  for (const t of ["set_phase", "ask", "check_messages", "budget", "environments", "open_plan", "run_plan", "run_task", "wait"]) {
    assert.ok(p.includes(`\`${t}\``), t);
  }
});

test("prompt names exactly the Phase values", () => {
  const p = chatSystemPrompt("/pkg/skills");
  for (const ph of ["read", "clarify", "plan", "probe", "write", "run", "report", "playwright"]) {
    assert.ok(p.includes(`\`${ph}\``), ph);
  }
  assert.ok(!p.includes("triage`"));
  assert.ok(!/`triage`/.test(p));
});

test("prompt promises only what the allow-list allows", async () => {
  const { SKILL_SCRIPTS } = await import("../../src/chat/claude.ts");
  const p = chatSystemPrompt("/pkg/skills");
  for (const s of SKILL_SCRIPTS) assert.ok(p.includes(s.split("/").at(-1)!), s);
  for (const c of ["`npm run typecheck`", "`npm run lint`", "`npx playwright test`", "`.gitignore`", "`e2e/`"]) assert.ok(p.includes(c), c);
  assert.ok(!/project's typecheck and lint commands/.test(p));
});
