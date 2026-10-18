// A ChatSessions over a fake claude spawner and a temp folder, for tests that need an ApiContext.
import type { ClaudeSpawner } from "../../src/chat/claude.ts";
import { ChatSessions } from "../../src/chat/sessions.ts";
import { ChatStore } from "../../src/chat/store.ts";
import type { ManagerLike } from "../../src/runs/manager.ts";
import { tmpDir } from "../helpers.ts";

/** `argvs` collects what each spawned (never-finishing) fake claude was started with. */
export function fakeChats(manager: ManagerLike, root: string = tmpDir()): { chats: ChatSessions; argvs: string[][] } {
  const argvs: string[][] = [];
  const spawn: ClaudeSpawner = (argv) => {
    argvs.push(argv);
    let resolve!: (r: { code: number; stderr: string }) => void;
    const done = new Promise<{ code: number; stderr: string }>((r) => { resolve = r; });
    return { done, kill: () => resolve({ code: -15, stderr: "" }) };
  };
  const chats = new ChatSessions({
    root, manager, store: new ChatStore(root), spawn, skillsDir: "/skills", systemPrompt: "sys",
    mcpUrl: (id) => `http://127.0.0.1:1/mcp/${id}`,
  });
  return { chats, argvs };
}
