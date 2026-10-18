---
name: duckwright-autotest
description: Test a feature end to end with Duckwright from a spec, an implementation plan, a ticket or a few words. Clarifies once, then plans, probes, writes tasks, runs them, triages failures and reports, using the duckwright-setup, duckwright-tasks and duckwright-playwright skills, and offers Playwright tests at the end. Use when the user asks to test a feature, spec or plan end to end with Duckwright, or invokes /duckwright-autotest.
---

# Testing a feature end to end

The person gives you a spec, an implementation plan, a ticket or a few words, and wants to know if the
feature works. You do the whole job: read, ask once, plan, probe, write tasks, run them, triage, report.
You follow the three other Duckwright skills and do not restate their rules here. Where this skill
overrides one, it says so.

`{{SKILLS}}` below is the folder that holds the Duckwright skills: the parent of this skill's folder.

Duckwright runs need `duckwright`, `playwright-cli` and `claude` on PATH; the doctor in step 1 checks.

## Scope

Keep to this list. Claude Code's own permissions still ask the person before a command runs; never work
around a refusal another way.

- Bash: `node {{SKILLS}}/<skill>/scripts/<script>.mjs` for the six bundled scripts (`doctor.mjs`,
  `facts.mjs`, `check-tasks.mjs`, `sitemap-brief.mjs`, `gate.mjs`, `runs-brief.mjs`), `duckwright -p -f`,
  `duckwright check`, `duckwright explore`, `npx playwright test`, `npm run typecheck` and `npm run lint`.
  No other command, no `npx tsc`, `npx eslint` or `npx prettier`; when the project has no such npm
  script, say so in the report instead of checking another way.
- Write and Edit: `tasks/`, `environments/`, `.duckwright/testing-map.md`, `.duckwright/facts/`,
  `.duckwright/probes/`, `CLAUDE.md`, `.gitignore`, and for the Playwright step `*.spec.ts`, `*.spec.js`,
  `*.test.ts`, `*.test.js` and files under `e2e/`, `tests/` and `playwright/`. Anything else the other
  skills would change (a Playwright config, `package.json`), propose as a diff in the report.
- Never readable or writable: `.duckwright/local/` (the accounts database) and anything under `.auth/`.

## 1. Read

Read the attached or named files first. Then follow `{{SKILLS}}/duckwright-tasks/SKILL.md` step 1: the
CLAUDE.md Duckwright section, testing map, environment file, sitemap brief, facts brief, existing tasks.

Run `node {{SKILLS}}/duckwright-setup/scripts/doctor.mjs --root .`. If it fails, the project is not set
up: follow `{{SKILLS}}/duckwright-setup/SKILL.md` here, and fold its questions into step 3.

### Signing in

Roles sign in with environment accounts when there are any: a person adds them on the web UI's
Environments page (`duckwright --web`). You never read the accounts database; take account ids from the
environment file (a `Test accounts` section) and the person's answer in step 3. `duckwright check <file>`
fails when a task names an id the environment does not have.

When the environment has an account for a role, that account is how the role signs in, for probes and
tasks alike. Do not use or ask for a state file then. In the file's front matter put `env: <name>` and
`accounts: <id>`, delete the `state:` line, and sign in with a step such as: Open <the sign-in page>.
Fill the username field with `{{<id>.username}}` and the password field with `{{<id>.password}}`, then
submit. If the sign-in fails, finish with failure "login failed: <what the page says>". The run types
the real values; you and the task never see the password. `gate.mjs` then needs no `--state`. For
`close-gaps.md` gate 3, an account the person confirmed counts as the role's sign-in.

Use a state file only for a role no account covers. When a run reports "login failed" with an account,
ask the person to check that account on the Environments page; never ask for the password.

## 2. Mark each phase

Start your message with one line, `Phase: <name>`, at the start of each phase: `read`, `clarify`,
`plan`, `probe`, `write`, `run`, `report`, `playwright`. Triage (step 8) happens within the `run` phase.
Use no other phase name.

## 3. Clarify once

Put every question only the person can answer in one message (the AskUserQuestion tool for up to four
short choices, else plain text), then end your turn. Give each question a best guess so "yes" works:
environment, sign-in per role (name the account id you will use; a state file only when no account
covers the role), whether writes are allowed, expected values the documents do not give, anything the
spec leaves ambiguous about behaviour. Merge the setup questions and the `duckwright-tasks` step 3
questions. The "at most five questions" limits of those skills do not apply here; keep the message as
short as the gaps allow.

Always include the spend question with a ceiling for the browser runs, `$5` unless the person gave one:
"I'll stop when the runs reach $<ceiling> — change it?". Say that the ceiling counts the `Cost:` lines of
the runs only, not this session's own model spend, which you cannot see.

Never ask for a password, token or cookie.

## 4. Plan

Write `tasks/<feature>/test-plan.md` under the Duckwright root: black-box scenarios from the spec
(behaviour, contracts, edge cases, errors), plus the pages, routes, endpoints and roles the
implementation plan says the change touches. List one line per scenario in your reply. Do not wait for
approval; the person can reply at any time and you fold it in (step 11).

## 5. Probe

Close gaps as `{{SKILLS}}/duckwright-tasks/SKILL.md` step 3b says (memory first, ask for intent,
investigate current behaviour, assume only what fails loudly). Overrides:

- The probe budget in `close-gaps.md` gate 5 does not apply. The spend ceiling from step 3 does.
- The person's answers in step 3, plus the map's `write-envs`, replace the separate yes for writes. A
  general yes covers probes and scoped explores on `investigate-envs`.
- Run a probe with `cd <root> && duckwright -p -f <probe file>` and read its `Result`, `Cost` and
  `History` lines.

Facts go through `facts.mjs` as that skill says.

## 6. Write the tasks

Write task files, `shared/setup.md` and `plan.json` per `duckwright-tasks` steps 4 to 6. Run
`duckwright check` and `check-tasks.mjs` and fix every error.

## 7. Run

`cd <root> && duckwright -p -f tasks/<feature>/` runs the folder's tasks in name order and prints a
summary. For a long plan, run it in the background and wait for it to finish. The `History` paths are
the run folders. Add up the `Cost:` lines as you go.

## 8. Triage

For each failed task read the brief: `node {{SKILLS}}/duckwright-playwright/scripts/runs-brief.mjs <run folder>`.
Decide:

- **Task bug** (wrong label, URL, missing wait, setup gap): fix the task, flag the fact that gave the
  wrong value with `facts.mjs suspect`, re-run it with `duckwright -p -f <task file>`. At most 2 re-runs
  per task.
- **Environment problem** (state file expired, seed data missing, app down): ask and end the turn.
- **Possible app bug** (wrong total, wrong message, behaviour the spec requires is missing): never loosen
  the check. When the intended value is known, record it with `facts.mjs bug`. When the spec does not say
  what is right, ask and end the turn.

Stop and ask only for: something only the person knows, an environment problem a person must fix, a
conflict between the spec and a verified probe where you cannot tell which is right, or a write the map
does not allow. Put all open questions in one message. Decide everything else yourself, write it down as
an assumption and report it.

## 9. Report

Write the report in your reply and to `tasks/<feature>/report.md`:

- scenarios passed
- scenarios failed, each with its classification and evidence (run folder, failing step)
- scenarios skipped, and why
- app bugs found
- assumptions
- facts kept and retired
- notes a person must act on
- total cost of the runs (this session's own model spend is not included)

## 10. Offer Playwright

Ask once whether to write Playwright tests from the passing runs. On yes, follow
`{{SKILLS}}/duckwright-playwright/SKILL.md`, ask its convention questions, and add the result to the
report. Verify with `npx playwright test <files>` against the environment you tested when it is in
`investigate-envs` (and in `write-envs` if the tests write). Never weaken an assertion to make a test pass.

## 11. Listen

The person's next message is the only channel. Fold what they say in before you continue; plan feedback
must land before the runs it is meant to change.

## 12. Stop at the ceiling

When the run costs you have added up reach the ceiling, start nothing new. Let a run in flight finish,
report what is done and what is left, and end the turn. The person can raise the ceiling and say
"continue".

## Never

- Break any rule in the Never lists of `duckwright-setup`, `duckwright-tasks` and `duckwright-playwright`;
  they all still apply.
- Run against production.
- Put credentials in your replies, in tasks, in facts or in tests.
- Read `.duckwright/local/` (the accounts database) or anything under `.auth/`.
- Go outside the Scope list, or work around a refusal another way.
- Loosen a check or an assertion to turn a failure into a pass.
- Wait for approval of the plan, or ask a question you can settle with a fact, a probe or a written assumption.
