# API Test Export (`export --api`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `duckwright export --api runs/<id>` writes a `@playwright/test` spec that replays the run's captured API calls with the `request` fixture and asserts each call's status, so the backend flow can be tested without the UI.

**Architecture:** A new module `src/exportApi.ts` turns `history.json` network entries plus the per-call files under `network/<id>/` into a spec string (`renderApiSpec`). `args.ts` gains an `--api` flag on the `export` subcommand, and `exportRun` in `export.ts` picks the renderer and the default output name. The UI export path is untouched.

**Tech Stack:** TypeScript on Node >=22.18 (standard library only), `node:test`.

**Spec:** No standalone spec. Requirement: `README.md` Roadmap, "API test export" item (line 414). Builds on the network capture design (`docs/superpowers/specs/2026-10-06-network-capture-redacted-history-design.md`: folder layout, redaction) and `docs/superpowers/plans/2026-10-06-api-assertions.md`. The decisions below fix what the roadmap line leaves open.

## Decisions

| # | Decision |
|---|---|
| A1 | **Which calls:** history entries whose `type` is `fetch` or `xhr` and whose `status` is not null, in capture order. Documents, scripts, images, and failed (status null) calls are dropped; failed ones add a warning. |
| A2 | **Shape:** one `test("<task> (API)", async ({ request }) => {...})`. Each call is `const resN = await request.fetch(<url>, { method, headers?, data? });` then `expect(resN.status()).toBe(<status>);`. `N` counts emitted calls from 1. |
| A3 | **URL:** the captured (already redacted) absolute URL, unchanged. If it contains `[REDACTED]`, add a warning. |
| A4 | **Headers:** only `content-type` and `accept` from `network/<id>/request.json`. All others (cookies, auth) are left out; if any captured header value was `[REDACTED]`, add a warning saying to supply auth by hand. |
| A5 | **Body:** from `network/<id>/request-body.txt` when present. A JSON content type whose body parses becomes `data: <JSON>`; anything else becomes `data: "<text>"`. A body containing `[REDACTED]` adds a warning. |
| A6 | **No response-body assertions.** Status only. |
| A7 | **Output:** default `<run>/duckwright.api.spec.ts` (`-o` overrides). Same refusals as the UI export: run not successful → exit 1; refusing to overwrite `history.json` → exit 2. No usable calls → exit 1 with `nothing to export: no API calls were captured (was the run made with --no-network?)`. |
| A8 | **`--export` on a run is unchanged** (UI spec only). `--api` exists only on the `export` subcommand. |
| A9 | **Session state:** the `request` fixture honors `test.use({ storageState })`, so the header comment tells the user to add it for `--state` runs; no code is generated for it. |

## Global Constraints

- Node standard library only; no new dependencies.
- Relative imports use the `.ts` extension; tests use `node:test` + `node:assert/strict`.
- `npm test` runs `npm run typecheck` first and must pass in full before each commit.
- Strings embedded in generated code go through `JSON.stringify`, so a URL, header or body can never break out of the string literal.
- Exit codes match the existing export: `0` written, `1` refused, `2` bad path or history.

## Review Focus

1. A call whose body, URL or header contains quotes, backticks, `${}` or newlines: the generated spec is still valid TypeScript. (Task 2)
2. A run captured with `--no-network` (no `network` keys, no `network/` folder): exit 1 with the "no API calls" message, no crash. (Tasks 2, 3)
3. A captured call whose `request.json` or `request-body.txt` is missing or unreadable: the call is still exported without headers or body, plus a warning, no crash. (Task 2)
4. A secret-looking header or body value: never written as a real secret; the spec carries `[REDACTED]` only and warns. (Task 2)
5. `export --api` on a failed run, or with `-o` pointing at `history.json`: refused like the UI export. (Task 3)

---

### Task 1: `--api` flag for `export`

**Files:**
- Modify: `src/args.ts` (`ExportArgs`, `EXPORT_USAGE`, `EXPORT_HELP`, `EXPORT_SPEC`, `parseExportArgs`)
- Test: `test/args.test.ts`

**Interfaces:**
- Consumes: existing `parseExportArgs(argv): Parsed<ExportArgs>`.
- Produces: `ExportArgs = { run: string; output: string | null; api: boolean }`. Later tasks read `args.api`.

- [ ] **Step 1: Write the failing tests**

Append to `test/args.test.ts` (look at how existing `parseExportArgs` tests import and assert, and match):

```ts
test("export_api_flag", () => {
  const p = parseExportArgs(["--api", "runs/a"]);
  assert.deepEqual(p, { kind: "args", args: { run: "runs/a", output: null, api: true } });
});

test("export_api_defaults_false", () => {
  const p = parseExportArgs(["runs/a", "-o", "x.ts"]);
  assert.deepEqual(p, { kind: "args", args: { run: "runs/a", output: "x.ts", api: false } });
});

test("export_api_flag_after_run", () => {
  const p = parseExportArgs(["runs/a", "--api"]);
  assert.equal(p.kind === "args" && p.args.api, true);
});

test("export_help_mentions_api", () => {
  const p = parseExportArgs(["-h"]);
  assert.equal(p.kind, "help");
  assert.match(p.kind === "help" ? p.text : "", /--api/);
});
```

Also update any existing `parseExportArgs` assertion that deep-equals `{ run, output }` to include `api: false`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/args.test.ts`
Expected: FAIL (`api` missing / unknown option `--api`).

- [ ] **Step 3: Implement**

In `src/args.ts`:

```ts
export interface ExportArgs {
  run: string;
  output: string | null;
  api: boolean;
}

export const EXPORT_USAGE = "usage: duckwright export [-h] [--api] [-o FILE] run";
```

In `EXPORT_HELP`, change the first line after the usage to keep "Write a @playwright/test spec from a successful run's history.json", and in `options:` add before `-o`:

```
  --api                 write an API spec (request fixture) from the run's
                        captured network calls instead of the UI spec
```

and change the `-o` default text to `spec path (default: <run>/${SPEC_NAME}, or <run>/${API_SPEC_NAME} with --api)`. Import `API_SPEC_NAME` from `./export.ts` (defined in Task 3; for this task define it first as `export const API_SPEC_NAME = "duckwright.api.spec.ts";` next to `SPEC_NAME` in `src/export.ts`).

Add `"--api": "--api"` to `EXPORT_SPEC.names` (view the object; it sits near line 190). In `parseExportArgs` add `let api = false;`, handle `else if (opt.name === "--api") api = true;` before the `-o` branch, and return `{ run: run!, output, api }`.

- [ ] **Step 4: Update existing CLI usage assertions**

`test/cli.test.ts:318` asserts the old usage string. Change it to `"usage: duckwright export [-h] [--api] [-o FILE] run"`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/args.ts src/export.ts test/args.test.ts test/cli.test.ts
git commit -m "feat(export): parse --api flag"
```

---

### Task 2: `renderApiSpec`

**Files:**
- Create: `src/exportApi.ts`
- Test: `test/exportApi.test.ts`

**Interfaces:**
- Consumes: `HistoryData`, `ExportError` from `src/export.ts`; `NetworkEntry`, `networkDir`, `Header` from `src/network.ts`; `REDACTED` from `src/redact.ts`.
- Produces: `renderApiSpec(data: HistoryData, runDir: string): { spec: string; warnings: string[] }` and `API_HEADER`. Throws `ExportError` (exit 1) when the run failed or no calls qualify.

`export.ts` will import this module in Task 3 while this module imports `ExportError` from `export.ts`; the cycle is safe because both are used only inside functions, never at module load.

- [ ] **Step 1: Write the failing tests**

Create `test/exportApi.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ExportError } from "../src/export.ts";
import type { HistoryData } from "../src/export.ts";
import { API_HEADER, renderApiSpec } from "../src/exportApi.ts";
import { tmpDir } from "./helpers.ts";

type Entry = { id: string; method: string; url: string; status: number | null; statusText: string; type: string | null; durationMs: number | null };
const entry = (id: string, method: string, url: string, status: number | null, type: string | null = "fetch"): Entry =>
  ({ id, method, url, status, statusText: "", type, durationMs: 1 });

function run(entries: Entry[][], success = true, task = "login"): HistoryData {
  const history = entries.map((network, i) => ({
    step: i + 1, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [], network,
  }));
  return { task, task_file: null, success, answer: "", steps: history.length, cost_usd: 0, history } as unknown as HistoryData;
}

function capture(runDir: string, id: string, headers: { name: string; value: string }[], body?: string): void {
  const dir = path.join(runDir, "network", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ id, step: 1, method: "X", url: "u", headers }));
  if (body !== undefined) fs.writeFileSync(path.join(dir, "request-body.txt"), body);
}

const refused = (re: RegExp) => (e: unknown) => e instanceof ExportError && e.exitCode === 1 && re.test(e.message);

test("renders_exact_api_spec", () => {
  const tmp = tmpDir();
  capture(tmp, "0001", [{ name: "content-type", value: "application/json" }, { name: "x-trace", value: "t" }], '{"user":"a"}');
  capture(tmp, "0002", [{ name: "accept", value: "*/*" }]);
  const { spec, warnings } = renderApiSpec(run([
    [entry("0001", "POST", "http://app.test/api/login", 201), entry("0003", "GET", "http://app.test/app.js", 200, "script")],
    [entry("0002", "GET", "http://app.test/api/me", 200, "xhr")],
  ]), tmp);
  assert.equal(spec, API_HEADER + "\n" + 'test("login (API)", async ({ request }) => {\n'
    + '  const res1 = await request.fetch("http://app.test/api/login", {\n'
    + '    method: "POST",\n'
    + '    headers: {"content-type":"application/json"},\n'
    + '    data: {"user":"a"},\n'
    + "  });\n"
    + "  expect(res1.status()).toBe(201);\n"
    + '  const res2 = await request.fetch("http://app.test/api/me", {\n'
    + '    method: "GET",\n'
    + '    headers: {"accept":"*/*"},\n'
    + "  });\n"
    + "  expect(res2.status()).toBe(200);\n"
    + "});\n");
  assert.deepEqual(warnings, []);
});

test("failed_run_refused", () => {
  assert.throws(() => renderApiSpec(run([[entry("0001", "GET", "http://a/b", 200)]], false), tmpDir()), refused(/did not succeed/));
});

test("no_network_keys_refused", () => {
  const data = run([]);
  data.history = [{ step: 1, evaluation_previous_goal: "", memory: "", next_goal: "", actions: [], results: [] }];
  assert.throws(() => renderApiSpec(data, tmpDir()), refused(/no API calls were captured/));
});

test("only_non_api_calls_refused", () => {
  assert.throws(
    () => renderApiSpec(run([[entry("0001", "GET", "http://a/x.png", 200, "image")]]), tmpDir()),
    refused(/no API calls were captured/),
  );
});

test("failed_call_dropped_with_warning", () => {
  const tmp = tmpDir();
  const { spec, warnings } = renderApiSpec(run([[
    entry("0001", "GET", "http://a/dead", null), entry("0002", "GET", "http://a/ok", 200),
  ]]), tmp);
  assert.doesNotMatch(spec, /dead/);
  assert.match(spec, /http:\/\/a\/ok/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /0001.*failed/);
});

test("hostile_strings_stay_inside_literals", () => {
  const tmp = tmpDir();
  const url = 'http://a/p?q=`${process.exit()}`"\\n';
  capture(tmp, "0001", [{ name: "content-type", value: "text/plain" }], 'a"\n`${x}`');
  const { spec } = renderApiSpec(run([[entry("0001", "POST", url, 200)]]), tmp);
  assert.ok(spec.includes(`request.fetch(${JSON.stringify(url)}, {`));
  assert.ok(spec.includes(`data: ${JSON.stringify('a"\n`${x}`')},`));
  assert.equal(spec.split("\n").filter((l) => l.includes("process.exit")).length, 1);
});

test("missing_capture_files_exports_bare_call_with_warning", () => {
  const tmp = tmpDir();
  const { spec, warnings } = renderApiSpec(run([[entry("0001", "GET", "http://a/x", 200)]]), tmp);
  assert.ok(spec.includes('method: "GET",\n  });'));
  assert.doesNotMatch(spec, /headers:|data:/);
  assert.match(warnings.join("\n"), /0001.*request\.json/);
});

test("invalid_json_body_falls_back_to_string", () => {
  const tmp = tmpDir();
  capture(tmp, "0001", [{ name: "content-type", value: "application/json" }], "{not json");
  const { spec } = renderApiSpec(run([[entry("0001", "POST", "http://a/x", 200)]]), tmp);
  assert.ok(spec.includes('data: "{not json",'));
});

test("redactions_warn_and_never_leak", () => {
  const tmp = tmpDir();
  capture(tmp, "0001", [{ name: "authorization", value: "[REDACTED]" }, { name: "content-type", value: "application/json" }], '{"password":"[REDACTED]"}');
  const { spec, warnings } = renderApiSpec(run([[entry("0001", "POST", "http://a/x?token=[REDACTED]", 200)]]), tmp);
  assert.doesNotMatch(spec, /authorization/i);
  assert.match(warnings.join("\n"), /auth/i);
  assert.match(warnings.join("\n"), /body.*\[REDACTED\]/);
  assert.match(warnings.join("\n"), /url.*\[REDACTED\]/i);
});
```

(`tmpDir` is the helper `test/export.test.ts` imports from `./helpers.ts`; if it needs a cleanup argument or returns something else, adapt to its real signature.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/exportApi.test.ts`
Expected: FAIL, module `../src/exportApi.ts` not found.

- [ ] **Step 3: Implement**

Create `src/exportApi.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

import { ExportError } from "./export.ts";
import type { HistoryData } from "./export.ts";
import { networkDir } from "./network.ts";
import type { Header, NetworkEntry } from "./network.ts";
import { REDACTED } from "./redact.ts";

export const API_HEADER = "// Generated by duckwright from history.json and network/. Review before committing:\n"
  + "// captured URLs, headers and bodies are redacted, so secrets appear as [REDACTED].\n"
  + "// For a run that used --state, add test.use({ storageState: 'auth.json' }) to send its cookies.\n"
  + "import { test, expect } from '@playwright/test';\n";

const API_TYPES: ReadonlySet<string> = new Set(["fetch", "xhr"]);
const KEEP_HEADERS: ReadonlySet<string> = new Set(["content-type", "accept"]);

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readHeaders(file: string): Header[] | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const h = (JSON.parse(text) as { headers?: unknown }).headers;
    return Array.isArray(h) ? (h as Header[]).filter((x) => typeof x?.name === "string" && typeof x?.value === "string") : [];
  } catch {
    return null;
  }
}

/** Render a successful run's captured API calls as a @playwright/test spec using `request`. */
export function renderApiSpec(data: HistoryData, runDir: string): { spec: string; warnings: string[] } {
  if (!data.success) throw new ExportError("run did not succeed; only successful runs can be exported", 1);
  const warnings: string[] = [];
  const body: string[] = [];
  let n = 0;
  let authRedacted = false;
  for (const rec of data.history) {
    for (const en of (rec.network ?? []) as NetworkEntry[]) {
      if (en.type === null || !API_TYPES.has(en.type)) continue;
      if (en.status === null) {
        warnings.push(`call ${en.id} ${en.method} failed in the capture; skipped`);
        continue;
      }
      const dir = path.join(networkDir(runDir), en.id);
      const all = readHeaders(path.join(dir, "request.json"));
      if (all === null) warnings.push(`call ${en.id}: request.json unreadable; exported without headers`);
      const headers = (all ?? []).filter((h) => KEEP_HEADERS.has(h.name.toLowerCase()));
      if ((all ?? []).some((h) => h.value === REDACTED)) authRedacted = true;
      const text = readText(path.join(dir, "request-body.txt"));
      if (en.url.includes(REDACTED)) warnings.push(`call ${en.id}: url contains ${REDACTED}; fix it by hand`);
      if (text?.includes(REDACTED)) warnings.push(`call ${en.id}: body contains ${REDACTED}; fix it by hand`);
      let data_: string | null = null;
      if (text !== null && text !== "") {
        const json = headers.some((h) => h.name.toLowerCase() === "content-type" && /json/i.test(h.value));
        try {
          data_ = json ? JSON.stringify(JSON.parse(text)) : JSON.stringify(text);
        } catch {
          data_ = JSON.stringify(text);
        }
      }
      n++;
      body.push(
        `  const res${n} = await request.fetch(${JSON.stringify(en.url)}, {`,
        `    method: ${JSON.stringify(en.method.toUpperCase())},`,
      );
      if (headers.length) {
        body.push(`    headers: ${JSON.stringify(Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value])))},`);
      }
      if (data_ !== null) body.push(`    data: ${data_},`);
      body.push("  });", `  expect(res${n}.status()).toBe(${en.status});`);
    }
  }
  if (n === 0) {
    throw new ExportError("nothing to export: no API calls were captured (was the run made with --no-network?)", 1);
  }
  if (authRedacted) warnings.push("some request headers were redacted (auth); add them to the test by hand");
  const spec = API_HEADER + "\n"
    + `test(${JSON.stringify(`${data.task} (API)`)}, async ({ request }) => {\n`
    + body.map((l) => l + "\n").join("")
    + "});\n";
  return { spec, warnings };
}
```

Adjust the warning texts if a test regex does not match (the tests are the contract: `/0001.*failed/`, `/0001.*request\.json/`, `/auth/i`, `/body.*\[REDACTED\]/`, `/url.*\[REDACTED\]/i`). `JSON.stringify` output with U+2028/2029 is valid in modern JS, no extra handling needed.

- [ ] **Step 4: Run tests**

Run: `node --test test/exportApi.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/exportApi.ts test/exportApi.test.ts
git commit -m "feat(export): render captured API calls as a request-fixture spec"
```

---

### Task 3: Wire `--api` through `exportRun` and the CLI, document

**Files:**
- Modify: `src/export.ts` (`exportRun`, `API_SPEC_NAME`), `src/cli.ts` (`exportSpec`, `exportMain`)
- Modify: `README.md` (usage ~line 109, regression-test section ~lines 300-335, files table ~line 360, roadmap line 414)
- Test: `test/export.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `renderApiSpec(data, runDir)` (Task 2), `ExportArgs.api` (Task 1).
- Produces: `exportRun(p: string, out: string | null = null, api = false): { path: string; warnings: string[] }`.

- [ ] **Step 1: Write the failing tests**

In `test/export.test.ts` (uses its local `writeRun`, `exportError`, `tmpDir`):

```ts
test("export_run_api_writes_default_api_spec", () => {
  const tmp = tmpDir();
  const runDir = writeRun(tmp, {
    ...GREET,
    history: [{ ...(GREET.history[0] as object), network: [
      { id: "0001", method: "GET", url: "http://a/api/x", status: 200, statusText: "OK", type: "fetch", durationMs: 1 },
    ] }],
  });
  const { path: p } = exportRun(runDir, null, true);
  assert.equal(p, path.join(runDir, "duckwright.api.spec.ts"));
  assert.match(fs.readFileSync(p, "utf8"), /async \(\{ request \}\)/);
  assert.equal(fs.existsSync(path.join(runDir, SPEC_NAME)), false);
});

test("export_run_api_refuses_overwriting_history", () => {
  const tmp = tmpDir();
  const runDir = writeRun(tmp, GREET);
  assert.throws(() => exportRun(runDir, path.join(runDir, "history.json"), true), exportError(2, /overwrite/));
});

test("export_run_api_without_calls_exits_1", () => {
  const tmp = tmpDir();
  assert.throws(() => exportRun(writeRun(tmp, GREET), null, true), exportError(1, /no API calls/));
});
```

Import `API_SPEC_NAME` is not needed here; the literal is asserted. In `test/cli.test.ts`, after `export_warnings_go_to_stderr` (uses the file's local `env()` and `main`):

```ts
function writeApiRun(tmp: string, withCall = true): string {
  const runDir = path.join(tmp, "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  const network = withCall
    ? [{ id: "0001", method: "GET", url: "http://a/api/x", status: 200, statusText: "OK", type: "fetch", durationMs: 1 }]
    : [];
  fs.writeFileSync(path.join(runDir, "history.json"), JSON.stringify({
    task: "t", success: true, answer: "", steps: 1, cost_usd: 0,
    history: [{ step: 1, actions: [{ cmd: "goto", args: ["u"], code: GOTO }], results: ["ok"], network }],
  }));
  return runDir;
}

test("export_api_subcommand_writes_api_spec", async () => {
  const e = env();
  const runDir = writeApiRun(e.tmp);
  assert.equal(await main(["export", "--api", runDir], e.deps()), 0);
  const spec = path.join(runDir, "duckwright.api.spec.ts");
  assert.ok(fs.statSync(spec).isFile());
  assert.ok(e.out.includes(`Test: ${spec}`));
  assert.equal(fs.existsSync(path.join(runDir, "duckwright.spec.ts")), false);
});

test("export_api_without_calls_exits_1", async () => {
  const e = env();
  const runDir = writeApiRun(e.tmp, false);
  assert.equal(await main(["export", "--api", runDir], e.deps()), 1);
  assert.ok(e.err.join("\n").includes("no API calls were captured"));
  assert.equal(fs.existsSync(path.join(runDir, "duckwright.api.spec.ts")), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/export.test.ts test/cli.test.ts`
Expected: FAIL (`exportRun` ignores the third argument; CLI does not pass `api`).

- [ ] **Step 3: Implement**

`src/export.ts`: import `renderApiSpec` from `./exportApi.ts`, and change `exportRun`:

```ts
export function exportRun(p: string, out: string | null = null, api = false): { path: string; warnings: string[] } {
  const { runDir, data } = loadHistory(p);
  const { spec, warnings } = api ? renderApiSpec(data, runDir) : renderSpec(data);
  const target = out ?? path.join(runDir, api ? API_SPEC_NAME : SPEC_NAME);
  // ...rest unchanged
```

`src/cli.ts`:

```ts
function exportSpec(deps: CliDeps, run: string, out: string | null = null, api = false): string {
  const { path: p, warnings } = exportRun(run, out, api);
```

and in `exportMain`: `exportSpec(deps, parsed.args.run, parsed.args.output, parsed.args.api)`. The other caller of `exportSpec` (the `--export` run path) keeps passing no `api`.

- [ ] **Step 4: Update README**

- Line ~109: `duckwright export [--api] RUN [-o FILE]`.
- In "Turning a run into a regression test" (after the `export runs/<id> -o` example, ~line 304) add:

```
   duckwright export --api runs/<id>                # API-only spec: runs/<id>/duckwright.api.spec.ts
```

- Add a short paragraph after the line-326 paragraph: `--api` replays the run's captured `fetch`/`xhr` calls with the `request` fixture and asserts each status; headers other than `content-type` and `accept` are left out, captured values are redacted (so the export warns where `[REDACTED]` appears), and `--state` runs need `test.use({ storageState })` added by hand. Requires network capture; exit codes as for the UI export.
- Files table (line ~360): add a row `exportApi.ts` | Renders captured API calls as a `request`-fixture spec.
- Line 414: change `- [ ]` to `- [x]`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/export.ts src/cli.ts README.md test/export.test.ts test/cli.test.ts
git commit -m "feat(export): add export --api for request-fixture API specs"
```
