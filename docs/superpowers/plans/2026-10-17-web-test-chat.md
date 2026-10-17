# Test Chat in the Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat view in `duckwright --web` where a person attaches a spec and plan, answers one round of questions, and a Claude Code session then plans, probes, writes, runs and reports Duckwright tests on its own, optionally ending with Playwright tests.

**Architecture:** The web server drives one `claude -p --output-format stream-json` process per chat turn (`--resume` keeps the conversation), with a new orchestrator skill (`skills/duckwright-autotest/`) as appended system prompt and the package's `skills/` added as a readable folder. The session reaches Duckwright's `RunManager` through a small MCP endpoint (JSON-RPC over HTTP, `node:http`, per-chat bearer token) served by the same web server, so its runs are ordinary, visible runs. Chats persist under `<root>/.duckwright/chats/<id>/`.

**Tech Stack:** TypeScript (Node ≥ 22.18, `node:test`), React + Vite web UI (existing), Claude Code CLI.

**Spec:** `docs/superpowers/specs/2026-10-17-web-test-chat-design.md`

## Global Constraints

- Web mode stays `127.0.0.1` only, per-launch token, Host/Origin checks, 1 MiB JSON body cap; uploads get their own cap of 10 MiB per file.
- No new runtime dependency; the MCP endpoint uses `node:http` through the existing server.
- Never run the chat agent with a general shell: Bash only through the allow-list in Task 2.
- Chat model default `sonnet`; spend ceiling default `5` (USD) per chat, editable.
- Chat agent model and the browser run model (`Globals.model`) are separate settings.
- No change to `loop.ts`, `brain.ts`, `pw.ts`, or to `RunManager` behaviour.
- Transcripts never hold secrets: every text written to `transcript.jsonl` goes through `redactText` (`src/redact.ts`).
- Comment style, naming and file layout follow `src/web/` (top-of-file comment saying what the file is; small focused files).

## Review Focus

1. A person message sent while a turn is running must reach the agent (via MCP) or start the next turn; it must never be dropped. → test in Task 4 and Task 5.
2. A `run_*` MCP call once the chat's spend (turn costs + run costs) has reached the ceiling must refuse without starting anything. → test in Task 4.
3. Stop during a turn must kill the `claude` process and stop every task and plan run that chat started, and leave the chat usable for the next message. → test in Task 5.
4. A request to `/mcp/<id>` with a wrong, missing or other chat's token must get 401 and never reach the manager; a browser token must not work there either. → test in Task 6.
5. A `claude` process that exits non-zero, prints non-JSON lines, or never sends a `result` event must end the turn with an error message in the chat, not hang it. → test in Task 5.

---

## File structure

```
src/chat/
  types.ts        ChatMeta, ChatMessage, ChatEvent, Phase: shared by server, MCP, UI (import type)
  store.ts        disk: create/list/load chats, append transcript, save meta, save uploads
  claude.ts       claude argv builder, stream-json line parser, streaming spawner
  prompt.ts       builds the appended system prompt from skills/duckwright-autotest/SKILL.md
  mcp.ts          JSON-RPC MCP handler and its tools over ManagerLike
  tracker.ts      follows manager events for the tasks/plans a chat started: verdicts, costs, history paths
  sessions.ts     ChatSessions: turns, queue, stop, spend, events
src/web/          api.ts, server.ts, index.ts gain chat routes, /mcp, uploads, chat events on SSE
skills/duckwright-autotest/SKILL.md     the orchestrator skill
web/src/          chat.ts (reducer), ChatPane.tsx, Header/App wiring
test/chat/        store, claude, prompt, mcp, tracker, sessions tests
test/web/         api/server/store tests extended
```

---

### Task 1: Chat types and disk store

**Files:**
- Create: `src/chat/types.ts`, `src/chat/store.ts`
- Test: `test/chat/store.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type ChatId = string;                       // "20261017-101500-brave-otter" style, via rundir's stamp + randomLabel
  export type Phase = "read" | "clarify" | "plan" | "probe" | "write" | "run" | "report" | "playwright";
  export type TurnState = "idle" | "running" | "stopping";
  export interface ChatMeta {
    id: ChatId; title: string; model: string; ceilingUsd: number;
    sessionId: string | null;        // Claude Code session id, set after the first turn
    spentUsd: number;                // agent turns + runs it started
    phase: Phase | null; planFolder: string | null;
    createdAt: number; updatedAt: number;
  }
  export type ChatMessage =
    | { kind: "person"; at: number; text: string; attachments: string[] }
    | { kind: "agent"; at: number; text: string }
    | { kind: "activity"; at: number; text: string }          // one-line tool activity
    | { kind: "questions"; at: number; questions: string[] }
    | { kind: "error"; at: number; text: string };
  export type ChatEvent =
    | { type: "chat:updated"; chat: ChatMeta; turn: TurnState }
    | { type: "chat:message"; chatId: ChatId; message: ChatMessage };
  ```
- Produces (`store.ts`):
  ```ts
  export class ChatStore {
    constructor(root: string, now?: () => number);           // folder: <root>/.duckwright/chats
    create(o: { model: string; ceilingUsd: number }): ChatMeta;
    list(): ChatMeta[];                                      // newest updatedAt first; skips unreadable folders
    load(id: ChatId): { meta: ChatMeta; messages: ChatMessage[] } | null;
    saveMeta(meta: ChatMeta): void;                          // atomic: write tmp then rename
    append(id: ChatId, m: ChatMessage): ChatMessage;          // redacts text fields, returns what was written
    saveUpload(id: ChatId, name: string, data: Buffer): string; // returns path relative to root; name sanitised to basename, never overwrites (-2, -3)
    folder(id: ChatId): string;
  }
  export const isChatId: (s: string) => boolean;             // /^[a-z0-9-]{1,80}$/
  ```

- [ ] **Step 1: Write the failing tests** in `test/chat/store.test.ts` using `tmpDir()` from `test/helpers.ts`:
  - `create then load round-trips meta` — `load(c.id).meta` deep-equals `c`; `c.sessionId === null`, `c.spentUsd === 0`, `c.title === "New chat"`.
  - `append redacts secrets` — appending `{kind:"agent", text:"token=abc123secret"}` writes text equal to `redactText("token=abc123secret")` and `load` returns it.
  - `list is newest first` — two chats, second `saveMeta` with larger `updatedAt` comes first.
  - `saveUpload never overwrites and strips folders` — `saveUpload(id, "../../x.md", buf)` twice returns `.duckwright/chats/<id>/uploads/x.md` then `.../x-2.md`.
  - `load of unknown or invalid id is null` — `load("../etc")` and `load("nope")` return `null`.
- [ ] **Step 2: Run** `node --test test/chat/store.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `types.ts` and `ChatStore`** — `transcript.jsonl` one JSON message per line; `chat.json` for meta. Id from `rundir.ts` helpers (timestamp + `randomLabel()`).
- [ ] **Step 4: Run** `node --test test/chat/store.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/chat test/chat && git commit -m "Add chat store"`

---

### Task 2: Claude process: argv, stream parser, spawner

**Files:**
- Create: `src/chat/claude.ts`
- Test: `test/chat/claude.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClaudeTurn {
    prompt: string; model: string; resume: string | null;
    cwd: string;                 // the Duckwright root
    skillsDir: string;           // <package>/skills
    systemPrompt: string;        // from Task 3
    mcpUrl: string; mcpToken: string;
  }
  export function claudeArgv(t: ClaudeTurn): string[];
  export type StreamItem =
    | { kind: "init"; sessionId: string }
    | { kind: "text"; text: string }
    | { kind: "tool"; name: string; summary: string }           // summary: one line from the tool input
    | { kind: "result"; sessionId: string; costUsd: number; isError: boolean; text: string };
  export function parseStreamLine(line: string): StreamItem[];   // [] for blank, non-JSON or uninteresting lines
  export interface ClaudeProcess { done: Promise<{ code: number; stderr: string }>; kill(): void }
  export type ClaudeSpawner = (argv: string[], cwd: string, onLine: (line: string) => void) => ClaudeProcess;
  export const spawnClaude: ClaudeSpawner;                       // node:child_process, no shell, stdin ignored
  export const ALLOWED_TOOLS: (skillsDir: string) => string[];
  ```
- `claudeArgv` returns, in order: `claude -p <prompt> --output-format stream-json --verbose --model <model>`, then `--resume <id>` when set, then `--tools Read,Grep,Glob,Write,Edit,Bash`, `--allowedTools ...ALLOWED_TOOLS(skillsDir)`, `--add-dir <skillsDir>`, `--append-system-prompt <systemPrompt>`, `--mcp-config <json>`, `--strict-mcp-config`. The `--mcp-config` JSON is `{"mcpServers":{"duckwright":{"type":"http","url":mcpUrl,"headers":{"Authorization":"Bearer "+mcpToken}}}}`. `--allowedTools` takes many values, so a later `--` flag must follow it (see `src/brain.ts:229`).
- `ALLOWED_TOOLS(skillsDir)` is exactly: `Read`, `Grep`, `Glob`, `Edit(tasks/**)`, `Edit(.duckwright/**)`, `Edit(environments/**)`, `Edit(CLAUDE.md)`, `Bash(node ${skillsDir}/*:*)`, `Bash(duckwright check:*)`, `Bash(duckwright explore:*)`, `Bash(npx playwright test:*)`, `Bash(npx tsc:*)`, `Bash(npm run lint:*)`, `Bash(npm run typecheck:*)`, `Bash(npx eslint:*)`, `Bash(npx prettier:*)`, `Edit(**/*.spec.ts)`, `Edit(**/*.spec.js)` (the Playwright phase), `mcp__duckwright__*`. In Claude Code, `Edit(...)` rules also cover the Write tool.
- `parseStreamLine` maps Claude Code stream-json: `{"type":"system","subtype":"init","session_id"}` → init; `{"type":"assistant","message":{"content":[...]}}` → one `text` per text block and one `tool` per `tool_use` block (summary: for Bash the `command`, for Read/Edit/Write the `file_path`, for `mcp__duckwright__<x>` just `<x>`, truncated to 120 chars); `{"type":"result",...}` → result with `total_cost_usd`, `is_error`, `result`.

- [ ] **Step 1: Write the failing tests**:
  - `argv for a first turn` — `claudeArgv({...resume:null})` starts with `["claude","-p",prompt,"--output-format","stream-json","--verbose","--model","sonnet"]`, has no `--resume`, and `JSON.parse` of the value after `--mcp-config` equals the object above.
  - `argv resumes` — with `resume:"s1"` contains `"--resume","s1"` right after the model.
  - `allowed tools have no bare Bash or Write` — `ALLOWED_TOOLS("/p/skills")` contains `"Bash(node /p/skills/*:*)"` and contains neither `"Bash"` nor `"Write"`.
  - `parses init, text, tool and result` — feed the four shapes; expect `[{kind:"init",sessionId:"s"}]`, `[{kind:"text",text:"hi"}]`, `[{kind:"tool",name:"Bash",summary:"duckwright check tasks/x"}]`, `[{kind:"result",sessionId:"s",costUsd:0.12,isError:false,text:"done"}]`.
  - `ignores garbage` — `parseStreamLine("not json")` and `parseStreamLine("")` return `[]`.
- [ ] **Step 2: Run** `node --test test/chat/claude.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — `spawnClaude` splits stdout on `\n` (keep the partial tail), resolves `done` on `close`, `kill()` sends SIGTERM. Reuse the Windows `.cmd` handling pattern from `src/proc.ts`.
- [ ] **Step 4: Run** `node --test test/chat/claude.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add claude stream-json driver for chats"`

---

### Task 3: The orchestrator skill and system prompt

**Files:**
- Create: `skills/duckwright-autotest/SKILL.md`, `src/chat/prompt.ts`
- Test: `test/chat/prompt.test.ts`

**Interfaces:**
- Produces: `export function chatSystemPrompt(skillsDir: string): string` — reads `skills/duckwright-autotest/SKILL.md`, strips its front matter, replaces every `{{SKILLS}}` with `skillsDir`, and prefixes one line: `You are running inside Duckwright's web chat. The person reads your messages in a browser.`
- Consumes: MCP tool names from Task 4 (`set_phase`, `ask`, `check_messages`, `budget`, `open_plan`, `run_plan`, `run_task`, `wait`).

The skill text must say, in this order (copy rules from the spec's "The flow", do not restate the other skills' rules):
1. Read the attached files, then follow `{{SKILLS}}/duckwright-tasks/SKILL.md` step 1. Run `node {{SKILLS}}/duckwright-setup/scripts/doctor.mjs --root .`; if it fails, follow `duckwright-setup`, folding its questions into step 2.
2. Call `set_phase` at the start of each phase.
3. Clarify once: put every question in one `ask` call (each with a best guess), include the spend ceiling question ("I'll stop at $<ceiling> — change it?") and then end the turn. No five-question limit here. Never ask for a password, token or cookie.
4. Plan: write `tasks/<feature>/test-plan.md` (black-box scenarios from the spec; touched pages/routes/roles from the implementation plan), post one line per scenario, do not wait.
5. Probe per `duckwright-tasks` 3b. Overrides: the probe budget in `close-gaps.md` gate 5 does not apply (the chat ceiling does, see `budget`); the person's answers in step 2 plus the map's `write-envs` replace the separate writes yes. Run probes with `run_task`, never with Bash.
6. Write tasks per `duckwright-tasks` 4–6 (`duckwright check`, `check-tasks.mjs`).
7. Run: `open_plan` then `run_plan`, then `wait`.
8. Triage each failure from `node {{SKILLS}}/duckwright-playwright/scripts/runs-brief.mjs <run folder>`: task bug → fix, `facts.mjs suspect`, re-run (max 2 re-runs per task); environment problem → `ask` and end turn; possible app bug → never loosen the check, `facts.mjs bug` when intended value known, else `ask`.
9. Report in chat and `tasks/<feature>/report.md` (sections from the spec's Report step).
10. Ask once about Playwright tests. On yes follow `duckwright-playwright`, ask its questions with `ask`, and run `npx playwright test <files>` against the chat's environment when it is in `investigate-envs` (and `write-envs` if the tests write); never weaken an assertion.
11. After every MCP result and between phases, read `pending_messages` / call `check_messages` and fold the person's words in before continuing.
12. When `budget` says the ceiling is reached, start nothing new, `wait` for running runs, report what is done and left, end the turn.
13. A "Never" list: the three skills' Never lists still apply; never run against production; never put credentials in chat, tasks, facts or tests.

- [ ] **Step 1: Write the failing tests**:
  - `prompt substitutes the skills folder` — `chatSystemPrompt("/pkg/skills")` contains `/pkg/skills/duckwright-tasks/SKILL.md` and no `{{SKILLS}}`.
  - `prompt has no front matter` — does not start with `---` and does not contain `name: duckwright-autotest`.
  - `prompt names every MCP tool` — contains each of the eight tool names.
- [ ] **Step 2: Run** `node --test test/chat/prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the skill and `chatSystemPrompt`.** Front matter: `name: duckwright-autotest`, a description saying it is used by Duckwright's web chat. Locate the skill via `path.resolve(import.meta.dirname, "../../skills")` (works from `src/chat` and `dist/chat`), exported as `DEFAULT_SKILLS_DIR`.
- [ ] **Step 4: Run** `node --test test/chat/prompt.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add duckwright-autotest orchestrator skill"`

---

### Task 4: Run tracker and MCP endpoint

**Files:**
- Create: `src/chat/tracker.ts`, `src/chat/mcp.ts`
- Test: `test/chat/tracker.test.ts`, `test/chat/mcp.test.ts`

**Interfaces:**
- Consumes: `ManagerLike`, `ManagerEvent`, `RunOutcome` (`src/runs/manager.ts`, `src/events.ts`); `Phase` from Task 1.
- Produces (`tracker.ts`):
  ```ts
  export interface TaskResult { id: TaskId; name: string; state: TaskState; runId: string | null; costUsd: number; historyPath: string | null; answer: string | null }
  export class RunTracker {
    constructor(manager: ManagerLike);
    own(taskIds: TaskId[]): void;                 // the chat started these
    ownPlan(planId: PlanId): void;                // all of the plan's tasks are owned
    owned(): { tasks: TaskId[]; plans: PlanId[] };
    runCostUsd(): number;                          // sum of run:end costUsd and live decision/step costs of owned tasks
    results(ids: TaskId[]): TaskResult[];
    settled(ids: TaskId[]): Promise<void>;         // resolves when none of ids is running/paused/stopping or queued in a plan
    close(): void;                                 // unsubscribe
  }
  ```
- Produces (`mcp.ts`):
  ```ts
  export interface McpHost {
    manager: ManagerLike; tracker: RunTracker;
    spentUsd(): number; ceilingUsd(): number;
    takeMessages(): string[];                      // drains queued person messages
    setPhase(p: Phase): void; ask(questions: string[]): void;
  }
  export type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };
  export async function handleMcp(host: McpHost, msg: JsonRpc, waitCapSec?: number): Promise<object | null>; // null for notifications
  export const MCP_TOOLS: { name: string; description: string; inputSchema: object }[];
  ```
- Methods: `initialize` → `{protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"duckwright",version}}`; `notifications/*` → `null`; `tools/list` → `{tools: MCP_TOOLS}`; `tools/call` → `{content:[{type:"text",text: JSON.stringify(result)}], isError?: true}`; anything else → JSON-RPC error `-32601`.
- Tools and their result objects (every result also carries `pending_messages: host.takeMessages()`):
  - `set_phase({phase})` → `{ok:true}`; unknown phase → isError.
  - `ask({questions: string[]})` → `{ok:true, note:"end your turn now"}`.
  - `check_messages({})` → `{}` (just the pending messages).
  - `budget({})` → `{spent_usd, ceiling_usd, remaining_usd}`.
  - `open_plan({folder})` → `manager.plan(folder)`; on `already open` find the plan by folder in `manager.plans()`; returns `{plan_id, task_ids}`; tracker.ownPlan.
  - `run_plan({plan_id, which?: "all"|"failed"})` → budget gate, then `manager.runPlan`; `{ok:true}` or isError with the manager's error.
  - `run_task({file, env?})` → budget gate, `manager.add({mentions:[file], typed:null})` (on duplicate, find the task by `source.path` resolving to the same file), optional `setOverrides(id,{env})`, `start(id)`; `{task_id, run_id}`.
  - `wait({task_ids?: number[], plan_id?: number, timeout_sec?: number})` → waits `tracker.settled` up to `min(timeout_sec ?? 600, waitCapSec ?? 600)` seconds; `{done: boolean, results: TaskResult[]}`.
  - Budget gate: when `spentUsd() >= ceilingUsd()` return isError `{error:"spend ceiling reached", spent_usd, ceiling_usd}` and call nothing on the manager.

- [ ] **Step 1: Write the failing tests** with `FakeManager` (`test/tui/fake-manager.ts`; extend it if a needed method only records, e.g. `runPlan` already exists):
  - `tracker sums costs of owned runs only` — emit `run:end` with `costUsd 0.3` for owned task 1 and `0.5` for task 2; `runCostUsd() === 0.3`.
  - `settled resolves when owned tasks finish` — task 1 `running`, emit `task:updated` to `passed`; promise resolves.
  - `initialize and tools/list` — `tools/list` returns 8 tools with the names above.
  - `run_task refuses over the ceiling` — host with `spentUsd()=5, ceilingUsd()=5`; result `isError:true`, text contains `spend ceiling reached`, and `FakeManager` recorded no `add` or `start` call.
  - `every tool result carries pending messages` — host queue `["skip checkout"]`; `budget` result JSON has `pending_messages: ["skip checkout"]`; a second call has `[]`.
  - `wait times out with done false` — task stays `running`, `waitCapSec=0.05`; `{done:false}`.
  - `unknown method is -32601` and `notification returns null`.
- [ ] **Step 2: Run** `node --test test/chat/tracker.test.ts test/chat/mcp.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `RunTracker` and `handleMcp`.** Tracker subscribes once in the constructor; it keeps `TaskSnapshot`s from `task:*` events and outcomes from `run:end` events.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add chat MCP endpoint over the run manager"`

---

### Task 5: Chat sessions

**Files:**
- Create: `src/chat/sessions.ts`
- Test: `test/chat/sessions.test.ts`

**Interfaces:**
- Consumes: `ChatStore` (1), `claudeArgv`, `parseStreamLine`, `ClaudeSpawner` (2), `chatSystemPrompt` (3), `RunTracker`, `McpHost`, `handleMcp` (4).
- Produces:
  ```ts
  export interface ChatSessionsOptions {
    root: string; manager: ManagerLike; store: ChatStore;
    spawn: ClaudeSpawner; skillsDir: string; systemPrompt: string;
    mcpUrl(chatId: ChatId): string;               // filled by the server once it knows its port
    defaultModel?: string;                         // "sonnet"
    defaultCeilingUsd?: number;                    // 5
    newToken?: () => string;                       // per-chat MCP token; default auth.ts newToken
  }
  export class ChatSessions {
    constructor(o: ChatSessionsOptions);
    list(): Array<{ chat: ChatMeta; turn: TurnState }>;
    open(id: ChatId): { chat: ChatMeta; turn: TurnState; messages: ChatMessage[] } | null;
    create(o?: { model?: string; ceilingUsd?: number }): ChatMeta;
    send(id: ChatId, text: string, attachments: string[]): { ok: true } | { ok: false; error: string };
    stop(id: ChatId): Promise<void>;
    update(id: ChatId, o: { model?: string; ceilingUsd?: number; title?: string }): { ok: true } | { ok: false; error: string };
    mcp(id: ChatId, bearer: string | null, msg: JsonRpc): Promise<{ status: number; body: object | null }>;
    subscribe(fn: (e: ChatEvent) => void): () => void;
    stopAll(): Promise<void>;
  }
  ```
- Behaviour:
  - `send` on an idle chat appends the person message and starts a turn: prompt = text plus, when there are attachments, a line `Attached files: <paths, comma separated>`. Title becomes the first 60 chars of the first message.
  - `send` while `running`: append the message and queue it; `takeMessages()` drains the queue for MCP. When a turn ends with messages still queued, start the next turn with them joined by blank lines.
  - Stream handling: `init` → save `sessionId`; `text` → `agent` message; `tool` named `mcp__duckwright__*` is not shown (the MCP side emits its own activity), others → `activity` message (`"<name>: <summary>"`); `result` → add `costUsd` to `spentUsd`, end turn; `isError` → `error` message with the text.
  - Process ends with no `result`, or code ≠ 0 → `error` message `claude exited <code>: <first stderr line>`, turn `idle`.
  - MCP side effects: `set_phase` updates meta.phase; `ask` appends a `questions` message; `open_plan` sets meta.planFolder; `run_plan`/`run_task` append an activity line (`Running plan <folder>` / `Running <file>`).
  - When an owned task's snapshot gets `twofa` set, append activity `<task name> is waiting for a 2FA code` (the existing global `TwofaDialog` already lets the person answer).
  - `spentUsd` exposed to MCP = turn costs + `tracker.runCostUsd()`; saved to meta on every change.
  - `mcp(id, bearer, msg)`: 401 `{error:"unauthorized"}` unless `bearer` equals that chat's current token (compare with `crypto.timingSafeEqual`); token is regenerated at each turn start.
  - `stop`: turn → `stopping`, kill the process, `manager.stop` each owned running task and `manager.stopPlan` each owned plan, clear the queue, turn → `idle`, append activity `Stopped`.
  - `update` with `ceilingUsd` must be a finite number ≥ 0; `model` a non-empty string.

- [ ] **Step 1: Write the failing tests** with a fake `ClaudeSpawner` that records argv and lets the test push lines and close:
  - `first send starts a turn with no resume, second with resume` — push init `s1` + result; second `send`'s argv contains `--resume s1`.
  - `message during a turn is queued and delivered via MCP` — send A, send B while running; `mcp(id, token, tools/call budget)` result has `pending_messages:["B"]`; after `result`, no second turn starts.
  - `undelivered queued message starts the next turn` — send A, send B while running, push result; spawner called twice and second prompt contains `B`.
  - `cost accumulates and gates runs` — ceiling 0.1, result cost 0.2; `run_task` via `mcp` returns isError.
  - `stop kills and stops owned runs` — tracker owns task 1 (via `run_task`); `stop` → fake process `kill` called, `FakeManager` recorded `stop(1)`, turn `idle`, next `send` starts a new process.
  - `crash ends the turn with an error` — close with code 1, stderr `boom`, no result; last message `{kind:"error", text:"claude exited 1: boom"}`, turn `idle`.
  - `mcp rejects a wrong token` — status 401 and `FakeManager` recorded nothing.
  - `2FA wait shows in the chat` — owned task 1 gets `task:updated` with `twofa:{kind:"totp"}`; last message is activity `one is waiting for a 2FA code`.
- [ ] **Step 2: Run** `node --test test/chat/sessions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `ChatSessions`.** One `RunTracker` per chat, created lazily; closed on `stopAll`.
- [ ] **Step 4: Run** `node --test test/chat/` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add chat sessions"`

---

### Task 6: Server wiring: chat API, uploads, /mcp, SSE

**Files:**
- Modify: `src/web/api.ts` (ApiContext gains `chats: ChatSessions`; `snapshotOf` gains `chats: Array<{chat, turn}>`), `src/web/server.ts` (`/mcp/<id>` and uploads), `src/web/index.ts` (build `ChatStore` + `ChatSessions`, `stopAll` on quit)
- Test: `test/web/api.test.ts`, `test/web/server.test.ts`

**Interfaces:**
- Consumes: `ChatSessions` (5), `ChatEvent` (1).
- API routes (all through `authorize` like today):
  - `GET /api/chats` → `{ok, items: list()}`
  - `POST /api/chats` body `{model?, ceilingUsd?}` → `{ok, chat}`
  - `GET /api/chats/<id>` → `{ok, chat, turn, messages}` or 404
  - `POST /api/chats/<id>/messages` body `{text: string, attachments?: string[]}` → `{ok}`; 400 on empty text; 409 with the error from `send`.
  - `POST /api/chats/<id>/stop` → `{ok}`
  - `PUT /api/chats/<id>` body `{model?, ceilingUsd?, title?}` → `{ok}` / 400
  - `POST /api/chats/<id>/uploads?name=<file>` raw body (not JSON), cap 10 MiB → `{ok, path}`; 413 above the cap.
- `/mcp/<id>`: routed in `server.ts` **before** `authorize()` (the claude process has no cookie and its Host is fine but it sends no Origin). Accept only `POST`, `Content-Type: application/json`, body ≤ 1 MiB; bearer from `Authorization`; reply via `chats.mcp(...)`; `202` with empty body when it returns `body: null`. Any other method → 405.
- SSE: the `events()` stream also subscribes to `ctx.chats.subscribe` and writes chat events; the state message includes `chats`.
- `index.ts`: `mcpUrl(id) = http://127.0.0.1:${port}/mcp/${id}` (port known after `startServer`; give `ChatSessions` a getter). `quit()` awaits `chats.stopAll()` before `manager.stopAll()`.

- [ ] **Step 1: Write the failing tests**:
  - api: `POST /api/chats then GET lists it`; `POST messages with empty text is 400`; `PUT ceilingUsd -1 is 400`; `GET unknown chat is 404`. Use a `ChatSessions` with a fake spawner and `tmpDir()`.
  - server: `mcp without bearer is 401`; `mcp with the browser token cookie but no bearer is 401`; `mcp tools/list with the chat token is 200 and lists 8 tools` (start a turn first so a token exists; read it from the fake spawner's argv `--mcp-config`); `GET /mcp/<id> is 405`; `upload over 10 MiB is 413`; `SSE state includes chats`.
- [ ] **Step 2: Run** `node --test test/web/api.test.ts test/web/server.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement the routes and wiring.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS (typecheck included).
- [ ] **Step 5: Commit** `git commit -m "Serve chats, uploads and the MCP endpoint in web mode"`

---

### Task 7: Web UI chat view

**Files:**
- Create: `web/src/chat.ts` (pure reducer), `web/src/ChatPane.tsx`
- Modify: `web/src/store.ts` (state gains `view: "workspace" | "chat"` and `chat: ChatUiState`; stream messages of type `chat:*` go to the chat reducer), `web/src/Header.tsx` (Workspace / Chat toggle), `web/src/App.tsx` (render `ChatPane` when `view === "chat"`), `web/src/styles.css`
- Test: `test/web/chat.test.ts`, extend `test/web/ui.smoke.test.ts`

**Interfaces:**
- Consumes: `ChatMeta`, `ChatMessage`, `ChatEvent`, `TurnState`, `Phase` (types only).
- Produces (`chat.ts`):
  ```ts
  export interface ChatUiState { chats: Array<{ chat: ChatMeta; turn: TurnState }>; openId: ChatId | null; messages: ChatMessage[]; draft: string; attachments: string[] }
  export type ChatAction =
    | { type: "chat:list"; items: ChatUiState["chats"] }
    | { type: "chat:opened"; chat: ChatMeta; turn: TurnState; messages: ChatMessage[] }
    | { type: "chat:draft"; text: string } | { type: "chat:attach"; path: string } | { type: "chat:detach"; path: string }
    | { type: "chat:sent" } | ChatEvent;
  export function reduceChat(s: ChatUiState, a: ChatAction): ChatUiState;
  export const PHASES: Phase[];   // read, clarify, plan, probe, write, run, report, playwright
  ```
- `ChatPane`: left list of chats (New chat button), right conversation: phase strip (current phase highlighted, `spentUsd` / `ceilingUsd` shown as `$0.84 / $5.00`), messages (`questions` as a card with a numbered list; `activity` as muted one-liners, consecutive ones grouped and collapsible; `error` in the error colour), input with `@` mentions (reuse `/api/candidates` as `AddDialog` does), Upload button (`<input type=file>` → `POST /api/chats/<id>/uploads`), model picker (`sonnet`, `opus`, `haiku`, or typed), ceiling field, Send (Enter; Shift+Enter newline) and Stop (shown while `turn !== "idle"`). When `chat.planFolder` is set, a "Show plan" link switches to the workspace view and selects that plan.
- Keyboard: existing global shortcuts must stay inactive while the chat input has focus (already true for textareas via `shouldIgnore`).

- [ ] **Step 1: Write the failing tests** (`test/web/chat.test.ts`, node --test, no DOM):
  - `chat:message for the open chat appends; for another chat it does not`.
  - `chat:updated replaces the list entry and keeps order by updatedAt`.
  - `chat:sent clears draft and attachments`.
  - smoke: the built page renders a "Chat" toggle (follow how `ui.smoke.test.ts` loads the UI).
- [ ] **Step 2: Run** `node --test test/web/chat.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `reduceChat`, `ChatPane`, and the store/header/app wiring.** Match `ui.tsx` components (`Button`, `Modal`) and existing CSS variables.
- [ ] **Step 4: Run** `npm test && npm run build` — Expected: PASS, build succeeds.
- [ ] **Step 5: Manual check:** run `node src/bin.ts --web` in a scratch project folder with `claude` on PATH, create a chat, send "hello", see an agent reply, the phase strip, and cost update. Note the result in the commit message body.
- [ ] **Step 6: Commit** `git commit -m "Add the chat view to the web UI"`

---

### Task 8: Docs

**Files:**
- Modify: `README.md` (Web mode section: a "Test chat" subsection; Features list one bullet; Roadmap: mark as done under Experience; "Writing tasks with Claude Code": mention `duckwright-autotest` is used by the chat and needs no install)
- Test: existing `test/cli.test.ts` README checks, if any, still pass.

- [ ] **Step 1: Write the README subsection**: what it does (one paragraph), the flow as a numbered list of the eight phases, the spend ceiling and its default, the model picker, where chats are saved (`.duckwright/chats/`), what the agent may do (tools allow-list in plain words), that explore runs do not show in the timeline in this version, and that a server restart ends a turn (send "continue").
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "Document the web test chat"`
