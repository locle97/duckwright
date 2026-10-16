---
name: duckwright-playwright
description: Convert Duckwright run history (a plan folder, a folder of run tasks, or one run folder with history.json) into Playwright tests that follow THIS project's test conventions. Use when the user asks to turn runs, a plan, or run tasks into Playwright or e2e tests, generate or port a spec from history.json, or invokes /duckwright-playwright. Asks the user whenever the project's convention or a run's intent is unclear.
---

# Duckwright runs to project-style Playwright tests

Duckwright's own export (`duckwright.spec.ts`) is a flat, single-`test()` replay with recorded code. Your job
is the step after it: read the run history and write the test the way this project's existing Playwright
tests are written (folders, fixtures, page objects, naming, config, auth, data), so a reviewer cannot tell
it from a hand-written one. The history is evidence of what worked in a real browser; the project's
convention decides the shape.

## 1. Resolve the input

The user gives a path: a **plan folder** (`tasks/<plan>/`: has `plan.json`, one subfolder per task named like
its task file, each holding `history.json`), a **run-tasks folder** (the task subfolder(s) or a `runs/` folder),
or a single **run folder**. If they give none, look for `tasks/*/plan.json` and `runs/` and offer what you find.

Never read `history.json` raw: it holds every snapshot, network capture and result. Run
`node <this skill's folder>/scripts/runs-brief.mjs <path>` (add `--code` for each action's recorded
Playwright code). It lists each run's verdict, task text, env, assertions, API calls and what the export
cannot replay. Read `references/history-format.md` for the fields and what each action's `code` means.

Per run:
- `failure` runs and tasks with no run: do not convert. Report them.
- A plan's `plan.json` `notes` (seed commands, state files, env vars) and `skipped` scenarios belong in the report and in test setup/comments.
- `duckwright.spec.ts` beside a history is a reference, not the answer: its shape is the flat default you are replacing.

## 2. Learn the project's convention

Before writing, read, in this order, and stop when the picture is clear:

1. CLAUDE.md / AGENTS.md / `.claude/rules/*.md` sections on tests; the Duckwright testing map
   (`.duckwright/testing-map.md`) if present.
2. `playwright.config.*`: `testDir`, `baseURL`, projects, `use` (storageState, trace), `globalSetup`, `webServer`, `testMatch`.
3. Two or three existing specs in the closest area, plus their fixtures, page objects, helpers, test-data
   factories and `*.setup.ts` files. Note: file naming and location, `describe`/`test` naming, `test.step`
   use, locator style (`getByRole` vs test ids vs page-object methods), assertion style, how auth and data
   are handled, tags/annotations, imports and aliases, language (TS/JS), formatting.
4. `package.json` scripts and lint/format config, to run the project's own checks later.

No existing Playwright tests? Then there is no convention to follow: ask (step 3) rather than invent one.

## 3. Ask before guessing

Ask once, in one message, at most five questions, each with your best guess so "yes" works. Ask when:

- there is no Playwright setup, or two conventions coexist (which one is current?);
- where the files go and what they are named, if existing tests do not make it obvious;
- a run's **intent** is unclear: what the test should protect versus what the agent merely did on the way;
- the run depends on data or accounts: how the project seeds, resets or authenticates (state file vs fixture vs UI login), and whether a recorded value is stable or generated (ids, dates, totals);
- a run used tabs, request setup, manual 2FA, or recorded no assertions: what to do about it;
- grouping: one spec file per plan with one `test` per task, or per-task files.

Do not ask what the repo already answers. Never ask for a password, token or cookie.

## 4. Write the tests

One test per successful run, grouped as step 3 settled. For each:

- **Intent over transcript.** Keep the actions that express the scenario and its assertions; drop
  exploration (wrong turns, retries, scroll/wait noise, repeated snapshots) that the history shows the
  agent doing before it found the path.
- **Locators in the project's style.** Recorded `code` uses `getByRole`/`getByLabel`/`getByText`. Keep
  them if the project does; otherwise map them to its page-object methods, test ids or helpers. When a
  page object or helper already covers an action, use it; add a method only where none exists and the
  project's pattern has a place for it.
- **Assertions.** Carry over each recorded `expect` and `expect-request` (as `waitForResponse`, armed before
  the step that triggers it). Add the expected results written in the task file. Do not loosen a check to
  make a test pass. Do not assert generated values exactly.
- **Auth and data.** Replace recorded sign-in steps, state-file use and typed credentials with the
  project's mechanism (fixture, `storageState`, setup project). Literal secrets never go into a test; read
  them from the project's env/config source. Data the run created gets the project's cleanup pattern;
  test data is unique per run if the project requires it.
- **Waits.** Rely on auto-waiting and web-first assertions; no `waitForTimeout`.
- **Untranslatable parts** (tab commands, manual 2FA, state-dependent steps): follow what the user answered; otherwise leave a `test.fixme`/`// TODO` with the reason, never a silent omission.
- Header comment only if the project uses them: source run folder and task file, so the test is traceable.

Match formatting by running the project's formatter/linter on the new files.

## 5. Verify

1. Typecheck and lint with the project's commands.
2. List the tests: `npx playwright test <files> --list` must show every new test.
3. Run them (`npx playwright test <files>`) only if the target app is reachable and the user agrees (it hits a real environment and may write data). A failing locator is your bug: fix it from the recorded code. A failing assertion may be an app bug: report it, never weaken the check.
4. If you cannot run them, say so; do not call them passing.

## 6. Report

End with: files written (and which run each came from), the convention you followed and where you saw
it (file paths), answers the user gave, runs skipped and why, hand-edit spots (`fixme`/TODO), env vars or
state files a person must supply, and what you ran with its result.

## Never

- Convert a failed run, or invent steps or assertions the history and task text do not support.
- Commit or push, or overwrite an existing spec, without being asked (propose a diff for existing files).
- Put credentials, session cookies or 2FA secrets in a test. Recorded `fill` code can contain what the agent typed; check every `fill`.
- Invent a convention when the project has none: ask.
