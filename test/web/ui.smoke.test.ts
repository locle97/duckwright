import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

import type { ClaudeSpawner } from "../../src/chat/claude.ts";
import { ChatSessions } from "../../src/chat/sessions.ts";
import { ChatStore } from "../../src/chat/store.ts";
import { listEnvironments } from "../../src/environment.ts";
import { startWeb } from "../../src/web/index.ts";
import type { WebHandle } from "../../src/web/index.ts";
import { ROOT, tmpDir } from "../helpers.ts";
import { FakeManager, decision, ev, snapshot } from "../tui/fake-manager.ts";

const enabled = process.env.DUCKWRIGHT_UI_SMOKE === "1";
const built = fs.existsSync(path.join(ROOT, "dist", "web-ui", "index.html"));
const skip = !enabled ? "set DUCKWRIGHT_UI_SMOKE=1 to run the browser smoke test" : !built ? "run npm run build first" : false;

/** A Chromium to drive: DUCKWRIGHT_CHROMIUM, one under PLAYWRIGHT_BROWSERS_PATH, else the system Chrome. */
function chromiumPath(): string | undefined {
  if (process.env.DUCKWRIGHT_CHROMIUM) return process.env.DUCKWRIGHT_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  for (const d of fs.readdirSync(root).filter((n) => n.startsWith("chromium")).sort().reverse()) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = path.join(root, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

let browser: Browser;
let web: WebHandle;
const manager = new FakeManager([snapshot(1, "Open the shop and add a hat", { createdAt: 1 })]);

before(async () => {
  if (skip) return;
  web = await startWeb({ manager, maxParallel: 3, open: () => {} });
  const executablePath = chromiumPath();
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
});
after(async () => {
  if (skip) return;
  await browser?.close();
  web.quit();
  await web.done;
});

test("add a task, watch a run, open a step, answer a 2FA prompt, quit", { skip, timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  await page.goto(web.url);
  await page.waitForSelector("text=Open the shop and add a hat");

  // Add a task through the dialog.
  await page.getByRole("button", { name: "+ Add task" }).click();
  await page.locator("#add-text").fill("Check the cart total");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForSelector("text=Check the cart total");
  // The text can match the dialog's own textarea before the request reaches the manager, so wait for the call.
  for (let i = 0; i < 50 && !manager.log.includes("add:|Check the cart total"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(manager.log.includes("add:|Check the cart total"));

  // Start the first task, then play a run through the manager's events.
  await page.getByText("Open the shop and add a hat").first().click();
  const replay = page.getByRole("button", { name: "Replay spec" });
  await replay.waitFor({ state: "visible" });
  assert.equal(await replay.getAttribute("title"), "No spec yet: only a passed run writes duckwright.spec.ts");
  await page.getByRole("button", { name: "Start" }).click();
  assert.ok(manager.log.includes("start:1"));
  manager.update(1, { state: "running", runId: "r1", runCount: 1 });
  const d = decision("browse the storefront", [["goto", "https://shop.test"]]);
  await replay.waitFor({ state: "hidden" });
  manager.run(1, "r1", [ev.start(), ev.step(1), ev.decision(1, d, 0.02), ev.actionStart(1, 0), ev.actionResult(1, 0, "ok"), ev.stepEnd(1, d, ["ok"])]);
  await page.waitForSelector("text=browse the storefront");

  // The newest step is open while the run is followed; clicking its header closes and reopens it.
  await page.waitForSelector("text=goto https://shop.test");
  await page.getByText("browse the storefront").first().click();
  await page.waitForSelector("text=goto https://shop.test", { state: "hidden" });
  await page.getByText("browse the storefront").first().click();
  await page.waitForSelector("text=goto https://shop.test");

  // A 2FA prompt appears, takes a code, and the manager receives it.
  manager.update(1, { twofa: { kind: "totp" } });
  await page.locator("#twofa-code").fill("123456");
  await page.getByRole("button", { name: "Submit" }).click();
  assert.deepEqual(manager.twofaAnswers.at(-1), { id: 1, value: "123456" });
  manager.update(1, { twofa: null });

  // The run ends and its result shows.
  manager.run(1, "r1", [ev.end({
    status: "pass", exitCode: 0, success: true, answer: "Added a hat", steps: 1, costUsd: 0.02, historyPath: null,
    export: { kind: "off" }, warnings: [], error: null,
  })]);
  manager.update(1, { state: "passed" });
  await page.waitForSelector("text=Added a hat");

  // With a spec written, Replay spec is titled for the Inspector and calls the manager.
  manager.update(1, { hasSpec: true });
  await replay.waitFor({ state: "visible" });
  assert.equal(await replay.getAttribute("title"), "Open duckwright.spec.ts in the Playwright Inspector");
  await replay.click();
  for (let i = 0; i < 50 && !manager.log.includes("replaySpec:1"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(manager.log.includes("replaySpec:1"));
  manager.replayResult = { ok: false, error: "no spec for run r1: only a passed run writes duckwright.spec.ts" };
  await replay.click();
  await page.waitForSelector("text=no spec for run r1");

  // Quit from the header.
  await page.getByRole("button", { name: "Quit" }).click();
  await page.waitForSelector("text=Duckwright stopped");
  await web.done;
  assert.ok(manager.log.includes("stopAll"));
});

test("environments_page_create_and_add_account", { skip, timeout: 60_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dw-env-ui-"));
  // Like the real manager, read the environment names from disk on every call.
  const fake = new FakeManager([]);
  const realGlobals = fake.globals.bind(fake);
  fake.globals = () => ({ ...realGlobals(), environments: listEnvironments(cwd) });
  const own = await startWeb({ manager: fake, maxParallel: 3, open: () => {}, cwd });
  const page = await browser.newPage();
  try {
    await page.goto(own.url);
    await page.getByRole("button", { name: "Add task" }).first().waitFor();
    await page.keyboard.press("v");
    await page.getByRole("dialog", { name: "Environments" }).waitFor();
    await page.locator("#env-new").fill("dev");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // No base URL yet: the account form is disabled.
    assert.equal(await page.locator("#acc-id").isDisabled(), true);
    await page.locator("#env-base").fill("https://dev.example.test");
    await page.getByRole("button", { name: "Save environment" }).click();
    await page.locator("#acc-id").waitFor();
    await page.waitForFunction(() => !(document.querySelector("#acc-id") as HTMLInputElement).disabled);
    await page.locator("#acc-id").fill("admin");
    await page.locator("#acc-username").fill("root");
    await page.locator("#acc-password").fill("short");
    await page.waitForSelector("text=shorter than 8");
    await page.getByRole("button", { name: "Add account" }).click();
    await page.waitForSelector("text=password set");
    // Adding the same id again would overwrite it: refused inline.
    await page.locator("#acc-id").fill("admin");
    await page.waitForSelector("text=An account admin already exists");
    assert.equal(await page.getByRole("button", { name: "Add account" }).isDisabled(), true);
    await page.locator("#acc-id").fill("");
    // Reopening the account shows empty secret fields.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    assert.equal(await page.locator("#acc-password").inputValue(), "");
    assert.equal(await page.locator("#acc-totp").inputValue(), "");
    assert.equal(await page.locator("#acc-password").getAttribute("type"), "password");
    // A draft typed under one environment does not follow to another.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("#acc-id").fill("other");
    await page.locator("#acc-password").fill("secret-draft");
    await page.locator("#env-new").fill("qa");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("region", { name: "Environment qa" }).waitFor();
    assert.equal(await page.locator("#acc-id").inputValue(), "");
    assert.equal(await page.locator("#acc-password").inputValue(), "");
    await page.getByRole("button", { name: "dev", exact: true }).click();
    await page.getByRole("region", { name: "Environment dev" }).waitFor();
    assert.equal(await page.locator("#acc-id").inputValue(), "");
    assert.equal(await page.locator("#acc-password").inputValue(), "");
    // The new environment is offered by the global options without a restart.
    await page.keyboard.press("Escape");
    await page.keyboard.press("O");
    await page.locator("#opt-env").waitFor();
    assert.ok((await page.locator("#opt-env option").allTextContents()).includes("dev"));
  } finally {
    await page.close();
    own.quit();
    await own.done;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("chat_view_new_chat_send_reply_cost_stop_upload", { skip, timeout: 60_000 }, async () => {
  const root = tmpDir();
  const fake = new FakeManager([snapshot(1, "Open the shop", { createdAt: 1 })]);
  // A fake claude: it prints init, one tool line, a text reply and a result costing $0.84, then exits.
  // A prompt that says "hang" never answers, so Stop can be tried.
  const prompts: string[] = [];
  const spawn: ClaudeSpawner = (_argv, _cwd, onLine, stdin) => {
    const prompt = stdin ?? "";
    prompts.push(prompt);
    let resolve!: (r: { code: number; stderr: string }) => void;
    const done = new Promise<{ code: number; stderr: string }>((r) => { resolve = r; });
    if (!prompt.includes("hang")) {
      setTimeout(() => {
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }));
        onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "CLAUDE.md" } }] } }));
        onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello from the fake agent" }] } }));
        onLine(JSON.stringify({ type: "result", session_id: "s1", total_cost_usd: 0.84, is_error: false, result: "" }));
        resolve({ code: 0, stderr: "" });
      }, 50);
    }
    return { done, kill: () => resolve({ code: -15, stderr: "" }) };
  };
  const chats = new ChatSessions({
    root, manager: fake, store: new ChatStore(root), spawn, skillsDir: "/skills", systemPrompt: "sys",
    mcpUrl: (id) => `http://127.0.0.1:1/mcp/${id}`,
  });
  const own = await startWeb({ manager: fake, maxParallel: 3, open: () => {}, cwd: root, chats });
  const page = await browser.newPage();
  try {
    await page.goto(own.url);
    await page.getByRole("button", { name: "Add task" }).first().waitFor();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "+ New chat" }).click();
    const box = page.getByRole("textbox", { name: "Message" });
    await box.waitFor();
    // Typing a task shortcut letter in the chat input does not open dialogs or act on the workspace.
    await box.pressSequentially("hello? x a i");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await box.inputValue(), "hello? x a i");
    // Shift+Enter adds a line; Enter sends.
    await box.press("Shift+Enter");
    await box.pressSequentially("more");
    assert.equal(await box.inputValue(), "hello? x a i\nmore");
    await box.press("Enter");
    await page.waitForSelector("text=Hello from the fake agent");
    assert.equal(await box.inputValue(), "");
    assert.ok(prompts[0]!.includes("hello? x a i"));
    await page.getByLabel("Spend").filter({ hasText: "$0.84 / $5.00" }).waitFor();
    // The tool line is a collapsible activity group; the phase strip lists every phase.
    await page.locator("details.chat-activity summary", { hasText: "Read: CLAUDE.md" }).waitFor();
    assert.equal(await page.locator(".phases .phase").count(), 8);
    assert.ok(await page.getByRole("button", { name: "Stop" }).count() === 0);

    // Model and ceiling are editable and saved.
    const ceiling = page.getByLabel("Spend ceiling");
    await ceiling.fill("7");
    await ceiling.blur();
    await page.getByLabel("Spend").filter({ hasText: "/ $7.00" }).waitFor();

    // An upload becomes an attachment chip and goes with the next message.
    await page.locator("input[data-chat-upload]").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await page.waitForSelector(".tag:has-text('note.txt')");
    await box.fill("hang please");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Stop" }).waitFor();
    assert.ok(prompts[1]!.includes("note.txt"));
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });

    // Back to the workspace.
    await page.getByRole("button", { name: "Workspace" }).click();
    await page.getByRole("button", { name: "Add task" }).first().waitFor();
  } finally {
    await page.close();
    own.quit();
    await own.done;
  }
});
