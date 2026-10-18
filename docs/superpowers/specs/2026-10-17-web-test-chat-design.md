# Test chat in the web UI (`duckwright --web`)

## Intent

Today, getting a feature tested with Duckwright takes a person driving Claude Code through three skills by
hand: `/duckwright-setup`, then `/duckwright-tasks` (questions, probes, task files), then `duckwright plan`
or `duckwright -p -f` to run, then `/duckwright-playwright`. Plan mode inside Duckwright itself is a single
`claude -p` call with no tools: it splits an already-written QA plan into task files, never asks anything,
never looks at the app, and ignores the project's testing map, environment files and facts memory.

We want the web UI to do the whole job from a chat, like Claude Code does for code: the person drops in
context (usually a Superpowers spec and implementation plan from `docs/superpowers/specs/` and
`docs/superpowers/plans/`), answers one round of questions, and the agent then plans, probes, writes
tasks, runs them and reports, fully automatically. It comes back to the person only when something is
genuinely unclear. At the end it offers to turn the passing runs into Playwright tests.

"More professional than breaking tasks" means: the plan is grounded in the project's own knowledge and in
what probes verified on the live app, not in guesses from a document.

## Goals

- A chat panel in the existing web UI where the person types and attaches context files.
- One clarification round at the start, with the questions only the person can answer.
- After that, autonomous: test plan, probes, facts, task files, lint, runs, failure triage, report.
- Back and forth only when a step is unclear (see "When the agent stops and asks").
- Runs started by the chat are ordinary Duckwright runs: visible live in the existing timeline, listed
  under their plan in the sidebar, re-runnable by hand.
- At the end, ask whether to write Playwright tests; on yes, do the `duckwright-playwright` work in the
  same chat.
- The model for the chat agent is selectable in the chat; default `sonnet`.

## Non-goals

- Replacing the TUI or print mode, or the existing plan mode (`duckwright plan <file>` stays as is).
- Access from another machine, several users, accounts. Web mode stays loopback with its token.
- A CI / headless version of the chat.
- Changing the browser run loop (`loop.ts`, `brain.ts`, `pw.ts`).
- Writing application code or fixing app bugs the tests find.

## Anti-goals (a failure even if it technically works)

- A test that passes for the wrong reason: an expected result taken from what the app happens to show,
  or a check loosened after a failure to make it pass.
- Questions dribbled out one at a time during the run when they could have been asked up front.
- Writes to an environment the testing map does not list in `write-envs`, or any run against production.
- A credential, token or cookie appearing in the chat transcript, a task, a fact or a test.
- The agent quietly giving up: every failed, skipped or unrun scenario is in the final report with a reason.

## How it looks

The web UI gains a **Chat** view next to the existing task workspace (a third sidebar tab or a top-level
toggle; layout is the builder's call, matching the shadcn style already in `web/src/`).

- A message list (person and agent), with the agent's tool activity collapsed into one-line items
  ("Read testing map", "Probe: checkout labels on staging, $0.04", "Wrote 7 tasks", "Running plan 3/7").
- An input box with `@` file mentions (reuse `/api/candidates` and the TUI's mention parsing) and a
  file-upload button for files outside the repo. Uploaded files are saved under the chat's folder.
- A model picker in the chat header: `sonnet` (default), `opus`, `haiku`, or a typed model id.
- A phase strip: Read → Clarify → Plan → Probe → Write → Run → Report → (Playwright), showing where the
  agent is, plus running cost.
- Stop button: ends the agent's turn and stops any runs it started.
- Questions from the agent render as a distinct card; the person answers in the normal input.
- When the agent starts a plan run, the plan appears in the task workspace as today, and the chat shows
  a link to it.

## The flow (what the agent does)

The agent is a fourth skill, **`duckwright-autotest`** (name is the builder's call), that orchestrates the
other three. It does not duplicate their rules; it follows them, with the overrides listed here.

1. **Read.** The attached files, then the project's knowledge in `duckwright-tasks` step 1 order: CLAUDE.md
   Duckwright section, testing map, environment file, sitemap brief, facts brief, existing tasks.
   If the doctor (`duckwright-setup/scripts/doctor.mjs`) reports the project is not set up, do the
   `duckwright-setup` work first, in this chat, with its questions folded into step 2.
2. **Clarify once.** One message with every question only the person can answer, each with a best
   guess so "yes" works: environment, sign-in per role (state file or environment account), whether
   writes are allowed, expected values the documents do not give, anything the spec leaves ambiguous
   about behaviour. Merge the setup questions and the tasks questions into this one message. The
   existing "at most five questions" limits of the skills do not apply to the merged message, but keep
   it as short as the gaps allow. Never ask for a password, token or cookie.
3. **Plan.** Derive a black-box QA test plan from the spec (behaviour, contracts, edge cases, errors)
   and the implementation plan (which pages, routes, endpoints and roles the change touches). Write it
   as `<root>/tasks/<feature>/test-plan.md` and post a one-line-per-scenario list in the chat. Do not
   wait for approval; the person can reply with changes at any time and the agent folds them in.
4. **Probe.** Close gaps exactly as `duckwright-tasks` step 3b says (memory first, ask for intent,
   investigate current behaviour, assume only what fails loudly). The person's general "yes" covers
   probes and scoped explores on `investigate-envs`; the separate yes for writes in `close-gaps.md` is
   replaced by the map's `write-envs` plus the answer from step 2. Facts go through `facts.mjs` as today.
5. **Write.** Task files, `shared/setup.md` and `plan.json` per `duckwright-tasks` steps 4 and 5, then
   `duckwright check` and `check-tasks.mjs`, fixing every error.
6. **Run.** Run the whole plan through Duckwright (see Architecture), up to the web UI's `--max-parallel`.
7. **Triage failures.** For each failed task, read its run brief (`runs-brief.mjs`) and decide:
   - *Task bug* (wrong label, URL, missing wait, setup gap): fix the task, flag the fact that gave the
     wrong value (`facts.mjs suspect`), re-run. At most 2 re-runs per task.
   - *Environment problem* (state file expired, seed data missing, app down): stop and ask.
   - *Possible app bug* (wrong total, wrong message, missing behaviour the spec requires): never loosen
     the check. Record it (`facts.mjs bug` when the intended value is known) and list it in the report.
     If the spec does not say what is right, ask.
8. **Report.** In the chat and as `<root>/tasks/<feature>/report.md`: scenarios passed, failed (with
   classification and evidence: run folder, failing step), skipped (and why), app bugs found,
   assumptions, facts kept / retired, notes a person must act on, total cost.
9. **Offer Playwright.** Ask once whether to write Playwright tests from the passing runs. On yes, follow
   `duckwright-playwright`, asking its convention questions in the chat, and add the result to the report.

### When the agent stops and asks

Only for: something only the person knows (intended behaviour, a policy, an expected value), an
environment problem a person must fix (state file, seed data, server down), a conflict between the spec
and what a probe verified where it cannot tell which is right, or a write the map does not allow. All
open questions at that moment go in one message. Everything else it decides, writes down as an
assumption, and reports.

The person may also type at any time. While the agent's turn is running, the message is queued on the
server and handed to the agent through the MCP endpoint: every MCP tool result (notably `wait()`)
carries any pending person messages, and a `check_messages()` tool exists for phases without runs
(Plan, Write). The skill tells the agent to call it between phases. So plan feedback lands before the
runs it is meant to change.

## Architecture

### The chat agent

A real Claude Code session, driven by the web server:

- `src/chat/` (Node side) owns chat sessions: spawning `claude -p` with
  `--output-format stream-json --verbose`, the chosen `--model`, and `--resume <session-id>` for every
  turn after the first, so one conversation is one Claude Code session. Each person message is one turn.
  The agent "asks" by ending its turn with a question; the next person message resumes it.
- The stream-json events are mapped to chat events (text, tool activity line, cost) and sent to the
  browser over the existing SSE stream; the web API gets routes to create a chat, send a message, stop,
  set the model, list and reopen chats.
- Working directory: the Duckwright root (the folder `duckwright --web` was started in).
- The four skills ship inside the `duckwright` npm package (`skills/` is already in the repo) and are
  given to the session from there, so the chat works without `npx skills add`. How they are loaded
  (plugin dir, `--add-dir`, system prompt append) is the builder's call; it must not write into the
  person's `.claude/`.
- Permissions: the session runs non-interactively, so it needs an explicit allow-list: Read/Grep/Glob;
  Write/Edit limited to `tasks/`, `.duckwright/`, `environments/` (outside generated blocks), the chat's
  folder and, in the Playwright phase, the project's test folder; Bash limited to the skills' bundled
  scripts, `duckwright check`, and the project's typecheck/lint/`playwright test --list` commands.
  No general shell. Exact mechanism is the builder's call.

### Running through the web UI, not a shell

Probes, explores and plan runs must start through the same `RunManager` the web UI already uses, so they
appear live in the timeline and in history and honour `--max-parallel`, Stop, 2FA prompts and
environment accounts. The agent reaches them through a small MCP server that the web server exposes to
the chat session only (loopback, a per-chat token), with tools like: `open_plan(folder)`,
`run_plan(folder)`, `run_task(file, options)`, `wait(ids)` (returns verdicts and run folders),
`check_messages()`. Tool shape is the builder's call. A 2FA wait during an agent-started run shows in
the chat as well as on the run.

Explore is the exception in this version: `RunManager` has no explore run type, and explore's
post-run work (report, sitemap merge, writes guard) lives in `cli.ts`. The agent runs
`duckwright explore` as one allow-listed command, shown as an activity line in the chat but not in the
timeline. Moving explore into `RunManager` is a later piece of work.

### Server restart mid-turn

`RunManager` state is in memory, so a stopped server ends the agent's turn and its runs. Nothing extra is
persisted for recovery: the plan folder, task files, run folders and facts are already on disk. When the
person reopens the chat and sends a message (for example "continue"), the agent resumes the session,
re-reads the plan folder and the run folders, and carries on from the first task with no passing run.

### Persistence

Each chat lives in `<root>/.duckwright/chats/<id>/`: `chat.json` (title, model, Claude session id,
created/updated, plan folder it produced) and `transcript.jsonl` (the rendered messages, for reload).
Uploaded files go to `<root>/.duckwright/uploads/<id>/`, outside the chats folder, because the agent is
denied reading `.duckwright/chats/**` (other transcripts, the shared system prompt, the turn's MCP
bearer) and `.duckwright/local/**` (the accounts database). Reopening the web UI lists past chats and can continue one (via `--resume`). Transcripts must
not contain secrets: account passwords are already placeholders; anything matching the existing
redaction (`src/redact.ts`, `src/scrub.ts`) is masked before it is written.

## Constraints

- Web mode's security model is unchanged: `127.0.0.1` only, per-launch token, Host/Origin checks, 1 MiB
  body cap (uploads may need a separate, still bounded, limit).
- No new runtime dependency in the published package unless unavoidable; the MCP endpoint should use
  `node:http` like the existing server.
- Requires `claude` on PATH, as web mode already does.
- All rules in the three skills' "Never" sections still apply, except the two overrides stated above
  (merged question limit, and the general yes covering probes and map-allowed writes).
- The browser run model (`Globals.model`) and the chat agent's model are separate settings.

## Decided by the person

- Input: a chat message plus context files; usually a Superpowers spec and plan.
- One clarification round at the start, then back and forth only when a step is unclear.
- Fully automatic after that: probes and runs that cost money or create data on allowed environments
  do not need a per-action yes.
- At the end, offer Playwright tests via `duckwright-playwright`.
- Chat model selectable, `sonnet` by default.
- Spend: the probe limit in `close-gaps.md` gate 5 (5 probes, one explore, then a new yes) does not
  apply in the chat. Instead each chat has a dollar ceiling, asked in the Clarify message with a default
  of $5 (also editable in the chat header). The ceiling covers the agent's own cost plus every run it
  starts. When the next action would cross it, the agent stops starting work, lets running runs finish,
  and reports what is done and what is left; the person can raise the ceiling and say "continue".

## Calls I made (the person has not agreed to these specifically)

- Built as a Claude Code session plus an orchestrator skill, not by reimplementing the skills in
  Duckwright's TypeScript.
- Plan is shown but not gated on approval.
- Agent-started runs go through `RunManager` via an MCP endpoint, so they are visible and controllable.
- At most 2 automatic re-runs per failed task; never loosen a check.
- Chats persisted under `.duckwright/chats/`.
- Person messages typed mid-turn reach the agent through the MCP endpoint (`wait()` and `check_messages()`).
- Explore runs as an allow-listed command in this version, not through `RunManager`.
- A server restart ends the turn; "continue" resumes from what is on disk.
- Existing guardrails kept: never production, writes only on `write-envs`, no credentials anywhere.
- Playwright phase: the person's "yes" also covers running the new tests (`npx playwright test <files>`)
  against the environment the chat used, when it is in `investigate-envs` (and `write-envs` if the tests
  write). The agent fixes failing locators from the recorded code, never weakens an assertion, and
  reports a failing assertion as a possible app bug. The Bash allow-list includes that command.
  If the environment is not reachable, the tests are delivered typechecked, linted and listed, and
  the report says they were not run.

## Left to the builder

Layout details, the skill's name and wording, how skills are loaded into the session, MCP tool shapes,
event mapping from stream-json, chat list UI, test strategy (a fake `claude` process for chat tests, as
`test/` already fakes the planner and manager).
