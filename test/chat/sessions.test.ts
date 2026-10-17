import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ClaudeSpawner } from "../../src/chat/claude.ts";
import type { JsonRpc } from "../../src/chat/mcp.ts";
import { ChatSessions } from "../../src/chat/sessions.ts";
import { Scrubber, secretMarker } from "../../src/scrub.ts";
import { ChatStore } from "../../src/chat/store.ts";
import type { ChatEvent } from "../../src/chat/types.ts";
import { FakeManager, snapshot } from "../tui/fake-manager.ts";

interface FakeProc {
  argv: string[];
  stdin: string | undefined;
  push(o: object): void;
  close(code: number, stderr?: string): void;
  killed: boolean;
}

function fakeSpawner() {
  const procs: FakeProc[] = [];
  const spawn: ClaudeSpawner = (argv, _cwd, onLine, stdin) => {
    let resolve!: (r: { code: number; stderr: string }) => void;
    const done = new Promise<{ code: number; stderr: string }>((r) => { resolve = r; });
    const p: FakeProc = {
      argv, stdin, killed: false,
      push: (o) => onLine(JSON.stringify(o)),
      close: (code, stderr = "") => resolve({ code, stderr }),
    };
    procs.push(p);
    return { done, kill: () => { p.killed = true; resolve({ code: -15, stderr: "" }); } };
  };
  return { procs, spawn };
}

function setup(tasks = [snapshot(1, "one", { name: "one", state: "running" })], scrubber?: () => Scrubber) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-sessions-"));
  const manager = new FakeManager(tasks);
  const { procs, spawn } = fakeSpawner();
  let n = 0;
  const sessions = new ChatSessions({
    root, manager, store: new ChatStore(root), spawn, skillsDir: "/skills", systemPrompt: "sys",
    mcpUrl: (id) => `http://127.0.0.1:1/mcp/${id}`, newToken: () => `tok${++n}`, scrubber,
  });
  const events: ChatEvent[] = [];
  sessions.subscribe((e) => events.push(e));
  return { root, manager, procs, sessions, events };
}

/** The bearer in the turn's --mcp-config file (rewritten at each turn start). */
const tokenOf = (argv: string[]) =>
  JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.duckwright.headers.Authorization.slice("Bearer ".length);
const call = (name: string, args: object = {}): JsonRpc => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const result = (cost = 0.01, extra: object = {}) => ({ type: "result", session_id: "s1", total_cost_usd: cost, is_error: false, result: "done", ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test("first send starts a turn with no resume, second with resume", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  assert.deepEqual(sessions.send(chat.id, "hello", []), { ok: true });
  assert.equal(procs.length, 1);
  assert.ok(!procs[0].argv.includes("--resume"));
  assert.equal(procs[0].stdin, "hello");
  procs[0].push({ type: "system", subtype: "init", session_id: "s1" });
  procs[0].push({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } });
  procs[0].push(result());
  procs[0].close(0);
  await tick();
  const open = sessions.open(chat.id)!;
  assert.equal(open.turn, "idle");
  assert.equal(open.chat.sessionId, "s1");
  assert.equal(open.chat.title, "hello");
  assert.deepEqual(open.messages.map((m) => m.kind), ["person", "agent"]);
  assert.deepEqual(sessions.send(chat.id, "again", ["a.png", "b.txt"]), { ok: true });
  const argv = procs[1].argv;
  assert.deepEqual(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2), ["--resume", "s1"]);
  assert.equal(procs[1].stdin, "again\n\nAttached files: a.png, b.txt");
});

test("message during a turn is queued and delivered via MCP", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  assert.deepEqual(sessions.send(chat.id, "B", []), { ok: true });
  assert.equal(procs.length, 1);
  const r = await sessions.mcp(chat.id, tokenOf(procs[0].argv), call("budget"));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse((r.body as any).result.content[0].text).pending_messages, ["B"]);
  procs[0].push(result());
  procs[0].close(0);
  await tick();
  assert.equal(procs.length, 1);
  assert.equal(sessions.open(chat.id)!.turn, "idle");
});

test("undelivered queued message starts the next turn", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  sessions.send(chat.id, "B", []);
  sessions.send(chat.id, "C", []);
  procs[0].push(result());
  // The next turn waits for the process to exit.
  assert.equal(procs.length, 1);
  assert.equal(sessions.open(chat.id)!.turn, "running");
  procs[0].close(0);
  await tick();
  assert.equal(procs.length, 2);
  assert.equal(procs[1].stdin, "B\n\nC");
  assert.equal(sessions.open(chat.id)!.turn, "running");
});

test("cost accumulates and gates runs", async () => {
  const { sessions, procs, manager } = setup();
  const chat = sessions.create({ ceilingUsd: 0.1 });
  sessions.send(chat.id, "A", []);
  const token = tokenOf(procs[0].argv);
  procs[0].push(result(0.2));
  assert.equal(sessions.open(chat.id)!.chat.spentUsd, 0.2);
  const r = await sessions.mcp(chat.id, token, call("run_task", { file: "t.md" }));
  assert.equal((r.body as any).result.isError, true);
  assert.equal(manager.log.some((l) => l.startsWith("start")), false);
});

test("stop kills and stops owned runs", async () => {
  const { sessions, procs, manager } = setup();
  manager.addResult = { ok: true, added: [1], duplicates: [] };
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  const r = await sessions.mcp(chat.id, tokenOf(procs[0].argv), call("run_task", { file: "t.md" }));
  assert.equal((r.body as any).result.isError, undefined);
  sessions.send(chat.id, "B", []);
  await sessions.stop(chat.id);
  assert.equal(procs[0].killed, true);
  assert.ok(manager.log.includes("stop:1"));
  const open = sessions.open(chat.id)!;
  assert.equal(open.turn, "idle");
  assert.deepEqual(open.messages.at(-1), { ...open.messages.at(-1), kind: "activity", text: "Stopped" });
  // A late line from the killed process is ignored.
  procs[0].push(result(9));
  assert.equal(sessions.open(chat.id)!.chat.spentUsd, 0);
  assert.equal(procs.length, 1);
  sessions.send(chat.id, "C", []);
  assert.equal(procs.length, 2);
  assert.equal(procs[1].stdin, "C");
});

test("crash ends the turn with an error", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  procs[0].close(1, "boom\nmore");
  await tick();
  const open = sessions.open(chat.id)!;
  assert.equal(open.turn, "idle");
  assert.deepEqual(open.messages.at(-1), { kind: "error", at: open.messages.at(-1)!.at, text: "claude exited 1: boom" });
});

test("mcp rejects a wrong token", async () => {
  const { sessions, procs, manager } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  const r = await sessions.mcp(chat.id, "nope", call("run_task", { file: "t.md" }));
  assert.deepEqual(r, { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(await sessions.mcp(chat.id, null, call("budget")), { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(manager.log, []);
  assert.equal((await sessions.mcp(chat.id, tokenOf(procs[0].argv), call("budget"))).status, 200);
  assert.equal((await sessions.mcp("../x", "tok1", call("budget"))).status, 401);
});

test("2FA wait shows in the chat", async () => {
  const { sessions, procs, manager, events } = setup();
  manager.addResult = { ok: true, added: [1], duplicates: [] };
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  await sessions.mcp(chat.id, tokenOf(procs[0].argv), call("run_task", { file: "t.md" }));
  manager.update(1, { twofa: { kind: "totp" } });
  const last = sessions.open(chat.id)!.messages.at(-1)!;
  assert.equal(last.kind, "activity");
  assert.equal((last as { text: string }).text, "one is waiting for a 2FA code");
  const ev = events.at(-1)!;
  assert.equal(ev.type, "chat:message");
  await sessions.stopAll();
});

test("mcp side effects reach meta and messages; tool lines become activity", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  const tok = tokenOf(procs[0].argv);
  await sessions.mcp(chat.id, tok, call("set_phase", { phase: "probe" }));
  await sessions.mcp(chat.id, tok, call("ask", { questions: ["q1?"] }));
  procs[0].push({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Read", input: { file_path: "tasks/a.md" } },
    { type: "tool_use", name: "mcp__duckwright__budget", input: {} },
  ] } });
  procs[0].push(result(0, { is_error: true, result: "bad thing" }));
  const open = sessions.open(chat.id)!;
  assert.equal(open.chat.phase, "probe");
  assert.deepEqual(open.messages.slice(1).map((m) => ({ ...m, at: 0 })), [
    { kind: "questions", at: 0, questions: ["q1?"] },
    { kind: "activity", at: 0, text: "Read: tasks/a.md" },
    { kind: "error", at: 0, text: "bad thing" },
  ]);
});

test("send while stopping, update validation, invalid ids", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  const p = sessions.stop(chat.id);
  assert.equal(sessions.open(chat.id)!.turn, "stopping");
  assert.deepEqual(sessions.send(chat.id, "B", []), { ok: false, error: "the chat is stopping" });
  await p;
  assert.equal(procs.length, 1);
  assert.equal(sessions.update(chat.id, { ceilingUsd: -1 }).ok, false);
  assert.equal(sessions.update(chat.id, { ceilingUsd: Infinity }).ok, false);
  assert.equal(sessions.update(chat.id, { model: "" }).ok, false);
  assert.deepEqual(sessions.update(chat.id, { model: "opus", ceilingUsd: 2, title: "Shop" }), { ok: true });
  const meta = sessions.open(chat.id)!.chat;
  assert.equal(meta.model, "opus");
  assert.equal(meta.ceilingUsd, 2);
  assert.equal(meta.title, "Shop");
  assert.equal(sessions.open("../etc"), null);
  assert.equal(sessions.send("BAD ID", "x", []).ok, false);
  assert.equal(sessions.update("nope", { model: "x" }).ok, false);
  assert.equal(sessions.list()[0].chat.id, chat.id);
});

test("the turn ends when the process exits; a second result adds no cost", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  procs[0].push(result(0.2));
  procs[0].push(result(0.3));
  procs[0].push({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } });
  let open = sessions.open(chat.id)!;
  assert.equal(open.chat.spentUsd, 0.2);
  assert.equal(open.turn, "running");
  assert.deepEqual(open.messages.map((m) => m.kind), ["person"]);
  assert.deepEqual(sessions.send(chat.id, "B", []), { ok: true });
  assert.equal(procs.length, 1);
  procs[0].close(0);
  await tick();
  open = sessions.open(chat.id)!;
  assert.equal(open.chat.spentUsd, 0.2);
  assert.equal(procs.length, 2);
  assert.equal(procs[1].stdin, "B");
});

test("the token is rejected after stop and after the turn ends", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  const t1 = tokenOf(procs[0].argv);
  await sessions.stop(chat.id);
  assert.equal((await sessions.mcp(chat.id, t1, call("budget"))).status, 401);
  sessions.send(chat.id, "B", []);
  const t2 = tokenOf(procs[1].argv);
  assert.notEqual(t1, t2);
  procs[1].push(result());
  procs[1].close(0);
  await tick();
  assert.equal((await sessions.mcp(chat.id, t2, call("budget"))).status, 401);
});

test("a stale wait from a stopped turn does not drain the next turn's queue", async () => {
  const { sessions, procs, manager } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  const stale = sessions.mcp(chat.id, tokenOf(procs[0].argv), call("wait", { task_ids: [1] }));
  await tick();
  await sessions.stop(chat.id);
  sessions.send(chat.id, "B", []);
  sessions.send(chat.id, "C", []);
  manager.update(1, { state: "passed" });
  const r = await stale;
  assert.deepEqual(JSON.parse((r.body as any).result.content[0].text).pending_messages, []);
  const fresh = await sessions.mcp(chat.id, tokenOf(procs[1].argv), call("budget"));
  assert.deepEqual(JSON.parse((fresh.body as any).result.content[0].text).pending_messages, ["C"]);
  await sessions.stopAll();
});

test("upload saves into the chat folder and refuses unknown chats", () => {
  const { sessions, root } = setup();
  const chat = sessions.create();
  const r = sessions.upload(chat.id, "../note.txt", Buffer.from("hi"));
  assert.ok(r.ok);
  assert.equal(fs.readFileSync(path.join(root, (r as { path: string }).path), "utf8"), "hi");
  assert.deepEqual(sessions.upload("nope", "a.txt", Buffer.from("x")), { ok: false, error: "no such chat" });
  assert.deepEqual(sessions.upload("../x", "a.txt", Buffer.from("x")), { ok: false, error: "no such chat" });
});

test("the prompt and the token go on stdin and in a file, never in argv", async () => {
  const { sessions, procs, root } = setup();
  const chat = sessions.create();
  assert.deepEqual(sessions.send(chat.id, "--help\nsecond line", []), { ok: true });
  const argv = procs[0].argv;
  assert.equal(procs[0].stdin, "--help\nsecond line");
  const token = tokenOf(argv);
  assert.ok(!argv.some((a) => a.includes("--help") || a.includes("second line") || a.includes(token)));
  const mcpFile = argv[argv.indexOf("--mcp-config") + 1];
  assert.equal(mcpFile, path.join(root, ".duckwright", "chats", chat.id, "mcp.json"));
  if (process.platform !== "win32") assert.equal(fs.statSync(mcpFile).mode & 0o777, 0o600);
  const sysFile = argv[argv.indexOf("--append-system-prompt-file") + 1];
  assert.equal(sysFile, path.join(root, ".duckwright", "chats", "system-prompt.md"));
  assert.equal(fs.readFileSync(sysFile, "utf8"), "sys");
  assert.equal((await sessions.mcp(chat.id, token, call("budget"))).status, 200);
});

test("each turn gets what is left under the ceiling as --max-budget-usd", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create({ ceilingUsd: 2 });
  sessions.send(chat.id, "A", []);
  const budgetOf = (argv: string[]) => argv[argv.indexOf("--max-budget-usd") + 1];
  assert.equal(budgetOf(procs[0].argv), "2.00");
  procs[0].push(result(0.755));
  procs[0].close(0);
  await tick();
  sessions.send(chat.id, "B", []);
  assert.equal(budgetOf(procs[1].argv), "1.24");
});

test("at the ceiling, send keeps the message, says so and starts no turn", async () => {
  const { sessions, procs, events } = setup();
  const chat = sessions.create({ ceilingUsd: 0.5 });
  sessions.send(chat.id, "A", []);
  procs[0].push(result(0.5));
  procs[0].close(0);
  await tick();
  assert.deepEqual(sessions.send(chat.id, "B", []), { ok: true });
  assert.equal(procs.length, 1);
  const open = sessions.open(chat.id)!;
  assert.equal(open.turn, "idle");
  assert.deepEqual(open.messages.slice(-2).map((m) => ({ ...m, at: 0 })), [
    { kind: "person", at: 0, text: "B", attachments: [] },
    { kind: "error", at: 0, text: "Spend ceiling of $0.50 reached — raise it to continue" },
  ]);
  assert.equal(events.at(-1)!.type, "chat:updated");
  // Raising it lets the next message through.
  sessions.update(chat.id, { ceilingUsd: 1 });
  sessions.send(chat.id, "C", []);
  assert.equal(procs.length, 2);
  assert.equal(procs[1].argv[procs[1].argv.indexOf("--max-budget-usd") + 1], "0.50");
});

test("a queued message is not started past the ceiling", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create({ ceilingUsd: 0.3 });
  sessions.send(chat.id, "A", []);
  sessions.send(chat.id, "B", []);
  procs[0].push(result(0.3));
  procs[0].close(0);
  await tick();
  assert.equal(procs.length, 1);
  const open = sessions.open(chat.id)!;
  assert.equal(open.turn, "idle");
  assert.equal(open.messages.at(-1)!.kind, "error");
});

test("permission denials become activity lines", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  procs[0].push(result(0, { permission_denials: [
    { tool_name: "Bash", tool_use_id: "x", tool_input: { command: "curl http://example.com" } },
    { tool_name: "Write", tool_use_id: "y", tool_input: { file_path: "src/app.ts" } },
  ] }));
  const texts = sessions.open(chat.id)!.messages.filter((m) => m.kind === "activity").map((m) => (m as { text: string }).text);
  assert.deepEqual(texts, ["Not allowed: Bash curl http://example.com", "Not allowed: Write src/app.ts"]);
});

test("account passwords and TOTP secrets are masked on disk, in events and in the title", async () => {
  const scrubber = () => {
    const s = new Scrubber();
    s.addNamedSecret("hunter2pass", secretMarker("admin"));
    s.addSecret("JBSWY3DPEHPK3PXP");
    return s;
  };
  const { sessions, procs, events, root } = setup(undefined, scrubber);
  const chat = sessions.create();
  sessions.send(chat.id, "log in with hunter2pass", []);
  procs[0].push({ type: "assistant", message: { content: [{ type: "text", text: "secret JBSWY3DPEHPK3PXP noted" }] } });
  const disk = fs.readFileSync(path.join(root, ".duckwright", "chats", chat.id, "transcript.jsonl"), "utf8");
  assert.ok(!disk.includes("hunter2pass") && !disk.includes("JBSWY3DPEHPK3PXP"));
  assert.ok(disk.includes(secretMarker("admin")) && disk.includes("[REDACTED]"));
  const shown = JSON.stringify(events);
  assert.ok(!shown.includes("hunter2pass") && !shown.includes("JBSWY3DPEHPK3PXP"));
  assert.equal(sessions.open(chat.id)!.chat.title, `log in with ${secretMarker("admin")}`);
  assert.ok(!fs.readFileSync(path.join(root, ".duckwright", "chats", chat.id, "chat.json"), "utf8").includes("hunter2pass"));
  // The agent still gets what the person typed.
  assert.equal(procs[0].stdin, "log in with hunter2pass");
});

test("a session that cannot be resumed is cleared so the next turn starts fresh", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  procs[0].push({ type: "system", subtype: "init", session_id: "gone" });
  procs[0].push(result());
  procs[0].close(0);
  await tick();
  sessions.send(chat.id, "B", []);
  assert.equal(procs[1].argv[procs[1].argv.indexOf("--resume") + 1], "gone");
  procs[1].close(1, "No conversation found with session ID: gone");
  await tick();
  const open = sessions.open(chat.id)!;
  assert.equal(open.chat.sessionId, null);
  assert.equal(open.turn, "idle");
  assert.match((open.messages.at(-1) as { text: string }).text, /could not be resumed. Send your message again/);
  sessions.send(chat.id, "B", []);
  assert.ok(!procs[2].argv.includes("--resume"));
});

test("a stale session reported in the result text is cleared too", async () => {
  const { sessions, procs } = setup();
  const chat = sessions.create();
  sessions.send(chat.id, "A", []);
  procs[0].push({ type: "system", subtype: "init", session_id: "gone" });
  procs[0].push(result());
  procs[0].close(0);
  await tick();
  sessions.send(chat.id, "B", []);
  procs[1].push(result(0, { is_error: true, result: "No conversation found with session ID: gone" }));
  procs[1].close(1);
  await tick();
  assert.equal(sessions.open(chat.id)!.chat.sessionId, null);
});
