#!/usr/bin/env node
// PreToolUse hook for the duckwright-worker agent: the only Bash command it may run is
// `node <path>/pw-step.mjs ...` with plain arguments. Anything else is blocked (exit 2), so the worker
// has no shell and drives the browser only through the guarded runner.
//
// Claude Code passes the tool call as JSON on stdin: { tool_input: { command } }.
import fs from "node:fs";

const SHAPE = /^node\s+(?:"[^"\n]*|'[^'\n]*|[^\s"'`$;&|<>()\n]*)pw-step\.mjs\s+(init|act|finish)(?:\s|$)/;

function block(why) {
  process.stderr.write(`Blocked: ${why}. This agent may only run \`node .../pw-step.mjs init|act|finish ...\`.\n`);
  process.exit(2);
}

let cmd = "";
try {
  cmd = JSON.parse(fs.readFileSync(0, "utf8"))?.tool_input?.command ?? "";
} catch {
  block("could not read the tool call");
}
cmd = String(cmd).trim();
if (!SHAPE.test(cmd)) block("not a pw-step.mjs command");

// Walk the command once: quotes protect most characters, but never a newline, `$` or a backtick,
// and outside quotes no shell operator at all.
let quote = null;
for (let i = 0; i < cmd.length; i++) {
  const c = cmd[i];
  if (c === "\n" || c === "\r" || c === "`" || c === "$") block("shell expansion or newline in the command");
  if (quote) {
    if (c === quote) quote = null;
    else if (c === "\\" && quote === '"') i++;
    continue;
  }
  if (c === '"' || c === "'") quote = c;
  else if (";&|<>(){}\\".includes(c)) block(`shell operator '${c}' outside quotes`);
}
if (quote) block("unclosed quote");
process.exit(0);
