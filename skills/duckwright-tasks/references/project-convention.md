# What a project provides for Duckwright tasks

Three things, each with one job. A worked example is in the Duckwright repo at
`docs/design/task-authoring-skill/examples/project-larder/`.

| File | Job | Read by | Size |
| --- | --- | --- | --- |
| `CLAUDE.md`, a `## Duckwright` section | Pointer: where the Duckwright root and the testing map are | every Claude Code session | 5 to 10 lines |
| `<root>/.duckwright/testing-map.md` | **Authoring rules**: how this project's tasks are written | this skill, people writing tasks | a few KB |
| `<root>/environments/<name>.md` | **Runtime facts** the agent needs during a run | the Duckwright agent, every step | under 16384 bytes |

Plus what `duckwright explore` makes: `<root>/environments/<slug>.sitemap.json` and a generated block in
an env file.

The split matters. The env file is pasted into every step of every run, so it holds only what the agent
needs while driving the browser: URLs, accounts, seeded data, quirks, off-limits. Rules about how to
write a task (which state file per role, naming, data prefix, what to assert, what goes in plan notes)
are useless to the agent mid-run and only cost tokens there, so they go in the testing map.

## The Duckwright root

The folder you run `duckwright` from. It holds `environments/`, `tasks/` and usually `.auth/` (git-ignored
state files). Bare `env:` names resolve from it, so it must be fixed and written down. Often the repo
root; in a monorepo, a folder such as `e2e/`.

The map lives in a hidden folder, `.duckwright/`, because `duckwright -f <folder>` runs every root-level
`.md` file in a folder as a task.

## CLAUDE.md section

The `duckwright-setup` skill writes it from `templates/claude-md-section.md`; to do it by hand, copy that file from the Duckwright repo's `skills/duckwright-setup/templates/`. It says where the root and the map are, where UI strings and seed
data live in the code, and which files must never be read. Keep the rules themselves out of CLAUDE.md:
it is loaded into every session, including ones that have nothing to do with tests.

## Testing map

Markdown with front matter in Duckwright's own flat `key: value` syntax. The skill and
`scripts/check-tasks.mjs` read the front matter; the body is prose for Claude and people.

### Front matter keys (all optional)

| Key | Meaning | Used by the linter |
| --- | --- | --- |
| `default-env` | env name used when the user names none | |
| `write-envs` | comma list of envs where tasks may create or change data | |
| `data-prefix` | prefix for every name a task creates, for example `RT-` | warns when a creating task never uses it |
| `off-limits-terms` | comma list of words or paths no task may touch | warns on each mention |
| `allow-literals` | comma list of seed-only values that look like secrets but may appear in tasks | exempts them from the secret check |

### Body sections

Use these headings so the skill finds them. Number rules (`R1`, `R2`, ...) so a task can cite them in
`# sources:`. Leave out a section that does not apply.

- `## Environments`: each env, what it is for, whether writes are allowed.
- `## Auth`: per role, the account name, its state file, and how a person makes it. Which tasks may use the
  sign-in form. 2FA.
- `## Test data`: what the seed creates, with exact names and values; rules that let values be derived
  (prices, tax, delivery). Data isolation between tasks that share an account.
- `## Setup: UI or API`: how tasks get to their starting state; whether `request` may be used and for
  which endpoints (only ones the page calls on load are exportable).
- `## What the UI calls things`: page names, button and field labels, where the message strings are in
  the code.
- `## How to check results`: what every task must check; known API calls with their statuses; what never
  to check exactly.
- `## Needs a person`: seed commands, state files, env vars, things the browser cannot reach (mail,
  files, payments) and how to handle them.
- `## Naming`: folders, file names, IDs.
- `## Off-limits`: in words; mirror the short forms in `off-limits-terms`.

## Environment files

As in Duckwright's README (Environment context) and `examples/environments/staging.md`: Base URL, Test
accounts (names and how they are signed in, never passwords), Seeded data, Feature flags, Known quirks,
Off-limits.

To have explore add its findings to the same file instead of a second one, point it at the file:
`duckwright explore http://localhost:3000 --env environments/local.md`. The generated block is updated in
place; the sitemap still goes to `environments/<slug>.sitemap.json`; the skill finds it by the Base URL host.

## When something is missing

| Missing | What the skill does |
| --- | --- |
| CLAUDE.md section | finds the root by looking for `.duckwright/` or `environments/` |
| testing map | uses env file, sitemap and code; marks more assumptions; tells the user to run `/duckwright-setup` |
| env file | asks for the base URL; suggests `duckwright explore` |
| sitemap | writes tasks anyway; URLs are not checked; suggests `duckwright explore` |
| auth for a needed role | asks |
| an expected value | asks; never invents |
