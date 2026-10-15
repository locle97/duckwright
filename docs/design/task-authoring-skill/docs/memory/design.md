# Design: investigation and long-term memory for `duckwright-tasks`

Candidate 1. Branch `claude/cool-hopper-zodp5c` (PR #60), read-only. Every harness claim below was checked
in `src/`; file names are given where it matters.

## Summary

The skill already knows how to *probe* (a read-only `duckwright -p` run, `references/close-gaps.md`), but
what a probe learns lives only in one task's `# observed:` comment and the chat. Next session, it probes
or asks again. This design keeps the probe as the investigation tool and adds one thing: a small,
append-only **facts file** per host, `<root>/.duckwright/facts/<slug>.jsonl`, written only by a new script
`scripts/facts.mjs`. The script stores a value only if the run folder proves it, keeps who/when/how for
every fact, marks facts stale when their code file changes or their page goes stale, and prints a 4 KB
filtered brief that the skill reads in step 1 next to the sitemap brief. The user's verdicts ("that
message is right", "that is a bug, it should say X") are stored too, so nobody asks twice.

v1 is skill-only (SKILL.md, two references, one template, one script, a linter/doctor patch adding one
map key). A v2 harness change, `duckwright explore --focus`, is sketched for better evidence and guarded
writes; v1 does not need it.

## What the code actually does (and what it means here)

| Fact (source) | Consequence |
| --- | --- |
| `note` is rejected outside explore runs: `"error: command 'note' not allowed outside explore runs"` (`src/actions.ts`) | A `-p` probe cannot use notes; its findings come back in the `done` answer |
| A run folder keeps only the **last** snapshot: `page/snapshot.yml` is rewritten each step (`src/observe.ts`) | The answer cannot be checked against intermediate pages, except... |
| ...a passed `expect` stores its assertion in `history.json` (`code`, e.g. `await expect(page.getByText('Enter a promo code.')).toHaveText("Enter a promo code.")`; `src/expect.ts`). Failed ones store `null` | **The harness already verifies text for us**: ask the probe to `expect` each value before reporting it, then check the code lines |
| `network/<id>/request.json` + `response.json` hold method, URL, status (`src/network.ts`) | `api` facts are checkable mechanically |
| `-p` prints `Answer:` and `History:` (`src/report/plain.ts`) | The skill finds the run folder from stdout |
| Sitemap notes are plain strings with no run, date or URL; only `business`, `quirk`, `off-limits`, `account` are kept, 20 per kind, oldest pushed out (`src/explore/merge.ts`, `site.ts`) | The sitemap is the wrong home for provenance-carrying facts |
| The env file goes into every step's prompt, max 16384 bytes, and explore shrinks its generated block to fit (`src/environment.ts`, `src/explore/envfile.ts`) | Facts do not go there; every byte costs on every step |
| Explore auto-loads `environments/<slug>.md` and rewrites its generated block (`src/cli.ts` `exploreMain`) | A scoped explore has side effects on the runtime env; say so when asking |
| `--allow-writes` has a marker, a delete-click guard and a ledger; `-p` has none; no host guard anywhere (`src/runs/run.ts`, README) | Writes probes need skill-level gates; v2 moves them under the guard |
| The linter rejects a task without "Expected results:" (`check-tasks.mjs`) | Probe files need a small linter exception |

## 1. When to investigate, ask, or assume

Per gap, in order (full table and gates in `skills/duckwright-tasks/references/close-gaps.md`):

1. **Memory.** A current fact answers it: use it, no run. A stale one: re-run its probe file.
2. **Never investigated:** credentials, 2FA, inboxes, files, anything off-limits. Ask or plan note.
3. **Ask:** what the product *should* do (expected totals, wording, policy, permissions as intended).
4. **Investigate:** what the app *does today* (labels, where a feature lives, flow steps, the message after
   an action, field validation, what a role sees, seed data present, API calls), if all gates pass.
5. **Assume** only where a wrong guess fails loudly at that step (a label to click, which of two paths).
   Never an expected result: a wrong one can pass for the wrong reason.

Gates for any run: env in the map's new `investigate-envs` key (or named by the user now), never
production; URLs on the env's Base URL host (enforced by `ingest`); sign-in only via an existing state
file; writes only on `write-envs` with a separate yes and a stated undo; at most 5 probes x 15 steps (20
with writes) and one 40-step explore per request; one consent message for the whole request, combined
with the step-3 questions, with cost taken from the last probe's `cost_usd`.

## 2. How the skill drives Duckwright

| | Scoped `explore` (exists) | Probe: `duckwright -p -f <probe>` (exists) | `explore --focus` (new) |
| --- | --- | --- | --- |
| Answers a specific question | Poorly: the prompt is "understand the business, walk 3-5 flows" | Yes: the probe lists numbered questions | Yes |
| Budget | 60 default, 40 scoped | 15 (20 with writes) | 20 (30 with writes) |
| Evidence | Notes are unverified agent text | Passed `expect` code, last snapshot, network | Each `fact` note checked against that step's snapshot by the harness |
| Writes safety | Marker, guard, ledger | Prompt rules only | Marker, guard, ledger |
| Persists | Sitemap + env generated block (pages, flows; no exact labels or messages) | Nothing by itself; `facts.mjs ingest` stores proven values | Sitemap + `facts.jsonl` in the run folder |
| Harness change | No | No | **Yes** (`harness-v2/explore-focus.md`) |

**v1 choice: the probe**, written as a file in `<root>/.duckwright/probes/` from `templates/probe.md`
(kept, so re-verifying is re-running it), with a JSON answer and an `expect` before every reported value.
Scoped explore stays for an area the sitemap lacks. `--focus` is v2: it fixes "evidence only from the last
page" and "writes probes have no guard", which v1 works around with the `expect` rule and narrow writes.

## 3. What is stored, where

| Store | Holds | Loaded | Size |
| --- | --- | --- | --- |
| Sitemap `environments/<slug>.sitemap.json` (unchanged, harness-owned) | pages, flows, functions, frontier, notes | on demand, `sitemap-brief.mjs` | harness caps |
| Env file (unchanged) | runtime facts for the agent | **every step of a run** given `--env`/`env:` | 16384 bytes |
| Testing map (one new key `investigate-envs`) | authoring rules, where probes may run | every authoring session | a few KB |
| **Facts** `<root>/.duckwright/facts/<slug>.jsonl` (new) | verified labels, messages, flows, fields, locations, role views, seed data, API calls, quirks, plus user verdicts | on demand, `facts.mjs brief <area words>`: at most 40 lines / 4096 bytes | at most 400 facts per host; values 300 chars |
| **Probes** `<root>/.duckwright/probes/*.md` (new) | the probe tasks | when re-verifying | small |
| Run folders `runs/` | raw evidence | only by `ingest` | not in git; each fact keeps a 200-char excerpt |

Always-loaded path: only the CLAUDE.md pointer line (one line added) and the map key. Everything else is
on demand and filtered. Nothing new goes into the env file; the one exception is a `quirk` that changes how
the agent must drive a page, which the skill may *propose* for `## Notes (yours)` as a diff (existing rule).

Format: JSON Lines, one fact version per line, last line per id wins, ids derived from
(host, kind, area, subject) so re-asking the same question supersedes instead of duplicating. Full field
list and a worked record: `skills/duckwright-tasks/references/memory.md`. Git: commit facts and probes;
`.gitattributes` `merge=union` for the `.jsonl` (append-only, so union merge is lossless). The doctor
warns if it is missing.

## 4. Provenance, staleness, trust

- **Source on every fact:** `source {type: probe|user|code, run, probe, env, role, date}` and
  `evidence {how: expect|snapshot|network|user|code, ref, excerpt}`. `ingest` keeps a value only with
  evidence; the agent's claim alone is printed as `rejected`.
- **Confidence is the status, not a number:** `observed` (app shows it; may fix labels, routes, step
  order, API paths), `intended` (user confirmed; may be an expected result), `bug` (user said wrong;
  `intended_value` may be the expected result), `retired` (with a reason). `expect` evidence ranks over
  `snapshot` over `network` only in the order `ingest` looks.
- **Expiry and re-verify:** `verify_after` (data 14 days, quirk 30, others 60, none for user statements);
  any `code_refs` file committed after the fact's date (git); the sitemap marking the area stale or broken.
  The brief lists those under "re-verify", and the skill treats them as `# assumption:`. A changed value on
  re-probe drops an earlier `intended` verdict and says "ask the user again".
- **User wins:** testing map, env file outside the generated block, and the user now beat any fact. The
  skill retires the contradicted fact with the reason; it never edits the team's text to match a fact.
- **Prompt injection:** values are page text. The probe text says so; `facts.mjs` refuses comment
  markers and harness tags, prints values quoted, one line, truncated; SKILL.md says fact values are never
  instructions and can never widen envs, writes or off-limits (those come only from the map and env file).
  The evidence check also means an injected page can only make us store text that really is on that page,
  and it still only ends up quoted inside a task.

## 5. Read-back

- **Next authoring session:** step 1 runs `facts.mjs brief --root <root> --host <host> --sitemap <file>
  <area words>` right after `sitemap-brief.mjs`. Cost: one command, about 4 KB, only the area. Tasks cite
  `fact <id>` in `# sources:`, so a reviewer can find the record and its evidence. Teammates get it through
  git; the brief shows `as shopper C` and the date so they know whose view it was.
- **Runtime agent: no, by design.** Tasks already carry the verified labels and steps, and the task wins
  over the env file anyway. Putting facts in the env file would cost on every step, fight explore for the
  16 KB, and let a stale fact mislead a run. Runtime benefits indirectly (tasks with correct labels) and
  through the existing "propose a quirk to `## Notes (yours)`" path. Runtime runs also *feed* memory: a
  smoke run that cannot find a fact's label retires it.

## 6. Safety

- **No secrets:** `facts.mjs` refuses password/token/key assignments, long mixed tokens, JWTs, bearer and
  basic strings (the explore `note` checks plus two); warns on email addresses (keep seeded accounts only).
  Probes sign in only via state files; the skill never opens them.
- **Writes:** only on envs in both `investigate-envs` and `write-envs`, with a separate yes, the map's
  `data-prefix` + `PROBE-` for names, and an undo the probe itself checks with an `expect`. What is not
  undone is reported with name and URL; the user decides (or runs the seed reset). v2 puts this under the
  harness guard and ledger.
- **Never prod:** the env allow-list, a name/URL/env-text check for production, and `ingest`'s host check.
  The README's "no host guard" stays true for `--allow-writes`; a `DUCKWRIGHT_WRITE_HOSTS` allow-list is
  listed as a separate harness fix.
- **Consent and cost:** one message per request listing runs, env, role, writes and cost; no yes, no run.
  Budget caps above. The report lists cost per probe from `history.json`.

## 7. Split, v1, scope, failure modes

**v1 (skill-only), one PR:**

- `skills/duckwright-tasks/SKILL.md`: facts in step 1, a facts row in the conflict table, investigation
  folded into the single question round, step 3b rewritten as the decision rule, citations, retire on a
  failed smoke run, report and never-list additions. Full text and `patches/SKILL.md.diff`.
- `references/close-gaps.md` (rewritten: rule, gates, consent message, probe, cleanup, explore, arena),
  `references/memory.md` (new), `templates/probe.md` (new), `scripts/facts.mjs` (new, ~390 lines, no deps).
- `patches/setup-linter-convention.diff`: `investigate-envs` in `check-tasks.mjs` and `doctor.mjs` key
  lists, a probe exception in the linter, a doctor check for the facts file and `.gitattributes`, the
  testing-map template, the CLAUDE.md section line, and `project-convention.md`. `test/skill-check.test.ts`
  should also assert the probe template and memory reference exist.
- Larder example: map key (`patches/larder-testing-map.diff`), a probe, a facts file, three tasks.

**v2 (needs harness change):** `explore --focus` (`harness-v2/explore-focus.md`, ~150 lines in
`src/explore/`, `args.ts`, `cli.ts`). Separately: a host allow-list for `--allow-writes`.

**Out of scope:** facts in the env file or the runtime prompt; sharing facts between hosts (a staging
label is not proven on local); per-step snapshot retention; a facts UI in the TUI; the skill running
explore unprompted; storing arena outcomes or authoring rules as facts.

**Failure modes:**

| Failure | Handling |
| --- | --- |
| Probe answer has no JSON / agent skips the `expect`s | `ingest` rejects; reword once; then ask the user |
| Value on an intermediate page, no `expect` | Rejected (v1 limit); v2's note-time check fixes it |
| Same-day code change | Missed (dates, not times); the 60-day expiry and the first failing run catch it |
| `code_refs` outside a git checkout | Check skipped silently; time expiry still applies |
| Two sessions append at once | One `appendFileSync` per ingest; O_APPEND keeps lines whole |
| Git merge of two people's facts | `merge=union`; duplicate ids resolve to the later line |
| Hand edit breaks a line | That line is skipped, never fatal; doctor reports damaged lines |
| Fact store fills up (400) | `ingest` refuses; `compact`, or retire old facts |
| Role state file expired mid-probe | Probe finishes `done failure "state expired"`; nothing stored; ask a person |
| A writes probe leaves data | Reported with name and URL; seed reset suggested |
| Fact contradicts the map | Map wins; fact retired with the reason |
| Observed value is a bug | User marks it `bug`; the task uses `intended_value` and a plan note says it fails until fixed |

## Worked example: Larder, "promo code edge cases"

Files: `docs/design/task-authoring-skill/examples/project-larder/e2e/` in this candidate (probe, facts,
`.gitattributes`, `tasks/basket-promo-codes-2/`), the run folder in `fixtures/runs/`, and the brief in
`fixtures/brief-next-session.txt`. Every command below was run against those files.

**Request:** "Add tasks for removing an applied promo code, an empty code, and a lower-case code."

1. **Read.** Map, `local.md`, sitemap brief for `cart promo`, `facts.mjs brief` (no facts yet), i18n file.
   Gaps: G1 the control that removes an applied code (the existing setup only says "remove it"); G2 what
   Apply does with an empty field (i18n has `coupon.empty`, but is it shown, or is Apply disabled?); G3 the
   API call for removal; G4 what `save10` does today; G5 whether `save10` *should* work (policy).
2. **Sort.** G1-G4 observable: probe. G5 policy: ask. Gates: `local` is in `investigate-envs` and
   `write-envs`; shopper C's state file exists; seeing a removal needs a basket write, so this is a writes
   probe (adds a product, applies and removes codes, empties the basket).
3. **One message:** the probe (env, role, writes, undo, ~20 steps, cost) plus the question "should promo
   codes be case-insensitive?". User: "yes, run it; codes should be case-insensitive, that's LAR-412."
4. **Probe** `e2e/.duckwright/probes/basket-coupon-remove.md`, linted, then
   `cd e2e && duckwright -p -f .duckwright/probes/basket-coupon-remove.md`.
5. **Ingest:**
   ```
   $ node facts.mjs ingest --root . --run runs/20261015-142210-basket-coupon-remove \
       --probe .duckwright/probes/basket-coupon-remove.md --env local --role "shopper C" --code-ref app/src/i18n/en.json
   kept f-fc9d48 [field] /cart Apply with an empty Promo code field = "Enter a promo code." (expect: history.json step 6)
   kept f-c2af40 [flow] /cart remove an applied promo code = "Promo code removed." (expect: history.json step 8)
   kept f-866975 [label] /cart control that removes an applied promo code = "Remove code" (expect: history.json step 7)
   kept f-63f94f [api] /cart call made when an applied code is removed = "DELETE /api/cart/coupon 200" (network: network/0007)
   kept f-bd3a82 [message] /cart Apply with a lower-case code save10 = "This code is not valid." (expect: history.json step 9)
   rejected Q2 message after applying SAVE10 = "Promo code applied!": not found in a passed expect, the last snapshot or the network capture
   5 kept, 1 rejected, ...; cost of this probe $0.21 in 10 steps
   ```
   The rejected line is the agent paraphrasing a message it never checked: it does not become a fact.
6. **Verdicts.** The skill asks about the two values it wants as expected results; the user confirms both
   and calls G4 a bug:
   `facts.mjs confirm --quote "Yes, 'Enter a promo code.' is the copy we want." f-fc9d48`,
   `facts.mjs confirm --quote "DELETE returning 200 is right." f-63f94f`,
   `facts.mjs bug --quote "Codes should be case-insensitive; that is LAR-412." --intended "Promo code applied." f-bd3a82`.
7. **Write.** `tasks/basket-promo-codes-2/`: BSK-4 uses the observed label and flow (`# observed:`), the
   intended API status and a derived total, but not the unconfirmed "Promo code removed."; BSK-5 uses the
   intended message; BSK-6 checks the user's intended behaviour, with a plan note that it fails until
   LAR-412. The shared setup now says `click "Remove code"`. Linter: 0 errors (state-file warnings only).
8. **Report** lists facts kept/rejected, the cost, "basket emptied, nothing left", and the observed
   "Promo code removed." as needing confirmation.

**Next session, a teammate, a month later:** "add a test that SAVE10 can be re-applied after removal".
Step 1 prints `fixtures/brief-next-session.txt`: the label, flow, API call and the empty-code message are
current, the lower-case bug is listed with its intended value. No probe, no questions about those; the
only new gap is whether re-applying is allowed (policy: ask). If `app/src/i18n/en.json` had been changed
since, the four facts tied to it would be under "re-verify" and the skill would offer to re-run
`basket-coupon-remove.md` (tested: a later commit to that file moves them there).

## Rationale: alternatives considered and rejected

- **Store facts in the sitemap** (extra key or new note kinds). The sitemap is harness-owned, rewritten
  under a lock by every explore run, capped, and its notes are bare strings with no provenance. A second
  writer racing the merge and new fields the harness would have to preserve: rejected.
- **Store facts in the env file's `## Notes (yours)`.** Pasted into every step of every run, 16 KB shared
  with explore's block, and it is the team's hand-written text that this skill must not rewrite. Kept only
  for agent-relevant quirks, on a yes.
- **Store facts in the testing map.** It is the team's rules, read by people; machine-appended observations
  would bury the rules and turn every probe into a map edit to review.
- **One Markdown "knowledge" file per project.** Readable, but no reliable parsing for status, dates and
  ids, and the skill would read it whole. JSONL plus a brief script gives both the filter and the
  structure; humans read the brief.
- **Use scoped explore for every gap.** Its prompt is a broad first-visitor mandate with a 40-60 step
  budget, and it stores pages and flows, not exact labels or messages. Too expensive and too vague for
  "what does the remove button say".
- **Trust the probe's answer.** The existing close-gaps tells the skill to grep the run folder; making that
  a script (`ingest`) instead of an instruction means it is done every time, the same way, and the
  `expect` rule makes most values provable without a harness change.
- **Build the narrow mode first (`explore --focus`).** Better evidence and guarded writes, but a harness
  change, a release, and the skill would still need the facts file. v1 delivers the memory now; v2
  improves the evidence later without changing the file format.
- **Keep every step's snapshot** to prove intermediate values. Megabytes per run for a few strings; the
  `expect` rule (v1) and note-time check (v2) prove exactly the values that matter.
- **Numeric confidence scores.** Nobody can act on 0.7. Status (observed / intended / bug / retired) plus
  evidence kind says what a fact may be used for.
- **Auto-promote observed values to expected results after N agreeing probes.** Repetition proves the app
  is consistent, not that it is right. Only the user makes a fact `intended`.
- **Per-session consent stored in the map ("always allow probes").** Cost and data side effects differ per
  request; `investigate-envs` says *where*, the user still says *whether*, once per request.

## Files in this candidate

- `design.md` (this file)
- `skills/duckwright-tasks/SKILL.md` (full replacement) and `patches/SKILL.md.diff`
- `skills/duckwright-tasks/references/close-gaps.md` (full replacement), `references/memory.md` (new)
- `skills/duckwright-tasks/templates/probe.md` (new)
- `skills/duckwright-tasks/scripts/facts.mjs` (new; brief, ingest, add, confirm, bug, retire, compact)
- `patches/setup-linter-convention.diff` (applies cleanly to the branch: `git apply --check` passed)
- `patches/larder-testing-map.diff`
- `docs/design/task-authoring-skill/examples/project-larder/e2e/{.gitattributes, .duckwright/probes/basket-coupon-remove.md, .duckwright/facts/localhost-3000.jsonl, tasks/basket-promo-codes-2/*}`
- `fixtures/runs/20261015-142210-basket-coupon-remove/` (a hand-built run folder in the real layout), `fixtures/brief-next-session.txt`
- `harness-v2/explore-focus.md` (needs harness change)

**Verified:** `facts.mjs` ingest/confirm/bug/add/retire/compact/brief on the fixture, including secret
refusal, wrong-env refusal, and git-based staleness; patched linter on the probe and the new tasks (0
errors); patched doctor reports the facts file. **Not verified:** a live probe against a running app; the
fixture run folder is hand-built from the formats in `src/export.ts`, `src/expect.ts` and `src/network.ts`.
