import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, claudeArgv, mcpConfig, parseStreamLine, spawnClaude, type ClaudeTurn } from "../../src/chat/claude.ts";

const turn = (resume: string | null): ClaudeTurn => ({
  model: "sonnet", resume, skillsDir: "/p/skills",
  systemPromptFile: "/r/.duckwright/chats/system-prompt.md", mcpConfigFile: "/r/.duckwright/chats/c1/mcp.json", maxBudgetUsd: 4.5,
});

const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("argv for a first turn", () => {
  const argv = claudeArgv(turn(null));
  assert.deepEqual(argv.slice(0, 7),
    ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet"]);
  assert.ok(!argv.includes("--resume"));
  assert.equal(after(argv, "--mcp-config"), "/r/.duckwright/chats/c1/mcp.json");
  assert.equal(after(argv, "--append-system-prompt-file"), "/r/.duckwright/chats/system-prompt.md");
  assert.ok(!argv.includes("--append-system-prompt"));
  assert.equal(after(argv, "--max-budget-usd"), "4.50");
  assert.equal(after(argv, "--permission-mode"), "dontAsk");
  assert.equal(after(argv, "--setting-sources"), "");
  assert.ok(argv.includes("--strict-mcp-config"));
  // --allowedTools is variadic: a flag must follow its values.
  assert.equal(argv[argv.indexOf("--allowedTools") + ALLOWED_TOOLS("/p/skills").length + 1], "--disallowedTools");
  const deny = argv.indexOf("--disallowedTools");
  assert.deepEqual(argv.slice(deny + 1, deny + 5),
    ["Read(.duckwright/local/**)", "Read(.duckwright/chats/**)", "Edit(.duckwright/local/**)", "Edit(.duckwright/chats/**)"]);
  assert.equal(argv[deny + DISALLOWED_TOOLS.length + 1], "--add-dir");
});

test("argv resumes", () => {
  const argv = claudeArgv(turn("s1"));
  assert.deepEqual(argv.slice(7, 9), ["--resume", "s1"]);
});

test("mcp config holds the url and bearer", () => {
  assert.deepEqual(JSON.parse(mcpConfig("http://127.0.0.1:1/mcp", "tok")), {
    mcpServers: { duckwright: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer tok" } } },
  });
});

test("allowed tools: exact skill scripts, no bare Bash or Write, no npx tsc/eslint/prettier", () => {
  const t = ALLOWED_TOOLS("/p/skills");
  assert.ok(!t.includes("Bash"));
  assert.ok(!t.includes("Write"));
  assert.ok(!t.includes("Bash(node /p/skills/*:*)"));
  for (const s of ["duckwright-setup/scripts/doctor.mjs", "duckwright-tasks/scripts/facts.mjs", "duckwright-tasks/scripts/check-tasks.mjs",
    "duckwright-tasks/scripts/sitemap-brief.mjs", "duckwright-tasks/scripts/gate.mjs", "duckwright-playwright/scripts/runs-brief.mjs"]) {
    assert.ok(t.includes(`Bash(node /p/skills/${s}:*)`), s);
  }
  assert.equal(t.filter((r) => r.startsWith("Bash(node ")).length, 6);
  assert.ok(!t.includes("Edit(.duckwright/**)"));
  assert.ok(!t.some((r) => r.includes(".duckwright/local") || r.includes(".duckwright/chats")));
  for (const keep of ["Edit(.duckwright/facts/**)", "Edit(.duckwright/probes/**)", "Edit(.duckwright/testing-map.md)"]) assert.ok(t.includes(keep), keep);
  for (const gone of ["Bash(npx tsc:*)", "Bash(npx eslint:*)", "Bash(npx prettier:*)"]) assert.ok(!t.includes(gone), gone);
  for (const keep of ["Bash(npm run lint:*)", "Bash(npm run typecheck:*)", "Edit(.gitignore)", "Edit(**/*.test.ts)",
    "Edit(**/*.test.js)", "Edit(e2e/**)", "Edit(tests/**)", "Edit(playwright/**)"]) assert.ok(t.includes(keep), keep);
});

test("the real spawner writes the prompt to stdin and closes it", async () => {
  const lines: string[] = [];
  const p = spawnClaude([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], process.cwd(), (l) => lines.push(l), "--help\nsecond line\n");
  const r = await p.done;
  assert.equal(r.code, 0);
  assert.deepEqual(lines, ["--help", "second line"]);
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
    [{ kind: "result", sessionId: "s", costUsd: 0.12, isError: false, text: "done", denials: [] }]);
});

test("parses permission denials from the result", () => {
  const [r] = parseStreamLine(JSON.stringify({ type: "result", session_id: "s", total_cost_usd: 0, is_error: false, result: "",
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "a", tool_input: { command: "rm -rf /" } },
      { tool_name: "Write", tool_use_id: "b", tool_input: { file_path: "src/app.ts", content: "x" } },
      { tool_name: "WebFetch", tool_use_id: "c", tool_input: { url: "http://x" } },
      "junk",
    ] }));
  assert.deepEqual((r as { denials: unknown }).denials, [
    { name: "Bash", summary: "rm -rf /" }, { name: "Write", summary: "src/app.ts" }, { name: "WebFetch", summary: "" },
  ]);
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
