import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

import { startWeb } from "../../src/web/index.ts";
import type { WebHandle } from "../../src/web/index.ts";
import { ROOT } from "../helpers.ts";
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
  assert.ok(manager.log.some((l) => l === "add:|Check the cart total"));

  // Start the first task, then play a run through the manager's events.
  await page.getByText("Open the shop and add a hat").first().click();
  await page.getByRole("button", { name: "Start" }).click();
  assert.ok(manager.log.includes("start:1"));
  manager.update(1, { state: "running", runId: "r1", runCount: 1 });
  const d = decision("browse the storefront", [["goto", "https://shop.test"]]);
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

  // Quit from the header.
  await page.getByRole("button", { name: "Quit" }).click();
  await page.waitForSelector("text=Duckwright stopped");
  await web.done;
  assert.ok(manager.log.includes("stopAll"));
});
