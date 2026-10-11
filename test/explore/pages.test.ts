import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../src/explore/pages.ts";

const TABS = "### Result\n- 0: [Other](https://a.test/)\n- 1: (current) [Mugs | Shop](https://shop.example/mugs?utm=1#top)\n";
const SNAP = [
  "- link \"Home\" [ref=e1]:",
  "  - /url: /",
  "- link \"Cart\" [ref=e2]:",
  "  - /url: /cart?item=7",
  "- link \"Docs\" [ref=e3]:",
  "  - /url: https://docs.shop.example/x",
  "- link \"Mail\" [ref=e4]:",
  "  - /url: mailto:hi@shop.example",
  "- link \"Cart again\" [ref=e5]:",
  "  - /url: /cart",
].join("\n");

test("parsePage reads the current tab and normalized, resolved, de-duplicated links", () => {
  assert.deepEqual(parsePage(TABS, SNAP), {
    url: "https://shop.example/mugs",
    title: "Mugs | Shop",
    links: ["https://shop.example/", "https://shop.example/cart", "https://docs.shop.example/x"],
  });
});

test("parsePage without a snapshot has no links; non-http pages are null", () => {
  assert.deepEqual(parsePage(TABS, null)?.links, []);
  assert.equal(parsePage("- 0: (current) [New tab](about:blank)", SNAP), null);
  assert.equal(parsePage("", SNAP), null);
});
