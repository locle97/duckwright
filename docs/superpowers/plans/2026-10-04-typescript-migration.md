# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Duckwright runs as a Node/TypeScript CLI with the same commands, output, exit codes, safety checks and `history.json` as the Python version. The Python version is moved, frozen, to `legacy/`.

**Architecture:** This is a one-to-one port. Each Python module in `legacy/duckwright/` becomes a TypeScript module in `src/` with the same responsibility, ported bottom-up (`proc` → `pw`/`observe`/`rundir` → `expect` → `brain` → `prompt`/`actions` → `loop` → `export` → `taskfile` → `args` → `cli`). The one deliberate design change: subprocess calls are `async` and take an `AbortSignal`. Ctrl-C then kills the running `claude`/`playwright-cli` child, and the planned TUI can stop a run cleanly. Tests are ported from `legacy/tests/` file by file, keeping test names and assertions, so the Python suite acts as the spec.

**Tech Stack:** Node ≥ 22.18 (runs `.ts` natively for tests), TypeScript `^7.0.2` (`tsc` build only), `node:test` + `node:assert/strict`, `@types/node@^22`. `ajv@^8` is dev-only, for the schema test. There are no runtime dependencies.

**Spec:** no separate design doc. The behavioural spec is the Python implementation and its tests, `legacy/duckwright/*.py` and `legacy/tests/*.py` (after Task 1). When this plan and the Python code disagree on behaviour, the Python code wins, except for the **Intentional differences** listed below.

## Global Constraints

- `package.json`: `"name": "duckwright"`, `"version": "0.1.0"`, `"type": "module"`, `"license": "MIT"`, `"engines": {"node": ">=22.18"}`, `"bin": {"duckwright": "dist/bin.js"}`, `"files": ["dist", "prompts"]`, `"dependencies"` absent or `{}`.
- `tsconfig.json` compiler options: `"target": "es2023"`, `"module": "nodenext"`, `"strict": true`, `"erasableSyntaxOnly": true`, `"rewriteRelativeImportExtensions": true`, `"verbatimModuleSyntax": true`, `"types": ["node"]`. Imports between source files use `.ts` extensions (`import { x } from "./proc.ts"`). No `enum`, `namespace` or constructor parameter properties.
- Scripts: `"build": "tsc -p tsconfig.build.json"`, `"typecheck": "tsc -p tsconfig.json"`, `"test": "npm run typecheck && node --test \"test/**/*.test.ts\""`, `"prepare": "npm run build"`.
- Every user-facing string (messages, errors, `step N | …` lines, summary rows, prompt sections, spec header) is copied verbatim from the Python module it replaces.
- Exit codes are unchanged: `0` success, `1` failed run or export refusal, `2` usage/preflight/file errors, `130` interrupted.
- `history.json` keeps the same keys (snake_case) and value types. The TS version may format it differently (for example `0` vs `0.0` for cost, non-ASCII not `\u`-escaped), but `JSON.parse` of both must be deep-equal for the same run.
- Python's `len()` and slicing count code points. Wherever Python measures or truncates text (`MAX_SNAPSHOT_CHARS`, `HYBRID_MAX_CHARS`, `obs.chars`, `MAX_ERROR_CHARS`), TS uses `codePointLength`/`sliceCodePoints` from `src/text.ts`, never `.length`/`.slice`.
- Python's `str.splitlines()` is used by `observe` (line count), `prompt._flat` and `export` (code lines). TS uses `splitLines` from `src/text.ts`, which matches Python's separators. Never use `.split("\n")` for these.
- Internal TS names are camelCase (`nextGoal`, `costUsd`, `maxSteps`). Conversion to and from snake_case happens only where JSON is read (`parseDecision`, `loadHistory`) or written (`historyJson`, `DECISION_SCHEMA`).
- `legacy/` is frozen. After Task 1 nothing in it changes, and its test suite keeps passing in CI.

**Intentional differences from Python** (each is pinned by a test in its task):
1. CLI long options cannot be abbreviated (`--max` is an error, not `--max-steps`).
2. `--help` text is hand-written. It lists every option but is not argparse's layout.
3. A task-file path `~user/...` expands only when `user` is the current user. Any other `~name` is a located "not a usable path" error, as when Python cannot find the user.
4. A child started with no stdin gets `/dev/null` instead of inheriting the terminal.

## Review Focus

1. **Ctrl-C while `claude -p` is running.** Expected: the child is killed, that run's `history.json` says `"answer": "interrupted"` with the cost so far, `playwright-cli close` still runs, the exit code is `130`, and later batch tasks show `skip`. Pinned by Task 7 `agent aborts mid-decide and still closes the browser` and Task 11 `abort writes interrupted history and exits 130`.
2. **Emoji or other astral characters near a truncation limit** (snapshot at 40,000 code points, error at 300). Expected: the cut is made on code points, so the output never holds a lone surrogate and the counts match Python. Pinned by Task 2 `sliceCodePoints never splits a surrogate pair` and Task 3 `observe counts and truncates by code point`.
3. **Page text holding ` `, `\x85` or `\r` inside history results or goals.** Expected: flattened onto one line exactly as Python's `splitlines` would, so page text cannot start a fake history line. Pinned by Task 2 `splitLines matches Python separators` and Task 6 `step line flattens unicode line separators`.
4. **A huge or signed number in `max-steps`** (`max-steps: 999…9` with 5,000 digits in a task file; `--max-steps 1e3` on the command line). Expected: a task file accepts only digits from 1 to `Number.MAX_SAFE_INTEGER` and reports anything else as the located error. The CLI rejects a non-integer with `argument --max-steps: invalid int value: '1e3'`. Pinned by Task 9 `max-steps above safe integer is a located error` and Task 10 `max-steps rejects non-integers`.
5. **A missing `claude` binary, or one the OS cannot start** (`ENOENT`/`EACCES` from `spawn`). Expected: preflight catches the missing binary (`claude CLI not found on PATH (install Claude Code)`, exit `2`). A binary that fails to start after preflight becomes `error: Error: spawn claude ENOENT` in `history.json`, with exit `1` and no unhandled rejection. Pinned by Task 2 `runProcess rejects on spawn failure` and Task 11 `spawn failure is reported as error and exits 1`.

---

### Task 1: Move the Python implementation to `legacy/`

**Files:**
- Move (`git mv`): `duckwright/` → `legacy/duckwright/`, `tests/` → `legacy/tests/`, `pyproject.toml` → `legacy/pyproject.toml`, `scripts/smoke_install.sh` → `legacy/scripts/smoke_install.sh`
- Create: `legacy/README.md`, `legacy/LICENSE` (copy of `LICENSE`)
- Modify: `legacy/tests/test_taskfile.py:201` (examples path), `.github/workflows/ci.yml`
- Delete: `.github/workflows/release.yml` (Task 12 writes the npm one)

**Interfaces:**
- Produces: `legacy/` as a self-contained Python project. Running `cd legacy && pip install -e ".[dev]" && python -m pytest` passes. `examples/` and `benchmark_tasks/` stay at the repo root, shared by both versions.

- [ ] **Step 1: Move the files** with `git mv` as listed. `cp LICENSE legacy/LICENSE`.
- [ ] **Step 2: Write `legacy/README.md`**, three lines: a `# Duckwright (legacy Python version)` heading; "Frozen reference implementation, kept until the TypeScript version replaces it. Do not add features here."; "Run its tests with `pip install -e ".[dev]" && python -m pytest` from this folder." `legacy/pyproject.toml` keeps `readme = "README.md"`, which now resolves to this file.
- [ ] **Step 3: Fix the examples path** in `test_example_template_parses`: `ROOT.parent / "examples" / "task.md"`.
- [ ] **Step 4: Run the legacy suite**

Run: `cd legacy && pip install -e ".[dev]" && python -m pytest -q`
Expected: all tests pass (live e2e skipped). `test_packaging` builds from `legacy/` and `test_naming` scans `legacy/` only.

- [ ] **Step 5: Update CI.** In `ci.yml`, rename jobs `test` → `legacy-test` and `package` → `legacy-package`. Add `defaults: run: working-directory: legacy` to both, set `cache-dependency-path: legacy/pyproject.toml`, and reduce the matrix to `["3.11"]`. Delete `release.yml`.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: move the Python implementation to legacy/"
```

---

### Task 2: Node project scaffold, `proc.ts`, `text.ts`

**Files:**
- Create: `package.json`, `package-lock.json` (via `npm install`), `tsconfig.json`, `tsconfig.build.json`, `src/proc.ts`, `src/text.ts`, `test/helpers.ts`, `test/proc.test.ts`, `test/text.test.ts`, `prompts/` (copy of `legacy/duckwright/prompts/*.md`)
- Modify: `.gitignore` (add `node_modules/`, `dist/`), `.github/workflows/ci.yml` (add `node` job)

**Interfaces:**
- Produces (`src/proc.ts`):
  - `interface ProcResult { code: number; stdout: string; stderr: string }`
  - `interface RunOptions { cwd?: string; signal?: AbortSignal }`
  - `type Runner = (argv: string[], stdin: string | null, timeoutSec: number, opts?: RunOptions) => Promise<ProcResult>`
  - `const runProcess: Runner`
  - `class AbortedError extends Error` (message `"interrupted"`)
- Produces (`src/text.ts`): `splitLines(s: string): string[]`, `codePointLength(s: string): number`, `sliceCodePoints(s: string, end: number): string`
- Produces (`test/helpers.ts`): `fakeRunner(result: ProcResult | ((argv: string[], stdin: string | null) => ProcResult)): Runner & { calls: { argv: string[]; stdin: string | null; timeoutSec: number; cwd?: string }[] }` and `ok(stdout = ""): ProcResult`.

- [ ] **Step 1: Scaffold.** Write `package.json` with the Global Constraints fields and `devDependencies` `typescript@^7.0.2`, `@types/node@^22`, `ajv@^8`. `tsconfig.json` has the Global Constraints options plus `"noEmit": true` and `"include": ["src", "test"]`. `tsconfig.build.json` extends it with `"noEmit": false`, `"rootDir": "src"`, `"outDir": "dist"`, `"include": ["src"]`. Run `npm install`. `cp legacy/duckwright/prompts/*.md prompts/`.
- [ ] **Step 2: Write the failing tests.** In `test/proc.test.ts`, port the three tests in `legacy/tests/test_proc.py` (same names, as `test("…")` strings) against `runProcess`, using `node -e` scripts instead of `python -c`. Add:

```ts
test("runProcess times out with code -1", async () => {
  const r = await runProcess(["node", "-e", "setTimeout(()=>{}, 5000)"], null, 0.2);
  assert.deepEqual(r, { code: -1, stdout: "", stderr: "timeout" });
});
test("runProcess rejects with AbortedError when aborted", async () => {
  const ac = new AbortController();
  const p = runProcess(["node", "-e", "setTimeout(()=>{}, 5000)"], null, 10, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, AbortedError);
});
test("runProcess rejects on spawn failure", async () => {
  await assert.rejects(runProcess(["duckwright-no-such-binary"], null, 5), /ENOENT/);
});
test("runProcess passes stdin and closes it", async () => {
  const r = await runProcess(["node", "-e", "process.stdin.pipe(process.stdout)"], "héllo", 5);
  assert.equal(r.stdout, "héllo");
});
```

In `test/text.test.ts`:

```ts
test("splitLines matches Python separators", () => {
  assert.deepEqual(splitLines("a\nb\r\nc\rd\ve\ff\x1cg\x1dh\x1ei\x85j k l"),
    ["a","b","c","d","e","f","g","h","i","j","k","l"]);
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n\n"), ["", ""]);
});
test("sliceCodePoints never splits a surrogate pair", () => {
  assert.equal(sliceCodePoints("ab😀c", 3), "ab😀");
  assert.equal(codePointLength("ab😀c"), 4);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `src/text.ts` and `src/proc.ts`.** `runProcess` uses `child_process.spawn(argv[0], argv.slice(1), { cwd, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] })`. It never uses a shell. Output is collected as Buffers and decoded with `toString("utf8")` (invalid bytes become U+FFFD). On timeout it sends `SIGKILL` and resolves `{code: -1, stdout: "", stderr: "timeout"}`. Exit by signal maps to `-os.constants.signals[signal]`, matching Python's negative returncode. If `signal` is aborted, or is already aborted when the child exits, it sends `SIGTERM` and rejects `AbortedError`. A spawn `error` event rejects with that error.
- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Add the `node` CI job** to `ci.yml`: `actions/setup-node@v4` with matrix `node-version: ["22", "24"]`, `cache: npm`, then `npm ci`, `npm test`, `npm run build`.
- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig*.json .gitignore src test prompts .github/workflows/ci.yml
git commit -m "feat(ts): Node scaffold, async process runner and text helpers"
```

---

### Task 3: `pw.ts`, `observe.ts`, `rundir.ts`

**Files:**
- Create: `src/pw.ts`, `src/observe.ts`, `src/rundir.ts`, `test/pw.test.ts`, `test/observe.test.ts`, `test/rundir.test.ts`

**Interfaces:**
- Consumes: `Runner`, `runProcess`, `ProcResult` (Task 2); `splitLines`, `codePointLength`, `sliceCodePoints` (Task 2).
- Produces (`src/pw.ts`):
  - `class PlaywrightError extends Error`
  - `interface PlaywrightOptions { session?: string; runner?: Runner; timeout?: number; allowFileAccess?: boolean; signal?: AbortSignal }`, with defaults `"duckwright"`, `runProcess`, `30`, `false`
  - `class PlaywrightCLI { constructor(opts?: PlaywrightOptions); readonly session: string; run(cmd: string, args: string[]): Promise<ProcResult>; open(headed: boolean): Promise<ProcResult>; stateLoad(path: string): Promise<void>; close(): Promise<void>; snapshot(path: string): Promise<string> }`
  - `run`/`open`/`snapshot`/`stateLoad` pass `signal` to the runner. `close()` passes no signal and never throws.
- Produces (`src/observe.ts`): `MAX_SNAPSHOT_CHARS = 40_000`, `TRUNCATION_MARKER = "\n…[snapshot truncated]"`, `PAGE_DIR = "page"`, `SNAPSHOT_FILE = "snapshot.yml"`, `SNAPSHOT_MODES = ["hybrid", "full", "grep"] as const`, `type SnapshotMode = (typeof SNAPSHOT_MODES)[number]`, `HYBRID_MAX_CHARS = 5_000`, `interface Observation { tabs: string; snapshot: string; truncated: boolean; lines: number; chars: number }`, `pageDir(workdir: string): string`, `pasteSnapshot(mode: SnapshotMode, obs: Observation): boolean`, `observe(pw: PlaywrightCLI, workdir: string, maxChars?: number): Promise<Observation>`
- Produces (`src/rundir.ts`): `ADJECTIVES`, `NOUNS` (same 30 words each, same order), `MAX_LABEL = 40`, `slugify(text: string): string`, `randomLabel(rng?: () => number): string`, `runLabel(taskFile: string | null): string`, `makeRunDir(root: string, taskFile: string | null, now?: Date): string`

- [ ] **Step 1: Write the failing tests.** Port every test in `legacy/tests/test_pw.py`, `test_observe.py` and `test_rundir.py`, keeping names and assertions. Use `fakeRunner`, `fs.mkdtempSync(path.join(os.tmpdir(), "dw-"))` for `tmp_path`, and replace `random.Random(seed)` with a fixed `rng` returning given values. Add:

```ts
test("observe counts and truncates by code point", async () => {
  // snapshot of 39_999 "a" + "😀😀": 40_001 code points, 40_003 UTF-16 units
  const obs = await observe(pwWithSnapshot("a".repeat(39_999) + "😀😀"), tmp);
  assert.equal(obs.chars, 40_001);
  assert.equal(obs.snapshot, "a".repeat(39_999) + "😀" + TRUNCATION_MARKER);
});
test("close ignores the abort signal", async () => { /* aborted signal; close() still calls runner with no signal and resolves */ });
```

`pwWithSnapshot(text)` is a local helper: a `PlaywrightCLI` whose fake runner writes `text` to the `--filename=` path on `snapshot` and returns `ok()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pw.test.ts test/observe.test.ts test/rundir.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the three modules.** `open()` prepends `["env", "PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1"]` when `allowFileAccess` is set, as in Python. `slugify` does `toLowerCase().replaceAll("đ", "d").normalize("NFKD")`, drops everything outside `\x00-\x7f`, then applies Python's dash/strip/`MAX_LABEL` rules. `runLabel` takes `path.parse(taskFile).name`. `makeRunDir` formats local time as `YYYYMMDD-HHMMSS`, creates `root` recursively, then tries `mkdirSync` (non-recursive) on `base`, `base-2`, `base-3`… and retries on `EEXIST`. File I/O here may be synchronous.
- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pw.test.ts test/observe.test.ts test/rundir.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pw.ts src/observe.ts src/rundir.ts test/pw.test.ts test/observe.test.ts test/rundir.test.ts
git commit -m "feat(ts): playwright-cli wrapper, page observation, run folders"
```

---

### Task 4: `expect.ts`

**Files:**
- Create: `src/expect.ts`, `test/expect.test.ts`

**Interfaces:**
- Consumes: `PlaywrightCLI` (Task 3), `ProcResult` (Task 2).
- Produces: `CHECKS: Readonly<Record<string, readonly string[]>>` (keys in Python order: `visible, text, value, checked, unchecked, url`), `checkArgs(args: string[]): string | null`, `runExpect(pw: PlaywrightCLI, args: string[]): Promise<[result: string, code: string | null]>`

- [ ] **Step 1: Write the failing tests.** Port every test in `legacy/tests/test_expect.py`, keeping names and assertions, including every locator the Python tests accept or reject in `_is_locator`.
- [ ] **Step 2: Run to verify failure**

Run: `node --test test/expect.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/expect.ts`.** The regexes port directly: JS supports the lookbehinds in `_LITERAL`. `_q` is `JSON.stringify`. `_JS_WS` keeps the same character class, with the `g` flag. For `_CALL.findall`, use `matchAll` capture group 1. `actual is not want` becomes `actual !== want`. A non-string `actual` for `value`/`url` becomes `actual == null ? "" : String(actual)`.
- [ ] **Step 4: Run to verify pass**

Run: `node --test test/expect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/expect.ts test/expect.test.ts
git commit -m "feat(ts): expect checks verified against the live page"
```

---

### Task 5: `brain.ts`

**Files:**
- Create: `src/brain.ts`, `test/brain.test.ts`

**Interfaces:**
- Consumes: `CHECKS` (Task 4); `Runner`, `runProcess`, `AbortedError` (Task 2).
- Produces:
  - `SNAPSHOT_TOOLS = "Read,Grep"`, `TOOL_TIMEOUT = 120`, `ALLOWED_COMMANDS` (same 17 commands, same order, `as const`), `DECISION_SCHEMA` (same structure and snake_case keys as Python)
  - `interface Action { cmd: string; args: string[] }`
  - `interface Decision { evaluationPreviousGoal: string; memory: string; nextGoal: string; actions: Action[] }`
  - `class BrainError extends Error { cost: number; constructor(msg?: string, cost?: number) }`
  - `parseDecision(so: unknown): Decision`
  - `interface BrainOptions { systemFiles: string[]; model?: string; runner?: Runner; timeout?: number; snapshotDir?: string | null; signal?: AbortSignal }`, with defaults `"sonnet"`, `runProcess`, timeout `TOOL_TIMEOUT` when `snapshotDir` is set else `60`
  - `class Brain { constructor(opts: BrainOptions); argv(grep?: boolean): string[]; decide(prompt: string, grep?: boolean): Promise<[Decision, number]> }`
  - `type DecideFn = Pick<Brain, "decide">` (what `Agent` needs)

- [ ] **Step 1: Write the failing tests.** Port every test in `legacy/tests/test_brain.py`, keeping names and assertions. Validate `DECISION_SCHEMA` with `new Ajv({ strict: false })` where Python uses `jsonschema`. Where Python compares the `--json-schema` argv value to `json.dumps(DECISION_SCHEMA)`, compare `JSON.parse(value)` to `DECISION_SCHEMA`. Add:

```ts
test("decide lets AbortedError through", async () => {
  const brain = new Brain({ systemFiles: [], runner: async () => { throw new AbortedError(); } });
  await assert.rejects(brain.decide("p"), AbortedError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/brain.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/brain.ts`.** Keep the argv order from Python's `_argv`. In grep mode, pass `cwd: path.resolve(snapshotDir)` and turn each system file into an absolute path with `path.resolve`. Pass `signal` to the runner. The cost is used only when `typeof cost === "number" && Number.isFinite(cost)`, otherwise `0`. The malformed-action message is `` `malformed action: ${JSON.stringify(a)}` ``. Only `BrainError` gets its `cost` filled in. Any other rejection (`AbortedError`, spawn errors) propagates untouched.
- [ ] **Step 4: Run to verify pass**

Run: `node --test test/brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain.ts test/brain.test.ts
git commit -m "feat(ts): claude -p brain with the decision schema"
```

---

### Task 6: `prompt.ts` and `actions.ts`

**Files:**
- Create: `src/prompt.ts`, `src/actions.ts`, `test/prompt.test.ts`, `test/actions.test.ts`

**Interfaces:**
- Consumes: `Decision`, `Action`, `ALLOWED_COMMANDS` (Task 5); `Observation`, `SNAPSHOT_FILE` (Task 3); `checkArgs`, `runExpect` (Task 4); `PlaywrightCLI` (Task 3); `splitLines`, `sliceCodePoints` (Task 2).
- Produces (`src/prompt.ts`): `HISTORY_WINDOW = 15`, `interface StepRecord { step: number; decision: Decision; results: string[]; codes: (string | null)[] }`, `stepLine(rec: StepRecord): string` (Python's `StepRecord.line()`), `buildPrompt(task: string, step: number, maxSteps: number, history: StepRecord[], memory: string, obs: Observation, opts?: { window?: number; nudge?: string | null; paste?: boolean }): string`, with defaults `window = HISTORY_WINDOW`, `nudge = null`, `paste = true`.
- Produces (`src/actions.ts`): `ALLOWED: ReadonlySet<string>`, `ALLOWED_LIST`, `PAGE_CHANGING: ReadonlySet<string>`, `ALLOWED_FLAGS: Readonly<Record<string, ReadonlySet<string>>>`, `MAX_ERROR_CHARS = 300`, `EARLIER_FAILED`, `extractCode(stdout: string): string | null`, `execute(pw: PlaywrightCLI, actions: Action[], codes?: (string | null)[]): Promise<{ results: string[]; done: { success: boolean; answer: string } | null }>`

- [ ] **Step 1: Write the failing tests.** Port every test in `legacy/tests/test_prompt.py` and `test_actions.py`, keeping names and assertions. `rec.line()` becomes `stepLine(rec)` and `done == (True, "x")` becomes `done` deep-equal to `{ success: true, answer: "x" }`. Add:

```ts
test("step line flattens unicode line separators", () => {
  const rec = { step: 1, decision: { evaluationPreviousGoal: "a b", memory: "", nextGoal: "c\x85d", actions: [] }, results: ["x\ry"], codes: [] };
  assert.equal(stepLine(rec), "step 1 | a b | c d | x y");
});
test("error results are cut by code point", async () => { /* stderr of 299 "a" + "😀😀": result is "error: " + 299 "a" + "😀" */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/prompt.test.ts test/actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both modules.** `_flat(s)` is `splitLines(s).join(" ")`. `_HARNESS_TAG` uses the `gi` flags. `_RAN_CODE` uses the `m` flag. Truncation is `sliceCodePoints(msg, "error: ".length + MAX_ERROR_CHARS)`. The `done` arg list in its error message uses `JSON.stringify` per arg, joined with `", "`. `codes` is extended in place, as in Python.
- [ ] **Step 4: Run to verify pass**

Run: `node --test test/prompt.test.ts test/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/actions.ts test/prompt.test.ts test/actions.test.ts
git commit -m "feat(ts): step prompts and the action allow-list"
```

---

### Task 7: `loop.ts`

**Files:**
- Create: `src/loop.ts`, `test/loop.test.ts`

**Interfaces:**
- Consumes: `PlaywrightCLI`, `PlaywrightError`, `observe`, `pasteSnapshot`, `SnapshotMode` (Task 3); `DecideFn`, `BrainError`, `Decision` (Task 5); `StepRecord`, `buildPrompt` (Task 6); `execute` (Task 6); `AbortedError` (Task 2).
- Produces:
  - `REPEAT_NUDGE` (verbatim), `REPEAT_THRESHOLD = 3`
  - `interface RunResult { success: boolean; answer: string; steps: number; costUsd: number; history: StepRecord[] }`
  - `interface AgentOptions { task: string; pw: PlaywrightCLI; brain: DecideFn; workdir: string; maxSteps?: number; maxFailures?: number; headed?: boolean; state?: string | null; onStep?: (rec: StepRecord) => void; snapshotMode?: SnapshotMode; signal?: AbortSignal }`, with defaults `25`, `3`, `false`, `null`, none, `"full"`
  - `class Agent { constructor(opts: AgentOptions); costUsd: number; run(): Promise<RunResult> }`

- [ ] **Step 1: Write the failing tests.** Port every test in `legacy/tests/test_loop.py`, keeping names and assertions. The Python fake brain becomes an object with `async decide(prompt, grep)`. Add:

```ts
test("agent aborts mid-decide and still closes the browser", async () => {
  const ac = new AbortController();
  // fake pw runner records argv; brain.decide aborts ac then throws new AbortedError()
  await assert.rejects(agent.run(), AbortedError);
  assert.deepEqual(lastCall.argv.slice(2), ["close"]);
  assert.equal(agent.costUsd, 0.01); // cost from the step before the abort is kept
});
test("agent checks the signal before each step", async () => { /* signal aborted before run(): rejects AbortedError, brain never called, close still runs */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/loop.ts`** as a direct port of `Agent.run`/`_loop`, in `try { … } finally { await pw.close() }`. At the top of each step, `if (signal?.aborted) throw new AbortedError()`. Only `BrainError` counts as a brain failure. Anything else propagates. `costUsd` is updated in place so the CLI can read it after a throw.
- [ ] **Step 4: Run to verify pass**

Run: `node --test test/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop.ts test/loop.test.ts
git commit -m "feat(ts): the agent loop with abort support"
```

---

### Task 8: `export.ts` with golden specs from the legacy version

**Files:**
- Create: `src/export.ts`, `test/export.test.ts`, `test/fixtures/export/<name>/history.json` and `test/fixtures/export/<name>/expected.spec.ts` for each fixture, `test/fixtures/form.html` (copy of `legacy/tests/fixtures/form.html`, used by Task 13)

**Interfaces:**
- Consumes: `splitLines` (Task 2).
- Produces: `SPEC_NAME = "duckwright.spec.ts"`, `HEADER`, `TAB_COMMANDS`, `NO_ASSERTIONS` (all verbatim), `class ExportError extends Error { exitCode: number; constructor(message: string, exitCode: number) }`, `interface HistoryData` (the `history.json` shape: `task: string; task_file: string | null; success: boolean; answer: string; steps: number; cost_usd: number; history: HistoryStep[]`, where `HistoryStep` has snake_case keys and `actions: { cmd: string; args: string[]; code: string | null }[]`), `loadHistory(p: string): { runDir: string; data: HistoryData }`, `renderSpec(data: HistoryData): { spec: string; warnings: string[] }`, `exportRun(p: string, out?: string | null): { path: string; warnings: string[] }`

- [ ] **Step 1: Generate golden fixtures with the legacy CLI.** Create four `history.json` files: `greet` (goto + fill + click + expect text), `multiline` (a multi-line code block), `tabs` (a successful `tab-new` plus a failed `tab-select`), `unicode` (task `"Chào Linh ✓"` and a `"` in the title). For each, run `cd legacy && python -m duckwright export ../test/fixtures/export/<name> -o ../test/fixtures/export/<name>/expected.spec.ts`.
- [ ] **Step 2: Write the failing tests.** Port every test in `legacy/tests/test_export.py`, keeping names and assertions, then add:

```ts
for (const name of ["greet", "multiline", "tabs", "unicode"]) {
  test(`spec matches legacy output: ${name}`, () => {
    const dir = path.join(FIXTURES, "export", name);
    const { spec } = renderSpec(loadHistory(dir).data);
    assert.equal(spec, fs.readFileSync(path.join(dir, "expected.spec.ts"), "utf8"));
  });
}
test("export refuses a symlink to the run's history", () => { /* out = symlink → runDir/history.json: ExportError exitCode 2, history unchanged */ });
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/export.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `src/export.ts`.** `loadHistory` treats a directory argument as `<dir>/history.json`. A missing file is `history not found: <file>`. Any other read or parse error is `cannot read <file>: <e.message>`. Both have exit code 2. `_shape_error` checks are ported one-for-one. The overwrite guard compares both paths after `path.resolve` and then `fs.realpathSync` where the path exists. The spec title is `JSON.stringify(task)`.
- [ ] **Step 5: Run to verify pass**

Run: `node --test test/export.test.ts`
Expected: PASS, including all four golden comparisons byte-for-byte.

- [ ] **Step 6: Commit**

```bash
git add src/export.ts test/export.test.ts test/fixtures
git commit -m "feat(ts): Playwright spec export, checked against legacy output"
```

---

### Task 9: `taskfile.ts`

**Files:**
- Create: `src/taskfile.ts`, `test/taskfile.test.ts`

**Interfaces:**
- Consumes: `SNAPSHOT_MODES`, `SnapshotMode` (Task 3).
- Produces:
  - `type TaskSettings = Partial<{ maxSteps: number; model: string; headed: boolean; skill: string; session: string; state: string; export: boolean; snapshot: SnapshotMode }>`
  - `KEYS`: front-matter key → `[dest: keyof TaskSettings, kind: "int" | "str" | "bool" | "path" | "snapshot"]`, the same eight keys as Python, with `allow-file-access` deliberately absent
  - `class TaskFileError extends Error`, `interface TaskFile { task: string; settings: TaskSettings; baseDir: string }`
  - `loadTaskFile(p: string): TaskFile`, `TASK_SUFFIXES = [".md", ".txt"]`, `taskPaths(paths: string[]): (string | TaskFileError)[]`, `expandTaskPaths(paths: string[]): string[]`

- [ ] **Step 1: Write the failing tests.** Port every test in `legacy/tests/test_taskfile.py` (34 tests), keeping names and assertions. `test_example_template_parses` reads `<repo>/examples/task.md`. `test_tilde_path_expanded` uses `os.homedir()`. Add:

```ts
test("max-steps above safe integer is a located error", () => {
  const p = w(tmp, "---\nmax-steps: 9007199254740992\n---\nGo");
  assert.match(err(p), new RegExp(`^${esc(p)}:2: max-steps must be a whole number of at least 1`));
});
test("tilde of the current user expands", () => {
  const p = w(tmp, `---\nstate: ~${os.userInfo().username}/x.json\n---\nGo`);
  assert.equal(loadTaskFile(p).settings.state, path.join(os.homedir(), "x.json"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/taskfile.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/taskfile.ts`.**
  - Read the file as bytes and decode with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })`. That strips a BOM and turns invalid UTF-8 into `<path>: cannot read: <message>`. `ENOENT` gives `<path>: file not found`, and `EISDIR` or another error gives `cannot read`.
  - `int` kind: `/^[0-9]+$/`, then `Number(v)`, valid only for `1 ≤ n ≤ Number.MAX_SAFE_INTEGER`.
  - `path` kind: a value containing `\0` raises `is not a usable path: embedded null byte`. `~` and `~/…` expand to `os.homedir()`. `~<current user>…` expands the same way. Any other `~name` raises `is not a usable path: cannot expand ~name`. The result is `path.resolve(baseDir, expanded)`.
  - `baseDir` is `fs.realpathSync(path.dirname(path.resolve(p)))`.
  - Dedupe keys in `taskPaths` are `fs.realpathSync` of the path, falling back to `path.resolve`, then to the string as typed.
  - The folder prefix keeps `arg` as typed and appends `path.sep` unless `arg` already ends with `/` or `path.sep`.
- [ ] **Step 4: Run to verify pass**

Run: `node --test test/taskfile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/taskfile.ts test/taskfile.test.ts
git commit -m "feat(ts): task files with front-matter settings"
```

---

### Task 10: `args.ts`, the argparse-compatible command line

**Files:**
- Create: `src/args.ts`, `test/args.test.ts`

**Interfaces:**
- Consumes: `SnapshotMode`, `HYBRID_MAX_CHARS` (Task 3); `TaskSettings` (Task 9); `SPEC_NAME` (Task 8).
- Produces:
  - `interface RunArgs { task: string | null; file: string[] | null; maxSteps: number; model: string; headed: boolean; skill: string; session: string; state: string | null; allowFileAccess: boolean; export: boolean; snapshot: SnapshotMode }`
  - `interface ExportArgs { run: string; output: string | null }`
  - `class UsageError extends Error { usage: string }`. The message has no prefix; the CLI prints `usage` and then `duckwright: error: <message>` (or `duckwright export: error: …`).
  - `type Parsed<T> = { kind: "args"; args: T } | { kind: "help"; text: string } | { kind: "version" }`
  - `parseRunArgs(argv: string[], defaultSkill: string, settings?: TaskSettings): Parsed<RunArgs>`. Precedence: built-in defaults < `settings` < flags in `argv`. Defaults are `maxSteps 25`, `model "sonnet"`, `headed false`, `skill defaultSkill`, `session "duckwright"`, `state null`, `allowFileAccess false`, `export false`, `snapshot "hybrid"`.
  - `parseExportArgs(argv: string[]): Parsed<ExportArgs>`

- [ ] **Step 1: Write the failing tests.** Port the argument-parsing tests from `legacy/tests/test_main.py` (those calling `_parse`, `_parse_export` or `_args_for`, or asserting argparse errors), keeping names and assertions. Add:

```ts
const parse = (...a: string[]) => parseRunArgs(a, "/skill.md");
test("file is greedy until the next option", () => {
  assert.deepEqual(args(parse("-f", "a.md", "Open the site")).file, ["a.md", "Open the site"]);
  assert.deepEqual(args(parse("-f", "a.md", "--headed", "-f", "b.md")).file, ["a.md", "b.md"]);
});
test("negatable booleans", () => {
  assert.equal(args(parseRunArgs(["--no-headed", "x"], "/s", { headed: true })).headed, false);
});
test("settings are defaults, flags win", () => {
  assert.equal(args(parseRunArgs(["--model", "opus", "x"], "/s", { model: "haiku", maxSteps: 3 })).model, "opus");
  assert.equal(args(parseRunArgs(["x"], "/s", { maxSteps: 3 })).maxSteps, 3);
});
test("max-steps rejects non-integers", () => {
  assert.throws(() => parse("--max-steps", "1e3", "x"), { message: "argument --max-steps: invalid int value: '1e3'" });
});
test("snapshot flags are mutually exclusive", () => {
  assert.throws(() => parse("--snapshot-full", "--snapshot-grep", "x"),
    { message: "argument --snapshot-grep: not allowed with argument --snapshot-full" });
});
test("long options cannot be abbreviated", () => {
  assert.throws(() => parse("--max", "3", "x"), { message: "unrecognized arguments: --max 3" });
});
test("double dash makes the rest positional", () => {
  assert.equal(args(parse("--", "--headed")).task, "--headed");
});
```

`args(p)` is a local helper that asserts `p.kind === "args"` and returns `p.args`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/args.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/args.ts`** as a small hand-written scanner. Do not use `util.parseArgs`: it has no greedy `-f` or mutual exclusion.
  - Value options: `--max-steps`, `--model`, `--skill`, `--session`, `--state`. Each takes `--opt=value` or the next argument, as long as that argument does not start with `-`; otherwise the error is `argument --opt: expected one argument`.
  - `-f`/`--file` takes one or more following arguments, up to the next one starting with `-` or `--`. With none, the error is `argument -f/--file: expected at least one argument`. Repeated `-f` flags extend the list.
  - `--max-steps` accepts `/^\s*[+-]?\d+\s*$/`. Anything else gives `argument --max-steps: invalid int value: '<v>'`.
  - The flags are `--headed`/`--no-headed`, `--export`/`--no-export`, `--allow-file-access`, `--snapshot-hybrid|full|grep`, `-h`/`--help` and `--version`.
  - `--` ends option parsing. One positional is allowed. Leftover arguments raise `unrecognized arguments: <space-joined>`.
  - Usage line: `usage: duckwright [-h] [--version] [-f FILE [FILE ...]] [--max-steps MAX_STEPS] [--model MODEL] [--headed | --no-headed] [--skill SKILL] [--session SESSION] [--state FILE] [--allow-file-access] [--export | --no-export] [--snapshot-hybrid | --snapshot-full | --snapshot-grep] [task]`. The help text is that line plus each option's Python `help=` string (the hybrid one reads `5,000`) and the Python `description` and `epilog`.
- [ ] **Step 4: Run to verify pass**

Run: `node --test test/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/args.ts test/args.test.ts
git commit -m "feat(ts): argparse-compatible command-line parsing"
```

---

### Task 11: `cli.ts` and `bin.ts`

**Files:**
- Create: `src/cli.ts`, `src/bin.ts`, `test/cli.test.ts`, `test/naming.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (`src/cli.ts`):
  - `interface PromptPaths { system: string; defaultSkill: string; snapshotFull: string; snapshotGrep: string; snapshotHybrid: string }`
  - `PROMPTS: PromptPaths`, resolved from `new URL("../prompts/", import.meta.url)`. This works from `src/` (tests) and `dist/` (installed).
  - `version(): string`, read from `../package.json` relative to `import.meta.url`, or `"unknown"`.
  - `interface AgentLike { costUsd: number; run(): Promise<RunResult> }`
  - `interface CliDeps { which(name: string): string | null; createAgent(opts: AgentOptions): AgentLike; prompts: PromptPaths; stdout(line: string): void; stderr(line: string): void; signal: AbortSignal }`
  - `historyJson(task: string, success: boolean, answer: string, steps: number, costUsd: number, history: StepRecord[], taskFile: string | null): HistoryData`
  - `main(argv: string[], deps?: Partial<CliDeps>): Promise<number>`. The real defaults are a PATH-scanning `which` (`fs.accessSync(dir/name, X_OK)`), `opts => new Agent(opts)`, `PROMPTS`, `console.log`/`console.error`, and a never-aborting signal.
- Produces (`src/bin.ts`): starts with `#!/usr/bin/env node`. It creates an `AbortController` and sets `process.on("SIGINT")`: the first press aborts, a second calls `process.exit(130)`. Then `process.exitCode = await main(process.argv.slice(2), { signal })`.

- [ ] **Step 1: Write the failing tests.** Port the remaining tests in `legacy/tests/test_main.py` (single run, batch, preflight, export subcommand, `history.json` shape, prompt files, `find`/`eval` absent from `prompts/playwright-cli.md`), keeping names and assertions.
  - `monkeypatch.setattr(Agent, "run", …)` becomes `deps.createAgent`.
  - `monkeypatch.setattr(m, "SYSTEM_MD", …)` becomes `deps.prompts`.
  - `shutil.which` becomes `deps.which`, and `capsys` becomes collecting `deps.stdout`/`deps.stderr`.
  - `monkeypatch.chdir` becomes `process.chdir` into a temp dir, restored in `afterEach`.
  - A `KeyboardInterrupt` raised from `run` becomes `throw new AbortedError()`.

  Port `legacy/tests/test_naming.py` to `test/naming.test.ts`, scanning the repo root and adding `node_modules` and `legacy` to the skipped folders. Add:

```ts
test("abort writes interrupted history and exits 130", async () => {
  const ac = new AbortController();
  const code = await main(["x"], deps({ signal: ac.signal, createAgent: () => ({ costUsd: 0.02, run: async () => { ac.abort(); throw new AbortedError(); } }) }));
  assert.equal(code, 130);
  const h = readHistory();
  assert.equal(h.answer, "interrupted");
  assert.equal(h.cost_usd, 0.02);
  assert.deepEqual(errLines, ["interrupted"]);
});
test("spawn failure is reported as error and exits 1", async () => {
  const e = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const code = await main(["x"], deps({ createAgent: () => ({ costUsd: 0, run: async () => { throw e; } }) }));
  assert.equal(code, 1);
  assert.equal(readHistory().answer, "error: Error: spawn claude ENOENT");
});
test("batch after abort skips the rest", async () => { /* 3 files; the first run aborts → summary rows: stop, skip, skip; exit 130 */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/cli.test.ts test/naming.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/cli.ts` and `src/bin.ts`** as a port of `__main__.py`: `main`, `_export_main`, `_preflight`, `_run_one`, `_run_batch`.
  - `_args_for` becomes `parseRunArgs(argv, prompts.defaultSkill, tf.settings)` with `task` replaced by `tf.task`.
  - The `PlaywrightCLI` and `Brain` get `deps.signal`. `AgentOptions.signal` is `deps.signal` too.
  - `_run_one` catches `PlaywrightError` (exit 1, `playwright error: …`), then `AbortedError` (exit 130, `interrupted`), then any other error (exit 1, `` `error: ${e.name}: ${e.message}` ``).
  - `history.json` is written with `JSON.stringify(data, null, 2)`. Costs print with `toFixed(4)`.
  - A `UsageError` prints `usage` and then `duckwright: error: <message>` to stderr and returns `2`. Help prints to stdout and returns `0`. Version prints `duckwright <version()>` and returns `0`.
- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, every test file.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/bin.ts test/cli.test.ts test/naming.test.ts
git commit -m "feat(ts): duckwright command line, batch runs and Ctrl-C handling"
```

---

### Task 12: Packaging, install smoke test, release workflow, README

**Files:**
- Create: `scripts/smoke_install.sh`, `test/packaging.test.ts`, `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml` (add the smoke step to the `node` job), `README.md`

**Interfaces:**
- Consumes: `package.json` (Task 2), `dist/bin.js` (Task 11 build).

- [ ] **Step 1: Write the failing packaging test.** In `test/packaging.test.ts`, run `npm pack --dry-run --json --ignore-scripts` (after `npm run build` in a `before` hook) and assert:

```ts
const files = pack[0].files.map((f: { path: string }) => f.path).sort();
for (const p of ["dist/bin.js", "dist/cli.js", "prompts/system.md", "prompts/playwright-cli.md",
  "prompts/snapshot-full.md", "prompts/snapshot-grep.md", "prompts/snapshot-hybrid.md",
  "package.json", "README.md", "LICENSE"]) assert.ok(files.includes(p), p);
assert.ok(!files.some((p: string) => /^(src|test|legacy|scripts)\//.test(p)));
assert.equal(pack[0].name, "duckwright");
assert.deepEqual(pkg.bin, { duckwright: "dist/bin.js" });
assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
assert.ok(fs.readFileSync("dist/bin.js", "utf8").startsWith("#!/usr/bin/env node\n"));
```

- [ ] **Step 2: Run to verify failure, then make it pass.** Run `node --test test/packaging.test.ts`; it fails until `files`/`bin` are right and the build emits `bin.js`. Fix and re-run until it passes.
- [ ] **Step 3: Write `scripts/smoke_install.sh`.** It runs `npm pack` into a temp dir and `npm install -g --prefix "$prefix" <tarball>`. It then checks that `"$prefix/bin/duckwright" --version` prints exactly `duckwright <version from package.json>`. Finally it runs `env PATH="$emptydir" "$(command -v node)" "$prefix/lib/node_modules/duckwright/dist/bin.js" x` and expects exit `2` and `claude CLI not found` on stderr. That run proves the bundled prompts resolve, and it can never reach a real `claude`. Print `smoke ok`.

Run: `bash scripts/smoke_install.sh`
Expected: `smoke ok`.

- [ ] **Step 4: CI and release.** Add `- run: bash scripts/smoke_install.sh` after the build step in the `node` job. Write `release.yml`: trigger on tags `v*`. Steps: `setup-node` with `registry-url: https://registry.npmjs.org`, a check that `${GITHUB_REF_NAME#v}` equals `node -p "require('./package.json').version"`, `npm ci`, `npm test`, `npm run build`, `bash scripts/smoke_install.sh`, then `npm publish --provenance --access public`, with `permissions: id-token: write, contents: read` and `environment: npm`.
- [ ] **Step 5: Update `README.md`.**
  - Python badge → `![Node](https://img.shields.io/badge/node-%3E%3D22.18-blue)`.
  - Prerequisites: Node.js 22.18 or later instead of Python.
  - Install: `npm install -g github:locle97/duckwright`, or from a clone `npm install && npm run build && npm install -g .`, or from a tarball (`npm pack`).
  - Upgrading section: `pipx uninstall duckwright` first.
  - The skill-copy note now points at `prompts/playwright-cli.md` and `test/cli.test.ts`.
  - "No Python dependencies" feature → "No runtime dependencies".
  - Development: `npm install`, `npm test`, `DUCKWRIGHT_E2E=1 npm test`.
  - Roadmap: "PyPI release" → "npm release" (`release.yml` needs npm trusted publishing set up for the package first).
  - Add one line under Development: "The original Python version lives, frozen, in `legacy/`."
- [ ] **Step 6: Run everything**

Run: `npm test && npm run build && bash scripts/smoke_install.sh && (cd legacy && python -m pytest -q)`
Expected: all pass, `smoke ok`.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke_install.sh test/packaging.test.ts .github/workflows README.md package.json
git commit -m "build(ts): npm packaging, install smoke test, release workflow, README"
```

---

### Task 13: Live parity check

**Files:**
- Create: `test/e2e.test.ts`
- Create: `docs/superpowers/plans/2026-10-04-typescript-migration-parity.md` (the results table)

**Interfaces:**
- Consumes: `Agent`, `Brain`, `PlaywrightCLI`, `pageDir`, `PROMPTS` (Tasks 3–11).

- [ ] **Step 1: Port `legacy/tests/test_e2e.py`** to `test/e2e.test.ts`. `test_missing_skill_exits` runs `node src/bin.ts x --skill /nope` and expects exit `2` and `playwright-cli skill not found`. The three `test_e2e_form` modes are skipped unless `process.env.DUCKWRIGHT_E2E === "1"`, with the same assertions.
- [ ] **Step 2: Run the live e2e** (needs `claude` logged in and `playwright-cli` installed)

Run: `DUCKWRIGHT_E2E=1 node --test test/e2e.test.ts`
Expected: 4 pass.

- [ ] **Step 3: Run the six benchmark tasks with both versions.** Run `node dist/bin.js -f benchmark_tasks/ --export` and `cd legacy && python -m duckwright -f ../benchmark_tasks/ --export`. In the parity doc, record each task's pass/fail, step count and cost for both versions, and whether the exported specs pass `npx playwright test`. Expected: the same pass/fail per task. Steps and cost may vary, as the model is not deterministic.
- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts docs/superpowers/plans/2026-10-04-typescript-migration-parity.md
git commit -m "test(ts): live e2e and benchmark parity with the legacy version"
```
