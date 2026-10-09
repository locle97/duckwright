# Environment Context QA Test Plan

**Goal:** Add a per-environment context file (`environments/<name>.md`, chosen with `--env <name>`, a task file's `env:` or the config's `env`) whose text is seeded into every step's prompt, so the agent starts each run knowing the environment under test, and tick the roadmap item.
**Spec:** `docs/superpowers/specs/2026-10-09-environment-context-design.md`
**Scope:** Black-box CLI, file, HTTP and UI scenarios against the spec's Contracts (C1 to C10). Unit and integration tests are covered by the implementation and are not repeated here.

## Environment

Runs use a real browser through the real `playwright-cli`. Only `claude` is replaced by a scripted stub that saves every prompt it receives, so QA can read exactly what the agent was sent. Both are found through `PATH`, which is how Duckwright finds them.

- **Tools:** Node >= 22.18, `bash`, `jq`, `curl`, `sed`, `stat`, `iconv` (optional), a browser with DevTools, a terminal of at least 120x40 for the TUI. `playwright-cli` installed as README -> Prerequisites describes.
- **User:** run everything as a **non-root** user. Root ignores file permissions, which makes TS-15 impossible.
- **Build gate:** in the branch checkout (`$REPO`), `npm ci && npm run build`, then `export DW="node $REPO/dist/bin.js"`. For TS-54 only, also build `main` in a second checkout `$MAIN` (`git -C $REPO worktree add $MAIN main && cd $MAIN && npm ci && npm run build`) and `export DW_MAIN="node $MAIN/dist/bin.js"`.
- **QA workspace:** `export QA_WORK=/tmp/dw-env QA_DIR=/tmp/dw-env/out XDG_CONFIG_HOME=/tmp/dw-env/xdg`, then `mkdir -p $QA_WORK/bin $QA_WORK/scripts $QA_WORK/tasks $QA_WORK/qa-envs $QA_DIR $XDG_CONFIG_HOME/duckwright` and `cd $QA_WORK`. Run every `$DW` command from `$QA_WORK`: it is the current working directory, so names resolve to `$QA_WORK/environments/<name>.md` and runs land in `$QA_WORK/runs/`. `XDG_CONFIG_HOME` keeps your real `duckwright.conf` out of the way; the config file is `$CONF=$XDG_CONFIG_HOME/duckwright/duckwright.conf`.
- **PATH:** `export PATH="$QA_WORK/bin:$PATH"` (after `playwright-cli` is installed, so the real one is still found after the stub dir).
- **Fixture server:** `node $QA_WORK/qa-server.mjs` in a second terminal. It serves `http://localhost:8765`.
- **Run a script (print mode):** `QA_SCRIPT=$QA_WORK/scripts/<NAME> $DW -p "QA task" --session qa-env --max-steps 6 [flags]`. The stub answers the Nth brain call of a run with `scripts/<NAME>/N.json` and saves each prompt as `$QA_DIR/prompt-<G>.txt`, where `G` counts every call since the reset (1, 2, 3, ... across runs and batch tasks).
- **Read a prompt's environment section:** `sec() { sed -n '/^<environment>$/,/^<\/environment>$/p' "$1"; }`, e.g. `sec $QA_DIR/prompt-1.txt`.
- **Locate the run:** after a reset there is one run: `RUN=$(ls -d $QA_WORK/runs/2*/)`.
- **Web UI:** `QA_SCRIPT=... $DW --web --port 4173 [flags]` from `$QA_WORK`. It prints `http://127.0.0.1:4173/?t=<token>`. Open that URL; set `TOKEN=<token> PORT=4173`. API calls: `C="Cookie: dw_token_$PORT=$TOKEN"`, `O="Origin: http://127.0.0.1:$PORT"`, `B=http://127.0.0.1:$PORT`, `J="Content-Type: application/json"`. Task ids: `curl -s -H "$C" $B/api/state | jq '.tasks[] | {id, name}'`. Add a typed task: `curl -s -X POST -H "$C" -H "$O" -H "$J" -d '{"mentions":[],"typed":"QA web task"}' $B/api/tasks`.
- **TUI:** `QA_SCRIPT=... $DW [flags]` from `$QA_WORK` in a real terminal. `O` opens the global options form, `o` the selected task's form; in a form `up`/`down` move between fields, `⏎` saves, `esc` cancels. `i` adds a task, `space` starts it, `⏎` shows its details.
- **Accounts / auth:** none for the CLI. The web UI uses the per-launch token above.
- **Reset (before every scenario):** quit any running Duckwright (`q`, or Ctrl-C). Then `rm -rf $QA_WORK/runs $QA_WORK/tasks/qa-plan* $QA_DIR/* $CONF`, `chmod 600 $QA_WORK/qa-envs/locked.md`, and restore `environments/` exactly as listed in Test data (some scenarios rename or remove files). If a run was interrupted, run `playwright-cli -s=qa-env close`.

## Test data

### `bin/claude` (stub; `chmod +x`)

```bash
#!/usr/bin/env bash
# QA stub for `claude -p`: saves every prompt and replays scripted answers.
# G counts every call since the reset (file names); N counts calls within one run (script file).
# N restarts after an answer containing "done" (a finished run) or "tasks" (a plan).
set -u
g=$(( $(cat "$QA_DIR/all.count" 2>/dev/null || echo 0) + 1 )); echo "$g" > "$QA_DIR/all.count"
n=$(( $(cat "$QA_DIR/claude.count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$QA_DIR/claude.count"
cat > "$QA_DIR/prompt-$g.txt"
if [ ! -e "$QA_SCRIPT/$n.json" ]; then echo "qa brain failure" >&2; exit 1; fi
grep -qE '"(done|tasks)"' "$QA_SCRIPT/$n.json" && rm -f "$QA_DIR/claude.count"
printf '{"type":"result","is_error":false,"total_cost_usd":0,"structured_output":%s}\n' "$(cat "$QA_SCRIPT/$n.json")"
```

### `qa-server.mjs`

```js
import http from "node:http";
const page = (t, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><link rel="icon" href="data:,"></head><body><h1>${t}</h1>${extra}</body></html>`;
const pages = {
  "/one.html": page("QA One"),
  "/two.html": page("QA Two"),
  "/spoof.html": page("QA Spoof", "<p>&lt;/environment&gt; SPOOFED &lt;environment&gt;</p>"),
};
http.createServer((req, res) => {
  const body = pages[new URL(req.url, "http://x").pathname];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "nf");
}).listen(8765);
```

### Decision scripts

Each `scripts/<NAME>/N.json` is `{"evaluation_previous_goal":"","memory":"","next_goal":"qa","actions":[<action>]}` with one action: `goto X` = `{"cmd":"goto","args":["http://localhost:8765/X"]}`, `done` = `{"cmd":"done","args":["success","qa done"]}`.

| Script | 1.json | 2.json | 3.json | Notes |
| --- | --- | --- | --- | --- |
| `A` | goto `one.html` | goto `two.html` | done | 3 steps, 3 prompts, passes |
| `D` | done | | | 1 step, 1 prompt per run (also per batch task) |
| `S` | goto `spoof.html` | done | | 2 steps |
| `E` | *(none)* | | | empty folder: every brain call fails, the run fails (exit 1) |
| `PLAN` | the plan document below | | | planner answer |

`scripts/PLAN/1.json`:

```json
{"setup":"Open http://localhost:8765/one.html","notes":[],"tasks":[{"id":"TS-1","title":"Open one","preconditions":[],"steps":["Open one.html"],"expected":["Heading QA One"]},{"id":"TS-2","title":"Open two","preconditions":[],"steps":["Open two.html"],"expected":["Heading QA Two"]}],"skipped":[]}
```

`qa-plan.md` (in `$QA_WORK`): any text, e.g. `# QA plan` / `TS-1 open one` / `TS-2 open two`. Planning it writes `tasks/qa-plan/`.

### Environment folder `$QA_WORK/environments/` (the listed set)

| File | Content (exact) |
| --- | --- |
| `staging.md` | `# Staging` / `QA-ENV-STAGING base URL http://localhost:8765` / `Off-limits: /admin` (3 lines, trailing newline) |
| `prod.md` | `QA-ENV-PROD` |
| `cfg.md` | `QA-ENV-CFG` |
| `none.md` | `QA-ENV-NONEFILE` |
| `.hidden.md` | `QA-ENV-HIDDEN` |
| `notes.txt` | `QA-ENV-TXT-IN-DIR` |
| `Upper.MD` | `QA-ENV-UPPER` |
| `bad name.md` | `QA-ENV-BADNAME` |
| `adir.md/` | an empty **directory** |

Expected picker list for this folder (D15): `["cfg","prod","staging"]`.

### Path fixtures `$QA_WORK/qa-envs/`

| File | How to make it |
| --- | --- |
| `crlf.md` | `printf '\xEF\xBB\xBF\n  QA-ENV-CRLF line1\r\nline2  \r\n\n' > qa-envs/crlf.md` |
| `plain.txt` | `printf 'QA-ENV-PLAINTXT\n' > qa-envs/plain.txt` |
| `empty.md` | `printf '  \n\n\t\n' > qa-envs/empty.md` (whitespace only) |
| `big-ok.md` | `head -c 16384 /dev/zero \| tr '\0' a > qa-envs/big-ok.md` (exactly 16384 bytes) |
| `big.md` | `head -c 16385 /dev/zero \| tr '\0' a > qa-envs/big.md` (16385 bytes) |
| `badutf.md` | `printf 'QA\xff\xfe\n' > qa-envs/badutf.md` |
| `locked.md` | `printf 'QA-ENV-LOCKED\n' > qa-envs/locked.md`; scenarios that need it run `chmod 000` |
| `secret.md` | `printf 'QA-ENV-SECRET totp JBSWY3DPEHPK3PXP\n' > qa-envs/secret.md` |

Config-folder fixture: `mkdir -p $XDG_CONFIG_HOME/duckwright/envs-cfg && printf 'QA-ENV-CONFIGDIR\n' > $XDG_CONFIG_HOME/duckwright/envs-cfg/c.md`.

### Task files `$QA_WORK/tasks/`

Front-matter lines are shown separated by ` / `; line 1 is `---`.

- `t-plain.md`: `QA plain task` (no front matter)
- `t-prod.md`: `---` / `env: prod` / `---` / `QA prod task`
- `t-none.md`: `---` / `env: none` / `---` / `QA none task`
- `t-rel.md`: `---` / `env: ../qa-envs/crlf.md` / `---` / `QA rel task` (resolved from `tasks/`, so it is `$QA_WORK/qa-envs/crlf.md`; from the cwd it would be `/tmp/qa-envs/crlf.md`, which does not exist)
- `t-nope.md`: `---` / `env: nope` / `---` / `QA nope task`
- `t-big.md`: `---` / `env: ../qa-envs/big.md` / `---` / `QA big task`
- `bad-env.md`: `---` / `env: bad name` / `---` / `QA bad`. Bad value on line 2.
- `empty-env.md`: `---` / `env:` / `---` / `QA bad`. Line 2.
- `dup-env.md`: `---` / `env: prod` / `env: cfg` / `---` / `QA dup`. Second key on line 3.

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C1, C2, C3, C7 | TS-1, TS-2, TS-3, TS-4, TS-5, TS-6, TS-7, TS-8, TS-9, TS-17, TS-51, TS-54 |
| SC2 | C1, C4, C10 | TS-20, TS-21, TS-22, TS-23, TS-24, TS-25, TS-26, TS-27, TS-28, TS-29, TS-30, TS-31, TS-34, TS-50, TS-55, TS-56 |
| SC3 | C1, C2 | TS-10, TS-11, TS-12, TS-13, TS-14, TS-15, TS-16, TS-17, TS-18, TS-19, TS-38, TS-42, TS-48 |
| SC4 | C9 | TS-32, TS-33, TS-54 |
| SC5 | C5, C6 | TS-35, TS-36, TS-37, TS-38, TS-39, TS-40, TS-41, TS-42, TS-43, TS-44, TS-45, TS-46, TS-47, TS-48, TS-49, TS-57 |
| SC6 | C7, C8 | TS-51, TS-52, TS-53 |
| All (build) | all | TS-0 |

| Contract | Scenarios |
| --- | --- |
| C1 `--env` option | TS-1, TS-2, TS-5, TS-6, TS-7, TS-10, TS-11, TS-19, TS-22, TS-23, TS-24 |
| C2 environment file | TS-1, TS-3, TS-4, TS-12 to TS-18, TS-38, TS-42, TS-48 |
| C3 `<environment>` prompt section | TS-1, TS-3, TS-8, TS-9, TS-54 |
| C4 task-file / config key | TS-20, TS-21, TS-24, TS-25, TS-26, TS-27, TS-28, TS-34, TS-49, TS-55 |
| C5 web API overrides | TS-35, TS-36, TS-37, TS-38 |
| C6 TUI / web picker and display | TS-39 to TS-48, TS-57 |
| C7 system prompt wording | TS-51 |
| C8 docs and example | TS-52, TS-53 |
| C9 `history.json` `env` | TS-32, TS-33, TS-54 |
| C10 plan-mode `env:` | TS-29, TS-30, TS-31, TS-50, TS-56 |

## Scenarios

### TS-0: Build gate: typecheck and tests pass

**Contract:** all · **Criteria:** all · **Type:** CLI · **Priority:** P1

**Preconditions:** branch checkout, `npm ci` done.

**Steps:**
1. In `$REPO`, run `npm test; echo "exit=$?"`.

**Expected:**
- Prints `exit=0`.

### TS-1: `--env staging` puts the file's text into every step prompt, right after the task

**Contract:** C1, C2, C3 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; fixture server running; `environments/staging.md` as in Test data.

**Steps:**
1. Run Script `A` with `--env staging`. Note the exit code.
2. Run `ls $QA_DIR/prompt-*.txt`.
3. For each of `prompt-1.txt`, `prompt-2.txt`, `prompt-3.txt`, run `sec $QA_DIR/prompt-N.txt`.
4. Run `grep -n -E '^<(/?task|environment|/environment|memory)>' $QA_DIR/prompt-1.txt`.

**Expected:**
- Exit code `0`.
- Exactly three prompt files (one per step).
- Each `sec` output is exactly:
  ```
  <environment>
  # Staging
  QA-ENV-STAGING base URL http://localhost:8765
  Off-limits: /admin
  </environment>
  ```
- In step 4 the order of the matching lines is `</task>` (or the task block's closing line), then `<environment>`, then `</environment>`, then `<memory>`; the line before `<environment>` is blank, and the line after `</environment>` is blank.

### TS-2: `--env=staging` form is accepted

**Contract:** C1 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3

**Preconditions:** reset; fixture server running.

**Steps:**
1. Run Script `D` with `--env=staging`.
2. Run `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Exit code `0`; the section is the same as in TS-1.

### TS-3: A path value is relative to the cwd and its text is normalised (BOM, CRLF, trim)

**Contract:** C1, C2, C3 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; fixture server running; `qa-envs/crlf.md`.

**Steps:**
1. Run Script `D` with `--env qa-envs/crlf.md`.
2. Run `sec $QA_DIR/prompt-1.txt | od -c | head`.
3. Run `jq -c .env $RUN/history.json`.

**Expected:**
- Exit code `0`.
- The section is exactly `<environment>`, `QA-ENV-CRLF line1`, `line2`, `</environment>` (four lines): no BOM bytes (`357 273 277`), no `\r`, no leading blank line or leading spaces before `QA-ENV-CRLF`, no trailing spaces after `line2`.
- History: `{"name":"crlf","path":"/tmp/dw-env/qa-envs/crlf.md"}`.

### TS-4: A non-markdown path is used verbatim

**Contract:** C2 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; fixture server running; `qa-envs/plain.txt`.

**Steps:**
1. Run Script `D` with `--env qa-envs/plain.txt`.
2. Run `sec $QA_DIR/prompt-1.txt` and `jq -c .env $RUN/history.json`.

**Expected:**
- Exit code `0`; the section holds the single line `QA-ENV-PLAINTXT`.
- History: `{"name":"plain.txt","path":"/tmp/dw-env/qa-envs/plain.txt"}` (only a `.md` extension is dropped from the label).

### TS-5: `none` means no environment; a file named `none.md` is reachable only by path

**Contract:** C1, C2 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3

**Preconditions:** reset; fixture server running; `environments/none.md`.

**Steps:**
1. Run Script `D` with `--env none`. Run `grep -c '<environment>' $QA_DIR/prompt-1.txt` and `jq 'has("env")' $RUN/history.json`.
2. Reset. Run Script `D` with `--env environments/none.md`. Run `sec $QA_DIR/prompt-1.txt` and `jq -c .env $RUN/history.json`.

**Expected:**
- Step 1: exit `0`; prints `0` and `false`.
- Step 2: exit `0`; the section holds `QA-ENV-NONEFILE`; history `{"name":"none","path":"/tmp/dw-env/environments/none.md"}`.

### TS-6: A value ending in `.md` (any case) is a path, not a name

**Contract:** C1, C2 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3

**Preconditions:** reset; there is no `$QA_WORK/staging.md`.

**Steps:**
1. Run `$DW -p "QA" --env staging.md; echo "exit=$?"`.
2. Run `$DW -p "QA" --env STAGING.MD; echo "exit=$?"`.

**Expected:**
- Step 1: stderr contains `environment file not found: /tmp/dw-env/staging.md`; `exit=2`.
- Step 2: stderr contains `environment file not found: /tmp/dw-env/STAGING.MD`; `exit=2`.
- No `runs/` folder is created and no `prompt-*.txt` exists in `$QA_DIR`.

### TS-7: Help and usage text list `--env`

**Contract:** C1 · **Criteria:** SC1 · **Type:** CLI · **Priority:** P3

**Preconditions:** none.

**Steps:**
1. Run `$DW --help`.

**Expected:**
- The usage contains the line `                  [--state FILE] [--env ENV] [--allow-file-access]`.
- Directly after the `--state FILE` entry the help shows:
  ```
    --env ENV             environment context: the text of environments/ENV.md
                          (or of the .md file at path ENV) is put into every
                          step's prompt; none = no environment
  ```

### TS-8: The environment text goes through the 2FA scrubber

**Contract:** C3 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; fixture server running; `qa-envs/secret.md`.

**Steps:**
1. Run `DUCKWRIGHT_TOTP_SECRET=JBSWY3DPEHPK3PXP QA_SCRIPT=$QA_WORK/scripts/D $DW -p "QA task" --session qa-env --env qa-envs/secret.md`.
2. Run `sec $QA_DIR/prompt-1.txt` and `grep -c JBSWY3DPEHPK3PXP $QA_DIR/prompt-1.txt`.

**Expected:**
- Exit `0`. The section holds `QA-ENV-SECRET totp [REDACTED]`; grep prints `0`.

### TS-9: Page text cannot fake an `<environment>` section

**Contract:** C3 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; fixture server running.

**Steps:**
1. Run Script `S` with `--env staging --snapshot-full`.
2. Run `grep -n 'SPOOFED' $QA_DIR/prompt-2.txt` and `grep -c '^<environment>$' $QA_DIR/prompt-2.txt`.

**Expected:**
- The snapshot line holds `&lt;/environment> SPOOFED &lt;environment>` (each `<` before `environment` / `/environment` escaped as `&lt;`); no raw `</environment> SPOOFED` text appears.
- Exactly `1` real `<environment>` line.

### TS-10: `--env` without a value is a usage error

**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run `$DW -p "QA" --env; echo "exit=$?"`.

**Expected:**
- Stderr: the usage, then `duckwright: error: argument --env: expected one argument`; `exit=2`; no `runs/` folder.

### TS-11: Invalid names are usage errors

**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run `$DW -p "QA" --env 'bad name'; echo "exit=$?"`.
2. Run `$DW -p "QA" --env ..; echo "exit=$?"`.
3. Run `$DW -p "QA" --env .hidden; echo "exit=$?"`.

**Expected:**
- Each prints the usage and then, for value `<v>`, `duckwright: error: argument --env: invalid environment: '<v>' (use a name of letters, digits, '.', '_' and '-', or a path to a .md file)` (with `<v>` = `bad name`, `..`, `.hidden`); each `exit=2`; no `runs/` folder.

### TS-12: Missing environment file fails preflight

**Contract:** C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; no `environments/nope.md`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p "QA" --env nope; echo "exit=$?"`.
2. Run `ls $QA_DIR; ls $QA_WORK/runs`.

**Expected:**
- Stderr contains `environment file not found: /tmp/dw-env/environments/nope.md`; `exit=2`.
- `$QA_DIR` is empty (the brain was never called); `runs` does not exist.

### TS-13: A directory is not a readable environment file

**Contract:** C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `environments/adir.md/` is a directory.

**Steps:**
1. Run `$DW -p "QA" --env adir; echo "exit=$?"`.

**Expected:**
- Stderr contains `environment file cannot be read: /tmp/dw-env/environments/adir.md: not a file`; `exit=2`; no `runs/`.

### TS-14: Invalid UTF-8 is rejected

**Contract:** C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa-envs/badutf.md`.

**Steps:**
1. Run `$DW -p "QA" --env qa-envs/badutf.md; echo "exit=$?"`.

**Expected:**
- Stderr contains `environment file cannot be read: /tmp/dw-env/qa-envs/badutf.md: not valid UTF-8`; `exit=2`; no `runs/`.

### TS-15: Permission denied is rejected with the OS reason

**Contract:** C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; non-root user; `chmod 000 $QA_WORK/qa-envs/locked.md`.

**Steps:**
1. Run `$DW -p "QA" --env qa-envs/locked.md; echo "exit=$?"`.
2. Run `chmod 600 $QA_WORK/qa-envs/locked.md`.

**Expected:**
- Stderr contains a line starting `environment file cannot be read: /tmp/dw-env/qa-envs/locked.md: ` followed by a non-empty OS error message that mentions permission (for example containing `EACCES` or `permission denied`); `exit=2`; no `runs/`.

### TS-16: An empty or whitespace-only file is rejected

**Contract:** C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa-envs/empty.md`.

**Steps:**
1. Run `$DW -p "QA" --env qa-envs/empty.md; echo "exit=$?"`.

**Expected:**
- Stderr contains `environment file is empty: /tmp/dw-env/qa-envs/empty.md`; `exit=2`; no `runs/`.

### TS-17: Size limit: exactly 16384 bytes is accepted

**Contract:** C2 · **Criteria:** SC1, SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; fixture server running; `qa-envs/big-ok.md` (`stat -c %s` prints `16384`).

**Steps:**
1. Run Script `D` with `--env qa-envs/big-ok.md`.
2. Run `sec $QA_DIR/prompt-1.txt | sed -n 2p | tr -d '\n' | wc -c`.

**Expected:**
- Exit `0`; step 2 prints `16384`.

### TS-18: Size limit: 16385 bytes is rejected

**Contract:** C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa-envs/big.md` (16385 bytes).

**Steps:**
1. Run `$DW -p "QA" --env qa-envs/big.md; echo "exit=$?"`.

**Expected:**
- Stderr contains `environment file too large: /tmp/dw-env/qa-envs/big.md is 16385 bytes (limit 16384)`; `exit=2`; no `runs/`.

### TS-19: Batch: every task's environment problem is reported, nothing runs

**Contract:** C1, C2 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `tasks/t-nope.md`, `tasks/t-big.md`, `tasks/t-plain.md`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-nope.md tasks/t-big.md tasks/t-plain.md; echo "exit=$?"`.

**Expected:**
- Stderr is exactly these two lines, in this order:
  ```
  tasks/t-nope.md: environment file not found: /tmp/dw-env/environments/nope.md
  tasks/t-big.md: environment file too large: /tmp/dw-env/qa-envs/big.md is 16385 bytes (limit 16384)
  ```
- `exit=2`; `$QA_DIR` is empty; no `runs/`.

### TS-20: Config `env` applies when nothing else sets one

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; fixture server running; `$CONF` contains the single line `env: cfg`.

**Steps:**
1. Run Script `D` (typed task, no `--env`).
2. Run `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Exit `0`; the section holds `QA-ENV-CFG`.

### TS-21: Task file `env:` beats the config

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1

**Preconditions:** reset; fixture server running; `$CONF` is `env: cfg`; `tasks/t-prod.md`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-prod.md --session qa-env`.
2. Run `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Exit `0`; the section holds `QA-ENV-PROD` and not `QA-ENV-CFG`.

### TS-22: `--env` beats the task file and the config

**Contract:** C1, C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P1

**Preconditions:** reset; fixture server running; `$CONF` is `env: cfg`; `tasks/t-prod.md`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-prod.md --session qa-env --env staging`.
2. Run `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Exit `0`; the section is the staging text of TS-1 and holds neither `QA-ENV-PROD` nor `QA-ENV-CFG`.

### TS-23: Batch: `--env` applies to every file, overriding each file's `env:` (D6)

**Contract:** C1 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; fixture server running; no config; `tasks/t-prod.md`, `tasks/t-plain.md`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-prod.md tasks/t-plain.md --session qa-env --env staging`.
2. Run `sec $QA_DIR/prompt-1.txt` and `sec $QA_DIR/prompt-2.txt`.
3. Reset. Run the same command without `--env`, then `sec` both prompts.

**Expected:**
- Step 1: exit `0`; both sections hold `QA-ENV-STAGING`.
- Step 3: prompt-1 (t-prod) holds `QA-ENV-PROD`; prompt-2 (t-plain) has no `<environment>` section.

### TS-24: `none` cancels a lower-level environment at the CLI and in a task file

**Contract:** C1, C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; fixture server running; `$CONF` is `env: cfg`; `tasks/t-none.md`, `tasks/t-prod.md`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-none.md --session qa-env`.
2. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-prod.md --session qa-env --env none`.
3. Run `grep -c '<environment>' $QA_DIR/prompt-1.txt $QA_DIR/prompt-2.txt` and `jq 'has("env")' $QA_WORK/runs/*/history.json`.

**Expected:**
- Both runs exit `0`; both grep counts are `0`; both `has("env")` print `false`.

### TS-25: A relative `env:` path in a task file resolves from the task file's folder

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; fixture server running; `tasks/t-rel.md`; `/tmp/qa-envs/crlf.md` does not exist.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/t-rel.md --session qa-env`.
2. Run `sec $QA_DIR/prompt-1.txt` and `jq -c .env $RUN/history.json`.

**Expected:**
- Exit `0`; the section holds `QA-ENV-CRLF line1` / `line2`; history `{"name":"crlf","path":"/tmp/dw-env/qa-envs/crlf.md"}`.

### TS-26: A relative config `env` path resolves from the config's folder

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P3

**Preconditions:** reset; fixture server running; config-folder fixture made; `$CONF` is `env: envs-cfg/c.md`.

**Steps:**
1. Run Script `D` with no `--env`.
2. Run `sec $QA_DIR/prompt-1.txt` and `jq -r .env.path $RUN/history.json`.

**Expected:**
- Exit `0`; the section holds `QA-ENV-CONFIGDIR`; path is `/tmp/dw-env/xdg/duckwright/envs-cfg/c.md`.

### TS-27: Bad `env:` lines in a task file

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `tasks/bad-env.md`, `tasks/empty-env.md`, `tasks/dup-env.md`.

**Steps:**
1. Run `$DW -p -f tasks/bad-env.md; echo "exit=$?"`.
2. Run `$DW -p -f tasks/empty-env.md; echo "exit=$?"`.
3. Run `$DW -p -f tasks/dup-env.md; echo "exit=$?"`.

**Expected:**
- Step 1: stderr has `<file>:2: env must be an environment name (letters, digits, ".", "_", "-") or a path, got "bad name"`, where `<file>` names `tasks/bad-env.md`; `exit=2`.
- Step 2: `<file>:2: "env" has no value` (file `tasks/empty-env.md`); `exit=2`.
- Step 3: `<file>:3: "env" is set twice` (file `tasks/dup-env.md`); `exit=2`.
- No `runs/` in any case.

### TS-28: A bad config `env` value stops every command

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `$CONF` is the single line `env: ..`.

**Steps:**
1. Run `$DW -p "QA"; echo "exit=$?"`.

**Expected:**
- Stderr: `/tmp/dw-env/xdg/duckwright/duckwright.conf:1: env must be an environment name (letters, digits, ".", "_", "-") or a path, got ".."`; `exit=2`; no `runs/`.

### TS-29: Plan mode with `--env <name>` writes `env:` into every task file

**Contract:** C10 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; `qa-plan.md`; `scripts/PLAN`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/PLAN $DW plan qa-plan.md -p --env staging; echo "exit=$?"`.
2. Run `ls tasks/qa-plan tasks/qa-plan/shared` and `head -5 tasks/qa-plan/01-*.md tasks/qa-plan/02-*.md`.
3. Run `grep -c '^env:' tasks/qa-plan/shared/setup.md`.
4. Reset `$QA_DIR` only (`rm -f $QA_DIR/*`); start the fixture server; run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/qa-plan/01-*.md --session qa-env`, then `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- `exit=0`; the folder holds two task files, `plan.json` and `shared/setup.md`.
- Each task file's front matter is, in order: `---`, the existing `# From …, scenario TS-N` comment, `setup: shared/setup.md`, `env: staging`, `---`.
- Step 3 prints `0`.
- Step 4: exit `0`; the section holds `QA-ENV-STAGING`.

### TS-30: Plan mode with a path `--env` writes the path relative to the planned folder

**Contract:** C10 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; `qa-plan.md`; `scripts/PLAN`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/PLAN $DW plan qa-plan.md -p --env qa-envs/crlf.md`.
2. Run `grep '^env:' tasks/qa-plan/01-*.md`.
3. Clear `$QA_DIR`, run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/qa-plan/01-*.md --session qa-env` and `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Step 2: `env: ../../qa-envs/crlf.md`.
- Step 3: exit `0`; the section holds `QA-ENV-CRLF line1` / `line2`.

### TS-31: Running an existing planned folder with `--env` uses it for the runs but writes nothing (D23)

**Contract:** C10 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** TS-29 step 1 done (folder `tasks/qa-plan/` with `env: staging` in both task files); `$QA_DIR` cleared (`rm -f $QA_DIR/*`); fixture server running.

**Steps:**
1. Run `md5sum tasks/qa-plan/*.md tasks/qa-plan/shared/setup.md tasks/qa-plan/plan.json`.
2. Run `QA_SCRIPT=$QA_WORK/scripts/D $DW -p -f tasks/qa-plan/ --session qa-env --env prod; echo "exit=$?"`.
3. Run `sec $QA_DIR/prompt-1.txt` and `sec $QA_DIR/prompt-2.txt`.
4. Run the `md5sum` of step 1 again and `ls -d tasks/qa-plan*`.

**Expected:**
- Step 2: both tasks run; `exit=0`.
- Step 3: both sections hold `QA-ENV-PROD` and not `QA-ENV-STAGING` (`--env` beats each file's `env:`).
- Step 4: the checksums equal those of step 1; only `tasks/qa-plan` exists (no `tasks/qa-plan-2/`).
- Note: `duckwright plan tasks/qa-plan/ -p` is not used, because `-p` refuses an already-planned folder (exit 2) and never reaches the D23 behavior.

### TS-32: `history.json` records the environment's name and path, never its text

**Contract:** C9 · **Criteria:** SC4 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; fixture server running.

**Steps:**
1. Run Script `A` with `--env staging`.
2. Run `jq -c .env $RUN/history.json`.
3. Run `jq -c 'keys_unsorted' $RUN/history.json`.
4. Run `grep -c -E 'QA-ENV-STAGING|Off-limits' $RUN/history.json`.

**Expected:**
- Step 2: `{"name":"staging","path":"/tmp/dw-env/environments/staging.md"}`.
- Step 3: `"env"` comes immediately after `"task_file"`.
- Step 4: `0`.

### TS-33: The environment is recorded on a failed run too

**Contract:** C9 · **Criteria:** SC4 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; fixture server running.

**Steps:**
1. Run Script `E` with `--env staging; echo "exit=$?"`.
2. Run `jq -c '[.success, .env]' $RUN/history.json`.

**Expected:**
- `exit=1`; step 2 prints `[false,{"name":"staging","path":"/tmp/dw-env/environments/staging.md"}]`.

### TS-34: An `env:` path that is not usable is a task-file error

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `printf -- '---\nenv: a\0/b.md\n---\nQA\n' > tasks/nul-env.md` (a null byte inside the path value on line 2).

**Steps:**
1. Run `$DW -p -f tasks/nul-env.md; echo "exit=$?"`.

**Expected:**
- Stderr has `<file>:2: env is not a usable path: embedded null byte`, where `<file>` names `tasks/nul-env.md`; `exit=2`; no `runs/`.

### TS-35: Web state lists environments and shows the base environment

**Contract:** C5 · **Criteria:** SC5 · **Type:** API · **Priority:** P1

**Preconditions:** reset; `environments/` as in Test data.

**Steps:**
1. Start `$DW --web --port 4173 --env prod`; set up `C`, `O`, `B`.
2. Run `curl -s -H "$C" $B/api/state | jq -c '.globals.environments, .globals.base.env'`.
3. Run `curl -s -N --max-time 3 -H "$C" $B/api/events | grep -m1 '^data:' | sed 's/^data: //' | jq -c '[.type, .globals.environments, .globals.base.env]'`.

**Expected:**
- Step 2: `["cfg","prod","staging"]` (no `.hidden`, `notes`, `Upper`, `bad name`, `adir`, `none`), then `"prod"`.
- Step 3: the event stream's first event is the state snapshot: `["state",["cfg","prod","staging"],"prod"]`.

### TS-36: Web API saves global and per-task `env` overrides

**Contract:** C5 · **Criteria:** SC5 · **Type:** API · **Priority:** P1

**Preconditions:** reset; fixture server running; web started as `QA_SCRIPT=$QA_WORK/scripts/D $DW --web --port 4173 --env prod`; one typed task added (id `$TID`).

**Steps:**
1. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":"staging"}' $B/api/globals`.
2. `curl -s -H "$C" $B/api/state | jq -c --arg t "$TID" '[.globals.overrides.env, (.tasks[] | select((.id|tostring)==$t) | [.effective.env, .inherited.env])]'`.
3. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":null}' $B/api/tasks/$TID/overrides`, then repeat step 2 adding `.overrides.env` of the task.
4. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":"none"}' $B/api/globals`, then `curl -s -H "$C" $B/api/state | jq -c .globals.overrides.env`.
5. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":"cfg"}' $B/api/globals`; `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{}' $B/api/tasks/$TID/overrides`; `curl -s -w ' %{http_code}' -X POST -H "$C" -H "$O" $B/api/tasks/$TID/start`; wait for the run to finish; `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Every PUT in steps 1, 3, 4 and 5 prints `{"ok":true} 200`.
- Step 2: `["staging",["staging","staging"]]`.
- Step 3: the task's `overrides.env` is `null`, `effective.env` is `null`, `inherited.env` is `"staging"`.
- Step 4: `null` (`"none"` is stored as `null`).
- Step 5: start prints `{"ok":true,"runId":"<run id>"} 200` (`runId` is a non-empty string); the run's prompt section holds `QA-ENV-CFG`.

### TS-37: Web API rejects bad `env` values

**Contract:** C5 · **Criteria:** SC5 · **Type:** API · **Priority:** P2

**Preconditions:** web running (as in TS-36); one task `$TID`.

**Steps:**
1. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":5}' $B/api/globals`.
2. Same with body `{"env":"bad name"}`.
3. Same with body `{"env":"qa-envs/crlf.md"}`.
4. Same with body `{"env":".."}` against `$B/api/tasks/$TID/overrides`.

**Expected:**
- Each returns `{"ok":false,"error":"env must be an environment name or null"} 400`; `/api/state` overrides are unchanged.

### TS-38: Starting a task whose environment file is bad returns 409

**Contract:** C5, C2 · **Criteria:** SC3, SC5 · **Type:** API · **Priority:** P2

**Preconditions:** web running; one task `$TID`; no `environments/ghost.md`.

**Steps:**
1. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":"ghost"}' $B/api/globals`.
2. `curl -s -w ' %{http_code}' -X POST -H "$C" -H "$O" $B/api/tasks/$TID/start`.

**Expected:**
- Step 1: `{"ok":true} 200` (existence is not checked when saving).
- Step 2: `{"ok":false,"error":"environment file not found: /tmp/dw-env/environments/ghost.md"} 409`; no run starts (no `prompt-*.txt`).

### TS-39: Web UI: pick an environment globally, see it, and run with it

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; fixture server running; web started as `QA_SCRIPT=$QA_WORK/scripts/D $DW --web --port 4173`; one typed task added.

**Steps:**
1. Look at the global options strip.
2. Click the `env: none` chip (or press `O`) to open the **Global options** dialog. Open the select labelled `environment` (`#opt-env`) and read its options.
3. Pick `staging`; click **Save**.
4. Look at the strip again.
5. Start the task; when it finishes run `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Step 1: a chip `env: none` without ` ✱`.
- Step 2: options, in order: `inherit (none)`, `none`, `cfg`, `prod`, `staging`; `inherit (none)` is selected.
- Step 3: the dialog closes without error.
- Step 4: the chip reads `env: staging ✱`.
- Step 5: the section holds `QA-ENV-STAGING`.

### TS-40: Web UI: per-task environment overrides the global one

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P3

**Preconditions:** TS-39 state (global `staging`); `$QA_DIR` cleared.

**Steps:**
1. Select the task, press `o` (or click its **Options** button). Open `#opt-env`.
2. Pick `none`; click **Save**. Start the task again.
3. Run `grep -c '<environment>' $QA_DIR/prompt-1.txt`.

**Expected:**
- Step 1: the dialog title is `Options: <task name>`; the first option reads `inherit (staging)`.
- Step 3: `0`. The global chip still reads `env: staging ✱`.

### TS-41: Web UI: no `environments/` folder

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; `mv environments environments.off`; web started without `--env`.

**Steps:**
1. Open the Global options dialog and the `#opt-env` select.
2. Restore: quit, `mv environments.off environments`.

**Expected:**
- Exactly two options: `inherit (none)` and `none`. No error is shown.

### TS-42: Web UI: a bad environment file shows an error toast when the task starts

**Contract:** C6, C2 · **Criteria:** SC3, SC5 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; web running; one task; global environment set to `staging` in the dialog (as TS-39 step 3).

**Steps:**
1. In the shell, `mv environments/staging.md /tmp/dw-env/staging.bak`.
2. Start the task in the UI.
3. Restore: `mv /tmp/dw-env/staging.bak environments/staging.md`.

**Expected:**
- An error toast reads `environment file not found: /tmp/dw-env/environments/staging.md`; the task shows the same error; no run starts.

### TS-43: Web UI: the dialog shows a save error

**Contract:** C6, C5 · **Criteria:** SC5 · **Type:** UI · **Priority:** P3

**Preconditions:** web running; Global options dialog open.

**Steps:**
1. In DevTools Elements, change the `value` of the `cfg` option of `#opt-env` to `bad name`.
2. Pick that option; click **Save**.

**Expected:**
- The dialog stays open and shows `env must be an environment name or null`.

### TS-44: TUI: global environment picker cycles, saves and is shown

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; fixture server running; TUI started as `QA_SCRIPT=$QA_WORK/scripts/D $DW` in a 120x40 terminal.

**Steps:**
1. Look at the global options pane.
2. Press `O`; press `up` once to reach the last field, `environment`.
3. Press `space` four times, noting the value after each press.
4. Press `space` until it shows `staging`; press `⏎`.
5. Look at the options pane. Press `i`, type `QA tui task`, `⏎`; select it and press `space`; when done, press `⏎` on it to open the details.
6. Run `sec $QA_DIR/prompt-1.txt`.

**Expected:**
- Step 1: a row `environment` with value `none` in the normal colour.
- Step 3: values `cfg`, `prod`, `staging`, `none`.
- Step 5: the pane row reads `environment` `staging` in the accent colour; the task details show the row `environment  staging`.
- Step 6: the section holds `QA-ENV-STAGING`.

### TS-45: TUI: typing is ignored and ctrl+r restores the inherited value

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P3

**Preconditions:** reset; TUI started as `$DW --env prod`.

**Steps:**
1. Press `O`, `up` to `environment`. Note the value.
2. Type `xyz`.
3. Press `space` once, then `ctrl+r`; press `⏎`.

**Expected:**
- Step 1: `prod`. Step 2: still `prod`.
- Step 3: after `space` the value changes; after `ctrl+r` it is `prod` again; after `⏎` the pane row shows `prod` in the normal (not accent) colour.

### TS-46: TUI: per-task environment and the detail row

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P3

**Preconditions:** reset; fixture server running; TUI started as `QA_SCRIPT=$QA_WORK/scripts/D $DW --env prod`; one typed task added.

**Steps:**
1. Select the task, press `o`, `up` to `environment`, press `space` until `none`, `⏎`.
2. Press `⏎` on the task to open its details.
3. Start it; when done run `grep -c '<environment>' $QA_DIR/prompt-1.txt`.

**Expected:**
- Step 2: the detail row reads `environment  none`; the global pane still shows `prod`.
- Step 3: `0`.

### TS-47: TUI: no `environments/` folder

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; `mv environments environments.off`; TUI started without `--env`.

**Steps:**
1. Press `O`, `up` to `environment`; press `space` three times.
2. Quit; `mv environments.off environments`.

**Expected:**
- The value stays `none` (the only choice); no error is shown.

### TS-48: TUI: a bad environment file shows an error when the task starts

**Contract:** C6, C2 · **Criteria:** SC3, SC5 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; TUI running; global `environment` set to `staging` (TS-44 step 4); one typed task.

**Steps:**
1. In another shell, `mv environments/staging.md /tmp/dw-env/staging.bak`.
2. Start the task with `space`.
3. Restore the file.

**Expected:**
- An error toast reads `environment file not found: /tmp/dw-env/environments/staging.md`; the task shows the same error; no run starts.

### TS-49: TUI add box reports a bad `env:` in a mentioned task file

**Contract:** C4 · **Criteria:** SC5 · **Type:** UI · **Priority:** P2

**Preconditions:** reset; TUI running; `tasks/bad-env.md`.

**Steps:**
1. Press `i`, type `@tasks/bad-env.md`, press `⏎`.

**Expected:**
- Nothing is added; under the box: `…tasks/bad-env.md:2: env must be an environment name (letters, digits, ".", "_", "-") or a path, got "bad name"`.

### TS-50: Web plan with a global environment override writes `env:`

**Contract:** C10 · **Criteria:** SC2 · **Type:** API, File · **Priority:** P3

**Preconditions:** reset; web started as `QA_SCRIPT=$QA_WORK/scripts/PLAN $DW --web --port 4173 --env cfg`.

**Steps:**
1. `curl -s -X PUT -H "$C" -H "$O" -H "$J" -d '{"env":"prod"}' $B/api/globals`.
2. `curl -s -X POST -H "$C" -H "$O" -H "$J" -d '{"source":"qa-plan.md"}' $B/api/plans`; wait until the plan shows its tasks.
3. `grep '^env:' tasks/qa-plan/*.md`.

**Expected:**
- Every task file has `env: prod` (the global override wins over the argv `cfg`).

### TS-51: System prompt describes the environment context

**Contract:** C7 · **Criteria:** SC1, SC6 · **Type:** File · **Priority:** P3

**Preconditions:** branch checkout.

**Steps:**
1. Open `$REPO/prompts/system.md`.

**Expected:**
- The first paragraph contains `the task, the environment context when the run has one, your memory notes, the open tabs, and the current page's accessibility snapshot`.
- After the intro there is a `## Environment context` section whose paragraph is exactly the text in spec C7 (starting `When the prompt has an \`<environment>\` section,` and ending `The task wins where the two disagree.`).

### TS-52: README documents the feature and ticks the roadmap

**Contract:** C8 · **Criteria:** SC6 · **Type:** File · **Priority:** P1

**Preconditions:** branch checkout.

**Steps:**
1. Run `grep -n -- '--env ENV' $REPO/README.md`.
2. Run `grep -n '^| `env` |' $REPO/README.md`.
3. Run `grep -n '^### ' $REPO/README.md` and read the `### Environment context` section.
4. Run `grep -n 'Environment context\*\*' $REPO/README.md`.

**Expected:**
- Step 1: the options list has `--env ENV` with the RUN_HELP text (TS-7).
- Step 2: `` | `env` | an environment name, `none`, or a path to its file (see [Environment context](#environment-context)) | ``.
- The task-file and Global config relative-path bullets both list `env`.
- Step 3: `### Environment context` comes right after `### Two-factor verification` and before `### Task files`; the section covers folder and naming, `--env` / `env:` / config with precedence, `none`, the 16 KB limit and preflight errors, every-step `<environment>` placement, the `history.json` `env` record, the TUI/web picker, plan mode `env:`, and the advice never to put raw secrets in it and to reference them by name, like `--state`.
- Step 4: the roadmap line starts `- [x] **Environment context**` and its remaining text is unchanged.

### TS-53: Example environment file is valid and usable

**Contract:** C8 · **Criteria:** SC6 · **Type:** File, CLI · **Priority:** P1

**Preconditions:** reset; fixture server running.

**Steps:**
1. Run `stat -c %s $REPO/examples/environments/staging.md` and `grep -n '^#' $REPO/examples/environments/staging.md`.
2. Run Script `D` with `--env $REPO/examples/environments/staging.md`.

**Expected:**
- Size below `2048`; headings for Base URL, Test accounts, Seeded data, Feature flags, Known quirks and Off-limits; credentials referenced by env-var name and a `--state` file; no real secret values.
- Step 2: exit `0`; the prompt's section holds the example's text; `jq -r .env.name $RUN/history.json` is `staging`.

## Regression

### TS-54: Without an environment, prompts and history are unchanged from `main`

**Contract:** C3, C9 · **Criteria:** SC1, SC4 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; fixture server running; `$DW_MAIN` built; no config.

**Steps:**
1. Run Script `A` with `$DW` (no `--env`). `mkdir $QA_WORK/new && mv $QA_DIR/prompt-*.txt $QA_WORK/new/ && mv $RUN $QA_WORK/new/run`.
2. Reset `$QA_DIR`; run Script `A` with `$DW_MAIN` in place of `$DW`.
3. Run `diff $QA_WORK/new/prompt-1.txt $QA_DIR/prompt-1.txt` (and for prompts 2, 3).
4. Run `jq -c keys_unsorted $QA_WORK/new/run/history.json` and the same on the main run's `history.json`.

**Expected:**
- No `<environment>` in any new prompt; each diff is empty.
- Both key lists are identical; neither contains `env`.

### TS-55: `duckwright init` template gains the commented `env` key

**Contract:** C4 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset (no `$CONF`).

**Steps:**
1. Run `$DW init`; then `grep -n -E '^# (snapshot|env):|Relative paths' $CONF`.
2. Run Script `D` with no `--env` (fixture server running) and `grep -c '<environment>' $QA_DIR/prompt-1.txt`.

**Expected:**
- `# env: staging` is on the line right after `# snapshot: hybrid`; the relative-paths comment reads `(skill, state, env)`.
- Step 2: exit `0`, count `0` (the commented key changes nothing).

### TS-56: Plan mode without an environment writes no `env:` line

**Contract:** C10 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; `qa-plan.md`; `scripts/PLAN`.

**Steps:**
1. Run `QA_SCRIPT=$QA_WORK/scripts/PLAN $DW plan qa-plan.md -p`.
2. Run `grep -c '^env:' tasks/qa-plan/*.md` and `head -4 tasks/qa-plan/01-*.md`.

**Expected:**
- Every count is `0`; the front matter is `---`, the `# From …` comment, `setup: shared/setup.md`, `---`, as before this change.

### TS-57: Existing options still show in the TUI and web UI

**Contract:** C6 · **Criteria:** SC5 · **Type:** UI · **Priority:** P3

**Preconditions:** reset; web and TUI each started without `--env`.

**Steps:**
1. In the web UI, read the options strip and open the Global options dialog.
2. In the TUI, read the options pane and open `O`.

**Expected:**
- Web chips `model`, `max steps`, `headed`, `snapshot`, `video`, `screenshot` still show with their values, followed by `env: none`; the dialog still has its existing fields plus `environment`.
- TUI: rows `model`, `max steps`, `headed`, `snapshot mode`, `video`, `screenshot`, then `environment`; the form's existing fields still edit and save as before.

## Out of scope

- Unit and integration tests (run as checks during implementation).
- A real agent run against a live site to judge whether the model actually uses the context (spec "Manual e2e").
- `${ENV_VAR}` placeholders or any secret handling beyond the documented convention.
- Several environments per run, inheritance between environment files, non-markdown parsing.
- Environment info in exported specs (`duckwright.spec.ts`), run headers, timelines or `run:start` events.
- Watching `environments/` for changes; creating or editing environment files from the TUI or web UI.
- The file being deleted between preflight and run start (D12): the window is internal and cannot be hit reliably from outside.
