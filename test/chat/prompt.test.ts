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
  for (const t of ["set_phase", "ask", "check_messages", "budget", "open_plan", "run_plan", "run_task", "wait"]) {
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
