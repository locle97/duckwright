import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTION_OPTIONS,
  ACTION_QUESTION,
  HybridBrain,
  MAX_TARGETS,
  JEV_URL,
  JevAuthError,
  JevClient,
  JevError,
  TARGET_QUESTION,
  currentFocus,
  currentTabUrl,
  extractTargets,
  targetCandidates,
  targetDescription,
} from "../src/jev.ts";
import type { JevAnswer, JevQuestion, JevTransport } from "../src/jev.ts";
import { BrainError } from "../src/brain.ts";
import type { Decision, StepInput } from "../src/brain.ts";
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

test("extractTargets adds the text of the enclosing item as context", () => {
  const snap = [
    "- list [ref=e1]:",
    "  - listitem [ref=e2]:",
    '    - link "Book A ..." [ref=e3] [cursor=pointer]:',
    "      - /url: a.html",
    "    - paragraph [ref=e4]: £56.88",
    "    - text: In stock",
    "  - listitem [ref=e5]:",
    '    - link "Book B ..." [ref=e6] [cursor=pointer]:',
    "    - paragraph [ref=e7]: £23.21",
    '- link "Home" [ref=e8] [cursor=pointer]',
  ].join("\n");
  assert.deepEqual(extractTargets(snap), [
    { ref: "e3", role: "link", name: "Book A ...", context: "£56.88 · In stock" },
    { ref: "e6", role: "link", name: "Book B ...", context: "£23.21" },
    { ref: "e8", role: "link", name: "Home" },
  ]);
});

test("extractTargets drops links to the current page", () => {
  const snap = [
    '- link "Travel" [ref=e1] [cursor=pointer]:',
    "  - /url: index.html",
    '- link "Mystery" [ref=e2] [cursor=pointer]:',
    "  - /url: ../mystery_3/index.html",
  ].join("\n");
  const url = "https://x.test/books/travel_2/index.html";
  assert.deepEqual(extractTargets(snap, url).map((t) => t.ref), ["e2"]);
  assert.deepEqual(extractTargets(snap).map((t) => t.ref), ["e1", "e2"]);
});

test("extractTargets drops an unnamed link that duplicates a named link's url", () => {
  const snap = [
    "- link [ref=e1] [cursor=pointer]:",
    "  - /url: a.html",
    '- link "Book A" [ref=e2] [cursor=pointer]:',
    "  - /url: a.html",
    "- link [ref=e3] [cursor=pointer]:",
    "  - /url: b.html",
  ].join("\n");
  assert.deepEqual(extractTargets(snap).map((t) => t.ref), ["e2", "e3"]);
});

test("currentTabUrl reads the current tab", () => {
  const tabs = "- 0: [Other](https://a.test/)\n- 1: (current) [T | S](https://b.test/p/index.html)";
  assert.equal(currentTabUrl(tabs), "https://b.test/p/index.html");
  assert.equal(currentTabUrl("tabs"), null);
});

test("targetDescription includes the item context", () => {
  assert.equal(
    targetDescription({ ref: "e3", role: "link", name: "Book A", context: "£5" }),
    'link "Book A" (£5)',
  );
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

test("negative usage", async () => {
  for (const usage of [{ input_tokens: -1, output_tokens: 5 }, { input_tokens: 5, output_tokens: -1 }]) {
    const { client } = setup([{ status: 200, body: okBody({ usage }) }]);
    await assert.rejects(client.ask({}, QUESTIONS), (e: unknown) => {
      assert.ok(e instanceof JevError);
      assert.equal(e.message, "jev malformed response: bad usage");
      assert.equal(e.cost, 0);
      return true;
    });
  }
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

// ---- HybridBrain ----

const claudeDec: Decision = { evaluationPreviousGoal: "e", memory: "cm", nextGoal: "cg", actions: [{ cmd: "snapshot", args: [] }] };
const SNAP = '- button "Submit" [ref=e12]\n- link "" [ref=e13] [cursor=pointer]';

function mkStep(over: Partial<StepInput["ctx"]> = {}, snapshot = SNAP): StepInput {
  return {
    obs: { tabs: "tabs", snapshot, truncated: false, lines: 2, chars: 10 },
    ctx: { step: 2, task: "T", memory: "M", historyLines: ["step 1 | …"], nudged: false, previousFailed: false, ...over },
  };
}

function fakes(answers?: Record<string, JevAnswer>, jevErr?: Error, claudeErr?: Error) {
  const asks: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
  const claudeCalls: [string, boolean | undefined][] = [];
  const jev = {
    async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<[Record<string, JevAnswer>, number]> {
      asks.push({ state, questions });
      if (jevErr) throw jevErr;
      return [answers!, 0.001];
    },
  };
  const claude = {
    async decide(prompt: string, grep?: boolean): Promise<[Decision, number]> {
      claudeCalls.push([prompt, grep]);
      if (claudeErr) throw claudeErr;
      return [{ ...claudeDec }, 0.5];
    },
  };
  return { jev, claude, asks, claudeCalls };
}

const ans = (a: string, ac: number, t = "e12", tc = 0.9): Record<string, JevAnswer> => ({
  action: { choice: a, confidence: ac },
  target: { choice: t, confidence: tc },
});

test("HybridBrain accepted click with target", async () => {
  const f = fakes(ans("click", 0.93, "e12", 0.88));
  const hb = new HybridBrain({ jev: f.jev, claude: f.claude });
  const [d, cost] = await hb.decide("P", true, mkStep());
  assert.equal(f.claudeCalls.length, 0);
  assert.deepEqual(d, {
    evaluationPreviousGoal: "",
    memory: "M",
    nextGoal: 'jev: click button "Submit" (0.88)',
    actions: [{ cmd: "click", args: ["e12"] }],
    source: "jev",
    jev: { action: "click", action_confidence: 0.93, target: "e12", target_confidence: 0.88, routed: "accepted" },
  });
  assert.equal(cost, 0.001);
  const q = f.asks[0];
  // No goal from Claude, so Jev gets the whole task.
  assert.deepEqual(q.state, { task: "T", memory: "M", history: ["step 1 | …"], tabs: "tabs", snapshot: SNAP });
  assert.equal(q.questions.action.question, `${ACTION_QUESTION}\n\nTask: T`);
  assert.equal(q.questions.action.type, "choice");
  assert.equal(q.questions.target.question, TARGET_QUESTION);
  assert.deepEqual(Object.keys(q.questions.action.criteria), [
    "click", "check", "uncheck", "hover", "press_enter", "press_tab", "press_escape", "go_back", "needs_text", "done",
  ]);
  assert.equal(
    q.questions.action.criteria.click,
    "Click one element on the page: a link, button, tab, menu item or option.",
  );
  assert.deepEqual(q.questions.target.criteria, { e12: 'button "Submit"', e13: "link (no name)" });
  assert.equal(Object.keys(ACTION_OPTIONS).length, 10);
});

test("HybridBrain accepted press_enter ignores low target", async () => {
  const f = fakes(ans("press_enter", 0.9, "e13", 0.1));
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep());
  assert.deepEqual(d.actions, [{ cmd: "press", args: ["Enter"] }]);
  assert.equal(d.nextGoal, "jev: press_enter (0.90)");
  assert.deepEqual(d.jev, { action: "press_enter", action_confidence: 0.9, target: "e13", target_confidence: 0.1, routed: "accepted" });
  assert.equal(d.source, "jev");
});

test("HybridBrain confidence equal to threshold is accepted", async () => {
  const f = fakes(ans("click", 0.8, "e12", 0.8));
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep());
  assert.equal(d.source, "jev");
});

test("HybridBrain low action confidence goes to claude", async () => {
  const f = fakes(ans("click", 0.79));
  const [d, cost] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", false, mkStep());
  assert.deepEqual(f.claudeCalls, [["P", false]]);
  assert.deepEqual(d, {
    ...claudeDec,
    source: "claude",
    jev: { action: "click", action_confidence: 0.79, target: "e12", target_confidence: 0.9, routed: "low_confidence" },
  });
  assert.equal(cost, 0.501);
});

test("HybridBrain low target confidence goes to claude", async () => {
  const f = fakes(ans("click", 0.95, "e12", 0.5));
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep());
  assert.equal(d.source, "claude");
  assert.equal(d.jev?.routed, "low_confidence");
});

for (const choice of ["needs_text", "done"]) {
  test(`HybridBrain ${choice} goes to claude`, async () => {
    const f = fakes(ans(choice, 0.99));
    const [d, cost] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep());
    assert.equal(f.claudeCalls.length, 1);
    assert.equal(d.source, "claude");
    assert.equal(d.jev?.routed, choice);
    assert.equal(cost, 0.501);
  });
}

const many = Array.from({ length: 256 }, (_, i) => `- button "B${i}" [ref=e${i + 1}]`).join("\n");
const skipCases: [string, StepInput | undefined][] = [
  ["step 1", mkStep({ step: 1 })],
  ["nudged", mkStep({ nudged: true })],
  ["previous failure", mkStep({ previousFailed: true })],
  ["no targets", mkStep({}, '- textbox "Q" [ref=e1]')],
  ["256 targets", mkStep({}, many)],
  ["missing step", undefined],
];
for (const [name, step] of skipCases) {
  test(`HybridBrain skips jev: ${name}`, async () => {
    const f = fakes(ans("click", 0.99));
    const [d, cost] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", false, step);
    assert.equal(f.asks.length, 0);
    assert.deepEqual(f.claudeCalls, [["P", false]]);
    assert.equal(d.source, "claude");
    assert.equal(d.jev, null);
    assert.equal(cost, 0.5);
  });
}

test("HybridBrain JevError falls back with its cost", async () => {
  const f = fakes(undefined, new JevError("jev http 500", 0.002));
  const [d, cost] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep());
  assert.deepEqual(d.jev, {
    action: null, action_confidence: null, target: null, target_confidence: null, routed: "error: jev http 500",
  });
  assert.equal(d.source, "claude");
  assert.equal(cost, 0.502);
});

test("HybridBrain claude BrainError after jev carries cost and record", async () => {
  const f = fakes(ans("click", 0.1), undefined, new BrainError("boom", 0.5));
  await assert.rejects(
    new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep()),
    (e: unknown) => {
      assert.ok(e instanceof BrainError);
      assert.equal(e.cost, 0.501);
      assert.equal(e.jev?.routed, "low_confidence");
      return true;
    },
  );
});

test("HybridBrain propagates JevAuthError and AbortedError", async () => {
  for (const err of [new JevAuthError(), new AbortedError()]) {
    const f = fakes(undefined, err);
    await assert.rejects(
      new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep()),
      (e: unknown) => e instanceof err.constructor,
    );
    assert.equal(f.claudeCalls.length, 0);
  }
});

test("HybridBrain custom threshold", async () => {
  const f = fakes(ans("click", 0.93));
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude, minConfidence: 0.95 }).decide("P", true, mkStep());
  assert.equal(d.jev?.routed, "low_confidence");
});

// ---- Candidates and focus ----

const DUP_SNAP = [
  '- link "Home" [ref=e1] [cursor=pointer]:',
  "  - /url: /",
  '- link "humor" [ref=e2] [cursor=pointer]:',
  "  - /url: /tag/humor/",
  '- link "humor" [ref=e3] [cursor=pointer]:',
  "  - /url: /tag/humor/",
  '- link "humor" [ref=e4] [cursor=pointer]:',
  "  - /url: /tag/other/",
  '- button "Add" [ref=e5]',
  '- button "Add" [ref=e6]',
  '- link "Next" [ref=e7] [cursor=pointer]:',
  "  - /url: /page/2/",
].join("\n");

test("targetCandidates merges links to the same place and shows where links lead", () => {
  assert.deepEqual(
    targetCandidates(DUP_SNAP, "https://x.test/").map((c) => [c.target.ref, c.description]),
    [
      ["e2", 'link "humor" -> /tag/humor/'],
      ["e4", 'link "humor" -> /tag/other/'],
      ["e5", 'button "Add"'],
      ["e6", 'button "Add"'],
      ["e7", 'link "Next" -> /page/2/'],
    ],
  );
  // extractTargets itself is unchanged: every ref, no urls.
  assert.deepEqual(extractTargets(DUP_SNAP, "https://x.test/").map((t) => t.ref), ["e2", "e3", "e4", "e5", "e6", "e7"]);
});

test("targetCandidates shortens long urls", () => {
  const snap = `- link "L" [ref=e1] [cursor=pointer]:\n  - /url: /${"a".repeat(200)}`;
  const [c] = targetCandidates(snap);
  assert.ok(c.description.endsWith("…"));
  assert.equal(c.description.length, 'link "L" -> '.length + 80);
});

test("currentFocus is Claude's goal plus the progress notes, and null without a goal", () => {
  assert.equal(currentFocus({ memory: " M ", goal: " G " }), "G\nM");
  assert.equal(currentFocus({ memory: "", goal: "G" }), "G");
  // No goal (the previous step was Jev's): the notes may be stale too, so the whole task is used.
  assert.equal(currentFocus({ memory: "M" }), null);
  assert.equal(currentFocus({ memory: "M", goal: "  " }), null);
});

test("HybridBrain asks about the current goal and merged candidates", async () => {
  const f = fakes(ans("click", 0.9, "e2", 0.9));
  const step = mkStep({ goal: "Click the humor tag." }, DUP_SNAP);
  step.obs.tabs = "- 0: (current) [X](https://x.test/)";
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, step);
  const q = f.asks[0];
  assert.equal((q.state as { task: string }).task, "Click the humor tag.\nM");
  // The whole task still frames the action question.
  assert.equal(q.questions.action.question, `${ACTION_QUESTION}\n\nTask: T`);
  assert.deepEqual(Object.keys(q.questions.target.criteria), ["e2", "e4", "e5", "e6", "e7"]);
  assert.deepEqual(d.actions, [{ cmd: "click", args: ["e2"] }]);
  assert.equal(d.nextGoal, 'jev: click link "humor" (0.90)');
});

test("HybridBrain falls back to the whole task when there is no goal", async () => {
  const f = fakes(ans("click", 0.9));
  await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep({ memory: "M" }));
  assert.equal((f.asks[0].state as { task: string }).task, "T");
});

test("HybridBrain counts the target limit after merging same-destination links", async () => {
  const snap = Array.from({ length: MAX_TARGETS + 1 }, (_, i) =>
    `- link "Tag" [ref=e${i + 1}] [cursor=pointer]:\n  - /url: /tag/`).join("\n");
  const f = fakes(ans("click", 0.9, "e1", 0.9));
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep({}, snap));
  assert.equal(f.asks.length, 1);
  assert.equal(d.source, "jev");
});

test("HybridBrain sends a target outside the list to claude", async () => {
  const f = fakes(ans("click", 0.99, "e99", 0.99));
  const [d] = await new HybridBrain({ jev: f.jev, claude: f.claude }).decide("P", true, mkStep());
  assert.equal(d.source, "claude");
  assert.equal(d.jev?.routed, "low_confidence");
});
