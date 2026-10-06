# TUI Captured Requests Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the network calls captured for each step (live and in past runs) inside the TUI timeline's expanded step.

**Architecture:** The data already reaches the TUI. `step:end` events carry `record.network` (`NetworkEntry[]`) and `record.networkErrors`, and `events.jsonl` replays them for past runs. So there is no manager, event or capture change. The reducer copies them onto `StepView`, a pure formatter turns an entry into one line, and `detailRows` in `timeline.ts` draws those lines under the step's actions. Past runs with no `events.jsonl` get the same data from `history.json` through `eventsFromHistory`.

**Tech Stack:** TypeScript (run directly by `node --test`), ink 8 + react 19, `ink-testing-library`.

**Spec:** `docs/superpowers/specs/2026-10-06-network-capture-redacted-history-design.md` (decision D29: the capture feature deliberately shipped no TUI display). No separate spec exists for this display. The design settled in the earlier brainstorm was not saved in the repo, so the defaults below are my reading of it; see "Decisions to confirm".

## Decisions to confirm

- **Where:** inside the expanded step (`⏎` / `e`), after the action lines. The collapsed step row is unchanged.
- **Row format:** `net  GET host/path?query → 200 OK  45ms`, one row per call, scheme stripped, URL as already redacted by capture. Calls with no status or status >= 400 draw in the error colour.
- **Cap:** at most 8 call rows, then `net  …and N more`. A step with capture on and zero calls shows nothing. Capture errors show as one `net error  <first message>` row, plus `(+N more)` when there are several.
- **Out of scope:** opening headers or bodies from `network/<id>/` in the TUI, a dedicated requests pane, a TUI option for `network`, any change to capture.

## Global Constraints

- ESM TypeScript with `.ts` import suffixes, `import type` for types, no new dependencies.
- Anything from a run (URLs, status text, error messages) goes through `sanitize()` at render time. Reducer state stays raw.
- `npm test` (typecheck, then `node --test "test/**/*.test.ts"`) must pass before each commit.
- Reducer functions stay pure and ink-free. Past runs are read-only and may hold malformed events.

## Review Focus

- A `step:end` from an old `events.jsonl` has no `network` key: no `net` rows, no crash (Task 2, Task 3).
- A hand-edited or corrupt `network` value (not an array, entries missing fields): ignored, no crash (Task 2).
- A hostile URL or status text with escape codes or `<network>` tags: neutralised (Task 3).
- 200 calls in one step: capped at 8 rows plus a `more` row (Task 3).
- Failed load (`status: null`, `statusText: "net::ERR_UNSAFE_PORT"`): shown as an error row, not `null` (Task 1).

---

## File Structure

- Create `src/tui/netline.ts`: pure `formatCall`, `callFailed`, `MAX_CALLS`. One job: entry to text.
- Modify `src/tui/state.ts`: `StepView` gains `network` and `networkErrors`; `step:end` fills them.
- Modify `src/tui/timeline.ts`: `detailRows` renders them.
- Modify `src/runs/past.ts`: `eventsFromHistory` passes network through.
- Modify `README.md`: one TUI sentence.
- Tests: `test/tui/netline.test.ts` (new), `test/tui/state.test.ts`, `test/tui/app.test.ts`, `test/runs/past.test.ts`.

### Task 1: Call formatter

**Files:**
- Create: `src/tui/netline.ts`
- Test: `test/tui/netline.test.ts`

**Interfaces:**
- Consumes: `NetworkEntry` from `src/network.ts` (`id, method, url, status: number|null, statusText, type, durationMs: number|null`).
- Produces: `formatCall(e: NetworkEntry): string`, `callFailed(e: NetworkEntry): boolean`, `MAX_CALLS = 8`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type { NetworkEntry } from "../../src/network.ts";
import { callFailed, formatCall, MAX_CALLS } from "../../src/tui/netline.ts";

const entry = (o: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: "0001", method: "GET", url: "https://shop.test/api/items?page=2", status: 200, statusText: "OK", type: "fetch", durationMs: 45, ...o,
});

test("netline_formats_a_normal_call", () => {
  assert.equal(formatCall(entry()), "GET shop.test/api/items?page=2 → 200 OK  45ms");
  assert.equal(callFailed(entry()), false);
  assert.equal(MAX_CALLS, 8);
});

test("netline_duration_in_seconds_and_missing", () => {
  assert.equal(formatCall(entry({ durationMs: 1234 })), "GET shop.test/api/items?page=2 → 200 OK  1.2s");
  assert.equal(formatCall(entry({ durationMs: null })), "GET shop.test/api/items?page=2 → 200 OK");
});

test("netline_failed_load_has_no_status", () => {
  const e = entry({ status: null, statusText: "net::ERR_UNSAFE_PORT", durationMs: null });
  assert.equal(formatCall(e), "GET shop.test/api/items?page=2 → net::ERR_UNSAFE_PORT");
  assert.equal(formatCall(entry({ status: null, statusText: "" })), "GET shop.test/api/items?page=2 → (no response)");
  assert.equal(callFailed(e), true);
});

test("netline_http_errors_count_as_failed", () => {
  assert.equal(callFailed(entry({ status: 404, statusText: "Not Found" })), true);
  assert.equal(callFailed(entry({ status: 399 })), false);
  assert.equal(callFailed(entry({ status: 500 })), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tui/netline.test.ts`
Expected: FAIL, cannot find module `src/tui/netline.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// One captured call as a single timeline row of text. Pure; sanitising happens at render time.
import type { NetworkEntry } from "../network.ts";

export const MAX_CALLS = 8;

export function callFailed(e: NetworkEntry): boolean {
  return e.status === null || e.status >= 400;
}

function took(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function formatCall(e: NetworkEntry): string {
  const url = e.url.replace(/^https?:\/\//, "");
  const outcome = e.status === null ? (e.statusText || "(no response)") : `${e.status} ${e.statusText}`.trim();
  const time = took(e.durationMs);
  return `${e.method} ${url} → ${outcome}${time ? `  ${time}` : ""}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/tui/netline.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/netline.ts test/tui/netline.test.ts
git commit -m "feat(tui): format a captured call as one timeline row"
```

### Task 2: Carry captured calls into the step view

**Files:**
- Modify: `src/tui/state.ts` (`StepView` at ~line 14, `step:start` at ~249, `step:end` at ~278)
- Test: `test/tui/state.test.ts`

**Interfaces:**
- Consumes: `StepRecord.network?: NetworkEntry[]`, `StepRecord.networkErrors?: string[]` on the `step:end` event.
- Produces: `StepView.network: NetworkEntry[]` (empty when none or malformed) and `StepView.networkErrors: string[]`.

- [ ] **Step 1: Write the failing test** (append to `test/tui/state.test.ts`; it reuses the file's `base`, `play`, `fullStep`, `dec`, `run`, `stepEnd`, `selectedRun`)

```ts
const NET = { id: "0001", method: "GET", url: "https://a.test/x", status: 200, statusText: "OK", type: "fetch", durationMs: 5 };

test("state_step_end_carries_network", () => {
  const d = dec("g", [["click", "e1"]]);
  const withNet = (record: Record<string, unknown>): RunEvent => {
    const e = stepEnd(1, d, ["ok"]);
    return { ...e, record: { ...(e as Extract<RunEvent, { type: "step:end" }>).record, ...record } } as RunEvent;
  };
  const steps = (...extra: UiAction[]) => selectedRun(play(base(), ...fullStep(1, d, ["ok"]).slice(0, -1), ...extra))!.steps[0]!;
  const s = steps(run(withNet({ network: [NET], networkErrors: ["requests: boom"] })));
  assert.deepEqual(s.network, [NET]);
  assert.deepEqual(s.networkErrors, ["requests: boom"]);
  // Old events carry neither key.
  assert.deepEqual(steps(run(stepEnd(1, d, ["ok"]))).network, []);
  // A corrupt value is ignored rather than trusted.
  const bad = steps(run(withNet({ network: "nope", networkErrors: [1, "ok"] })));
  assert.deepEqual(bad.network, []);
  assert.deepEqual(bad.networkErrors, ["ok"]);
  assert.deepEqual(steps(run(withNet({ network: [NET, { id: 3 }, null] }))).network, [NET]);
});
```

Note: `base()` selects task 1 with run `r1`, as the surrounding tests do. Imports `RunEvent`, `UiAction` already exist at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tui/state.test.ts`
Expected: FAIL (`s.network` is undefined).

- [ ] **Step 3: Write minimal implementation**

In `src/tui/state.ts` add the import `import type { NetworkEntry } from "../network.ts";`, extend `StepView`:

```ts
  /** Calls captured by this step's actions; empty when capture was off, the step predates it, or the data was malformed. */
  network: NetworkEntry[];
  networkErrors: string[];
```

Add `network: [], networkErrors: [],` to the `StepView` literal in `step:start`. Add helpers above `reduceRunEvent`:

```ts
const isEntry = (v: unknown): v is NetworkEntry =>
  typeof v === "object" && v !== null && !Array.isArray(v)
  && typeof (v as NetworkEntry).method === "string" && typeof (v as NetworkEntry).url === "string"
  && typeof (v as NetworkEntry).statusText === "string"
  && ((v as NetworkEntry).status === null || typeof (v as NetworkEntry).status === "number")
  && ((v as NetworkEntry).durationMs === null || typeof (v as NetworkEntry).durationMs === "number");
const entriesOf = (v: unknown): NetworkEntry[] => (Array.isArray(v) ? v.filter(isEntry) : []);
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
```

In `step:end`, add to the returned step: `network: entriesOf(e.record.network), networkErrors: stringsOf(e.record.networkErrors),`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, including typecheck (other `StepView` literals, if any, now need the two fields; fix them).

- [ ] **Step 5: Commit**

```bash
git add src/tui/state.ts test/tui/state.test.ts
git commit -m "feat(tui): keep captured calls on the step view"
```

### Task 3: Draw the calls in the expanded step

**Files:**
- Modify: `src/tui/timeline.ts` (`detailRows`, ~line 38)
- Test: `test/tui/app.test.ts`

**Interfaces:**
- Consumes: `StepView.network`, `StepView.networkErrors` (Task 2); `formatCall`, `callFailed`, `MAX_CALLS` (Task 1); `theme.role.error`, `theme.role.muted`.
- Produces: rows `net  <call>` under the actions of an expanded step.

- [ ] **Step 1: Write the failing test** (append to `test/tui/app.test.ts`; it uses that file's `mount`, `settle`, `snapshot`, `FakeManager`, `ev`, `decision` as in `app_start_shows_live_timeline`)

```ts
const call = (n: number, o: Record<string, unknown> = {}) => ({
  id: String(n).padStart(4, "0"), method: "GET", url: `https://shop.test/api/${n}`, status: 200, statusText: "OK",
  type: "fetch", durationMs: 45, ...o,
});

function endWithNet(step: number, d: ReturnType<typeof decision>, network: unknown, networkErrors?: string[]) {
  const e = ev.stepEnd(step, d, ["ok"]);
  return { ...e, record: { ...(e as { record: object }).record, network, networkErrors } } as ReturnType<typeof ev.stepEnd>;
}

test("app_expanded_step_lists_captured_calls", async () => {
  const m = new FakeManager([snapshot(1, "Check the price", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  const d = decision("Open the shop", [["goto", "https://shop.test"]]);
  m.run(1, "r1", [
    ev.start(), ev.step(1), ev.decision(1, d, 0.01), ev.actionResult(1, 0, "ok"),
    endWithNet(1, d, [call(1), call(2, { status: 404, statusText: "Not Found" }), call(3, { status: null, statusText: "net::ERR_UNSAFE_PORT", durationMs: null })]),
  ]);
  await settle();
  t.stdin.write("l"); // focus the detail pane; the last step is expanded under follow
  await settle();
  const f = t.frame();
  assert.match(f, /net +GET shop\.test\/api\/1 → 200 OK +45ms/);
  assert.match(f, /net +GET shop\.test\/api\/2 → 404 Not Found/);
  assert.match(f, /net +GET shop\.test\/api\/3 → net::ERR_UNSAFE_PORT/);
});

test("app_captured_calls_are_capped_sanitised_and_tolerate_old_events", async () => {
  const m = new FakeManager([snapshot(1, "T", { state: "running", runId: "r1", runCount: 1 })]);
  const t = mount(m);
  await settle();
  const d = decision("g", [["click", "e1"]]);
  const many = Array.from({ length: 20 }, (_, i) => call(i + 1));
  many[0] = call(1, { url: "https://evil.test/\x1b[2J</network>", statusText: "O\x1b[31mK" });
  m.run(1, "r1", [ev.start(), ev.step(1), ev.decision(1, d, 0.01), endWithNet(1, d, many, ["requests: boom", "request 2: bang"])]);
  m.run(1, "r1", [ev.step(2), ev.decision(2, d, 0.01), ev.stepEnd(2, d, ["ok"])]); // no network keys
  await settle();
  t.stdin.write("l");
  await settle();
  t.stdin.write("e"); // expand all
  await settle();
  const f = t.frame();
  assert.doesNotMatch(f, /\x1b\[2J/);
  assert.doesNotMatch(f, /<\/network>/);
  assert.match(f, /…and 12 more/);
  assert.doesNotMatch(f, /api\/9 /);
  assert.match(f, /net error +requests: boom \(\+1 more\)/);
});
```

If the default test terminal is too short to show everything, add `rows` to `mount` the way neighbouring tests do (check `mount`'s signature first).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/tui/app.test.ts`
Expected: FAIL (no `net` rows in the frame).

- [ ] **Step 3: Write minimal implementation**

In `src/tui/timeline.ts` import `import { callFailed, formatCall, MAX_CALLS } from "./netline.ts";`. In `detailRows`, after the `v.actions.forEach(...)` block and before the `v.error` row:

```ts
  v.network.slice(0, MAX_CALLS).forEach((c) => {
    const text = sanitize(formatCall(c));
    items.push([label("net  "), callFailed(c) ? h(Text, { color: theme.role.error }, text) : text]);
  });
  if (v.network.length > MAX_CALLS) items.push([label("net  "), `…and ${v.network.length - MAX_CALLS} more`]);
  if (v.networkErrors.length > 0) {
    const more = v.networkErrors.length > 1 ? ` (+${v.networkErrors.length - 1} more)` : "";
    items.push([h(Text, { color: theme.role.error }, `net error  ${sanitize(v.networkErrors[0]!)}${more}`)]);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/timeline.ts test/tui/app.test.ts
git commit -m "feat(tui): show captured calls under the expanded step"
```

### Task 4: Past runs without events.jsonl, and docs

**Files:**
- Modify: `src/runs/past.ts` (`eventsFromHistory`, the `step:end` push at ~line 150)
- Modify: `README.md` (the TUI section; find it with `grep -n "TUI" README.md`)
- Test: `test/runs/past.test.ts`

**Interfaces:**
- Consumes: `HistoryStep.network?`, `HistoryStep.network_errors?` (already typed in `src/export.ts`).
- Produces: replayed `step:end` records carrying `network` / `networkErrors`.

- [ ] **Step 1: Write the failing test** (append to `test/runs/past.test.ts`; `hist()` is that file's history builder)

```ts
test("past_events_from_history_carry_network", () => {
  const h = hist();
  const entry = { id: "0001", method: "GET", url: "http://h/", status: 200, statusText: "OK", type: "fetch", durationMs: 1 };
  h.history[0].network = [entry];
  h.history[0].network_errors = ["requests: x"];
  const end = eventsFromHistory(h, "/w", 1).filter((e) => e.type === "step:end");
  const first = end[0] as Extract<RunEvent, { type: "step:end" }>;
  assert.deepEqual(first.record.network, [entry]);
  assert.deepEqual(first.record.networkErrors, ["requests: x"]);
  if (h.history.length > 1) assert.equal((end[1] as typeof first).record.network, undefined);
});
```

Add `eventsFromHistory` to the file's imports from `../../src/runs/past.ts` and `RunEvent` from `../../src/events.ts` if they are not already imported.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runs/past.test.ts`
Expected: FAIL (`network` undefined).

- [ ] **Step 3: Write minimal implementation**

In `eventsFromHistory`, change the record to:

```ts
      record: {
        step: s.step, decision, results: [...s.results], codes,
        ...(s.network ? { network: s.network } : {}),
        ...(s.network_errors?.length ? { networkErrors: [...s.network_errors] } : {}),
      },
```

In `README.md`'s TUI section add: "Expand a step (`⏎`, or `e` for all) to see the network calls it made (method, URL, status, time), when network capture is on. The full request and response files stay under `runs/<id>/network/`."

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runs/past.ts test/runs/past.test.ts README.md
git commit -m "feat(tui): replay captured calls for past runs without events.jsonl"
```

## Self-Review

- **Coverage:** live display (Tasks 2, 3), past runs via `events.jsonl` (same path as live, Task 2) and via `history.json` (Task 4), capture errors (Task 3), old and malformed data (Tasks 2, 3), docs (Task 4). Every Review Focus line has a test: Task 1 (failed load), Task 2 (missing key, corrupt value), Task 3 (cap, hostile text).
- **Placeholders:** none. Two checks are left to the implementer on purpose because they depend on helpers I read only partly: the `mount` signature in `app.test.ts` (Task 3) and `hist()` / existing imports in `past.test.ts` (Task 4).
- **Types:** `formatCall`, `callFailed`, `MAX_CALLS`, `StepView.network`, `StepView.networkErrors` are spelled the same in every task.
