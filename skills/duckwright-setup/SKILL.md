---
name: duckwright-setup
description: Set up a project for Duckwright browser tests, or check that it is still set up. Use when the user asks to set up, onboard, initialise or configure Duckwright for a project, when /duckwright-tasks reports a missing testing map or environment file, when state files, environments or the sitemap look wrong, or when the user invokes /duckwright-setup or asks to run the Duckwright doctor. Writes the project's testing map, the CLAUDE.md Duckwright section and a starter environment file, then lists what only a person can do.
---

# Setting up a project for Duckwright

You prepare a project so the `duckwright-tasks` skill can write correct tasks for it. You write the project's
starter files from what the user tells you and what the repo already says, and you list what only a person
can do. You do not write tasks, run browsers by default, create credentials or seed data.

What the project ends up with is described in `duckwright-tasks/references/project-convention.md` (installed
next to this skill when both are installed; otherwise in the Duckwright repo under
`skills/duckwright-tasks/references/`). In short: a `## Duckwright` section in CLAUDE.md, a testing map at
`<root>/.duckwright/testing-map.md`, and `<root>/environments/<name>.md`.

## 0. Pick the mode

- **Doctor** (the user says check, doctor, "is this set up?", or the files already exist): run step 1 only,
  report each `warn` and `fail` with its fix, and stop. Change nothing.
- **Setup** (anything else): run steps 1 to 7.

## 1. Run the doctor

`node <this skill's folder>/scripts/doctor.mjs --root <root>` (root defaults to the current folder; if
you do not know it yet, run it from the repo root and read the first lines). It checks Node 22.18+,
`duckwright`, `playwright-cli` and `claude` on PATH, the root layout, the map's front matter, the CLAUDE.md
section, env file size (16384-byte limit), `.auth/` in `.gitignore`, the state files tasks name, and the
explore sitemap's age and leftover items. It is read-only.

Missing tools are reported with the install command; run none of them yourself. Tell the user.

## 2. Find the Duckwright root

The folder `duckwright` is run from. It holds `environments/`, `tasks/` and `.auth/`; bare `env:` names resolve
from it. Look for an existing `environments/` or `.duckwright/` (Glob, skip `node_modules`), then an
existing e2e folder (`e2e/`, `tests/e2e/`, `playwright/`). Otherwise propose the repo root, or `e2e/` in a
monorepo. Confirm the root with the user in step 3; do not create folders before then.

## 3. Ask once

One message, at most five questions, each with your best guess from the repo so the user can answer "yes":

1. Base URL of each environment (local, staging), and which of them may receive writes (create, edit, delete).
2. Roles and how each signs in. Prefer an **environment account** per role: a person adds it on the web
   UI's Environments page (`duckwright --web`), and tasks sign in with `{{<id>.username}}` and
   `{{<id>.password}}` without ever seeing the password. Otherwise a role signs in through a **state file**
   (a saved browser login). The agent cannot read environment variables. Only public demo or seed-only
   credentials may be written in a task.
3. How test data is seeded or reset (a command, a script path, "the app starts empty").
4. What is off-limits (billing, deleting accounts, sending real email, a production host).
5. A data prefix for things tasks create (default `RT-`).

Look in the repo first and propose answers from it: `README`/`package.json` scripts for the app's URL and
seed command, `.env.example` for variable names (never read `.env*` values), i18n or copy files for UI
strings, existing e2e or Playwright tests for roles and flows. Cite what you used.

Never ask for a password, token or cookie. If the user pastes one, do not write it anywhere; say so and
point at the state-file steps in step 6.

## 4. Write the starter files

For each file: if it exists, read it, show the user the proposed change as a diff, and write only after a
yes. Never overwrite silently. Never touch the generated block (`<!-- duckwright:generated:start ... -->`
to `:end -->`) of an env file; explore owns it.

- **`<root>/.duckwright/testing-map.md`** from `templates/testing-map.md`, filled from the answers. Keep
  the front matter to the five keys the template shows. Replace every `TODO` you can; leave `TODO` only
  where nobody knows yet (the doctor warns on it). Number the rules (R1, R2, ...) so tasks can cite them.
- **`CLAUDE.md`**: append a `## Duckwright (browser tests)` section from `templates/claude-md-section.md`
  to the CLAUDE.md nearest the root (create it only if the project has none and the user agrees). Fill
  every `<placeholder>`.
- **`<root>/environments/<name>.md`**: only facts you were given or found, in the sections of
  `examples/environments/staging.md` in the Duckwright repo (Base URL, Test accounts, Seeded data, Feature
  flags, Known quirks, Off-limits). Accounts are names and roles, never passwords. If a fact is unknown,
  leave the section out rather than invent it. Keep it small: it is pasted into every agent step and
  explore adds a generated block to the same limit.
- **`.gitignore`**: add `.auth/` (under the root) so state files with session cookies are never committed.

## 5. Offer explore (only with a yes)

`duckwright explore <base-url> --env environments/<name>.md` drives a real browser and calls Claude: it costs
money and takes time. Offer it once and say what it gives you (a sitemap and a generated block that
`duckwright-tasks` uses to check URLs and labels). Run it only if the user agrees.

- Add `--allow-writes` only for a disposable test instance, and only if the user says so in those words;
  it has no host guard.
- Never point it at production.
- If the user declines, say that `duckwright-tasks` still works without a sitemap, with more assumptions listed.

## 6. Hand over what only a person can do

End with a checklist, with exact commands where you know them. At least:

- Create each state file: sign in as the role once in a browser and save the session to the path the map
  names. With playwright-cli this is `playwright-cli state-save <file>` after signing in (check
  `playwright-cli --help` for the current command); it must land under `<root>/.auth/`.
- Seed or reset data with the command from question 3.
- Set any environment variable a run needs, such as `DUCKWRIGHT_TOTP_SECRET` for 2FA.
- Install missing tools from the doctor's output.

## 7. Verify and report

1. Run the doctor again. Every `fail` must be fixed or named in the report as waiting for a person.
2. Report: the root, the files written or changed (and the ones you left alone), the sources you took
   answers from, what is still `TODO`, the person's checklist, and the next step:
   `/duckwright-tasks <what to test>`.

## Never

- Write a password, token, API key or cookie into any file.
- Read `.env*` files or anything under `.auth/`.
- Overwrite an existing file without showing the diff and getting a yes.
- Run `duckwright explore`, `duckwright` task runs or any install command without the user agreeing.
- Edit application code or write tasks (that is `duckwright-tasks`).
