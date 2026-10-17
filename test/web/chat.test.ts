// The chat view's reducer and its wiring into the browser store.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMeta, ChatMessage } from "../../src/chat/types.ts";
import { groupMessages, initialChat, planForFolder, reduceChat } from "../../web/src/chat.ts";
import type { ChatUiState } from "../../web/src/chat.ts";
import { initialState, reduce } from "../../web/src/store.ts";
import type { Action } from "../../web/src/store.ts";
import { planSnapshot, snapshot } from "../tui/fake-manager.ts";

const meta = (id: string, updatedAt: number, over: Partial<ChatMeta> = {}): ChatMeta => ({
  id, title: id, model: "sonnet", ceilingUsd: 5, sessionId: null, spentUsd: 0, phase: null, planFolder: null,
  createdAt: 1, updatedAt, ...over,
});
const agent = (text: string): ChatMessage => ({ kind: "agent", at: 1, text });
const open = (s: ChatUiState, id: string): ChatUiState => reduceChat(reduceChat(s, { type: "chat:opening", id }), { type: "chat:opened", chat: meta(id, 1), turn: "idle", messages: [] });

test("chat:message for the open chat appends; for another chat it does not", () => {
  let s = open(initialChat(), "a");
  s = reduceChat(s, { type: "chat:message", chatId: "a", message: agent("hi") });
  s = reduceChat(s, { type: "chat:message", chatId: "b", message: agent("elsewhere") });
  assert.deepEqual(s.messages, [agent("hi")]);
});

test("chat:updated replaces the list entry and keeps order by updatedAt", () => {
  let s = reduceChat(initialChat(), { type: "chat:list", items: [{ chat: meta("a", 10), turn: "idle" }, { chat: meta("b", 20), turn: "idle" }] });
  assert.deepEqual(s.chats.map((c) => c.chat.id), ["b", "a"]);
  s = reduceChat(s, { type: "chat:updated", chat: meta("a", 30, { spentUsd: 0.84 }), turn: "running" });
  assert.deepEqual(s.chats.map((c) => c.chat.id), ["a", "b"]);
  assert.equal(s.chats[0]!.chat.spentUsd, 0.84);
  assert.equal(s.chats[0]!.turn, "running");
  assert.equal(s.chats.length, 2);
  s = reduceChat(s, { type: "chat:updated", chat: meta("c", 5), turn: "idle" });
  assert.deepEqual(s.chats.map((c) => c.chat.id), ["a", "b", "c"]);
});

test("chat:sent clears the draft and attachments", () => {
  let s = open(initialChat(), "a");
  s = reduceChat(s, { type: "chat:draft", text: "hello @x" });
  s = reduceChat(s, { type: "chat:attach", path: "uploads/a.png" });
  s = reduceChat(s, { type: "chat:attach", path: "uploads/a.png" });
  assert.deepEqual(s.attachments, ["uploads/a.png"]);
  s = reduceChat(s, { type: "chat:sent" });
  assert.equal(s.draft, "");
  assert.deepEqual(s.attachments, []);
  s = reduceChat(reduceChat(s, { type: "chat:attach", path: "p" }), { type: "chat:detach", path: "p" });
  assert.deepEqual(s.attachments, []);
});

test("opening another chat starts a fresh input; reopening the same one keeps it", () => {
  let s = reduceChat(open(initialChat(), "a"), { type: "chat:draft", text: "keep" });
  s = open(s, "a");
  assert.equal(s.draft, "keep");
  s = open(s, "b");
  assert.equal(s.draft, "");
});

test("the store routes chat stream messages and snapshots to the chat state, and switches views", () => {
  let s = initialState();
  assert.equal(s.view, "workspace");
  s = reduce(s, { type: "view", view: "chat" });
  assert.equal(s.view, "chat");
  s = reduce(s, { type: "stream", now: 0, message: { type: "chat:updated", chat: meta("a", 5), turn: "idle" } });
  assert.deepEqual(s.chat.chats.map((c) => c.chat.id), ["a"]);
});

test("planForFolder matches normalised folder strings", () => {
  const plans = [planSnapshot(1, [], { folder: "tasks/shop" }), planSnapshot(2, [], { folder: null })];
  assert.equal(planForFolder(plans, "./tasks/shop/")?.id, 1);
  assert.equal(planForFolder(plans, "tasks\\shop")?.id, 1);
  assert.equal(planForFolder(plans, "tasks/other"), null);
  assert.equal(planForFolder(plans, null), null);
});

test("groupMessages joins consecutive activity lines", () => {
  const act = (text: string): ChatMessage => ({ kind: "activity", at: 1, text });
  const g = groupMessages([agent("a"), act("x"), act("y"), agent("b"), act("z")]);
  assert.deepEqual(g.map((x) => (x.kind === "activity" ? x.lines : x.message.kind)), ["agent", ["x", "y"], "agent", ["z"]]);
});

test("messages streamed while a chat loads or reloads are kept, without duplicates", () => {
  let s = reduceChat(initialChat(), { type: "chat:opening", id: "a" });
  // An event arrives between the GET and chat:opened; the fetched history may or may not hold it.
  s = reduceChat(s, { type: "chat:message", chatId: "a", message: agent("two") });
  s = reduceChat(s, { type: "chat:opened", chat: meta("a", 1), turn: "idle", messages: [agent("one")] });
  assert.deepEqual(s.messages, [agent("one"), agent("two")]);
  // A reload after a reconnect: the history now holds "two" and a missed "three".
  s = reduceChat(s, { type: "chat:draft", text: "typing" });
  s = reduceChat(s, { type: "chat:opening", id: "a" });
  s = reduceChat(s, { type: "chat:opened", chat: meta("a", 2), turn: "idle", messages: [agent("one"), agent("two"), agent("three")] });
  assert.deepEqual(s.messages, [agent("one"), agent("two"), agent("three")]);
  assert.equal(s.draft, "typing");
  // A reply for a chat the person left meanwhile does not replace the open one.
  s = reduceChat(s, { type: "chat:opening", id: "b" });
  s = reduceChat(s, { type: "chat:opened", chat: meta("a", 3), turn: "idle", messages: [agent("late")] });
  assert.equal(s.openId, "b");
  assert.deepEqual(s.messages, []);
});

test("every state snapshot is counted so the open chat can be reloaded", () => {
  const snap: Action = { type: "stream", now: 0, message: { type: "state", tasks: [], plans: [], globals: { base: snapshot(0, "").effective, overrides: {}, environments: [] }, activeCount: 0, maxParallel: 3, notices: [], theme: "auto", runs: [], chats: [] } };
  const s = reduce(reduce(initialState(), snap), snap);
  assert.equal(s.snapshots, 2);
});
