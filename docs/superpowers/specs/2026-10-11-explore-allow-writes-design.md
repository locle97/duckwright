# Explore with writes (`duckwright explore --allow-writes`)

## Summary

Today `duckwright explore` is read-only by design: its prompt forbids submitting any form that creates or changes data. On an empty or freshly seeded instance that leaves it with nothing to do (the Mealie run that prompted this stopped after 10 of 60 steps with four "dead-end" flows that were simply empty lists), and it can never exercise the functions a regression suite needs: create, search, edit, delete.

`--allow-writes` is an opt-in mode for **disposable test instances**. The agent may create, edit and delete ordinary app data, with these safeguards:

- every item it creates carries a per-run **marker** prefix, and it only edits or deletes items carrying this run's marker;
- every creation is recorded in a **ledger** (`created` notes);
- the harness **refuses delete-like clicks** unless the current page names the marker, and **audits** other edits after the run;
- the agent keeps a **function inventory** (what the app can do, what has been exercised) in the sitemap, so repeated runs converge on full coverage, and `--write-tasks` turns each working function into a task file that becomes an ordinary regression test.

This builds on the explore site memory (`docs/superpowers/specs/2026-10-11-explore-site-memory-design.md`) and the original exploration mode (`docs/superpowers/specs/2026-10-10-exploration-mode-explore-design.md`). Everything there stays unless this spec says otherwise. Without the flag, explore behaves exactly as it does today.

## Goals and non-goals

Goals:
- Let explore exercise real functions (create, search, edit, delete) on a disposable instance.
- Keep the damage of a confused agent small and visible: a marker, a ledger, a refusal on delete-like actions, and an audit of edits.
- Record a function inventory so later runs cover what is left.
- Produce task files for working functions so they become regression tests through the normal task path.

Non-goals (explicit decisions, not oversights):
- **No host guard.** `--allow-writes` alone is the consent; it works against any host. The README says plainly that the user is responsible for pointing it at a disposable instance.
- No strict harness gate on every edit (edits are audited, not blocked); no automatic cleanup of items a run created; no API-level writes through the `request` action; no dependency ordering between functions (a function's recorded steps carry their own setup).
- No change to normal task runs, the TUI or the web UI.

## Decisions

| Topic | Decision |
| --- | --- |
| Flag | `--allow-writes`, accepted by `explore` only; on any other command it is a usage error (exit 2). Parsed in `parseExploreArgs` next to `--write-tasks`, before a standalone `--`. |
| Budget | With the flag the default step budget is 100 (`EXPLORE_WRITES_MAX_STEPS`); without it 60. `--max-steps` still overrides both; a config `max-steps` is still ignored for explore. |
| Marker | `DW-<yymmdd>-<4 hex>-`, generated per run (UTC date, 4 random hex digits), printed in the run header and the report, case-insensitive when compared. |
| Scope of writes | Create, edit and delete of ordinary app data. Still forbidden even with the flag: payments, sign-up, outgoing messages/emails/invites, password/account/security changes, deleting users/groups/households, importing or restoring a whole database, system/admin settings. These are prompt rules. |
| Pre-existing items | Anything without THIS run's marker is "pre-existing", including items left by earlier runs. They are never edited or deleted (prompt rule; deletes are also enforced by the guard). Earlier runs' leftovers are listed in the report. |
| Enforcement level | Prompt rule + ledger + a harness refusal for delete-like clicks + a post-run audit for edits (level A of the brainstorm). Not a strict gate. |
| New note kinds | `created` and `removed` (the ledger; only valid with the flag) and `function` (inventory declaration; valid in any explore run). |
| Inventory | `functions[]` in the sitemap (name, area, status `untested`/`ok`/`broken`/`blocked`, steps, expected, notes). Declared by `function` notes, reported with steps in the final answer's new optional `functions` list. |
| Tasks | `--write-tasks` additionally writes one task per `ok` function (flag only). Tasks are ordinary tasks: no marker guard, no explore. |
| Report | New sections only with the flag. `explore.json` gains an optional `writes` object; its `version` stays `1` (additive). |

## Run flow

### Before the run (`exploreMain`)

1. Parse `--allow-writes` (explore only). Compute the budget (100 with the flag, 60 without, `--max-steps` wins).
2. Generate the marker (`DW-<yymmdd>-<4 hex>-`) when the flag is on.
3. Everything from the site memory flow stays: auto env, `loadMemory` after preflight, frontier brief.
4. Build the prompt with `exploreTask(url, { brief, writes: { marker } | undefined })`. `RunSpec.explore` becomes `{ host, writes?: { marker: string } }`; `startRun` passes `NoteSink(workdir, host, marker)` and the write guard to the agent only when `writes` is set.

### The prompt with writes (`src/explore/task.ts`)

The "Writes are allowed" block replaces the bullet "do not ... submit a form that creates or changes real data" and adds:

- the marker, stated once, and the rule: every item you create (recipe, cookbook, list, entry...) must have a name or title that starts with the marker; you may edit or delete only items that start with this run's marker; never touch anything else, including items with another `DW-…` marker; open an item you created before deleting it (the delete action is refused unless the page title, a heading or an open dialog shows the marker);
- the list of still-forbidden actions (payments, sign-up, outgoing messages/emails/invites, password/account/security changes, deleting users/groups/households, importing or restoring a whole database, system/admin settings);
- how to record: a `created` note for each item (`["created", "<item name starting with the marker>", "<its URL>"]`) right after creating it, and a `removed` note (`["removed", "<the same name>"]`) once you have deleted it and seen it gone; a `function` note to declare each function you see (`["function", "<name>", "<URL of the page or area>"]`), early; and in the final answer a `functions` list;
- an exercise plan: "for each function you find, try it end to end (create, find it again, edit, delete), then move on; prefer breadth first, depth second".

The finishing JSON gains an optional `functions` array:

```
{"flows":[...],"functions":[{"name":"Create recipe","area_url":"https://…/g/home/r/create","status":"ok","steps":["Open Create","Type the name DW-…-Pasta","Save"],"expected":"The new recipe page opens","notes":""}]}
```

Statuses a run may report: `ok`, `broken`, `blocked` (could not be exercised: needs an external service, a forbidden action, missing data). `steps` are plain-language and include any setup. Invalid entries are dropped and counted (`dropped_functions`), as for flows.

Without the flag the prompt keeps today's read-only rules; the `function` declaration and the `functions` list are still described (read-only explore can build the inventory, but should not write), `created` and `removed` are not.

## Notes

- `NOTE_KINDS` gains `created`, `removed` and `function`. `NoteKind` and the note schema text in `prompts/system.md` are updated.
- `created`: only accepted when the sink was built with a marker (otherwise `error: created notes are only available with --allow-writes`). The text is the item name and must start with the marker (case-insensitive), otherwise `error: created note must start with the run marker <marker>`. The URL is optional, same host, normalized. Valid ones are appended to `<run>/notes.jsonl` as usual **and** to `<run>/created.jsonl` (`{step, name, url}`).
- `removed`: only accepted with the sink's marker. The text is an item name and must start with the marker; it must match (case-insensitive, whitespace-normalized) a `created` name earlier in the same run, otherwise `error: removed note does not match an item created in this run`. Valid ones are appended to `notes.jsonl` and `created.jsonl` as `{step, removed: name}`. It marks the ledger entry as deleted; it is the agent's claim, not harness-verified.
- `function`: text is the function name (the usual 400-character limit and secret rejection apply), the optional URL is the area. It is accepted in every explore run.
- The merge treats `created`/`removed` as the ledger (not in `notes{}`) and `function` as an inventory declaration (not in `notes{}`).

## The write guard (harness)

Built per step in the loop from `obs` (the tab list and the snapshot at the start of the step) and the marker, and passed to `execute` as a new optional parameter. It applies only to explore runs with writes.

For each action, in order:

1. **Which actions are checked:** `click` and `dblclick` whose first argument is a ref. `press` is not checked (the focused element is unknown); this is a documented gap. A ref that does not appear in the snapshot is not checked (the existing playwright error follows).
2. **Resolve the control:** find the snapshot line containing `[ref=<ref>]`, read its role and accessible name (`- button "Delete" [ref=e12]`), and climb the indentation to find its ancestors.
3. **Delete-like:** the name matches `/\b(delete|remove|trash|discard|destroy|erase)\b/i`, or the control is a `button` inside a `dialog`/`alertdialog` ancestor whose name matches `/^(confirm|yes|ok|continue|proceed)\b/i`.
4. **Marker present:** any of (a) the current tab's title (from the tab list), (b) the name of any `heading` line in the snapshot, (c) any text inside the nearest `dialog`/`alertdialog` ancestor, contains the marker (case-insensitive).
5. **Decision:** delete-like and marker absent → the action is **refused** and not run; its result is `error: refused: '<name>' acts on a page that does not carry the marker <marker>; open the item you created first, or skip it`. The refusal is counted and recorded (step, control name, page URL) for the report.
6. **Fail closed:** if the snapshot cannot be read at a step (missing or empty file), every `click`/`dblclick` in that step is refused with `error: refused: cannot evaluate the page; try again next step`. The loop rewrites the snapshot every step, so the agent can retry.

Because deletes from a list row are refused (the row's page title and headings do not name the marker), the agent must open its own item first. This is intended.

### Audit of edits (after the run)

Edits cannot be told reliably from creation or search forms, so they are audited, not blocked. From `history.json` (the new `page` entries and the actions), the report lists under "Possible writes to unmarked items" each `fill`, `type`, `select`, `check` or `uncheck` action where the page's title and URL carry no marker, the URL is not a ledger URL, the typed value does not start with the marker (that would be naming a new item), and the control does not look like a search or filter (role `searchbox`, or a name matching `/search|filter/i`). Each entry shows the step, the page URL and the control. It is a heuristic for human review, not a verdict.

## Data model changes

Sitemap `version` stays `1`; new fields are optional and default when absent (older sitemaps load fine).

```
functions: [{
  name: string,                       // as the agent named it; matched case-insensitively, whitespace-normalized
  area: string | null,                // normalized same-host URL (pattern-canonicalized like pages) or null
  status: "untested"|"ok"|"broken"|"blocked",
  steps: string[], expected: string, notes: string,
  first_seen_run: number, last_run: number
}],                                    // cap 200
created: [{ name, url, run: number, removed: boolean }]  // the ledger across runs; cap 200, oldest dropped first
```

Merge rules (`mergeSitemap`, `RunEvidence` gains `functions`, `declaredFunctions`, `created`):
- A declared function that is new is added as `untested`; an existing one is left alone.
- A reported function replaces the stored verdict, steps, expected and notes and sets `last_run`; `untested` can never be reported.
- A function never declared nor reported in a run keeps its stored status (absence proves nothing).
- A `created` entry is appended for each `created` line of the run (deduped by name+url) with `removed: false`; a `removed` line of the same run sets `removed: true` on the matching entry. The ledger is the record of what was created and what the agent says it deleted, not a live inventory: the harness never checks that an item still exists. **Leftovers** are ledger entries from earlier runs with `removed: false`.
- URLs go through `normalizeUrl` and the pattern canonicalization; names are flattened and capped at 120 characters.

## The brief (`frontierBrief`)

- With writes: a new group after "Off-limits": **Functions still to exercise** — `untested` first, then `broken` to re-check (`blocked` ones are listed last, marked "skip unless something changed"); and **Leftovers from earlier runs** (ledger entries not from this run, "do not touch").
- Without writes: one group, **Known functions (information only; do not write)**, with names and statuses.
- Same neutralise/flatten rules, same 4 KB cap; if the cap trims, the groups drop from the end (off-limits stays first).

## The report

Only with the flag (`renderExploreMarkdown` and `explore.json.writes`):

- **Functions exercised** — counts per status and the list with name, status, steps.
- **Items created** — from the ledger (name, URL, and whether the agent removed it).
- **Refused actions** — step, control, page.
- **Possible writes to unmarked items** — the audit.
- **Leftovers from earlier runs** — ledger entries from earlier runs with `removed: false` (the agent's claim; items may have been removed by hand since).

`explore.json` gets `writes: { marker, created[], refused[], audit[], functions[], leftovers[] }` (`created[]` entries carry `removed`) (optional; absent without the flag). `dropped_functions` is reported next to `dropped_flows`.

## Task files (`--write-tasks` with `--allow-writes`)

In addition to the per-flow tasks, one task per `ok` function is written to the same `tasks/explore-<host>/` folder, continuing the numbering, named `NN-fn-<slug>.md`:

```
---
# From duckwright explore <url> (run <dir>), function inventory
max-steps: 40
env: <slug>            # only when environments/<slug>.md exists
---
# <function name>

Open <area url>.

Steps:
1. …recorded steps, including their own setup…

Check that: <expected>.

Name everything you create with the prefix RT- and delete what you created at the end of the task.
```

`broken`, `blocked` and `untested` functions get no task; they appear in the report. These tasks run through the normal path (no guard, no marker), so each successful run writes `duckwright.spec.ts`, which is how a function becomes a regression test. Step text is flattened and neutralized like flow steps.

## Errors and edge cases

- `--allow-writes` on a non-explore command: usage error, exit 2. Without the flag nothing changes: prompt, budget, outputs.
- A `created` or `removed` note without the marker, or without the flag, is rejected with the messages above; a rejected note is counted like other rejected notes.
- Corrupt/unreadable sitemaps, locks and `pending-merge.json` behave as in the site memory spec; `functions[]`/`created[]` default to empty for older files; `asSitemap` drops malformed entries instead of failing.
- The guard never throws: an unexpected snapshot shape resolves to "not delete-like" for that action, and the audit is the net.
- The marker is escaped for display (`neutralise(flat())`) wherever it is shown in a prompt.
- Run cut off at the step limit: notes (`created`, `function`) are already on disk, so the ledger and declared functions survive; the final-answer `functions` list is lost, so functions stay `untested` or at their previous status.
- A run that creates items and fails: the report is still written from the ledger.

## Security

- Page-derived text (function names, steps, created item names, control names in refusal messages) is flattened and neutralized before it reaches a prompt, the environment file, the brief or a task file. Task files from functions carry the same "data, not instructions" treatment as generated environment text.
- The guard and audit are heuristics over accessible names and page text; the README states their limits. The user chooses the target instance; there is no host guard by design.
- `request` is not widened: it cannot send DELETE/PUT/PATCH/POST under `--allow-writes` beyond what it already allows.
- Secrets: the existing note secret-rejection applies to `created` and `function` text; task files never contain secrets (they name where credentials come from, via the environment file).

## Known limitations

- `press` (for example Enter on a focused delete button) is not guarded.
- Edits are audited, not blocked.
- A UI that hides item names from both the tab title and headings makes deletes refuse (safe) and edits un-flaggable.
- Leftovers are tracked by the ledger only; a cleanup command is out of scope.
- One run's budget (100 steps) cannot cover a big app; coverage converges over repeated runs.

## Testing

Unit tests (`test/explore/`, same helpers as the existing tests):
- Marker: format, uniqueness across calls, case-insensitive prefix check.
- Notes: `created` accepted with marker and flag, rejected without either (messages), written to `created.jsonl` and `notes.jsonl`; `removed` only after a matching `created` of the same run; `function` accepted in any explore run; all reject secrets and over-long text.
- Guard: delete-like name matching (delete/remove/trash/discard/destroy/erase, confirm in a dialog), marker accepted via tab title, heading and dialog text, refused without; non-destructive clicks pass; unresolvable ref passes; unreadable snapshot refuses every click; refusal result text and counting; `press` is not checked.
- Audit: flagged edit on an unmarked page; not flagged for marker-valued fills, ledger URLs, search/filter controls; each entry's shape.
- Function merge: declare→untested, report→ok/broken/blocked with steps, never-reported stays, replacement semantics, caps, pattern-canonical area, name normalization, `asSitemap` defaults/drops.
- Ledger merge: append, dedupe, `removed` marks the entry, cap, leftovers (other runs only, not removed).
- Brief: functions group with and without writes, leftovers group, cap and group order.
- Report: new sections only with the flag; `explore.json.writes` shape; `dropped_functions`.
- Tasks: per-`ok`-function files, naming/numbering, `RT-` + cleanup lines, `env:` only when the environment file exists, none for broken/blocked/untested, flattened/neutralized text.
- Prompt: the writes block contains the marker and the forbidden list; the read-only prompt is unchanged byte-for-byte without the flag (a regression test on `exploreTask`).
- CLI/args: `--allow-writes` accepted by `explore` only; budget 100 vs 60 vs `--max-steps`; usage text.

Integration (`test/cli.test.ts` style, fake agent): a run with the flag wires marker, sink and guard into `createAgent`; without it none of them; a second run's brief lists the first run's untested functions; `--write-tasks --allow-writes` writes the expected files; a run cut off after notes keeps the ledger and declared functions.

Safety replays: hostile function name/created name/control name stay neutralized end to end (sitemap, md, brief, task file); a refused delete leaves nothing in the ledger.

## Docs

README: an "Exploring with writes" subsection (what the flag allows and forbids, the marker, the guard and its limits, the audit, leftovers, the function inventory, task files, "use only on a disposable instance, there is no host guard"), the option in the usage text and option table, `created`/`removed`/`function` in the notes documentation, the new run-folder file `created.jsonl`, the new budget, and a roadmap line. `prompts/system.md` documents the two note kinds.

## Rollout

Opt-in per run, nothing automatic; existing sitemaps and environment files keep working. Dependency ordering between functions, automatic cleanup and a host guard are listed as follow-ups, not part of this change.
