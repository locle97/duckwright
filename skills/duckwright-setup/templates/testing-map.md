---
# Duckwright testing map. Read by the duckwright-tasks skill and by people writing tasks by hand.
# Flat key: value lines, same syntax as Duckwright task-file front matter. Delete keys you do not need.
default-env: TODO
write-envs: TODO
# investigate-envs: envs the duckwright-tasks skill may probe to learn labels and flows (never production)
investigate-envs: TODO
data-prefix: RT-
off-limits-terms: TODO
# allow-literals: seed-only values that look like secrets, comma separated
---
# TODO project testing map

Rules for writing Duckwright task files. Runtime facts (base URL, accounts, quirks) belong in
`environments/<name>.md`, not here. Number rules so tasks can cite them.

## Environments

- `TODO` (`environments/TODO.md`): what it is, who seeds it, whether tasks may create data, and whether
  the skill may probe it (`investigate-envs`; probes that write also need `write-envs`).

## Auth

- R1. How tasks sign in (state file per role, or the sign-in form only for sign-in tests).

  | Role | Account | State file (under the root) | How a person makes it |
  | --- | --- | --- | --- |
  | TODO | TODO | `.auth/TODO.json` | TODO |

- R2. Every task with a state file says: if the page shows the sign-in form, finish with failure
  "state expired: recreate <state file>".

## Test data

- What the seed creates, with exact names and values. Rules that let values be derived.
- R3. Names a task creates start with the data prefix and the task ID; the task deletes them at the end.
- R4. Tasks that share an account must not collide (separate accounts, or run with --max-parallel 1).

## Setup: UI or API

- R5. UI by default. `request` only for endpoints the page calls on load (others make export refuse the run).

## What the UI calls things

- Page names, button and field labels. Where message strings live in the code.

## How to check results

- R6. Every task checks at least one visible text, value or URL; actions that call the API also get
  METHOD /path STATUS. Known calls: TODO.
- R7. Never check generated values exactly (ids, dates, order numbers).

## Needs a person (plan notes, not task steps)

- Seed command, state files, env vars such as DUCKWRIGHT_TOTP_SECRET, anything outside the browser.

## Naming

- Folder `tasks/<feature>/`, files `NN-<what-it-checks>.md`, heading `# <ID>: <title>`. ID prefixes: TODO.

## Off-limits

- TODO (mirror the short forms in `off-limits-terms`).
