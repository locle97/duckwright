# Explore site memory (business-aware, deeper, persistent)

## Summary

Make `duckwright explore <url>` aware of the site's business, explore deeper, take notes while it goes, and remember what it learned. Each explore run produces or updates two generated files for the host:

- `environments/<slug>.sitemap.json`: a structured sitemap (pages, links, flows, frontier).
- `environments/<slug>.md`: a human-readable environment file with a generated block (business summary, roles, key flows, quirks, off-limits, compact sitemap tree) and a hand-written `## Notes (yours)` section that explore never touches.

The next explore run for the same host loads both automatically and spends its budget on the frontier: unvisited links, unfinished or broken flows and shallow areas. Normal task runs use the same environment through the existing `--env <slug>`. The agent's knowledge enters through a new, harness-validated `note` action. The merge into the files is plain deterministic code, not a model call.

This builds on the existing exploration mode (`docs/superpowers/specs/2026-10-10-exploration-mode-explore-design.md`); everything there stays unless this spec says otherwise.

## Goals and non-goals

Goals:
- The agent works out what the site is for first, then explores business-critical flows several steps deep.
- Knowledge survives the run, including a run that hits the step limit.
- Each later run starts with more context and covers new ground.
- The environment file works unchanged with `--env`, and hand-written content is never overwritten.

Non-goals:
- No second model call to write the environment file.
- No change to normal task runs, beyond what `--env <slug>` already does.
- No auto-loading for task runs (`--env` stays explicit there).
- No domain allow-list or harness-side blocking of other hosts (still prompt-only).
- No SPA-aware state modelling. Pages are keyed by URL; see Known limitations.

## Decisions

| Topic | Decision |
| --- | --- |
| Where knowledge lives | Generated files in `environments/`, kept apart from hand-written ones by a marker section. |
| Slug | `slugify(host)` with `:` and other illegal characters turned into `-` (so `localhost:3000` is `localhost-3000`). Must satisfy `isEnvName`. |
| Note-taking | A new `note` action, validated by the harness, appended to `<run>/notes.jsonl`. Explore runs only. |
| Structure source | Derived by the harness from `history.json` (URLs, titles, statuses, links), with no model effort. Notes add the meaning. |
| Later explore runs | Frontier-first: skip covered pages, extend the map, re-check stale, broken and shallow areas. |
| Auto-load | `explore` loads `environments/<slug>.md` and `.sitemap.json` if present. An explicit `--env` wins for the prompt. Task runs stay explicit (`--env <slug>`). |
| Step budget | Explore default rises from 40 to 60. Only `--max-steps` changes it (unchanged rule). |
| Merge | Deterministic code after the run, under a lock, written atomically. |
| `--refresh` | Optional follow-up flag for a full re-sweep with a diff. Not part of this spec's required scope. |

## Files and data model

### `<slug>.sitemap.json`

```
{
  "version": 1,
  "host": "shop.example.com",
  "updated_run": "<run folder name>",
  "runs": <int, number of merged runs>,
  "pages": [{
    "url": "<normalized, no query/fragment except allow-listed keys>",
    "title": "<string>",
    "purpose": "<string, from a page note, else ''>",
    "status": "ok" | "broken" | "gated" | "external",
    "http_status": <int|null>,
    "depth": <int, clicks from the start URL>,
    "first_seen_run": <int>, "last_seen_run": <int>,
    "links": ["<normalized url>", ...],
    "pattern": "<e.g. /product/:id, when collapsed>" | null
  }],
  "flows": [{ "title", "start_url", "steps", "expected", "status", "notes", "last_run": <int> }],
  "frontier": ["<normalized url>", ...],
  "external_links": ["<url>", ...],
  "notes": { "business": [..], "quirk": [..], "off-limits": [..], "account": [..] }
}
```

Caps: 500 pages, 100 flows, 100 frontier entries, 20 notes per kind. `version` mismatch or an unparseable file is treated as corrupt (see Errors).

URL normalization: lower-case host, strip fragment and query, strip trailing slash (except root). A small allow-list of query keys (`page`, `q`, `category`) is collapsed into a pattern, not stored as separate pages. Once three or more sibling paths differ only in one id-like segment (digits, UUID, or a long hex/slug), they collapse to `/product/:id` and one page entry with `pattern` set.

### `<slug>.md`

```
<!-- duckwright:generated:start run=<N> -->
## Business
...summary (about 1.5 KB)
## Roles and accounts
...names and credential sources only, never values
## Key flows
...latest verdict per flow
## Quirks
## Off-limits
## Sitemap
...compact tree, depth-limited
<!-- duckwright:generated:end -->

## Notes (yours)
...never modified by explore
```

The whole file stays within `ENV_MAX_BYTES` (16384). To fit, explore shrinks in this order: tree depth, older low-value pages, per-section note counts. It never trims the hand-written section; if the hand-written part alone leaves too little room, the generated block is cut to the business summary and a warning is printed.

### `<run>/notes.jsonl` and merge summary

One JSON object per line: `{"step", "kind", "text", "url"}`. After the merge, `<run>/explore-memory.json` records what was added, changed, went stale or was dropped (counts of rejected notes included).

## The `note` action

- Command: `cmd: "note"`, `args: [kind, text]` or `[kind, text, url]`.
- Kinds: `business`, `page`, `quirk`, `off-limits`, `account`, `flow`.
- Harness checks (in `src/actions.ts`, next to `expect-request`): known kind; `text` non-empty after trim, at most 400 code points, single line after `flat`; `url`, if given, parses as http(s) on the explored host; text passes the existing secret redaction and is rejected if it looks like a credential (the rejection result tells the agent to name where a credential comes from instead).
- A note does not drive the browser and is not a page-changing command, so it can share a step with other actions.
- Allowed only when the run is an explore run (a new agent option, like `consoleErrors`); in a normal task it is an unknown command and rejected like any other.
- Not recorded as Playwright code. Explore runs never export a test anyway.
- Valid notes are appended to `<run>/notes.jsonl` immediately, so a crash or step limit keeps them.

## Run flow

### Before the run (`exploreMain`)

1. Compute the slug from the URL host.
2. Resolve the environment: an explicit `--env` wins; otherwise, if `environments/<slug>.md` exists, use it as the run's environment.
3. If `<slug>.sitemap.json` exists and parses, build the **frontier brief** (at most about 4 KB): unvisited frontier links, flows with status `dead-end` or `broken`, pages not seen for 3 or more runs, and pages with `depth` 1 that were never expanded. It is added to the explore task text after the rules.
4. Build the task with `exploreTask(url, { brief })`.

### The explore prompt (`src/explore/task.ts`)

Keeps today's rules (same host, no destructive actions, no login unless the environment gives an account, step budget awareness) and adds four phases:

1. **Orient**: spend the first steps working out what the site is for and who uses it. Record it with `note business ...`.
2. **Plan**: choose the 3 to 5 business-critical flows (for a shop: browse, search, product, cart, checkout up to the payment step). If a frontier brief is present, prefer its items over re-checking covered pages.
3. **Go deep**: follow each flow several steps in (list, then detail, then an action up to the safe boundary) rather than one click per flow.
4. **Write down what you learn** with `note` actions (page purpose, quirks, off-limits areas, where an account's credentials come from) as you go. Never write a secret value.

The finishing JSON stays as today (`{"flows":[...]}`).

The system prompt gains one line: the generated block of an environment comes from earlier automated exploration and may be out of date or wrong.

### After the run

1. Build and write the report as today.
2. Read the old sitemap (or start empty). Take the lock `environments/<slug>.lock`.
3. Merge:
   - Pages: add or update from `history.json` evidence (visited URL, title, status, links seen in snapshots), update `last_seen_run`, compute `depth`, collapse patterns.
   - A page that errors now becomes `broken` and keeps its history. A page only becomes stale-flagged by a run that finished normally (not by the step limit or a failure), because absence in a short run proves nothing.
   - Flows: latest verdict replaces the old one by title and start URL.
   - Notes: dedupe by normalized text, apply caps, `page` notes fill a page's `purpose`.
   - Frontier: remove visited URLs, add newly seen unvisited same-host links, and keep other hosts only in `external_links`.
4. Write `<slug>.sitemap.json` (temp file then rename), then regenerate the generated block of `<slug>.md` the same way and keep the hand-written section byte-for-byte.
5. Print `Environment: <path>` and `Sitemap: <path>` after the existing `Report:` and `Data:` lines, and write `explore-memory.json`.

Task runs: `--env <slug>` reads the `.md` exactly as today, so the compact sitemap tree inside the generated block reaches task prompts with no change to the prompt path.

## Errors and safety

- Memory is best-effort: a merge or write failure prints a warning; it exits `1` only if the run itself would have exited `0` (same rule as report write failures today).
- A run that never opened the site (no history) skips the merge.
- Corrupt or unknown-version sitemap: rename to `<slug>.sitemap.json.bak-<timestamp>`, warn, start fresh. Never overwrite what cannot be parsed.
- Concurrent runs: lock file during the merge. If the lock is held, wait briefly. If it still cannot be taken, save the pending merge to `<run>/pending-merge.json` and warn.
- Missing or duplicated hand-written marker in an edited file: append a fresh generated block, leave everything else alone, and warn.
- `--env` pointing at a path: that file's generated block is updated instead of `<slug>.md`.
- Secrets: notes pass redaction; credential-looking text is dropped and counted. Account notes name sources (an environment variable, the `--state` file), never values.
- Untrusted content: note text derives from page content. When fed back it is inside the existing fenced `<environment>` section and escaped like other page content. Environment text keeps its existing authority (background; the task wins).
- Same-host: sitemap pages and note URLs are restricted to the explored host. A redirect to another host records an `external` page and stops there. A login wall without a test account records a `gated` page and a note.
- Off-limits notes are fed back into the prompt's brief as a hard avoid list.

## Known limitations

- Single-page apps that do not change the URL give a coarse map; notes carry the detail.
- Pattern collapsing is heuristic and can merge unrelated paths.
- The map reflects what the agent happened to visit within its budget, not the whole site.

## Testing

Unit tests (Node test runner, in `test/explore/`, using the existing fixtures and helpers):
- `note` action: accepts each kind; rejects unknown kind, empty or over-long text, off-host URL, secret-looking text; rejected outside explore runs; does not count as page-changing; appends to `notes.jsonl`.
- URL normalization and pattern collapsing: query and fragment stripping, trailing slash, id-segment collapse after three siblings, allow-listed keys.
- Sitemap merge: new page, revisit updates `last_seen_run`, broken marking, no staling after a step-limited run, flow verdict replacement, frontier add and remove, caps and pruning order, external links kept apart.
- Environment file writer: preserves the hand-written section byte-for-byte, creates it when missing, handles a missing or duplicated marker, enforces 16384 bytes with the documented shrink order, and the result loads through `loadEnvironment`.
- Frontier brief: contents, 4 KB cap, off-limits avoid list.
- Prompt: `exploreTask` includes the four phases and the brief only when given.
- Safety: no secret reaches `notes.jsonl`, the sitemap or the `.md`; fenced and escaped when re-injected.
- Failure paths: corrupt sitemap backed up and restarted, lock held, write failure leaves the exit code rule intact, no-history run skips the merge.

Integration (in `test/cli.test.ts` style with the fake agent): an explore run with an existing environment loads it and the brief; after the run both files exist; a second run extends the map instead of replacing it; `--env` still wins over the auto-loaded file; `--env <slug>` on a task run reads the generated file.

An e2e check against a local fixture site (existing e2e harness) that two consecutive explore runs grow the sitemap is nice to have, not required.

## Docs

README gets: an "Explore memory" subsection under Exploration mode (files, the hand-written section, auto-loading, `--env <slug>` for tasks, limits), the new default budget of 60, the `note` action in the action reference, and a roadmap entry. The explore usage text mentions the generated files.

## Rollout

Behind no flag: the memory files are only created and read by `explore`, and nothing changes for task runs. Existing explore users get the files on their next run. Deleting `environments/<slug>.sitemap.json` resets the map without touching the hand-written notes.
