import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, claudeArgv, parseStreamLine, type ClaudeTurn } from "../../src/chat/claude.ts";

const turn = (resume: string | null): ClaudeTurn => ({
  prompt: "hello", model: "sonnet", resume, cwd: "/r", skillsDir: "/p/skills",
  systemPrompt: "sys", mcpUrl: "http://127.0.0.1:1/mcp", mcpToken: "tok",
});

test("argv for a first turn", () => {
  const argv = claudeArgv(turn(null));
  assert.deepEqual(argv.slice(0, 8),
    ["claude", "-p", "hello", "--output-format", "stream-json", "--verbose", "--model", "sonnet"]);
  assert.ok(!argv.includes("--resume"));
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--mcp-config") + 1]), {
    mcpServers: { duckwright: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer tok" } } },
  });
  assert.ok(argv.includes("--strict-mcp-config"));
  // --allowedTools is variadic: a flag must follow its values.
  const after = argv[argv.indexOf("--allowedTools") + ALLOWED_TOOLS("/p/skills").length + 1];
  assert.equal(after, "--add-dir");
});

test("argv resumes", () => {
  const argv = claudeArgv(turn("s1"));
  assert.deepEqual(argv.slice(8, 10), ["--resume", "s1"]);
});

test("allowed tools have no bare Bash or Write", () => {
  const t = ALLOWED_TOOLS("/p/skills");
  assert.ok(t.includes("Bash(node /p/skills/*:*)"));
  assert.ok(!t.includes("Bash"));
  assert.ok(!t.includes("Write"));
});

test("parses init, text, tool and result", () => {
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s" })),
    [{ kind: "init", sessionId: "s" }]);
  const msg = (c: unknown[]) => JSON.stringify({ type: "assistant", message: { content: c } });
  assert.deepEqual(parseStreamLine(msg([{ type: "text", text: "hi" }])), [{ kind: "text", text: "hi" }]);
  assert.deepEqual(
    parseStreamLine(msg([{ type: "tool_use", name: "Bash", input: { command: "duckwright check tasks/x" } }])),
    [{ kind: "tool", name: "Bash", summary: "duckwright check tasks/x" }]);
  assert.deepEqual(
    parseStreamLine(msg([{ type: "tool_use", name: "mcp__duckwright__run_plan", input: { a: 1 } }])),
    [{ kind: "tool", name: "mcp__duckwright__run_plan", summary: "run_plan" }]);
  assert.deepEqual(
    parseStreamLine(JSON.stringify({ type: "result", session_id: "s", total_cost_usd: 0.12, is_error: false, result: "done" })),
    [{ kind: "result", sessionId: "s", costUsd: 0.12, isError: false, text: "done" }]);
});

test("truncates long summaries", () => {
  const items = parseStreamLine(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Read", input: { file_path: "x".repeat(300) } }] } }));
  assert.equal((items[0] as { summary: string }).summary.length, 120);
});

test("ignores garbage", () => {
  assert.deepEqual(parseStreamLine("not json"), []);
  assert.deepEqual(parseStreamLine(""), []);
});
