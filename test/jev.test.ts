import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JEV_URL,
  JevAuthError,
  JevClient,
  JevError,
  extractTargets,
} from "../src/jev.ts";
import type { JevQuestion, JevTransport } from "../src/jev.ts";
import { AbortedError } from "../src/proc.ts";

test("extractTargets keeps only target roles in order", () => {
  const snap = [
    '- heading "H" [ref=e1]',
    '- link "Home" [ref=e2] [cursor=pointer]:',
    '  - button "Go" [ref=e3]',
    '- textbox "Q" [ref=e4]',
    '- checkbox "Agree" [checked] [ref=e5]',
  ].join("\n");
  assert.deepEqual(extractTargets(snap), [
    { ref: "e2", role: "link", name: "Home" },
    { ref: "e3", role: "button", name: "Go" },
    { ref: "e5", role: "checkbox", name: "Agree" },
  ]);
});

test("extractTargets unnamed kept only with cursor pointer", () => {
  const snap = ["- button [ref=e6] [cursor=pointer]", "- button [ref=e7]", '- link "" [ref=e8]'].join("\n");
  assert.deepEqual(extractTargets(snap), [{ ref: "e6", role: "button", name: "" }]);
});

test("extractTargets drops duplicate refs", () => {
  const snap = ['- link "A" [ref=e2]', '- link "B" [ref=e2]'].join("\n");
  assert.deepEqual(extractTargets(snap), [{ ref: "e2", role: "link", name: "A" }]);
});

test("extractTargets unescapes quotes and backslashes", () => {
  const snap = '- button "Say \\"hi\\" \\\\ now" [ref=e9]';
  assert.deepEqual(extractTargets(snap), [{ ref: "e9", role: "button", name: 'Say "hi" \\ now' }]);
});

test("extractTargets ignores lines without ref", () => {
  assert.deepEqual(extractTargets('- button "X"'), []);
});

// ---- JevClient ----

const QUESTIONS: Record<string, JevQuestion> = {
  action: { type: "choice", question: "q", criteria: { click: "c", wait: "w" } },
  target: { type: "choice", question: "q", criteria: { e1: "b" } },
};
const USAGE = { input_tokens: 1000, output_tokens: 10 };
const COST = 1000 * 42e-9 + 10 * 42e-9;

function okBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answers: {
      action: { choice: "click", confidence: 0.9 },
      target: { choice: "e1", confidence: 0.8 },
    },
    usage: USAGE,
    ...over,
  });
}

interface Call {
  url: string;
  init: Parameters<JevTransport>[1];
}

function setup(script: Array<{ status: number; body: string } | Error>, signal?: AbortSignal, onSleep?: () => void) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const transport: JevTransport = async (url, init) => {
    calls.push({ url, init });
    const r = script[Math.min(i++, script.length - 1)];
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    onSleep?.();
  };
  const client = new JevClient({ apiKey: "k", transport, sleep, signal });
  return { client, calls, sleeps };
}

test("request url, headers and body", async () => {
  const { client, calls } = setup([{ status: 200, body: okBody() }]);
  await client.ask({ task: "t" }, QUESTIONS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer k", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "jev-latest", state: { task: "t" }, questions: QUESTIONS });
});

test("cost uses both prices", async () => {
  const { client } = setup([{ status: 200, body: okBody() }]);
  const [answers, cost] = await client.ask({}, QUESTIONS);
  assert.equal(cost, COST);
  assert.deepEqual(answers.action, { choice: "click", confidence: 0.9 });
});

test("429 then success", async () => {
  const { client, calls, sleeps } = setup([{ status: 429, body: "" }, { status: 200, body: okBody() }]);
  await client.ask({}, QUESTIONS);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(calls.length, 2);
});

test("529 three times", async () => {
  const { client, calls, sleeps } = setup([{ status: 529, body: "" }]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.message, "jev http 529 after 3 attempts");
    assert.equal(e.cost, 0);
    return true;
  });
  assert.deepEqual(sleeps, [1000, 3000]);
  assert.equal(calls.length, 3);
});

test("401 is JevAuthError without retry", async () => {
  const { client, calls, sleeps } = setup([{ status: 401, body: "" }]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevAuthError);
    assert.equal(e.message, "invalid TYPESAFE_API_KEY");
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("422 body excerpt", async () => {
  const { client } = setup([{ status: 422, body: "bad\n\n  input " + "x".repeat(300) }]);
  await assert.rejects(client.ask({}, QUESTIONS), {
    message: "jev http 422: " + "bad input " + "x".repeat(190),
  });
});

test("other status", async () => {
  const { client, calls } = setup([{ status: 500, body: "boom" }]);
  await assert.rejects(client.ask({}, QUESTIONS), { message: "jev http 500" });
  assert.equal(calls.length, 1);
});

test("timeout", async () => {
  const { client } = setup([new DOMException("t", "TimeoutError")]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.message, "jev timeout after 10s");
    assert.equal(e.cost, 0);
    return true;
  });
});

test("network error", async () => {
  const { client } = setup([new TypeError("fetch failed")]);
  await assert.rejects(client.ask({}, QUESTIONS), { message: "jev network error: fetch failed" });
});

test("non-JSON body", async () => {
  const { client } = setup([{ status: 200, body: "<html>" }]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.message, "jev malformed response: not JSON");
    assert.equal(e.cost, 0);
    return true;
  });
});

test("unknown choice", async () => {
  const body = okBody({ answers: { action: { choice: "fly", confidence: 0.5 }, target: { choice: "e1", confidence: 0.5 } } });
  const { client } = setup([{ status: 200, body }]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.message, 'jev malformed response: bad choice for "action"');
    assert.equal(e.cost, COST);
    return true;
  });
});

test("confidence out of range", async () => {
  const body = okBody({ answers: { action: { choice: "click", confidence: 1.5 }, target: { choice: "e1", confidence: 0.5 } } });
  const { client } = setup([{ status: 200, body }]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.message, 'jev malformed response: bad confidence for "action"');
    assert.equal(e.cost, COST);
    return true;
  });
});

test("missing answer", async () => {
  const body = okBody({ answers: { action: { choice: "click", confidence: 0.5 } } });
  const { client } = setup([{ status: 200, body }]);
  await assert.rejects(client.ask({}, QUESTIONS), { message: 'jev malformed response: missing answer "target"' });
});

test("missing usage", async () => {
  const body = JSON.stringify({ answers: {} });
  const { client } = setup([{ status: 200, body }]);
  await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.message, "jev malformed response: bad usage");
    assert.equal(e.cost, 0);
    return true;
  });
});

test("abort before call", async () => {
  const ac = new AbortController();
  ac.abort();
  const { client, calls } = setup([{ status: 200, body: okBody() }], ac.signal);
  await assert.rejects(client.ask({}, QUESTIONS), AbortedError);
  assert.equal(calls.length, 0);
});

test("abort during retry sleep", async () => {
  const ac = new AbortController();
  const { client, calls } = setup([{ status: 429, body: "" }, { status: 200, body: okBody() }], ac.signal, () => ac.abort());
  await assert.rejects(client.ask({}, QUESTIONS), AbortedError);
  assert.equal(calls.length, 1);
});

test("abort during call", async () => {
  const ac = new AbortController();
  const transport: JevTransport = async (_u, init) => {
    ac.abort();
    throw init.signal.reason;
  };
  const client = new JevClient({ apiKey: "k", transport, sleep: async () => {}, signal: ac.signal });
  await assert.rejects(client.ask({}, QUESTIONS), AbortedError);
});
