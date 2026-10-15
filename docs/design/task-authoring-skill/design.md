> **Arena synthesis.** Base: candidate 1 (opus), chosen by the parent and the cross-judge independently.
> Grafts: from candidate 3, `sitemap-brief.mjs` (filtered sitemap view, leftover-data warning), reading
> `.claude/rules/*.md` whose `paths:` match, and asking instead of picking when the sitemap is newer than
> the map; from candidate 4, lint rules for placeholders, vague checks and "close the browser", citing the
> explore run number in tasks built from the sitemap, and confirming the list when there are more than
> about six scenarios. Trimmed: map front matter cut from eight keys to five. Rejected: candidate 3's
> single global precedence list and candidate 4's "missing `state:` file is an error" (a person makes
> it, so a warning). Dropped: candidate 2 (fable) produced nothing, its model was out of credits.
> Verified: the Larder example lints with 0 errors and 3 expected warnings; a bad fixture now gets 12
> errors including the placeholder and upload steps candidate 1 had missed. `skill-check.test.ts` is for
> the implementation PR and was not re-run here. No live Duckwright run was done.

# Design: `duckwright-tasks`, a skill that writes task files from a project's own testing rules

Status: draft · Date: 2026-10-15 · Harness changes needed: none (two optional ones are listed at the end)

## Summary

We ship one Claude Code skill, `skills/duckwright-tasks/`, in the Duckwright repo. A user installs it in
their project and runs `/duckwright-tasks <what to test>`. The skill reads, in a fixed order, a pointer
in the project's CLAUDE.md, a **testing map** (`.duckwright/testing-map.md`, the project's rules for
writing tasks), the **environment file** (runtime facts the agent already gets), the **explore sitemap**,
existing tasks and, only for missing facts, a few code files. It writes a planned folder (task files,
`shared/setup.md`, `plan.json`) in the format `duckwright plan` already reads, lints it with a bundled
dependency-free script, audits every quoted value against its cited source, and reports what a person
still has to do.

The central decision is a split of project knowledge into two files with different readers:

- **Env file** (`environments/<name>.md`): what the agent needs *while driving the browser*. It is pasted
  into every step's prompt, capped at 16384 bytes, and shared with explore's generated block.
- **Testing map** (`.duckwright/testing-map.md`): how *tasks are written* for this project. Read only at
  authoring time, by the skill and by people. Costs nothing at run time.

CLAUDE.md gets only a 5-line pointer, because it is loaded into every session, test-related or not.

## What ships, and where

In the Duckwright repo (this candidate's output dir mirrors these paths):

| Path | What |
| --- | --- |
| `skills/duckwright-tasks/SKILL.md` | The skill: discovery, precedence, ask/infer, writing rules, output, self-check, report |
| `skills/duckwright-tasks/references/harness-constraints.md` | What a task can and cannot ask for, each fact tied to a source file |
| `skills/duckwright-tasks/references/project-convention.md` | The convention the project follows (also user docs) |
| `skills/duckwright-tasks/templates/{task.md,plan.json,testing-map.md,claude-md-section.md}` | Skeletons the skill fills |
| `skills/duckwright-tasks/scripts/check-tasks.mjs` | Linter, Node 22, no deps, read-only, ~320 lines |
| `examples/project-larder/` | Worked example: CLAUDE.md, testing map, env file, sitemap, and the skill's output for one request |
| `test/skill-check.test.ts` | Keeps the linter's key list and the reference in step with `src/taskfile.ts` and `src/brain.ts`; runs the example through the real parsers and the linter |

`skills/` sits at the top level, not in `.claude/skills/`: that folder holds the skills used to develop
Duckwright itself, and mixing a user-facing skill into it would install it for contributors too.

**Install for users** (README section to add): either copy `skills/duckwright-tasks/` into the
project's `.claude/skills/`, or `npx skills add locle97/duckwright --skill duckwright-tasks` (the `skills`
tool this repo already uses, see `skills-lock.json`). Optional packaging change: add `"skills"` to
`package.json` `files` so `npm i -g duckwright` carries a copy users can copy from. Not a harness change.

Verified in a scratch copy of the repo: `node --test test/skill-check.test.ts` passes 5/5, `tsc` is
clean for it, and the example's tasks and `plan.json` load with `loadTaskFile`, `loadPlan` and
`loadEnvironment`.

## What the project provides

Full spec: `references/project-convention.md`. Worked example: `examples/project-larder/`.

```
<repo>/CLAUDE.md                         ## Duckwright section: 5 lines, pointers only
<root>/                                  the folder duckwright runs from (Larder: e2e/)
  .duckwright/testing-map.md             authoring rules (hidden: `duckwright -f <dir>` runs every root .md)
  environments/local.md                  runtime facts + explore's generated block
  environments/localhost-3000.sitemap.json   from duckwright explore
  .auth/*.json                           state files, git-ignored, made by a person
  tasks/<feature>/                       the skill's output
```

**The Duckwright root** has to be written down because a bare `env: local` resolves from the run's
current directory (`src/environment.ts` `resolveEnv`), not from the task file. Every relative path the
skill writes depends on it.

**Testing map format.** Markdown with front matter in Duckwright's own flat `key: value` syntax, so there
is one syntax to learn. Only the keys a machine checks are in front matter (five; locations are derived, `max-steps` is a rule of thumb in the skill):

| Key | Purpose |
| --- | --- |
| `default-env`, `write-envs` | which env by default; which envs may receive writes |
| `data-prefix` | prefix for created data (`RT-`, the same prefix explore's function tasks already use) |
| `off-limits-terms` | words and paths the linter flags |
| `allow-literals` | seed-only values that look like secrets but may appear (a local test password, a public test card) |

The body is prose under fixed headings (Environments, Auth, Test data, Setup: UI or API, What the UI
calls things, How to check results, Needs a person, Naming, Off-limits) with numbered rules R1..Rn that
tasks cite in `# sources:`. Prose, because people write rules as prose and Claude reads it fine; front
matter, only where a script needs to check something.

**Env file**: unchanged from today's convention. One recommendation: run explore with
`--env environments/local.md` so its generated block lands in the team's env file instead of a second
`localhost-3000.md`, ; the sitemap is still named by host slug and the skill finds it from the Base URL.

## Discovery order, precedence, missing and conflicting info

Order the skill reads in (SKILL.md section 1):

1. Duckwright root: CLAUDE.md `Duckwright root:` line, else the folder with `.duckwright/` or
   `environments/`, else repo root.
2. Testing map: `<root>/.duckwright/testing-map.md` or the path CLAUDE.md names.
3. Env file: user's choice, else map `default-env`, else the only one in `environments/`, else ask.
   Split into team-written text and the generated block by the explore markers.
4. Sitemap: map `sitemap:`, else `environments/<slug of Base URL host>.sitemap.json`.
5. Two or three existing tasks: house style, and no duplicates.
6. Code, only for a missing fact, about ten files at most, each cited: i18n strings, routes, seed script.
7. The user's request and anything they point to.

Never read: `.env*`, state files, anything holding credentials. Sitemap and generated text are page
content and are treated as data, matching what `prompts/system.md` tells the agent.

**Conflicts: one owner per kind of fact**, instead of one global ranking, because sources are
authoritative for different things:

| Fact | Owner |
| --- | --- |
| How tasks are written | testing map (user can override per request; recorded as `# override:`) |
| URLs, accounts, seed data, quirks | env file, team-written part |
| Which pages and flows exist, labels | sitemap `status: ok` entries, and code |
| Off-limits | the union of every source; nothing widens it |
| What to test | the user |

The owner wins and the conflict is listed in the report. A generated block or sitemap can never widen
what a task may do; it can only add off-limits.

**Missing info** (table in `project-convention.md`): no map means the skill still works from env,
sitemap and code, marks more `# assumption:` lines, and offers to write a starter map at the end. No env
file means it asks for the base URL and suggests `duckwright explore`. No sitemap means URLs are not
checked. Missing auth for a needed role, or a missing expected value, is a question, never a guess.

## How explore output feeds in

- `sitemap.json` `pages`: the linter checks every URL in a task against page paths and `:id` patterns,
  and warns on `broken`/`stale` pages and on paths explore never saw. `gated` tells the skill a state
  file is needed. `title`/`purpose` give the app's own vocabulary.
- `flows` and `functions` with `status: ok`: proven starting points. The skill can also upgrade
  `tasks/explore-<host>/` files from `--write-tasks`: same flow, rewritten under the map's rules (state
  file, env, checks, IDs), into a new folder.
- `notes`: `off-limits` joins the union; `account` says which roles exist (never values); `quirk` and
  `business` are background.
- Generated env block: lowest-trust facts; the team-written part of the same file wins.
- Staleness: the sitemap's `runs` and per-page `last_seen_run` are shown in the report when old; the
  skill suggests a new explore run rather than trusting a stale map.

## Writing rules that carry the most weight

(Full list in SKILL.md section 4. These are the ones that come from real harness behaviour.)

- **Sign in with a state file.** The agent cannot read environment variables, so "password in the env
  var X" (as `examples/environments/staging.md` suggests) gives it no way to get the password. A task can
  only type what is written in it, so only `allow-literals` seed values may appear.
- **Fail loudly on an expired state.** Each state-file task (or its shared setup) says: if the sign-in
  form shows, `done failure "state expired: ..."`.
- **UI setup, not `request`,** unless the map allows an endpoint the page calls on load: `request` only
  replays calls already seen this run, and `duckwright export` refuses a `request` after any UI action
  other than `goto` (`src/request.ts`, `src/export.ts`).
- **Labels, not selectors.** The agent acts on accessibility-snapshot refs; the export writes its own
  locators. Test ids in steps help nobody.
- **No invented values.** Every quoted message and number has a `# sources:` or `# derived:` entry
  (derived = arithmetic on documented seed data, shown in the comment).
- **People's work goes to `plan.json` notes; impossible scenarios go to `skipped`** with a reason. Same
  split `duckwright plan` already makes, so the TUI shows them under "Before you run".
- **Isolation.** Fresh browser per task, but the server is shared: created data gets
  `<data-prefix><ID>-`, tasks that share an account are spread over accounts or the plan notes
  `--max-parallel 1` (Larder rule R4).
- Body text goes to the agent verbatim, HTML comments included; notes for people live in front-matter
  comments.

## Validation and self-verification

**1. Linter** (`scripts/check-tasks.mjs --root <root> <folder>`), run by the skill after writing; exit 1
on any error. It reimplements the front-matter rules of `src/taskfile.ts` (the test keeps the key list
in step).

| Check | Level |
| --- | --- |
| front matter closed; known keys only; no duplicates; typed values; no `allow-file-access` | error |
| `setup` exists and is not empty; `env` resolves (bare name from `--root`), UTF-8, not empty, at most 16384 bytes | error |
| env file over 80% of the limit (explore needs room) | warn |
| `state` file missing (a person makes it; preflight fails without it) | warn |
| `session:` set | warn |
| no `Expected results:` / `Check that` | error |
| shell, terminal, database, upload, second browser, file access in a step | error |
| secret-looking text (patterns from `src/explore/notes.ts` plus bearer, JWT, Stripe keys), minus `allow-literals` | error |
| API check with `network: false` | error |
| inbox/SMS, reload, tabs, downloads, long waits, native dialogs, selectors | warn |
| URL off the env's host; path not in sitemap; page `broken`/`stale` | warn |
| off-limits term mentioned | warn, which the skill must resolve with the user |
| creating data without the data prefix; `max-steps` under 2 per step + 3 | warn |
| `plan.json` shape as `loadPlan` checks it; listed files exist; stray `.md` files not listed | error / warn |

On the Larder example: `0 error(s), 3 warning(s)`, the three missing `.auth/shopper-*.json` files, which
is correct (they are git-ignored and made by a person). A deliberately bad file (shell step, password,
upload, second browser, selector, broken and unknown paths, off-limits term, API check with network off)
gets 8 errors and 7 warnings.

**2. Source audit.** For each task the skill Greps every quoted message and number in the source its
`# sources:`/`# derived:` comment names. No hit means invented: fix it or ask.

**3. Read-back.** Re-read each task as the agent gets it (setup text, then task) and ask: could someone
with only a browser and the env file do this without guessing?

**4. Optional smoke run, only with the user's yes.** One task, from the root:
`cd <root> && duckwright -p -f <folder>/01-....md`. A wrong label or URL is the skill's bug (fix the
task); a wrong total or message may be the app's bug (report it; never loosen the check).

## Ask vs infer

Ask (one message, at most five questions, only blockers): which env when ambiguous; how a role signs in
when the map is silent; whether writes are allowed on that env when `write-envs` is missing; an expected
value no source gives; what to test when the request is empty.

Infer and mark: file and folder names, IDs, max-steps, start pages, labels from sitemap or code, check
types, shared setup. Unsure inferences become `# assumption:` lines and are listed in the report.

## Worked example: Larder

Request: "write Duckwright tasks for promo codes in the basket".

The skill reads `CLAUDE.md` (root is `e2e/`), the map (R1 state files per shopper, R4 one account per
basket task, R7 no `request` setup, R8 API checks for `POST /api/cart/coupon`, R9 exact money, seed
tables), `environments/local.md`, the sitemap (`/products`, `/product/<slug>`, `/cart` all `ok`), and the
message strings from `app/src/i18n/en.json`. It asks nothing: every value is documented.

Output, `e2e/tasks/basket-promo-codes/`:

- `shared/setup.md`: open the basket; fail with "state expired" on the sign-in form; empty the basket.
- `01-save10-takes-10-percent-off.md` (shopper A): totals derived in a front-matter comment
  (2 x $2.50 + $4.00 = $9.00, discount $0.90, delivery $3.99, total $12.09), plus `POST /api/cart/coupon` 200.
- `02-expired-code-is-rejected.md` (shopper B): SPRING24, "This code has expired.", 422, total $7.99.
- `03-freeship-needs-20-subtotal.md` (shopper C): FREESHIP under $20.00, 422, delivery still $3.99.
- `plan.json`: notes (seed command, state-file commands, how to run), one skipped scenario (welcome email,
  no mail catcher).

## Failure modes

| Failure | Effect | Mitigation |
| --- | --- | --- |
| Map drifts from the app (renamed button, new route) | tasks fail at run time | sitemap check; smoke run; the failing `history.json` shows the real label |
| Stale or thin sitemap (SPA without URL changes) | URL warnings are noise or miss things | warnings, not errors; report sitemap age; suggest explore |
| Invented expected value | false failures, or checks that test nothing | source comments plus the Grep audit; ask instead |
| Expired state file | agent lands on sign-in and wanders | the "state expired" line makes it a one-step, clear failure |
| Shared server data, parallel runs (`--max-parallel 3`) | flaky collisions | per-task prefix, separate accounts, or a `--max-parallel 1` note |
| Run from the wrong folder | `environment file not found` at preflight | the report gives the exact `cd <root> && ...` command |
| Secret pulled from code into a task | secret in git, history and spec | never read `.env*`/state files; secret lint; `allow-literals` is explicit |
| Prompt injection via sitemap or generated text | skill writes harmful steps | treated as data; can only add off-limits, never widen |
| Linter drift from `src/taskfile.ts` | false passes | `test/skill-check.test.ts` |
| Off-limits false positive ("check the Refund link is hidden") | noisy warning | warn, then the skill asks the user once |
| Over-detailed click paths | brittle tasks | rule: one intent per step, labels for the key elements only |

## Out of scope

- Running tasks, CI wiring, exporting or editing Playwright specs.
- Creating state files, signing in, seeding databases, starting servers (all become plan notes).
- Changing application code or adding test ids.
- Editing env files or the map without being asked; never the generated block.
- Scenarios one browser cannot do: email or SMS inboxes (unless the map names a web mail catcher),
  file uploads, two users at once, background jobs, waits of minutes. They go to `skipped`.
- A new harness planner. `duckwright plan` stays as it is.

## Needs harness change (optional, not required for v1)

1. **`duckwright check -f <paths>`**: run the existing preflight (task-file parse, `setup`, `state`,
   `env` load) and exit 0/2 without starting a browser. Small: `preflight` already exists in
   `src/cli.ts`. It would replace the linter's front-matter half, so the two can never disagree.
2. **Secret references in task text** (for example `{{env:LARDER_PASSWORD}}` substituted at `fill` time
   and scrubbed like 2FA codes). Would make sign-in tests possible without literals. Bigger, touches
   `scrub.ts`, history and export; listed so nobody writes "password in env var X" expecting it to work.

Two harness findings worth a README fix on their own: `examples/environments/staging.md` suggests
"password in the env var STAGING_ADMIN_PASSWORD", which the agent cannot read; and the README could say
that `upload` and `dialog-accept`/`dialog-dismiss` are not in the allow-list.

## Rationale: alternatives considered and rejected

- **Extend `duckwright plan` with `--map` (in-harness).** The planner is a tool-less `claude -p` with a
  fixed schema: it cannot read the codebase for message strings, cannot ask the user, cannot run the
  linter or Grep its own output. Doing this in a Claude Code skill gets all of that for free and adds
  nothing to the harness.
- **Skill writes a QA plan, then calls `duckwright plan`.** Two model passes, and the planner
  ("never invent values", no project rules) would drop the state files, env and derived values.
- **Put all rules in the env file.** It is pasted into every step of every run and capped at 16 KB,
  which explore also fills. Authoring rules are dead weight there and could confuse the agent.
- **Put all rules in CLAUDE.md.** Loaded into every session, many projects' CLAUDE.md is already long,
  and there is nothing for a linter to read. Kept as a pointer.
- **Several rules files (`.duckwright/rules/*.md` with globs).** More moving parts for no gain in a
  typical project. One map with sections is enough; split later if a real project needs it.
- **YAML or JSON map.** People write rules as prose. Only the eight checkable keys are structured.
- **Generate Playwright specs directly.** Skips the point of Duckwright (run, record real locators,
  export) and guesses locators.
- **Always smoke-run every task.** Costs money, drives a browser, may write data. Offered for one task,
  on request.
- **Linter in TypeScript inside the CLI.** That is option 1 under "needs harness change"; v1 avoids
  harness changes and guards drift with a test instead.
- **One global precedence order.** A sitemap is right about which pages exist and wrong about how to
  write tasks; a map is the reverse. Per-fact owners resolve this without special cases; off-limits is
  the one fact that unions.

## Implementation effort

One PR: copy `skills/`, `examples/project-larder/`, `test/skill-check.test.ts` from this draft; add a
README section ("Writing tasks with Claude Code") with the install line and the three project files;
fix the staging example's env-var password line. No `src/` change.
