# Jev Backend (`--jev`) QA Test Plan

**Goal:** Add an opt-in `--jev` mode in which a per-step router asks TypeSafe's Jev model for the command and element ref, and falls back to Claude whenever the step needs text or Jev is not confident.
**Spec:** `docs/superpowers/specs/2026-10-08-jev-backend-cheaper-brain-design.md`
**Scope:** Black-box CLI, file, HTTP (outbound and web API) and UI scenarios against the spec's Contracts (C1 to C8). Unit and integration tests are covered by the implementation and are not repeated here.

## Environment

Every scenario runs a real browser through the real `playwright-cli`. Two things are replaced so runs are deterministic and free:

- `claude` is a scripted stub found first on `PATH` (Duckwright finds `claude` through `PATH`).
- The Jev API is a local HTTPS stub. The Jev URL is fixed (`https://api.typesafe.ai/v1/systemone`), so QA points the host name at `127.0.0.1` in `/etc/hosts` and makes Node trust the stub's self-signed certificate with `NODE_EXTRA_CA_CERTS`. Nothing reaches the real TypeSafe API.

Setup:

- **Tools:** Node >= 22.18, `bash`, `jq`, `curl`, `openssl`, `sudo` (for `/etc/hosts` and port 443), a browser (Chrome or Firefox) for the web UI, a terminal at least 120x40 for the TUI. `playwright-cli` installed as README -> Prerequisites describes.
- **Build gate:** in the branch checkout (`$REPO`), run `npm ci && npm run build`. Then `export DW="node $REPO/dist/bin.js"`.
- **QA workspace:** `export QA_WORK=/tmp/dw-jev QA_DIR=/tmp/dw-jev/out XDG_CONFIG_HOME=/tmp/dw-jev/xdg`, then `mkdir -p $QA_WORK/bin $QA_WORK/scripts $QA_WORK/tasks $QA_DIR $XDG_CONFIG_HOME/duckwright && chmod 777 $QA_DIR` and `cd $QA_WORK`. Run every `$DW` command from `$QA_WORK`, so runs land in `$QA_WORK/runs/`. `XDG_CONFIG_HOME` keeps your real `duckwright.conf` out of the way.
- **PATH:** `export PATH="$QA_WORK/bin:$PATH"` (after writing `bin/claude`, Test data).
- **Certificate:** `openssl req -x509 -newkey rsa:2048 -nodes -keyout $QA_WORK/jev.key -out $QA_WORK/jev.crt -days 7 -subj /CN=api.typesafe.ai -addext subjectAltName=DNS:api.typesafe.ai`, then `export NODE_EXTRA_CA_CERTS=$QA_WORK/jev.crt`.
- **Host name:** `echo '127.0.0.1 api.typesafe.ai' | sudo tee -a /etc/hosts`. Remove that line when QA is finished.
- **Proxy:** `unset HTTPS_PROXY https_proxy NODE_USE_ENV_PROXY` in the shell that runs `$DW`, so `fetch` connects straight to the stub.
- **Jev stub:** in a second terminal, `sudo QA_DIR=$QA_DIR QA_WORK=$QA_WORK node $QA_WORK/jev-stub.mjs`. It listens on `127.0.0.1:443`.
- **Fixture server:** in a third terminal, `node $QA_WORK/qa-server.mjs`. It serves `http://localhost:8765`.
- **Key:** `export TYPESAFE_API_KEY=qa-key-123` unless a scenario says otherwise.
- **Pick a script:** `qa_use() { export QA_SCRIPT=$QA_WORK/scripts/$1/claude; echo "$QA_WORK/scripts/$1/jev" > $QA_DIR/jev-script; }`, then `qa_use <NAME>`.
- **Run (print mode):** `$DW -p "QA <NAME>" --session qa-jev --max-steps 20 [flags] > $QA_DIR/out.txt 2> $QA_DIR/err.txt; echo "exit=$?"`.
- **Locate the run:** after a reset there is one run, so `RUN=$(ls -d $QA_WORK/runs/2*/)` and `H=$RUN/history.json`.
- **Jev requests:** the stub writes request N to `$QA_DIR/jev-req-N.json` as `{t, method, url, headers, body}` (`t` in ms). `ls $QA_DIR/jev-req-*.json 2>/dev/null | wc -l` counts them.
- **Claude calls:** the stub writes call N's prompt to `$QA_DIR/prompt-N.txt`. `ls $QA_DIR/prompt-*.txt 2>/dev/null | wc -l` counts them.
- **Cost check helper:** `jq '[.history[] | (.cost_usd*1e8|round)]' $H` prints step costs in units of 1e-8 USD. With the stubs' fixed values: a Claude call costs `0.01` (`1000000`), a Jev call with usage 1000 in / 10 out costs `1010 × 42e-9 = 0.00004242` (`4242`).
- **Web UI:** `$DW --web --port 4173 [flags]` from `$QA_WORK`. It prints `http://127.0.0.1:4173/?t=<token>`; open it in the browser and set `TOKEN=<token> PORT=4173`. API calls: `C="Cookie: dw_token_$PORT=$TOKEN"`, `O="Origin: http://127.0.0.1:$PORT"`, `B=http://127.0.0.1:$PORT`. Task ids: `curl -s -H "$C" $B/api/state | jq '.tasks[] | {id, name, state}'`.
- **TUI:** `$DW [flags]` in a terminal.
- **Accounts / auth:** none for the CLI. The web UI uses the per-launch token above. The Jev "key" is any non-blank string; the stub only records it.
- **Reset (before every scenario):** quit any running Duckwright (`q`, or Ctrl-C). Then `rm -rf $QA_WORK/runs $QA_WORK/tasks/qa-jev-plan* $QA_DIR/* $XDG_CONFIG_HOME/duckwright/duckwright.conf; export TYPESAFE_API_KEY=qa-key-123; unset DUCKWRIGHT_TOTP_SECRET QA_CLAUDE_COST`. If a run was interrupted, run `playwright-cli -s=qa-jev close`. The Jev stub and fixture server keep running.

## Test data

### `bin/claude` (stub; `chmod +x`)

```bash
#!/usr/bin/env bash
# QA stub for `claude -p`: saves the prompt and replays scripted decisions, one file per Claude call.
# The call counter restarts after a `done`, so sequential runs each start at 1.
set -u
n=$(( $(cat "$QA_DIR/claude.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$QA_DIR/claude.count"
cat > "$QA_DIR/prompt-$n.txt"
if [ ! -e "$QA_SCRIPT/$n.json" ]; then echo "qa brain failure" >&2; exit 1; fi
grep -q '"done"' "$QA_SCRIPT/$n.json" && rm -f "$QA_DIR/claude.count"
printf '{"type":"result","is_error":false,"total_cost_usd":%s,"structured_output":%s}\n' "${QA_CLAUDE_COST:-0.01}" "$(cat "$QA_SCRIPT/$n.json")"
```

### `jev-stub.mjs`

```js
import https from "node:https";
import fs from "node:fs";
const D = process.env.QA_DIR, W = process.env.QA_WORK;
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
https.createServer({ key: fs.readFileSync(`${W}/jev.key`), cert: fs.readFileSync(`${W}/jev.crt`) }, (req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const n = Number(fs.existsSync(`${D}/jev.count`) ? fs.readFileSync(`${D}/jev.count`, "utf8") : 0) + 1;
    fs.writeFileSync(`${D}/jev.count`, String(n));
    const body = parse(raw);
    fs.writeFileSync(`${D}/jev-req-${n}.json`, JSON.stringify({ t: Date.now(), method: req.method, url: req.url, headers: req.headers, body }, null, 2));
    const dir = fs.existsSync(`${D}/jev-script`) ? fs.readFileSync(`${D}/jev-script`, "utf8").trim() : "";
    const f = dir ? [`${dir}/${n}.json`, `${dir}/default.json`].find((p) => fs.existsSync(p)) : undefined;
    const s = f ? JSON.parse(fs.readFileSync(f, "utf8")) : { status: 500 };
    const send = () => {
      if (s.destroy) return req.socket.destroy();
      const status = s.status ?? 200;
      if (s.raw !== undefined) return res.writeHead(status, { "content-type": "application/json" }).end(s.raw);
      if (status !== 200) return res.writeHead(status, { "content-type": "text/plain" }).end(s.text ?? "qa");
      const crit = body?.questions?.target?.criteria ?? {};
      const ref = s.target === undefined ? Object.keys(crit)[0] : (Object.entries(crit).find(([, v]) => v === s.target)?.[0] ?? s.target);
      const tc = s.tc ?? 0.9;
      const answers = {
        action: { choice: s.action, confidence: s.ac, probabilities: { [s.action]: s.ac } },
        target: { choice: ref, confidence: tc, probabilities: { [ref]: tc } },
      };
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ answers, usage: s.usage ?? { input_tokens: 1000, output_tokens: 10 } }));
    };
    s.delay_ms ? setTimeout(send, s.delay_ms) : send();
  });
}).listen(443, "127.0.0.1");
```

Stub script entries (`jev/N.json` answers the Nth HTTP request of the run, including retries; `jev/default.json` answers any request without its own file; with neither, the stub answers HTTP 500):

- `{"action":"click","ac":0.93,"target":"link \"QA Two\"","tc":0.88}`: answers `click` on the ref whose description is `link "QA Two"`. Usage defaults to 1000 in / 10 out.
- `{"status":401}`, `{"status":429}`, `{"status":500}`: that status, body `qa`. `{"status":422,"text":"…"}`: 422 with that body.
- `{"delay_ms":12000}`: answers after 12 s (a valid default answer is never reached by the client).
- `{"destroy":true}`: closes the socket without a response.
- `{"raw":"not json"}`: HTTP 200 with that body.

### `qa-server.mjs`

```js
import http from "node:http";
const page = (t, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><link rel="icon" href="data:,"></head><body><h1>${t}</h1>${extra}</body></html>`;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const n = Number(u.searchParams.get("n") ?? 0);
  const pages = {
    "/one.html": page("QA One", '<a href="/two.html">QA Two</a> <button type="button">QA Button</button>'),
    "/two.html": page("QA Two", '<a href="/one.html">QA One</a>'),
    "/empty.html": page("QA Empty", "<p>No controls here.</p>"),
    "/many.html": page("QA Many", Array.from({ length: n }, (_, i) => `<button type="button">B${i + 1}</button>`).join("")),
  };
  const body = pages[u.pathname];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "nf");
}).listen(8765);
```

### Claude decision files

Each `scripts/<NAME>/claude/N.json` answers the Nth **Claude call** of the run (Jev-accepted steps do not call Claude). Shape: `{"evaluation_previous_goal":"","memory":"<M>","next_goal":"qa","actions":[<action>]}`, memory `""` unless the table says otherwise.

- `goto X` -> `{"cmd":"goto","args":["http://localhost:8765/X"]}`
- `click e9999` -> `{"cmd":"click","args":["e9999"]}` (a ref that does not exist)
- `done` -> `{"cmd":"done","args":["success","qa done"]}`

### Scripts

`J` = Jev stub file, `C` = Claude file. Default usage on every Jev 200 answer.

| Script | Claude files | Jev files | Steps it produces |
| --- | --- | --- | --- |
| `ACC` | 1 goto `one.html` (memory `qa mem 1`); 2 done | 1 `{"action":"click","ac":0.93,"target":"link \"QA Two\"","tc":0.88}`; 2 `{"action":"done","ac":0.99,"tc":0.5}` | 1 Claude, 2 Jev click, 3 Claude done |
| `ENTER` | 1 goto `one.html`; 2 done | 1 `{"action":"press_enter","ac":0.95,"tc":0.10}`; 2 `{"action":"needs_text","ac":0.99}` | 1 Claude, 2 Jev press, 3 Claude done |
| `EDGE` | 1 goto `one.html`; 2 done | 1 `{"action":"click","ac":0.80,"target":"link \"QA Two\"","tc":0.80}`; 2 `{"action":"needs_text","ac":0.99}` | 1 Claude, 2 Jev click, 3 Claude done |
| `LOWA` | 1 goto `one.html`; 2 done | 1 `{"action":"click","ac":0.79,"target":"link \"QA Two\"","tc":0.95}` | 1 Claude, 2 Claude done |
| `LOWT` | 1 goto `one.html`; 2 done | 1 `{"action":"click","ac":0.95,"target":"link \"QA Two\"","tc":0.50}` | 1 Claude, 2 Claude done |
| `TEXT` | 1 goto `one.html`; 2 done | 1 `{"action":"needs_text","ac":0.97,"target":"button \"QA Button\"","tc":0.60}` | 1 Claude, 2 Claude done |
| `ZERO` | 1 goto `empty.html`; 2 done | default `{"action":"needs_text","ac":0.99}` | 1, 2 Claude |
| `M255` | 1 goto `many.html?n=255`; 2 done | default `{"action":"needs_text","ac":0.99}` | 1, 2 Claude |
| `M256` | 1 goto `many.html?n=256`; 2 done | default `{"action":"needs_text","ac":0.99}` | 1, 2 Claude |
| `FAIL` | 1 goto `one.html`; 2 click e9999; 3 done | default `{"action":"needs_text","ac":0.99}` | 1, 2 (fails), 3 Claude |
| `NUDGE` | 1, 2, 3 goto `one.html`; 4 done | default `{"action":"needs_text","ac":0.99}` | 1 to 4 Claude |
| `E500` | 1 goto `one.html`; 2 done | 1 `{"status":500}` | 1, 2 Claude |
| `R429` | 1 goto `one.html`; 2 done | 1 `{"status":429}`; 2 as `ACC` 1; 3 `{"action":"needs_text","ac":0.99}` | 1 Claude, 2 Jev click, 3 Claude done |
| `R429X` | 1 goto `one.html`; 2 done | 1, 2, 3 `{"status":429}` | 1, 2 Claude |
| `R529X` | 1 goto `one.html`; 2 done | 1, 2, 3 `{"status":529}` | 1, 2 Claude |
| `E422` | 1 goto `one.html`; 2 goto `two.html`; 3 done | 1 `{"status":422,"text":"bad \n\n  state"}` (written with `printf` so the `\n` are real newlines); 2 `{"status":422,"text":"<300 x>"}` made with `printf '{"status":422,"text":"%s"}' $(printf 'x%.0s' {1..300})` | 1, 2, 3 Claude |
| `SLOW` | 1 goto `one.html`; 2 done | 1 `{"delay_ms":12000}` | 1, 2 Claude |
| `DROP` | 1 goto `one.html`; 2 done | 1 `{"destroy":true}` | 1, 2 Claude |
| `BAD` | 1 goto `one.html`; 2 goto `two.html`; 3 goto `one.html`; 4 done | 1 `{"raw":"not json"}`; 2 `{"action":"zzz","ac":0.9,"tc":0.9}`; 3 `{"action":"click","ac":1.5,"tc":0.9}` | 1 to 4 Claude |
| `CFAIL` | 1 goto `one.html`; *(no 2.json)*; 3 done | 1 `{"action":"needs_text","ac":0.99}` | 1 Claude, 2 brain error, 3 Claude done |
| `E3` | 1 goto `one.html`; 2 goto `two.html`; 3 goto `one.html`; 4 goto `two.html`; 5 done | default `{"status":500}` | 1 to 5 Claude |
| `A401` | 1 goto `one.html`; 2 done | 1 `{"status":401}` | 1 Claude, then stop |
| `HANG` | 1 goto `one.html`; 2 done | 1 `{"delay_ms":8000}` | 1 Claude, then Ctrl-C |
| `LONG` | 1 to 16 alternate goto `one.html` (odd) / `two.html` (even); 17 done | default `{"action":"needs_text","ac":0.99}` | 1 to 17 Claude |
| `PLAIN` | 1 goto `one.html`; 2 done | *(none)* | 1, 2 Claude |

### Task files

- `tasks/jev-on.md`: `---` / `jev: true` / `jev-threshold: 0.95` / `---` / `QA task jev on`
- `tasks/jev-off.md`: `---` / `jev: false` / `---` / `QA task jev off`
- `tasks/thr-only.md`: `---` / `jev-threshold: 0.5` / `---` / `QA task threshold only`
- `tasks/bad-jev.md`: `---` / `jev: maybe` / `---` / `QA bad`. The bad value is on line 2.
- `tasks/bad-thr-0.md`, `tasks/bad-thr-15.md`, `tasks/bad-thr-abc.md`: `---` / `jev-threshold: 0` (resp. `1.5`, `abc`) / `---` / `QA bad`. Line 2.
- `plans/qa-jev-plan.md`: a one-scenario plan: `# QA jev plan` / `## Scenarios` / `### TS-1: open page one` / `Open http://localhost:8765/one.html and report its heading.`

## Coverage

| Criterion | Contracts | Scenarios |
| --- | --- | --- |
| SC1 | C5, C6 | TS-2, TS-3, TS-12, TS-21 |
| SC2 | C4, C5, C6 | TS-2, TS-12, TS-13, TS-14, TS-15, TS-16, TS-17, TS-18, TS-19, TS-20, TS-21, TS-22, TS-23, TS-24, TS-25, TS-26, TS-27, TS-28, TS-29, TS-30, TS-31, TS-32 |
| SC3 | C1, C3 | TS-5, TS-6, TS-7, TS-8, TS-41 |
| SC4 | C1, C4, C7 | TS-2, TS-4, TS-8, TS-33, TS-44, TS-45 |
| SC5 | C2, C3 | TS-33, TS-34, TS-35, TS-36, TS-37, TS-38, TS-39, TS-40, TS-41, TS-42 |
| SC6 | C8 | TS-0, TS-43 |

| Contract | Scenarios |
| --- | --- |
| C1 run flags | TS-1, TS-2, TS-5, TS-6, TS-7, TS-8, TS-9, TS-10, TS-11, TS-14, TS-32, TS-42 |
| C2 task-file / config keys | TS-33, TS-34, TS-35, TS-36, TS-37 |
| C3 TUI / web options | TS-38, TS-39, TS-40, TS-41, TS-42 |
| C4 `history.json` | TS-2, TS-4, TS-12 to TS-32, TS-44, TS-45 |
| C5 routing (observable through `history.json` and the stubs) | TS-2, TS-3, TS-12 to TS-30 |
| C6 Jev HTTP request | TS-2, TS-3, TS-21 to TS-29, TS-31, TS-32 |
| C7 report line | TS-2, TS-4, TS-8, TS-33 |
| C8 README | TS-43 |

## Scenarios

### TS-0: Build gate: typecheck and test suite pass

**Contract:** all · **Criteria:** SC6 · **Type:** CLI · **Priority:** P1

**Preconditions:** clean checkout of the branch, `npm ci` done.

**Steps:**
1. In `$REPO`, run `npm run typecheck; echo "exit=$?"`.
2. Run `npm test; echo "exit=$?"`.

**Expected:**
- Both print `exit=0`.

### TS-1: Help and usage text show the new flags

**Contract:** C1 · **Criteria:** SC6 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. Run `$DW --help`.

**Expected:**
- The usage block has the line `                  [--jev | --no-jev] [--jev-threshold FLOAT]` directly after the `[--twofa-timeout SEC]` line.
- Directly after the `--twofa-timeout` help entry, the help has exactly:
  ```
    --jev, --no-jev       cheaper brain: TypeSafe's Jev picks the command and
                          element on steps it is sure of, Claude decides the
                          rest. Needs TYPESAFE_API_KEY. Sends the task, page
                          snapshots and history to TypeSafe (default off)
    --jev-threshold FLOAT
                          with --jev: the confidence Jev needs for its choice
                          to be used, greater than 0 and at most 1 (default
                          0.8)
  ```
- Every other usage and help line is the same as `duckwright --help` from a `main` build.

### TS-2: A confident, non-text Jev answer drives a step without Claude

**Contract:** C1, C4, C5, C6, C7 · **Criteria:** SC1, SC2, SC4 · **Type:** CLI, File, API · **Priority:** P1

**Preconditions:** reset; `qa_use ACC`; key `qa-key-123`.

**Steps:**
1. Run `$DW -p "QA ACC" --session qa-jev --max-steps 20 --jev > $QA_DIR/out.txt 2> $QA_DIR/err.txt; echo "exit=$?"`.
2. `cat $QA_DIR/out.txt`.
3. Count Jev requests and Claude calls.
4. `jq '{method, url, auth: .headers.authorization, ct: .headers["content-type"], host: .headers.host, model: .body.model, state: (.body.state|keys), task: .body.state.task, memory: .body.state.memory, history: .body.state.history, aq: .body.questions.action.question, atype: .body.questions.action.type, akeys: (.body.questions.action.criteria|keys_unsorted), click: .body.questions.action.criteria.click, nt: .body.questions.action.criteria.needs_text, tq: .body.questions.target.question, ttype: .body.questions.target.type, tvals: [.body.questions.target.criteria[]]}' $QA_DIR/jev-req-1.json`.
5. `jq '.history[1]' $H`, then `jq '[.history[] | {step, source, jev}]' $H`, then `jq '{keys: keys_unsorted, jev_steps, claude_steps, success, answer}' $H`.
6. Run the cost check helper on `$H`.

**Expected:**
- `exit=0`.
- stdout has `Result: success`, `Answer: qa done`, then `Steps: 3  Cost: $0.0201`, and on the very next line `Jev steps: 1/3`.
- 2 Jev requests (steps 2 and 3; none for step 1). 2 Claude calls (`prompt-1.txt`, `prompt-2.txt`; no `prompt-3.txt`).
- Request 1: `method` `POST`, `url` `/v1/systemone`, `auth` `Bearer qa-key-123`, `ct` starts with `application/json`, `host` `api.typesafe.ai`, `model` `jev-latest`; `state` keys are exactly `history`, `memory`, `snapshot`, `tabs`, `task`; `task` `QA ACC`; `memory` `qa mem 1`; `history` is one string starting `step 1 | `; `aq` `Which single next move best advances the task on this page?`; `atype` `choice`; `akeys` `["click","check","uncheck","hover","press_enter","press_tab","press_escape","go_back","needs_text","done"]`; `click` `Click one element on the page: a link, button, tab, menu item or option.`; `nt` `The next move needs typed text: open a URL, fill or type into a field, pick a select value, or anything not listed here.`; `tq` `Which element should that move act on?`; `ttype` `choice`; `tvals` is exactly `["link \"QA Two\"","button \"QA Button\""]` (the heading is not a target).
- `history[1]` (step 2): `source` `"jev"`; `next_goal` `jev: click link "QA Two" (0.88)`; `memory` `qa mem 1`; `evaluation_previous_goal` `""`; one action, `cmd` `click`, `args[0]` equal to the key of `link "QA Two"` in request 1's target criteria; its result does not start with `error:`; `jev` is `{"action":"click","action_confidence":0.93,"target":"<that ref>","target_confidence":0.88,"routed":"accepted"}`.
- Steps: 1 `{source:"claude", jev:null}`; 2 `source:"jev"`, `routed:"accepted"`; 3 `source:"claude"`, `jev` `{"action":"done","action_confidence":0.99,"target":<first ref>,"target_confidence":0.5,"routed":"done"}`.
- Top level: `jev_steps` 1, `claude_steps` 2, `success` true, `answer` `qa done`; in `keys`, `jev_steps` and `claude_steps` come directly after `cost_usd`. In each step, `cost_usd`, `source` and `jev` come after `results`.
- Cost helper: `[1000000, 4242, 1004242]`.

### TS-3: A no-target action is accepted even with a low target confidence; the key is trimmed

**Contract:** C4, C5, C6 · **Criteria:** SC1 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use ENTER`; `export TYPESAFE_API_KEY='  qa-key-123  '`.

**Steps:**
1. Run `ENTER` with `--jev`.
2. `jq '.history[1] | {source, next_goal, actions: [.actions[] | {cmd, args}], jev}' $H`.
3. `jq -r .headers.authorization $QA_DIR/jev-req-1.json`.

**Expected:**
- `exit=0`; stdout has `Jev steps: 1/3`.
- Step 2: `source` `jev`; `next_goal` `jev: press_enter (0.95)`; actions `[{"cmd":"press","args":["Enter"]}]`; `jev.action` `press_enter`, `jev.action_confidence` 0.95, `jev.target` is a ref string (Jev's target answer, recorded though not used), `jev.target_confidence` 0.1, `jev.routed` `accepted`.
- Step 3: `jev.routed` `needs_text`.
- Header is `Bearer qa-key-123`.

### TS-4: A run without `--jev` writes the new fields with Claude defaults and no report line

**Contract:** C4, C7 · **Criteria:** SC4 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; `qa_use PLAIN`; `unset TYPESAFE_API_KEY`.

**Steps:**
1. Run `PLAIN` without `--jev`.
2. `jq '[.history[] | {source, jev, c: (.cost_usd*1e8|round)}], .jev_steps, .claude_steps' $H`.
3. Count Jev requests.

**Expected:**
- `exit=0`; stdout has `Steps: 2  Cost: $0.0200` and no line starting `Jev steps:`. No key is required.
- Each step `{"source":"claude","jev":null,"c":1000000}`; `jev_steps` 0; `claude_steps` 2.
- 0 Jev requests.

### TS-5: `--jev` without a key fails fast with exit 2

**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P1

**Preconditions:** reset; `qa_use ACC`.

**Steps:**
1. `unset TYPESAFE_API_KEY`, run `ACC` with `--jev`.
2. `ls $QA_WORK/runs 2>&1`; count Claude calls and Jev requests.
3. `export TYPESAFE_API_KEY='   '`, run `ACC` with `--jev` again.

**Expected:**
- Steps 1 and 3: `exit=2`; stderr contains the line `TYPESAFE_API_KEY is not set (needed by --jev)`; stdout has no `Result:` line.
- No `runs/` folder (or an empty one); 0 Claude calls; 0 Jev requests.

### TS-6: Missing key in a batch names the file

**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa_use ACC`; `unset TYPESAFE_API_KEY`; `tasks/jev-on.md` exists.

**Steps:**
1. Run `$DW -p -f tasks/jev-off.md tasks/jev-on.md --session qa-jev > $QA_DIR/out.txt 2> $QA_DIR/err.txt; echo "exit=$?"`.

**Expected:**
- `exit=2`; stderr has `tasks/jev-on.md: TYPESAFE_API_KEY is not set (needed by --jev)` (the file as given on the command line, then `: `). Nothing runs: no run folder, 0 Claude calls.

### TS-7: TUI and web given `--jev` without a key exit 2 before opening

**Contract:** C1 · **Criteria:** SC3 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `unset TYPESAFE_API_KEY`; a terminal.

**Steps:**
1. Run `$DW --jev; echo "exit=$?"`.
2. Run `$DW --web --port 4173 --jev; echo "exit=$?"`.

**Expected:**
- Both print `TYPESAFE_API_KEY is not set (needed by --jev)` on stderr and `exit=2`. The TUI never draws; the web command prints no `http://127.0.0.1:4173/?t=` URL and `curl -s http://127.0.0.1:4173/` fails to connect.

### TS-8: An invalid key (401) stops the run with exit 1 and still writes `history.json`

**Contract:** C1, C4, C6, C7 · **Criteria:** SC3, SC4 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; `qa_use A401`.

**Steps:**
1. Run `A401` with `--jev`.
2. `cat $QA_DIR/err.txt $QA_DIR/out.txt`; count Jev requests and Claude calls.
3. `jq '.history | length, .[0].step, .[0].source' $H`.

**Expected:**
- `exit=1`; stderr has `jev error: invalid TYPESAFE_API_KEY`; stdout has no `Jev steps:` line.
- Exactly 1 Jev request (no retry); 1 Claude call.
- `history.json` exists with 1 step (step 1, source `claude`).

### TS-9: Invalid `--jev-threshold` and `--jev` values are usage errors

**Contract:** C1 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:** run each, capturing stderr and exit code:
1. `$DW -p "x" --jev --jev-threshold abc`
2. `$DW -p "x" --jev --jev-threshold inf`
3. `$DW -p "x" --jev --jev-threshold 1e-1`
4. `$DW -p "x" --jev --jev-threshold 0`
5. `$DW -p "x" --jev --jev-threshold 1.01`
6. `$DW -p "x" --jev-threshold`
7. `$DW -p "x" --jev=x`

**Expected:**
- All exit 2 with the usage text on stderr, then:
  1. `duckwright: error: argument --jev-threshold: invalid float value: 'abc'`
  2. `duckwright: error: argument --jev-threshold: invalid float value: 'inf'`
  3. `duckwright: error: argument --jev-threshold: invalid float value: '1e-1'`
  4. `duckwright: error: argument --jev-threshold: must be greater than 0 and at most 1`
  5. `duckwright: error: argument --jev-threshold: must be greater than 0 and at most 1`
  6. `duckwright: error: argument --jev-threshold: expected one argument`
  7. `duckwright: error: argument --jev/--no-jev: ignored explicit argument 'x'`
- No run folder; 0 Claude calls.

### TS-10: Accepted threshold forms, and a threshold without `--jev`

**Contract:** C1, C2 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa_use PLAIN`.

**Steps:**
1. Run `PLAIN` with `--jev --jev-threshold=1`. Reset, `qa_use PLAIN`.
2. Run `PLAIN` with `--jev --jev-threshold .5`. Reset, `qa_use PLAIN`. Run `PLAIN` with `--jev --jev-threshold 1.`. Reset, `qa_use PLAIN`.
3. `unset TYPESAFE_API_KEY`; run `PLAIN` with `--jev-threshold 0.9` and no `--jev`. Reset, `qa_use PLAIN`, `unset TYPESAFE_API_KEY`.
4. Run `$DW -p -f tasks/thr-only.md --session qa-jev`.

**Expected:**
- Steps 1 and 2 (all three runs): `exit=0`, no usage error (step 2 of `PLAIN` sends a Jev request; `PLAIN` has no Jev files, so the stub answers 500 and step 2 is Claude with `routed` `error: jev http 500`).
- Steps 3 and 4: `exit=0`, no usage error, no key error, 0 Jev requests, `jev_steps` 0.

### TS-11: `--no-jev` and flag order override other sources

**Contract:** C1, C2 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa_use PLAIN`; `unset TYPESAFE_API_KEY`.

**Steps:**
1. Run `$DW -p -f tasks/jev-on.md --no-jev --session qa-jev`.
2. Reset, `unset TYPESAFE_API_KEY`, `qa_use PLAIN`. Run `PLAIN` with `--jev --no-jev`.
3. Reset, `qa_use PLAIN` (key set). Run `$DW -p -f tasks/jev-off.md --jev --session qa-jev`.

**Expected:**
- Steps 1 and 2: `exit=0`, no key error, 0 Jev requests, no `Jev steps:` line.
- Step 3: at least 1 Jev request; stdout has `Jev steps: 0/2`.

### TS-12: Action and target confidence exactly at the threshold are accepted

**Contract:** C4, C5 · **Criteria:** SC1, SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use EDGE`.

**Steps:**
1. Run `EDGE` with `--jev` (default threshold 0.8).
2. `jq '.history[1] | {source, next_goal, routed: .jev.routed}' $H`.

**Expected:**
- `exit=0`; `Jev steps: 1/3`.
- Step 2: `source` `jev`, `next_goal` `jev: click link "QA Two" (0.80)`, `routed` `accepted`.

### TS-13: Action confidence just below the threshold goes to Claude, with both costs

**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use LOWA`.

**Steps:**
1. Run `LOWA` with `--jev`.
2. `jq '.history[1] | {source, actions: [.actions[].cmd], jev}' $H`; cost helper.

**Expected:**
- `exit=0`; `Steps: 2`; `Jev steps: 0/2`.
- Step 2: `source` `claude`; actions `["done"]`; `jev` `{"action":"click","action_confidence":0.79,"target":"<ref>","target_confidence":0.95,"routed":"low_confidence"}`.
- Costs `[1000000, 1004242]`.

### TS-14: Low target confidence, and `--jev-threshold` moves the bar

**Contract:** C1, C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset.

**Steps:**
1. `qa_use LOWT`; run `LOWT` with `--jev`. Record `jq '.history[1] | {source, routed: .jev.routed, tc: .jev.target_confidence}' $H`.
2. Reset, `qa_use ACC`; run `ACC` with `--jev --jev-threshold 0.95`. Record `jq '[.history[] | .jev.routed]' $H`.
3. Reset, `qa_use ACC`; run `ACC` with `--jev --jev-threshold 0.88`. Record the same.

**Expected:**
- Step 1: `{source:"claude", routed:"low_confidence", tc:0.5}`; `Jev steps: 0/2`.
- Step 2: `[null,"low_confidence"]`; run ends at step 2 (Claude's `done`); `Jev steps: 0/2`.
- Step 3: `[null,"accepted","done"]`; `Jev steps: 1/3`.

### TS-15: `needs_text` goes to Claude with the Jev cost added

**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; `qa_use TEXT`.

**Steps:**
1. Run `TEXT` with `--jev`.
2. `jq '.history[1] | {source, jev}' $H`; cost helper; count Claude calls.

**Expected:**
- `exit=0`; `Jev steps: 0/2`; 2 Claude calls.
- Step 2: `source` `claude`; `jev` `{"action":"needs_text","action_confidence":0.97,"target":"<ref of button \"QA Button\">","target_confidence":0.6,"routed":"needs_text"}`.
- Costs `[1000000, 1004242]`.

### TS-16: A page with 0 targets skips Jev

**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use ZERO`.

**Steps:**
1. Run `ZERO` with `--jev`. Count Jev requests; `jq '[.history[] | {source, jev}]' $H`; cost helper.

**Expected:**
- 0 Jev requests; every step `{source:"claude", jev:null}`; costs `[1000000, 1000000]`; `Jev steps: 0/2`.

### TS-17: 255 targets are sent; 256 targets skip Jev

**Contract:** C4, C5, C6 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use M255`.

**Steps:**
1. Run `M255` with `--jev`. `jq '.body.questions.target.criteria | length, (to_entries[0].value), (to_entries[-1].value)' $QA_DIR/jev-req-1.json`.
2. Reset, `qa_use M256`. Run `M256` with `--jev`. Count Jev requests; `jq '.history[1].jev' $H`.

**Expected:**
- Step 1: 1 Jev request, criteria length `255`, first `button "B1"`, last `button "B255"`; step 2 `jev.routed` `needs_text`.
- Step 2: 0 Jev requests; `history[1].jev` is `null`.

### TS-18: The step after a failed action skips Jev

**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use FAIL`.

**Steps:**
1. Run `FAIL` with `--jev`. Count Jev requests; `jq '[.history[] | {step, r: .results[0], source, routed: .jev.routed}]' $H`.

**Expected:**
- Step 2's result starts with `error:` (precondition check; if not, the scenario is invalid, not failed).
- 1 Jev request (for step 2). Step 2 `routed` `needs_text`; step 3 `jev` `null`, `source` `claude`.

### TS-19: A nudged step skips Jev

**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use NUDGE`.

**Steps:**
1. Run `NUDGE` with `--jev`. Count Jev requests; `grep -c 'You are repeating the same actions; try a different approach.' $QA_DIR/prompt-4.txt`; `jq '.history[3].jev' $H`.

**Expected:**
- 2 Jev requests (steps 2 and 3); `prompt-4.txt` contains the nudge (`1`); step 4 `jev` is `null`.

### TS-20: A Jev HTTP 500 goes to Claude with `routed: "error: …"`

**Contract:** C4, C5, C6 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use E500`.

**Steps:**
1. Run `E500` with `--jev`. `jq '.history[1] | {source, jev}' $H`; cost helper; count Jev requests.

**Expected:**
- `exit=0`; 1 Jev request (500 is not retried).
- Step 2: `source` `claude`; `jev` `{"action":null,"action_confidence":null,"target":null,"target_confidence":null,"routed":"error: jev http 500"}`; costs `[1000000, 1000000]`.

### TS-21: 429 is retried after 1 s and the retry's answer is used

**Contract:** C6 · **Criteria:** SC1, SC2 · **Type:** CLI, File, API · **Priority:** P2

**Preconditions:** reset; `qa_use R429`.

**Steps:**
1. Run `R429` with `--jev`. `jq -s '.[1].t - .[0].t' $QA_DIR/jev-req-1.json $QA_DIR/jev-req-2.json`; `jq '[.history[] | .jev.routed]' $H`.

**Expected:**
- 3 Jev requests (two for step 2, one for step 3); the gap between requests 1 and 2 is at least 1000 ms and below 2500 ms.
- Routed `[null,"accepted","needs_text"]`; `Jev steps: 1/3`.

### TS-22: 429 and 529 three times give up after 3 attempts

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI, File, API · **Priority:** P2

**Preconditions:** reset; `qa_use R429X`.

**Steps:**
1. Run `R429X` with `--jev`. Gaps between requests 1→2 and 2→3; `jq '.history[1].jev.routed' $H`.
2. Reset, `qa_use R529X`. Run `R529X` with `--jev`. Same checks.

**Expected:**
- Each run: exactly 3 Jev requests; gap 1→2 in [1000, 2500) ms; gap 2→3 in [3000, 4500) ms; `exit=0`; step 2 source `claude`.
- Routed: `error: jev http 429 after 3 attempts`, then `error: jev http 529 after 3 attempts`.

### TS-23: 422 messages collapse whitespace and keep the first 200 characters

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use E422`.

**Steps:**
1. Run `E422` with `--jev`. `jq -r '.history[1].jev.routed, .history[2].jev.routed' $H`.

**Expected:**
- Step 2: `error: jev http 422: bad state`.
- Step 3: `error: jev http 422: ` followed by exactly 200 `x` (check with `jq -r '.history[2].jev.routed | ltrimstr("error: jev http 422: ") | length' $H` → `200`).
- 2 Jev requests (422 is not retried).

### TS-24: A Jev call that takes longer than 10 s times out

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use SLOW`.

**Steps:**
1. Run `SLOW` with `--jev`, timing it with `time`.
2. `jq -r '.history[1].jev.routed, .history[1].source' $H`.

**Expected:**
- `exit=0`; routed `error: jev timeout after 10s`; source `claude`; 1 Jev request.
- The run takes at least 10 s and less than 20 s.

### TS-25: A dropped connection is a network error

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use DROP`.

**Steps:**
1. Run `DROP` with `--jev`. `jq -r '.history[1].jev.routed' $H`.

**Expected:**
- `exit=0`; routed starts with `error: jev network error: `; step 2 source `claude`.

### TS-26: Malformed 2xx bodies are errors, and valid usage is still charged

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use BAD`.

**Steps:**
1. Run `BAD` with `--jev`. `jq -r '.history[1:4][] | .jev.routed' $H`; cost helper.

**Expected:**
- `exit=0`; `Steps: 4`.
- Each of steps 2, 3, 4 has routed starting with `error: jev malformed response: ` and all four answer fields `null`.
- Costs `[1000000, 1000000, 1004242, 1004242]` (step 2's body had no valid usage; steps 3 and 4 had valid usage but an unknown choice, then a confidence of 1.5).

### TS-27: Claude failing after a Jev call keeps the Jev record and cost

**Contract:** C4, C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use CFAIL`.

**Steps:**
1. Run `CFAIL` with `--jev`. `jq '.history[1] | {results, source, actions, jev}' $H`; cost helper; count Jev requests.

**Expected:**
- `exit=0`; `Steps: 3`.
- Step 2: results `["brain error: …"]` (one entry starting `brain error:`), `source` `claude`, actions `[]`, `jev.routed` `needs_text`, cost `4242`.
- Step 3: `jev` `null` (previous step failed); 1 Jev request in all.

### TS-28: Jev errors never count as brain failures

**Contract:** C5 · **Criteria:** SC2 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use E3`.

**Steps:**
1. Run `E3` with `--jev`.

**Expected:**
- `exit=0`; `Result: success`; `Steps: 5`; the answer is `qa done`, not `stopped after 3 consecutive brain failures: …`.
- 4 Jev requests; steps 2 to 5 have `routed` `error: jev http 500`.

### TS-29: Ctrl-C during a Jev call interrupts the run

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `qa_use HANG`; a terminal.

**Steps:**
1. Run `$DW -p "QA HANG" --session qa-jev --max-steps 20 --jev; echo "exit=$?"` in the foreground.
2. When `$QA_DIR/jev-req-1.json` appears, wait 2 s and press Ctrl-C.

**Expected:**
- The process ends within about 2 s of Ctrl-C with `exit=130`; no `jev error` line; only 1 Claude call.

### TS-30: The previous Claude step's history and memory reach Jev; only 15 history lines are sent

**Contract:** C5, C6 · **Criteria:** SC2 · **Type:** CLI, API · **Priority:** P3

**Preconditions:** reset; `qa_use LONG`.

**Steps:**
1. Run `LONG` with `--jev`.
2. `jq '.body.state.history | length, .[0], .[1][0:9]' $QA_DIR/jev-req-16.json`.

**Expected:**
- `exit=0`; `Steps: 17`; 16 Jev requests.
- Request 16 (step 17): 16 entries; the first is `(1 earlier steps omitted)`; the second starts `step 2 | `.

### TS-31: Text sent to Jev is scrubbed like the Claude prompt

**Contract:** C6 · **Criteria:** SC2 · **Type:** CLI, API · **Priority:** P3

**Preconditions:** reset; `qa_use TEXT`; `export DUCKWRIGHT_TOTP_SECRET=JBSWY3DPEHPK3PXP`.

**Steps:**
1. Run `$DW -p "QA scrub JBSWY3DPEHPK3PXP" --session qa-jev --max-steps 20 --jev`.
2. `grep -c JBSWY3DPEHPK3PXP $QA_DIR/jev-req-1.json $QA_DIR/prompt-1.txt`.

**Expected:**
- Both counts are `0`; `jq -r .body.state.task $QA_DIR/jev-req-1.json` is not empty.

### TS-32: Plan-mode cases use `--jev`

**Contract:** C1 · **Criteria:** SC2, SC5 · **Type:** UI, File · **Priority:** P3

**Preconditions:** reset; `qa_use ACC`. Create the planned folder once **with the real `claude`** (remove `$QA_WORK/bin` from `PATH` for this command only): `$DW plan plans/qa-jev-plan.md -p`, which writes `tasks/qa-jev-plan/`. Restore `PATH`.

**Steps:**
1. Run `$DW --web --port 4173 --jev --plan tasks/qa-jev-plan/` (opening a planned folder does not call the planner).
2. Start the plan's only task from the web UI.
3. When it ends, open its `history.json`.

**Expected:**
- At least one Jev request; `jev_steps` is 1 and the steps' `source`/`jev` match TS-2 (step 2 accepted).

### TS-33: Task-file keys `jev` and `jev-threshold` act like the flags

**Contract:** C2, C7 · **Criteria:** SC5, SC4 · **Type:** CLI, File · **Priority:** P1

**Preconditions:** reset; `qa_use ACC`.

**Steps:**
1. Run `$DW -p -f tasks/jev-on.md --session qa-jev --max-steps 20 > $QA_DIR/out.txt 2> $QA_DIR/err.txt; echo "exit=$?"`.
2. `jq '[.history[] | .jev.routed]' $H`; count Jev requests.
3. Reset, `qa_use ACC`; run step 1 again with `--jev-threshold 0.88` added.

**Expected:**
- Step 1: `exit=0`; 1 Jev request; routed `[null,"low_confidence"]` (threshold 0.95 from the file); stdout has `Jev steps: 0/2` directly after the `Steps:` line.
- Step 3: routed `[null,"accepted","done"]`; `Jev steps: 1/3` (the flag beats the file).

### TS-34: Config keys turn on Jev; the task file beats the config

**Contract:** C2 · **Criteria:** SC5 · **Type:** CLI, File · **Priority:** P2

**Preconditions:** reset; `qa_use ACC`; `printf 'jev: true\njev-threshold: 0.95\n' > $XDG_CONFIG_HOME/duckwright/duckwright.conf`.

**Steps:**
1. Run `ACC` without any jev flag. Record routed list and Jev request count.
2. Reset, recreate the config, `qa_use PLAIN`. Run `$DW -p -f tasks/jev-off.md --session qa-jev`.

**Expected:**
- Step 1: Jev is used (1 request); routed `[null,"low_confidence"]`; `Jev steps: 0/2`.
- Step 2: 0 Jev requests; no `Jev steps:` line.

### TS-35: Invalid task-file values exit 2 with a located message

**Contract:** C2 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset.

**Steps:** run `$DW -p -f <file> --session qa-jev; echo "exit=$?"` for each:
1. `tasks/bad-jev.md`
2. `tasks/bad-thr-0.md`
3. `tasks/bad-thr-15.md`
4. `tasks/bad-thr-abc.md`

**Expected:**
- All `exit=2`, nothing runs, 0 Claude calls. stderr:
  1. `tasks/bad-jev.md:2: jev must be true or false, got "maybe"`
  2. `tasks/bad-thr-0.md:2: jev-threshold must be a number greater than 0 and at most 1, got "0"`
  3. `tasks/bad-thr-15.md:2: jev-threshold must be a number greater than 0 and at most 1, got "1.5"`
  4. `tasks/bad-thr-abc.md:2: jev-threshold must be a number greater than 0 and at most 1, got "abc"`

### TS-36: Invalid config values exit 2 with the config path

**Contract:** C2 · **Criteria:** SC5 · **Type:** CLI · **Priority:** P2

**Preconditions:** reset; `printf 'model: sonnet\njev-threshold: 2\n' > $XDG_CONFIG_HOME/duckwright/duckwright.conf`.

**Steps:**
1. Run `$DW -p "x"; echo "exit=$?"`.

**Expected:**
- `exit=2`; stderr has `<config path>:2: jev-threshold must be a number greater than 0 and at most 1, got "2"`, where `<config path>` is `$XDG_CONFIG_HOME/duckwright/duckwright.conf` as Duckwright prints it for other config errors.

### TS-37: `duckwright init` writes the commented jev keys

**Contract:** C2 · **Criteria:** SC5 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset (no config file).

**Steps:**
1. Run `$DW init`.
2. `grep -n -A2 '^# snapshot: hybrid$' $XDG_CONFIG_HOME/duckwright/duckwright.conf`.

**Expected:**
- The two lines after `# snapshot: hybrid` are `# jev: false` and `# jev-threshold: 0.8`.

### TS-38: TUI: `jev` toggles in the global pane and the task form

**Contract:** C3 · **Criteria:** SC5 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; `qa_use ACC`; key set; a 120x40 terminal.

**Steps:**
1. Start `$DW`. Add the task `QA ACC` (as README -> Interactive TUI describes).
2. Look at the global options pane.
3. Select the task, press `o`. Move to the last row.
4. Press space, then ctrl+r, then `→`, then ⏎.
5. Open the task's detail and read the settings list.
6. Start the task (`space`) and wait for it to end.

**Expected:**
- Step 2: the pane lists `jev` with `false`.
- Step 3: the last row is `jev` with value `false`.
- Step 4: space shows `true`; ctrl+r restores `false` (the effective value); `→` shows `true`; ⏎ closes the form.
- Step 5: the settings list shows `jev  true`.
- Step 6: Jev requests are made; the run's `history.json` has `jev_steps` 1.

### TS-39: Web UI: `jev` chip and options dialog

**Contract:** C3 · **Criteria:** SC5 · **Type:** UI · **Priority:** P1

**Preconditions:** reset; `qa_use ACC`; key set; web UI started without `--jev`.

**Steps:**
1. Read the options strip.
2. Open the global options dialog; open the `jev` select.
3. Choose `on`, Save. Read the strip.
4. Add the task `QA ACC` and start it from the UI; wait for it to end.
5. Open the global dialog, click Reset all, Save. Read the strip.

**Expected:**
- Step 1: chip `jev: off`.
- Step 2: options `inherit (off)`, `on`, `off`.
- Step 3: chip `jev: on ✱`.
- Step 4: Jev requests are made; `history.json` has `jev_steps` 1.
- Step 5: chip `jev: off` (no ` ✱`).

### TS-40: Web API: `jev` overrides and validation

**Contract:** C3 · **Criteria:** SC5 · **Type:** API · **Priority:** P2

**Preconditions:** reset; web UI started without `--jev`; one task `QA ACC` added; `TID` its id.

**Steps:**
1. `curl -s -H "$C" $B/api/state | jq '.globals.base.jev, (.tasks[] | select((.id|tostring)=="'$TID'") | {e: .effective.jev, i: .inherited.jev, o: .overrides.jev})'`.
2. `curl -s -X PUT -H "$C" -H "$O" -H 'content-type: application/json' -d '{"jev":true}' $B/api/globals`, then step 1 again.
3. `curl -s -X PUT -H "$C" -H "$O" -H 'content-type: application/json' -d '{"jev":false}' $B/api/tasks/$TID/overrides`, then step 1 again.
4. `curl -s -w ' %{http_code}' -X PUT -H "$C" -H "$O" -H 'content-type: application/json' -d '{"jev":"yes"}' $B/api/globals` and the same body to `$B/api/tasks/$TID/overrides`.

**Expected:**
- Step 1: `false`; `e` `false`.
- Step 2: `{"ok":true}`; task `e` `true`, `i` `true`.
- Step 3: `{"ok":true}`; task `o` `false`, `e` `false`.
- Step 4: both `{"ok":false,"error":"jev must be true or false"} 400`.

### TS-41: Starting a run from the UI with `jev` on and no key fails through preflight

**Contract:** C3 · **Criteria:** SC3, SC5 · **Type:** API, UI · **Priority:** P2

**Preconditions:** reset; `unset TYPESAFE_API_KEY`; web UI started without `--jev`; task `QA ACC` added with id `TID`; `PUT /api/tasks/$TID/overrides` `{"jev":true}`.

**Steps:**
1. `curl -s -w ' %{http_code}' -X POST -H "$C" -H "$O" $B/api/tasks/$TID/start`.
2. Look at the browser.
3. Quit; start the TUI without `--jev`, add `QA ACC`, set `jev` to `true` in its `o` form, press `space`.

**Expected:**
- Step 1: `{"ok":false,"error":"TYPESAFE_API_KEY is not set (needed by --jev)"} 409`; no run folder; 0 Claude calls.
- Step 2: an error toast with `TYPESAFE_API_KEY is not set (needed by --jev)`; the task shows that error.
- Step 3: the TUI shows the same message as an error toast and on the task; nothing runs.

### TS-42: Effective `jev` from the web overrides beats the command line

**Contract:** C1, C3 · **Criteria:** SC5 · **Type:** API · **Priority:** P3

**Preconditions:** reset; `qa_use PLAIN`; key set; web UI started **with** `--jev`; task `QA PLAIN` added.

**Steps:**
1. `PUT /api/tasks/$TID/overrides` `{"jev":false}`; start the task; wait for it to end.

**Expected:**
- 0 Jev requests; its `history.json` has `jev_steps` 0 and every `jev` `null`.

### TS-43: README documents the flag, the warning, the output and the roadmap

**Contract:** C8 · **Criteria:** SC6 · **Type:** File · **Priority:** P1

**Preconditions:** the branch's `README.md`.

**Steps:**
1. Read the options table, the task-file key table, the TUI global options sentence, the `[!WARNING]` blocks under Usage, the Output section and the Roadmap.

**Expected:**
- Options table: a `--jev` row directly after `--twofa-timeout` (default off, `--no-jev` overrides a task file, needs `TYPESAFE_API_KEY`, links to the warning) and a `--jev-threshold` row (default `0.8`, greater than 0 and at most 1).
- Task-file keys: `jev` | `true` or `false`; `jev-threshold` | a number greater than 0 and at most 1.
- The TUI globals sentence lists `jev`.
- A `[!WARNING]` next to the `--allow-file-access` one saying `--jev` sends the task, every page snapshot it routes, and the step history to TypeSafe's API (`api.typesafe.ai`), including anything visible on logged-in pages, and to use it only where that is acceptable.
- Output: describes `cost_usd`, `source`, `jev` per step, `jev_steps` and `claude_steps`, and the `Jev steps:` line.
- Roadmap: the Jev item is `[x]`, in the past tense, and says savings are not benchmarked yet.

## Regression

### TS-44: Export and past runs still accept `history.json` with and without the new fields

**Contract:** C4 · **Criteria:** SC4 · **Type:** CLI, UI · **Priority:** P2

**Preconditions:** reset; `qa_use ACC`; run `ACC` with `--jev` (as TS-2). Copy the run: `cp -a $RUN $QA_WORK/runs/20261008-120000-qa-old` and strip the new fields: `jq 'del(.jev_steps, .claude_steps) | .history |= map(del(.cost_usd, .source, .jev))' $RUN/history.json > $QA_DIR/h.json && mv $QA_DIR/h.json $QA_WORK/runs/20261008-120000-qa-old/history.json`.

**Steps:**
1. `$DW export $RUN -o $QA_DIR/new.spec.ts; echo "exit=$?"`.
2. `$DW export $QA_WORK/runs/20261008-120000-qa-old -o $QA_DIR/old.spec.ts; echo "exit=$?"`.
3. `diff $QA_DIR/new.spec.ts $QA_DIR/old.spec.ts`.
4. Start the web UI; open the History tab; open both runs.

**Expected:**
- Both exports `exit=0`; the files are identical (export output is unchanged by the new fields); the Jev-accepted click appears as a click step.
- Both runs load in History with their 3 steps; no error.

### TS-45: A Claude-only brain failure run is unchanged

**Contract:** C4 · **Criteria:** SC4 · **Type:** CLI, File · **Priority:** P3

**Preconditions:** reset; `mkdir -p scripts/NONE/claude`; `qa_use NONE`.

**Steps:**
1. Run `NONE` without `--jev`.

**Expected:**
- `exit=1`; `Result: failure`; the answer starts `stopped after 3 consecutive brain failures: `; 3 steps, each with results starting `brain error:`, `source` `claude`, `jev` `null`, `cost_usd` 0; `jev_steps` 0, `claude_steps` 3.

TS-4 (non-Jev print output and `history.json`), TS-1 (unchanged help lines) and TS-11 (`--no-jev` like `--no-video`) also guard existing surfaces.

## Out of scope

- Unit and integration tests (run as checks during implementation).
- Any call to the real TypeSafe API, including the spec's manual e2e and checking the live API shape or prices.
- The opt-in benchmark harness and its fixtures.
- Jev writing text (URLs, form values, the final answer); a plan-then-execute split; making Jev the default; running without Claude installed.
- A UI field for `jev-threshold`; a flag for the Jev model name; the step source in TUI/web timelines; `Jev steps` in TUI/web summaries.
- How the TUI/web show a run that fails with a 401 beyond "the run fails with that error" (the spec gives no copy).
